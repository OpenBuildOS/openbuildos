import { FieldValue } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";

/**
 * Naplánovaný doběh koše — po 30 dnech se smazaný obsah opravdu smaže (B3).
 *
 * ⭐ PROČ SERVER. Do 8/2026 dělal doběh KLIENT (`sweepExpiredTrash` v
 * `src/services/trash.ts`): spustil se jen tehdy, když si Koš otevřel někdo
 * s právy správce. Na stavbě, kde do Koše nikdo nechodí, se tedy nespustil
 * NIKDY a smazaný obsah ležel dál — přestože UI i
 * `docs/legal/ZASADY_OCHRANY_OSOBNICH_UDAJU.md` slibují opak. Slib krytý
 * náhodným klikáním není slib.
 *
 * ⚠️ PROČ NE FIRESTORE TTL POLICY. TTL umí smazat jen Firestore dokument.
 * Objekt ve Storage by nechala osiřelý (fotka pracovníka, na kterou už nic
 * neukazuje = porušené právo na výmaz) a počítadlo spotřeby
 * (`projects/{pid}/usage/current`) by neodečetla, takže by trvale lhalo
 * směrem nahoru. Doběh proto musí být kód, ne konfigurace.
 *
 * ⭐ SDÍLENÝ SOUBOR. Musí být IDENTICKÝ v obou repech (viz docs/REPO_BOUNDARIES.md):
 *   hlavní repo `functions/src/trashSweep.ts`
 *   companion   `selfhost/functions/src/trashSweep.ts`
 * Koš žije v tom Firebase projektu, který drží data workspace — u self-hostu
 * firemní projekt (companion), u hostovaného/staging workspace centrální
 * projekt (hlavní repo). Stejná úvaha jako u `planPromotion.ts`.
 *
 * ⭐ PROČ PROCHÁZENÍ PROJEKTŮ A NE `collectionGroup`. Dotaz přes skupinu kolekcí
 * by potřeboval single-field index se scopem COLLECTION_GROUP nad `purgeAt`
 * ve třech kolekcích, tedy `fieldOverrides` ve `firestore.indexes.json` OBOU
 * repů — a self-hostující firma by ho dostala až při dalším spuštění setup CLI.
 * Doběh, který mlčky nefunguje, dokud někdo nenasadí index, je přesně ta vada,
 * kterou tenhle soubor opravuje. Procházení `workspaces → projects` si vystačí
 * s AUTOMATICKÝM single-field indexem, takže funguje hned po nasazení funkce.
 * Cena je O(projekty) dotazů jednou denně — při realistickém počtu staveb
 * hluboko pod denním free tierem.
 */

/** Kolik dní obsah zůstane v koši (musí sedět s `TRASH_RETENTION_DAYS` v `src/services/softDelete.ts`). */
export const TRASH_RETENTION_DAYS = 30;

/**
 * Strop položek na jeden běh. Doběh jde sériově (u dokumentu je to N revizí +
 * N objektů), takže bez stropu by firma, která rok nevysypala koš, držela
 * funkci až do timeoutu. Zbytek se dobere při dalším běhu — a protože běh je
 * denní, fronta se rozpustí sama.
 */
export const SWEEP_MAX_ITEMS_PER_RUN = 400;

/** Kolik vypršelých položek si dotáhneme z jedné kolekce jednoho projektu. */
export const SWEEP_MAX_ITEMS_PER_COLLECTION = 50;

export type SweptType = "task" | "photo" | "document";

/** Kolekce pod projektem, ve kterých koš žije. Pořadí = pořadí úklidu. */
export const SWEPT_COLLECTIONS: Readonly<Record<SweptType, string>> = {
  task: "tasks",
  photo: "photos",
  document: "documents",
};

export interface ProjectRef {
  workspaceId: string;
  projectId: string;
}

/** Položka koše, které vypršelo `purgeAt`. Jen pole, která úklid potřebuje. */
export interface ExpiredItem {
  type: SweptType;
  id: string;
  /** Cesta k objektu ve Storage (fotka). Chybí u obsahu bez souboru i u starých fotek. */
  storagePath?: string;
  /** Velikost fotky včetně miniatury — odečítá se z počítadla spotřeby. */
  sizeBytes?: number;
}

/** Revize dokumentu tak, jak leží ve Firestoru (jen pole, která úklid čte). */
export interface VersionRecord {
  id: string;
  fileId?: unknown;
  filePath?: unknown;
  thumbnailObjectPath?: unknown;
  qrOverlayFilePath?: unknown;
  sizeBytes?: unknown;
  thumbnailSizeBytes?: unknown;
}

/** Přírůstek/úbytek počítadla spotřeby (`projects/{pid}/usage/current`). */
export interface UsageDelta {
  storageBytes?: number;
  photoCount?: number;
  docCount?: number;
}

/**
 * Na které soubory ukazují výkresy v Plánech. `null` z `listPlanFileReferences`
 * znamená „nevíme" — pak se objekty revizí NESMÍ mazat (viz
 * `src/services/planFileReferences.ts`).
 */
export interface PlanFileReferences {
  fileUrls: ReadonlySet<string>;
  sourceVersionIds: ReadonlySet<string>;
}

/** Plan doc tak, jak přijde z Firestoru (revize jsou vnořené pole). */
export interface RawPlanDocument {
  versions?: unknown;
}

/** Datová vrstva. Oddělená od admin SDK, ať jde doběh otestovat bez sítě. */
export interface TrashStore {
  /** Všechny projekty napříč workspaces tohoto backendu. */
  listProjects(): Promise<ProjectRef[]>;
  /** Položky projektu, kterým `purgeAt` vypršel (`purgeAt <= now`, nikdy null). */
  listExpired(project: ProjectRef, now: Date, limit: number): Promise<ExpiredItem[]>;
  /** Revize dokumentu (kaskáda při trvalém smazání dokumentu). */
  listVersions(project: ProjectRef, documentId: string): Promise<VersionRecord[]>;
  /** `null` = nepodařilo se zjistit → objekty revizí se nechají být. */
  listPlanFileReferences(project: ProjectRef): Promise<PlanFileReferences | null>;
  deleteContentDoc(project: ProjectRef, type: SweptType, id: string): Promise<void>;
  deleteVersionDoc(project: ProjectRef, versionId: string): Promise<void>;
  addUsage(project: ProjectRef, delta: UsageDelta): Promise<void>;
}

/** Mazání objektů ve Storage. Vrací počet objektů, které opravdu zmizely. */
export interface TrashStorage {
  deleteObjects(paths: readonly string[]): Promise<number>;
}

export interface SweepSummary {
  scannedProjects: number;
  purged: Record<SweptType, number>;
  /** Kolik objektů ve Storage doběh opravdu smazal. */
  storageObjectsDeleted: number;
  failures: number;
  /** `true` = došel strop, zbytek se dobere příští běh. */
  reachedLimit: boolean;
}

// ── čisté pomocníky (1:1 s klientem, testovatelné bez Firestoru) ─────────────

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Objekty jedné fotky — plná verze + miniatura. Miniatura leží vedle originálu
 * jako `thumb_{název}` (viz `uploadThumbnailToStorage` v `src/services/photos.ts`).
 * ⚠️ Musí zůstat shodné s `photoStorageObjectPaths` v `src/services/storageObjects.ts`.
 */
export function photoStorageObjectPaths(storagePath: unknown): string[] {
  if (!nonEmptyString(storagePath)) {
    return [];
  }
  const separatorIndex = storagePath.lastIndexOf("/");
  if (separatorIndex < 0) {
    return [storagePath];
  }
  const directory = storagePath.slice(0, separatorIndex);
  const fileName = storagePath.slice(separatorIndex + 1);
  return [storagePath, `${directory}/thumb_${fileName}`];
}

/**
 * Objekty jedné revize dokumentu — nahraný soubor, náhled a odvozené PDF s QR.
 * ⚠️ Musí zůstat shodné s `versionStorageObjectPaths`
 * v `src/modules/documents/services/documentService.ts`.
 */
export function versionStorageObjectPaths(version: VersionRecord): string[] {
  const paths: string[] = [];
  if (nonEmptyString(version.fileId)) {
    paths.push(version.fileId);
    const separatorIndex = version.fileId.lastIndexOf("/");
    if (separatorIndex > 0) {
      paths.push(`${version.fileId.slice(0, separatorIndex)}/thumbnails/preview.jpg`);
    }
  }
  if (nonEmptyString(version.thumbnailObjectPath)) {
    paths.push(version.thumbnailObjectPath);
  }
  if (nonEmptyString(version.qrOverlayFilePath)) {
    paths.push(version.qrOverlayFilePath);
  }
  return paths;
}

/** Vytáhne odkazy na soubory z už načtených plan docs. */
export function collectPlanFileReferences(plans: readonly RawPlanDocument[]): PlanFileReferences {
  const fileUrls = new Set<string>();
  const sourceVersionIds = new Set<string>();
  for (const plan of plans) {
    const versions: unknown[] = Array.isArray(plan?.versions) ? plan.versions : [];
    for (const version of versions) {
      const fileUrl = (version as { fileUrl?: unknown } | null)?.fileUrl;
      const sourceId = (version as { sourceDocumentVersionId?: unknown } | null)?.sourceDocumentVersionId;
      if (nonEmptyString(fileUrl)) {
        fileUrls.add(fileUrl);
      }
      if (nonEmptyString(sourceId)) {
        sourceVersionIds.add(sourceId);
      }
    }
  }
  return { fileUrls, sourceVersionIds };
}

/**
 * Ukazuje na soubor téhle revize některý výkres v Plánech?
 *
 * ⚠️ Povýšení revize do Plánů NEDĚLÁ kopii souboru — `PlanVersion.fileUrl` je
 * TÝŽ objekt jako `DocumentVersion.filePath`. Neznámý stav (`references === null`)
 * se proto záměrně počítá jako „ano": osiřelý blob je menší škoda než výkres na
 * stavbě, pod kterým zmizí PDF.
 */
export function isVersionFileUsedByPlan(
  references: PlanFileReferences | null,
  version: VersionRecord
): boolean {
  if (references === null) {
    return true;
  }
  if (nonEmptyString(version.id) && references.sourceVersionIds.has(version.id)) {
    return true;
  }
  return nonEmptyString(version.filePath) && references.fileUrls.has(version.filePath);
}

/**
 * Cesty k objektům revizí, které se OPRAVDU smějí smazat (ostatní drží Plány).
 * Odečet z počítadla se dělá i u ponechaných objektů — revize jako záznam
 * zmizela a bajty pod ní přebírají Plány. Podhodnocené počítadlo je bezpečný
 * směr, rozbitý výkres není.
 */
export function deletableVersionObjectPaths(
  references: PlanFileReferences | null,
  versions: readonly VersionRecord[]
): string[] {
  const paths: string[] = [];
  for (const version of versions) {
    if (isVersionFileUsedByPlan(references, version)) {
      continue;
    }
    paths.push(...versionStorageObjectPaths(version));
  }
  return paths;
}

/** Úbytek počítadla za smazané revize dokumentu (bajty + počet souborů). */
export function usageDeltaForVersions(versions: readonly VersionRecord[]): UsageDelta {
  const bytes = versions.reduce(
    (sum, version) => sum + numberOrZero(version.sizeBytes) + numberOrZero(version.thumbnailSizeBytes),
    0
  );
  return { storageBytes: -bytes, docCount: -versions.length };
}

/** Prázdná delta = nemá smysl posílat zápis. */
export function isEmptyUsageDelta(delta: UsageDelta): boolean {
  return !delta.storageBytes && !delta.photoCount && !delta.docCount;
}

// ── doběh ───────────────────────────────────────────────────────────────────

export interface SweepOptions {
  now?: Date;
  maxItems?: number;
  maxItemsPerCollection?: number;
  /** Kam se hlásí neúspěch jedné položky. Doběh kvůli ní nikdy nekončí. */
  onError?: (message: string, error: unknown) => void;
}

function emptySummary(): SweepSummary {
  return {
    scannedProjects: 0,
    purged: { task: 0, photo: 0, document: 0 },
    storageObjectsDeleted: 0,
    failures: 0,
    reachedLimit: false,
  };
}

/**
 * Uklidí vypršené položky koše napříč všemi projekty backendu.
 *
 * Pořadí u každé položky je ZÁMĚRNÉ: nejdřív zmizí ZÁZNAM, teprve pak objekt.
 * Kdyby se mazal první objekt a smazání záznamu selhalo, zůstala by v koši
 * položka s mrtvým souborem, kterou jde „obnovit" do rozbitého stavu. Opačně
 * vzniká v nejhorším osiřelý blob — a ten se aspoň zaloguje.
 *
 * NIKDY nevyhazuje kvůli jedné položce: úklid jednoho projektu nesmí zastavit
 * úklid ostatních.
 */
export async function sweepExpiredTrash(
  store: TrashStore,
  storage: TrashStorage,
  options: SweepOptions = {}
): Promise<SweepSummary> {
  const now = options.now ?? new Date();
  const maxItems = options.maxItems ?? SWEEP_MAX_ITEMS_PER_RUN;
  const perCollection = options.maxItemsPerCollection ?? SWEEP_MAX_ITEMS_PER_COLLECTION;
  const onError = options.onError ?? (() => undefined);
  const summary = emptySummary();

  let projects: ProjectRef[];
  try {
    projects = await store.listProjects();
  } catch (error) {
    onError("Seznam projektů se nepodařilo načíst — doběh koše se přeskočil.", error);
    summary.failures += 1;
    return summary;
  }

  let budget = maxItems;

  for (const project of projects) {
    if (budget <= 0) {
      summary.reachedLimit = true;
      break;
    }
    summary.scannedProjects += 1;

    let expired: ExpiredItem[];
    try {
      expired = await store.listExpired(project, now, Math.min(perCollection, budget));
    } catch (error) {
      onError(`Vypršené položky koše se nepodařilo načíst: ${project.workspaceId}/${project.projectId}`, error);
      summary.failures += 1;
      continue;
    }
    if (expired.length === 0) {
      continue;
    }

    // Plány se čtou JEDNOU na projekt, ne na revizi — a jen když je co mazat.
    let planReferences: PlanFileReferences | null = null;
    let planReferencesLoaded = false;

    for (const item of expired) {
      if (budget <= 0) {
        summary.reachedLimit = true;
        break;
      }
      try {
        if (item.type === "document") {
          if (!planReferencesLoaded) {
            planReferences = await store.listPlanFileReferences(project);
            planReferencesLoaded = true;
          }
          summary.storageObjectsDeleted += await purgeDocument(
            store,
            storage,
            project,
            item.id,
            planReferences
          );
        } else {
          summary.storageObjectsDeleted += await purgeSimpleItem(store, storage, project, item);
        }
        summary.purged[item.type] += 1;
        budget -= 1;
      } catch (error) {
        onError(
          `Vypršenou položku koše se nepodařilo smazat natrvalo: ${project.workspaceId}/${project.projectId}/${SWEPT_COLLECTIONS[item.type]}/${item.id}`,
          error
        );
        summary.failures += 1;
        budget -= 1;
      }
    }
  }

  return summary;
}

/** Úkol / fotka — jeden doc, u fotky navíc plná verze + miniatura ve Storage. */
async function purgeSimpleItem(
  store: TrashStore,
  storage: TrashStorage,
  project: ProjectRef,
  item: ExpiredItem
): Promise<number> {
  await store.deleteContentDoc(project, item.type, item.id);
  const deleted = await storage.deleteObjects(photoStorageObjectPaths(item.storagePath));
  if (item.type === "photo") {
    const delta: UsageDelta = { storageBytes: -numberOrZero(item.sizeBytes), photoCount: -1 };
    if (!isEmptyUsageDelta(delta)) {
      await store.addUsage(project, delta);
    }
  }
  return deleted;
}

/**
 * Dokument — kaskáda přes VŠECHNY revize (docy + soubory + odečet).
 * Plány povýšené z revizí se nemažou a jejich soubor zůstává (viz
 * `deletableVersionObjectPaths`), jinak by koš po 30 dnech hromadně vyprázdnil
 * PDF pod všemi výkresy, které z dokumentu vznikly.
 */
async function purgeDocument(
  store: TrashStore,
  storage: TrashStorage,
  project: ProjectRef,
  documentId: string,
  planReferences: PlanFileReferences | null
): Promise<number> {
  const versions = await store.listVersions(project, documentId);
  for (const version of versions) {
    await store.deleteVersionDoc(project, version.id);
  }
  await store.deleteContentDoc(project, "document", documentId);

  const deleted = await storage.deleteObjects(deletableVersionObjectPaths(planReferences, versions));

  const delta = usageDeltaForVersions(versions);
  if (!isEmptyUsageDelta(delta)) {
    await store.addUsage(project, delta);
  }
  return deleted;
}

// ── adaptéry nad admin SDK ──────────────────────────────────────────────────

/** Bucket, do kterého se mažou objekty. Jen ta část Storage, kterou doběh potřebuje. */
export interface AdminBucket {
  file(path: string): { delete(): Promise<unknown> };
}

/**
 * Datová vrstva nad admin SDK (obchází rules — doběh nemá uživatele).
 *
 * ⚠️ Dotaz na vypršené položky má DVĚ nerovnosti nad `purgeAt`. Ta spodní není
 * kosmetika: `restore()` zapisuje `purgeAt: null` a Firestore řadí `null` PŘED
 * všechny timestampy, takže samotné `purgeAt <= now` by vytáhlo i OBNOVENÉ
 * položky a doběh by je smazal. Druhá pojistka je kontrola typu níž.
 */
export function createFirestoreTrashStore(firestore: Firestore): TrashStore {
  const base = (project: ProjectRef) =>
    `workspaces/${project.workspaceId}/projects/${project.projectId}`;

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
      const items: ExpiredItem[] = [];
      for (const type of Object.keys(SWEPT_COLLECTIONS) as SweptType[]) {
        if (items.length >= limit) {
          break;
        }
        const snapshot = await firestore
          .collection(`${base(project)}/${SWEPT_COLLECTIONS[type]}`)
          .where("purgeAt", ">", new Date(0))
          .where("purgeAt", "<=", now)
          .limit(limit - items.length)
          .get();
        for (const doc of snapshot.docs) {
          const data = doc.data() ?? {};
          // Druhá pojistka: bez `deletedAt` položka v koši není, ať už v
          // `purgeAt` leží cokoli.
          if (!data.deletedAt) {
            continue;
          }
          items.push({
            type,
            id: doc.id,
            storagePath: typeof data.storagePath === "string" ? data.storagePath : undefined,
            sizeBytes:
              type === "photo"
                ? numberOrZero(data.sizeBytes) + numberOrZero(data.thumbnailSizeBytes)
                : undefined,
          });
        }
      }
      return items;
    },

    async listVersions(project, documentId) {
      const snapshot = await firestore
        .collection(`${base(project)}/documentVersions`)
        .where("documentId", "==", documentId)
        .get();
      return snapshot.docs.map((doc) => ({ ...(doc.data() ?? {}), id: doc.id }) as VersionRecord);
    },

    async listPlanFileReferences(project) {
      try {
        const snapshot = await firestore.collection(`${base(project)}/plans`).get();
        return collectPlanFileReferences(snapshot.docs.map((doc) => doc.data() as RawPlanDocument));
      } catch {
        // Neznámý stav → volající objekty revizí NEsmaže.
        return null;
      }
    },

    async deleteContentDoc(project, type, id) {
      await firestore.doc(`${base(project)}/${SWEPT_COLLECTIONS[type]}/${id}`).delete();
    },

    async deleteVersionDoc(project, versionId) {
      await firestore.doc(`${base(project)}/documentVersions/${versionId}`).delete();
    },

    async addUsage(project, delta) {
      const payload: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
      if (delta.storageBytes) {
        payload.storageBytes = FieldValue.increment(delta.storageBytes);
      }
      if (delta.photoCount) {
        payload.photoCount = FieldValue.increment(delta.photoCount);
      }
      if (delta.docCount) {
        payload.docCount = FieldValue.increment(delta.docCount);
      }
      await firestore.doc(`${base(project)}/usage/current`).set(payload, { merge: true });
    },
  };
}

/**
 * Mazání objektů. NIKDY nevyhazuje — smazání blobu je best-effort a nesmí
 * shodit smazání záznamu. Chybějící objekt (404) je normální stav: náhled
 * nemusel vzniknout, nebo se maže podruhé po dřívějším částečném úklidu.
 */
export function createBucketTrashStorage(
  bucket: AdminBucket,
  onError: (message: string, error: unknown) => void = () => undefined
): TrashStorage {
  return {
    async deleteObjects(paths) {
      const unique = Array.from(new Set(paths.filter(nonEmptyString)));
      let deleted = 0;
      for (const path of unique) {
        try {
          await bucket.file(path).delete();
          deleted += 1;
        } catch (error) {
          const code = (error as { code?: unknown } | null)?.code;
          if (code === 404) {
            continue;
          }
          onError(`Objekt ve Storage se nepodařilo smazat: ${path}`, error);
        }
      }
      return deleted;
    },
  };
}
