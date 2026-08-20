/**
 * Naplánovaný úklid sdílených PDF reportů — po 90 dnech soubor opravdu zmizí.
 *
 * ⭐ PROČ VŮBEC. Sdílení reportu nahraje PDF do Storage pod náhodné id a založí
 * `shareLinks` záznam. Zneplatnění odkazu rotuje download token, takže adresa
 * umře — ale SOUBOR leží dál a platí se za něj. Do 8/2026 o něm neexistoval
 * žádný zápis, takže ho nikdo nemohl ani najít, ani uklidit.
 *
 * ⭐ REPORT JE PROVOZNÍ ARTEFAKT, NE OBSAH STAVBY (rozhodnutí vlastníka
 * produktu, 19. 8. 2026). Dokumentace se drží, dokud ji někdo nesmaže; report
 * je odvozenina, kterou jde kdykoli vygenerovat znovu. Proto retence — a proto
 * se musí odečíst i ze spotřeby stavby, jinak by počítadlo trvale rostlo.
 *
 * ⚠️ PROČ NE FIRESTORE TTL POLICY. Stejný důvod jako u koše: TTL smaže jen
 * Firestore dokument. Objekt ve Storage by nechala osiřelý a počítadlo spotřeby
 * (`projects/{pid}/usage/current`) by neodečetla, takže by lhalo směrem nahoru.
 * Úklid proto musí být kód, ne konfigurace.
 *
 * ⚠️ POŘADÍ JE OBRÁCENÉ NEŽ U KOŠE, a je to záměr. `trashSweep.ts` maže
 * „záznam → objekt". Tady se maže „OBJEKT → záznam", protože přesně sirotčí
 * objekt je vada, kterou tenhle soubor opravuje: kdyby se první smazal záznam
 * a mazání objektu pak selhalo, zůstal by ve Storage soubor, o kterém už zase
 * nikdo neví. Opačné pořadí se samo zhojí — při dalším běhu je mazání objektu
 * neškodný no-op a záznam se dobere. Odečet spotřeby visí na smazání ZÁZNAMU,
 * takže proběhne právě jednou.
 *
 * ⭐ SDÍLENÝ SOUBOR. Musí být IDENTICKÝ v obou repech (viz docs/REPO_BOUNDARIES.md):
 *   hlavní repo `functions/src/reportSweep.ts`
 *   companion   `selfhost/functions/src/reportSweep.ts`
 * Reporty žijí v tom Firebase projektu, který drží data workspace — stejná
 * úvaha jako u `trashSweep.ts`.
 *
 * ⭐ PROČ PROCHÁZENÍ PROJEKTŮ A NE `collectionGroup`. Dotaz přes skupinu kolekcí
 * by potřeboval single-field index se scopem COLLECTION_GROUP nad `purgeAt`
 * ve `firestore.indexes.json` OBOU repů, a self-hostující firma by ho dostala
 * až při dalším spuštění setup CLI. Úklid, který mlčky nefunguje, dokud někdo
 * nenasadí index, je přesně ta vada, kterou tenhle soubor opravuje.
 */

import { FieldValue } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";

/** Kolik dní sdílený report zůstane (musí sedět s `REPORT_RETENTION_DAYS` v `src/services/reporting/reportRecords.ts`). */
export const REPORT_RETENTION_DAYS = 90;

/** Strop položek na jeden běh — zbytek se dobere zítra, běh je denní. */
export const REPORT_SWEEP_MAX_ITEMS_PER_RUN = 400;

/** Kolik vypršelých reportů si dotáhneme z jednoho projektu. */
export const REPORT_SWEEP_MAX_ITEMS_PER_PROJECT = 50;

export interface ProjectRef {
  workspaceId: string;
  projectId: string;
}

/** Report, kterému vypršel `purgeAt`. Jen pole, která úklid potřebuje. */
export interface ExpiredReport {
  id: string;
  /** Cesta objektu ve Storage. Chybí u záznamů z doby před evidencí cesty. */
  storagePath?: string;
  /** Velikost souboru — odečítá se z počítadla spotřeby. */
  sizeBytes?: number;
  /** Token sdílecího odkazu, ať po smazaném reportu nezůstane živý `/share/…`. */
  shareToken?: string;
  /**
   * Naskočila velikost reportu do počítadla spotřeby? Odečítá se JEN tehdy.
   *
   * 🔴 Přičtení na klientovi je best-effort a smí tiše selhat. Bezpodmínečný
   * odečet by tedy u takového reportu ubral místo, které se nikdy nepřipočetlo,
   * a počítadlo stavby by se trvale rozjelo směrem dolů.
   */
  usageCounted?: boolean;
}

/** Datová vrstva. Oddělená od admin SDK, ať jde úklid otestovat bez sítě. */
export interface ReportStore {
  listProjects(): Promise<ProjectRef[]>;
  /** Reporty projektu, kterým `purgeAt` vypršel (`purgeAt <= now`). */
  listExpired(project: ProjectRef, now: Date, limit: number): Promise<ExpiredReport[]>;
  deleteReportDoc(project: ProjectRef, reportId: string): Promise<void>;
  deleteShareLink(project: ProjectRef, token: string): Promise<void>;
  addUsage(project: ProjectRef, delta: { storageBytes: number }): Promise<void>;
}

/** Mazání objektů ve Storage. Vrací počet objektů, které opravdu zmizely. */
export interface ReportStorage {
  deleteObjects(paths: readonly string[]): Promise<number>;
}

export interface ReportSweepSummary {
  scannedProjects: number;
  deletedReports: number;
  deletedObjects: number;
  freedBytes: number;
  /** Kolik položek se nepodařilo uklidit — dobere je další běh. */
  failed: number;
  /** Běh narazil na strop a zbytek nechal na zítra. */
  hitRunLimit: boolean;
}

export interface ReportSweepHooks {
  onError?: (message: string, error: unknown) => void;
  onSummary?: (record: { severity: "info" | "warning" | "error"; message: string; payload: Record<string, unknown> }) => void;
}

/**
 * Projde všechny projekty backendu a uklidí reporty s vypršeným `purgeAt`.
 *
 * Nikdy nevyhazuje: jednotlivá selhání se počítají do `failed` a hlásí přes
 * `onError`. Funkce, která MAŽE DATA, nesmí spadnout uprostřed a nechat po
 * sobě půlku práce bez stopy — proto se každá položka řeší samostatně.
 */
export async function runReportSweep(
  store: ReportStore,
  storage: ReportStorage,
  hooks: ReportSweepHooks = {}
): Promise<ReportSweepSummary> {
  const summary: ReportSweepSummary = {
    scannedProjects: 0,
    deletedReports: 0,
    deletedObjects: 0,
    freedBytes: 0,
    failed: 0,
    hitRunLimit: false,
  };

  let projects: ProjectRef[];
  try {
    projects = await store.listProjects();
  } catch (error) {
    hooks.onError?.("reportSweep: nepodařilo se načíst projekty", error);
    summary.failed += 1;
    reportSummary(summary, hooks);
    return summary;
  }

  for (const project of projects) {
    if (summary.deletedReports + summary.failed >= REPORT_SWEEP_MAX_ITEMS_PER_RUN) {
      summary.hitRunLimit = true;
      break;
    }

    summary.scannedProjects += 1;

    let expired: ExpiredReport[];
    try {
      expired = await store.listExpired(project, new Date(), REPORT_SWEEP_MAX_ITEMS_PER_PROJECT);
    } catch (error) {
      hooks.onError?.(`reportSweep: nepodařilo se načíst vypršelé reporty (${project.projectId})`, error);
      summary.failed += 1;
      continue;
    }

    for (const report of expired) {
      if (summary.deletedReports + summary.failed >= REPORT_SWEEP_MAX_ITEMS_PER_RUN) {
        summary.hitRunLimit = true;
        break;
      }
      await sweepOneReport(store, storage, project, report, summary, hooks);
    }
  }

  reportSummary(summary, hooks);
  return summary;
}

async function sweepOneReport(
  store: ReportStore,
  storage: ReportStorage,
  project: ProjectRef,
  report: ExpiredReport,
  summary: ReportSweepSummary,
  hooks: ReportSweepHooks
): Promise<void> {
  try {
    // 1. OBJEKT. Musí padnout první — viz poznámka o pořadí v hlavičce souboru.
    if (report.storagePath) {
      summary.deletedObjects += await storage.deleteObjects([report.storagePath]);
    }

    // 2. Sdílecí odkaz. Bez něj by po smazaném reportu zůstal živý `/share/…`,
    //    který návštěvníkovi ukáže rozbitý soubor místo srozumitelného konce.
    if (report.shareToken) {
      await store.deleteShareLink(project, report.shareToken);
    }

    // 3. ZÁZNAM až nakonec — a teprve na něm visí odečet spotřeby, takže se
    //    při opakovaném běhu neodečte dvakrát.
    await store.deleteReportDoc(project, report.id);
    summary.deletedReports += 1;

    const bytes = typeof report.sizeBytes === "number" && Number.isFinite(report.sizeBytes) ? report.sizeBytes : 0;
    // `usageCounted !== true` schválně, ne `=== false`: chybějící pole (starší
    // záznam, ruční zásah) znamená „nevíme", a u měřidla je nevědomost důvod
    // neodečítat, ne odečíst naslepo.
    if (bytes > 0 && report.usageCounted === true) {
      await store.addUsage(project, { storageBytes: -bytes });
      summary.freedBytes += bytes;
    }
  } catch (error) {
    hooks.onError?.(`reportSweep: report ${report.id} se nepodařilo uklidit (${project.projectId})`, error);
    summary.failed += 1;
  }
}

/**
 * Souhrn běhu → JEDEN záznam v Cloud Loggingu, se ZÁVAŽNOSTÍ podle výsledku.
 *
 * Poučení z `trashSweep.ts`: `gcloud functions logs read` ukazuje jen textovou
 * hlášku, takže `logger.info("reportSweep", summary)` by znamenalo, že běh,
 * který smazal padesát souborů, vypadá stejně jako běh, kterému se všechno
 * rozsypalo. U funkce, která maže data, je tichý log to samé jako žádný.
 */
function reportSummary(summary: ReportSweepSummary, hooks: ReportSweepHooks): void {
  const megabytes = (summary.freedBytes / (1024 * 1024)).toFixed(1);
  const severity: "info" | "warning" | "error" =
    summary.failed > 0 && summary.deletedReports === 0 ? "error" : summary.failed > 0 ? "warning" : "info";

  const message =
    summary.deletedReports === 0 && summary.failed === 0
      ? `Úklid reportů: nic nevypršelo (${summary.scannedProjects} projektů).`
      : `Úklid reportů: smazáno ${summary.deletedReports} reportů (${megabytes} MB), ` +
        `${summary.failed} selhalo${summary.hitRunLimit ? ", narazilo se na strop běhu" : ""}.`;

  hooks.onSummary?.({
    severity,
    message,
    payload: { event: "report_sweep_finished", ...summary },
  });
}

// ---------------------------------------------------------------------------
// Adaptéry na admin SDK. Oddělené od {@link runReportSweep}, ať jde úklid
// otestovat bez sítě a bez emulátoru — stejný vzor jako v `trashSweep.ts`.
// ---------------------------------------------------------------------------

/** Minimum z `firebase-admin/storage`, které úklid potřebuje. */
export interface AdminReportBucket {
  file(path: string): { delete(): Promise<unknown> };
}

export function createFirestoreReportStore(firestore: Firestore): ReportStore {
  const base = (project: ProjectRef) => `workspaces/${project.workspaceId}/projects/${project.projectId}`;

  return {
    async listProjects() {
      const workspaces = await firestore.collection("workspaces").listDocuments();
      const projects: ProjectRef[] = [];
      for (const workspace of workspaces) {
        const projectRefs = await workspace.collection("projects").listDocuments();
        for (const projectRef of projectRefs) {
          projects.push({ workspaceId: workspace.id, projectId: projectRef.id });
        }
      }
      return projects;
    },

    async listExpired(project, now, limit) {
      // Spodní nerovnost není kosmetika: Firestore řadí `null` PŘED všechny
      // timestampy, takže samotné `purgeAt <= now` by vytáhlo i záznamy, kde
      // `purgeAt` chybí nebo je vynulovaný. Stejná past jako v `trashSweep.ts`.
      const snapshot = await firestore
        .collection(`${base(project)}/reports`)
        .where("purgeAt", ">", new Date(0))
        .where("purgeAt", "<=", now)
        .limit(limit)
        .get();

      return snapshot.docs.map((doc) => {
        const data = (doc.data() ?? {}) as Record<string, unknown>;
        return {
          id: doc.id,
          storagePath: typeof data.storagePath === "string" ? data.storagePath : undefined,
          sizeBytes: typeof data.sizeBytes === "number" ? data.sizeBytes : undefined,
          shareToken: typeof data.shareToken === "string" ? data.shareToken : undefined,
          usageCounted: data.usageCounted === true,
        };
      });
    },

    async deleteReportDoc(project, reportId) {
      await firestore.doc(`${base(project)}/reports/${reportId}`).delete();
    },

    async deleteShareLink(project, token) {
      await firestore.doc(`${base(project)}/shareLinks/${token}`).delete();
    },

    async addUsage(project, delta) {
      await firestore.doc(`${base(project)}/usage/current`).set(
        {
          updatedAt: FieldValue.serverTimestamp(),
          storageBytes: FieldValue.increment(delta.storageBytes),
        },
        { merge: true }
      );
    },
  };
}

/**
 * Mazání objektů. NIKDY nevyhazuje — chybějící objekt (404) je normální stav:
 * úklid mohl minule doběhnout jen zpola a záznam se dobírá teprve teď.
 */
export function createBucketReportStorage(
  bucket: AdminReportBucket,
  onError: (message: string, error: unknown) => void = () => undefined
): ReportStorage {
  return {
    async deleteObjects(paths) {
      let deleted = 0;
      for (const path of Array.from(new Set(paths.filter((value) => typeof value === "string" && value.length > 0)))) {
        try {
          await bucket.file(path).delete();
          deleted += 1;
        } catch (error) {
          if ((error as { code?: unknown } | null)?.code === 404) {
            continue;
          }
          onError(`Objekt reportu se nepodařilo smazat: ${path}`, error);
        }
      }
      return deleted;
    },
  };
}
