import { randomUUID } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";

/**
 * Serverové povýšení schválené revize výkresu do Plánů (#506, fáze 2).
 *
 * ⭐ PROČ SERVER. Do 8/2026 běželo povýšení v PROHLÍŽEČI schvalovatele
 * (`src/modules/documents/components/DocumentDetail.tsx` → `handlePromoteToPlan`).
 * Zápis do `plans` ale vyžaduje `canEditContent` (`firestore.rules`), takže
 * schvalovatel bez editačních práv (TDI, projektant) povýšení nedokončil —
 * a `src/services/plans.ts` chybu spolkla, plán uložila do localStorage
 * a UI ohlásilo „Výkres je v Plánech jako platná revize". Výkres přitom
 * existoval jen v jednom prohlížeči. Když povýšení dělá server (admin SDK
 * obchází rules), schvalovatel k `plans` žádné právo nepotřebuje a oprávnění
 * `certify` jde oddělit od `edit`.
 *
 * ⚠️ SOUBOR SE NEKOPÍRUJE. `PlanVersion.fileUrl` je TÝŽ objekt ve Storage jako
 * `DocumentVersion.filePath`. Na tom závisí mazání revizí — viz
 * `src/services/planFileReferences.ts`. Kdyby tahle funkce soubor kopírovala,
 * reference by přestaly sedět a mazání revize by pod výkresem odstřelilo PDF.
 *
 * ⭐ SDÍLENÝ SOUBOR. Musí být IDENTICKÝ v obou repech (viz docs/REPO_BOUNDARIES.md):
 *   hlavní repo `functions/src/planPromotion.ts`
 *   companion   `selfhost/functions/src/planPromotion.ts`
 * Trigger se registruje v tom Firebase projektu, který drží data workspace —
 * u self-hostu je to firemní projekt (companion), u hostovaného/staging
 * workspace centrální projekt (hlavní repo). Kdyby se soubory rozešly, povýšil
 * by se výkres jinak podle toho, kde firma hostuje.
 *
 * ⭐ TVAR ZÁPISU je záměrně 1:1 s `serializePlan()` v `src/services/plans.ts`
 * (data jako ISO řetězce, revize vnořené v poli, `undefined` se nezapisuje).
 * Klient plán čte `deserializePlan()`, takže jakýkoli rozdíl se projeví až
 * v UI. Změna tvaru na jedné straně = změna na obou.
 */

/** Stavy revize, ze kterých se povyšuje (finální kladné rozhodnutí). */
export const PROMOTABLE_VERSION_STATUSES = ["approved", "approved_with_comments"] as const;

export type PromotableVersionStatus = (typeof PROMOTABLE_VERSION_STATUSES)[number];

/** Stav povýšení zapsaný zpět na revizi — zdroj pravdy pro idempotenci i pro UI. */
export type PlanPromotionState = "promoted" | "skipped" | "failed";

export interface PlanPromotionMarker {
  status: PlanPromotionState;
  /** Id výkresu v Plánech (jen u `promoted`). */
  planId?: string;
  /** Id revize výkresu, která z téhle revize dokumentu vznikla. */
  planVersionId?: string;
  /** Strojový důvod u `skipped` / `failed` (viz PromotionSkipReason). */
  reason?: string;
  /** ISO čas posledního rozhodnutí. */
  at: string;
}

/** Revize dokumentu tak, jak leží ve Firestoru (jen pole, která povýšení čte). */
export interface SourceVersionRecord {
  id: string;
  documentId?: unknown;
  status?: unknown;
  filePath?: unknown;
  thumbnailUrl?: unknown;
  pageCount?: unknown;
  /**
   * Rozměr 1. strany v PDF jednotkách (scale 1), změřený klientem při příjmu
   * dokumentu. Server PDF neotevírá — tohle je jediný zdroj rozměru, který má.
   * Bez něj revize výkresu žádný rozměr nedostane a kontrola „nová revize je na
   * jinak velkém listu" (`src/components/plans/planRevisionCarry.ts`) rozhoduje
   * naslepo ve prospěch přenosu 1:1.
   */
  pageWidthUnits?: unknown;
  pageHeightUnits?: unknown;
  versionLabel?: unknown;
  uploadedBy?: unknown;
  uploadedAt?: unknown;
  documentCode?: unknown;
  scope?: unknown;
  planPromotion?: unknown;
}

/** Dokument, pod který revize patří. */
export interface SourceDocumentRecord {
  id: string;
  title?: unknown;
  discipline?: unknown;
  folderPath?: unknown;
  scope?: unknown;
}

/** Revize výkresu tak, jak ji do `plans` ukládá klient (`FirestorePlanVersion`). */
export interface StoredPlanVersion {
  id: string;
  planId: string;
  versionNumber: number;
  fileUrl?: string;
  fileName?: string;
  thumbnailUrl?: string;
  uploadedBy?: string;
  uploadedByName?: string;
  uploadedAt?: string;
  revisionLabel?: string;
  issueDate?: string;
  status?: string;
  sourceDocumentId?: string;
  sourceDocumentVersionId?: string;
  sourcePage?: number;
  createdAt: string;
  [extra: string]: unknown;
}

/** Výkres v Plánech tak, jak ho ukládá klient (`FirestorePlan`). */
export interface StoredPlan {
  id: string;
  projectId: string;
  name: string;
  folderPath?: string;
  documentCode?: string;
  kind?: string;
  status?: string;
  validVersionId?: string;
  currentVersionId: string;
  versions: StoredPlanVersion[];
  createdAt: string;
  updatedAt: string;
  [extra: string]: unknown;
}

export type PromotionSkipReason =
  /** Revize zmizela mezi eventem a transakcí. */
  | "version_missing"
  /** Revize mezitím opustila schválený stav (zamítnuta, superseded…). */
  | "version_not_approved"
  /** Dokument neexistuje nebo se ho nepodařilo přečíst. */
  | "document_missing"
  /** Není to výkres (`discipline !== "DRAWING"`). */
  | "not_a_drawing"
  /** Vícestránkové PDF — výběr stran dělá uživatel v dialogu, ne server. */
  | "not_single_page"
  /** Soubor není dostupný přes `http(s)` (interní brána, lokální blob…). */
  | "file_unavailable"
  /** Interní firemní dokument — nepatří do oficiálních Plánů projektu. */
  | "company_internal"
  /** Už povýšeno (marker na revizi) — druhé spuštění nesmí vyrobit druhý plán. */
  | "already_promoted";

export type PromotionDecision =
  | { kind: "skip"; reason: PromotionSkipReason; planId?: string; markSkip?: boolean }
  | { kind: "write"; created: boolean; plan: StoredPlan; planVersionId: string };

// ── malé pomocníky ───────────────────────────────────────────────────────────

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Rozměr strany dává smysl jen jako kladné konečné číslo. Nula/NaN/„595" jako
 * text se dál nepustí: poměr stran se z toho počítá dělením.
 */
function asPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Firestore drží datum jako Timestamp NEBO ISO řetězec — obojí na ISO. */
export function toIsoOrUndefined(value: unknown): string | undefined {
  if (!value) {
    return undefined;
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  }
  if (typeof value === "object" && "toDate" in value && typeof (value as { toDate: unknown }).toDate === "function") {
    const date = (value as { toDate: () => Date }).toDate();
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return undefined;
}

/**
 * Zahodí `undefined` klíče — Firestore je odmítá a klient je taky nezapisuje
 * (`stripUndefinedDeep` v `src/services/plans.ts`). Bez tohohle by se plán
 * uložený serverem lišil od plánu uloženého klientem.
 */
export function stripUndefinedDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefinedDeep(item)) as unknown as T;
  }
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, stripUndefinedDeep(entry)])
    ) as unknown as T;
  }
  return value;
}

/** Porovnání názvů 1:1 s klientem (`trim().toLowerCase()`). */
export function samePlanName(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function isPromotableStatus(value: unknown): value is PromotableVersionStatus {
  return typeof value === "string" && (PROMOTABLE_VERSION_STATUSES as readonly string[]).includes(value);
}

/**
 * Pustit trigger dál?
 *
 * Podmínkou je ZMĚNA stavu do schváleného. To je zároveň pojistka proti smyčce:
 * funkce si na revizi zapisuje marker `planPromotion`, čímž trigger spustí
 * podruhé — ale ten už vidí `before.status === after.status` a hned skončí.
 */
export function isApprovalTransition(beforeStatus: unknown, afterStatus: unknown): boolean {
  if (!isPromotableStatus(afterStatus)) {
    return false;
  }
  return beforeStatus !== afterStatus;
}

/** Přečte marker z revize; cokoli jiného než objekt se bere jako „bez markeru". */
export function readPromotionMarker(value: unknown): PlanPromotionMarker | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const status = (value as { status?: unknown }).status;
  if (status !== "promoted" && status !== "skipped" && status !== "failed") {
    return null;
  }
  return {
    status,
    planId: asString((value as { planId?: unknown }).planId),
    planVersionId: asString((value as { planVersionId?: unknown }).planVersionId),
    reason: asString((value as { reason?: unknown }).reason),
    at: asString((value as { at?: unknown }).at) ?? new Date(0).toISOString(),
  };
}

// ── rozhodovací jádro (čisté, bez Firestoru → testovatelné) ──────────────────

export interface DecidePromotionInput {
  version: SourceVersionRecord | null;
  document: SourceDocumentRecord | null;
  /** Všechny výkresy projektu (`plans` subkolekce), tak jak leží ve Firestoru. */
  plans: StoredPlan[];
  /** Zobrazované jméno nahrávajícího z adresáře členů; smí chybět. */
  uploadedByName?: string;
  now: Date;
  /** Injektovatelný generátor id — v testech deterministický. */
  newId?: () => string;
}

/**
 * Rozhodne, co se má stát. Nic nezapisuje.
 *
 * Podmínky jsou ZÁMĚRNĚ tytéž, které měl klient v `DocumentDetail.tsx`:
 * výkres (`discipline === "DRAWING"`), jedna strana (`pageCount === 1`)
 * a dostupný soubor (`filePath` začíná na `http`). Cílem téhle změny je přesun
 * vykonavatele, ne změna chování.
 */
export function decidePromotion(input: DecidePromotionInput): PromotionDecision {
  const { version, document, plans, now } = input;
  const newId = input.newId ?? (() => randomUUID());

  if (!version) {
    return { kind: "skip", reason: "version_missing" };
  }

  // Marker má přednost před vším ostatním — tohle je zámek idempotence.
  const marker = readPromotionMarker(version.planPromotion);
  if (marker?.status === "promoted") {
    return { kind: "skip", reason: "already_promoted", planId: marker.planId };
  }

  if (!isPromotableStatus(version.status)) {
    return { kind: "skip", reason: "version_not_approved" };
  }
  if (!document) {
    return { kind: "skip", reason: "document_missing" };
  }
  if (document.discipline !== "DRAWING") {
    return { kind: "skip", reason: "not_a_drawing" };
  }
  // Vícestránkové PDF potřebuje výběr stran od člověka (promotion dialog),
  // server ho neumí vymyslet. Chybějící pageCount = neověřeno → nepovyšovat.
  if (typeof version.pageCount !== "number" || version.pageCount !== 1) {
    return { kind: "skip", reason: "not_single_page" };
  }
  // Interní firemní dokumenty mají vlastní registr pod `companySpaces/`;
  // do oficiálních Plánů projektu nepatří.
  if (version.scope === "company_internal" || document.scope === "company_internal") {
    return { kind: "skip", reason: "company_internal", markSkip: true };
  }

  const fileUrl = asString(version.filePath);
  if (!fileUrl || !fileUrl.startsWith("http")) {
    // Uživatel tohle musí vidět — proto marker (UI si na něj sáhne).
    return { kind: "skip", reason: "file_unavailable", markSkip: true };
  }

  const planName = asString(document.title) ?? "Bez názvu";
  const nowIso = now.toISOString();
  const matched = plans.find((plan) => samePlanName(asString(plan.name) ?? "", planName));

  const shared = {
    fileUrl,
    fileName: `${planName}.pdf`,
    thumbnailUrl: asString(version.thumbnailUrl),
    uploadedBy: asString(version.uploadedBy),
    uploadedByName: input.uploadedByName,
    uploadedAt: toIsoOrUndefined(version.uploadedAt),
    revisionLabel: asString(version.versionLabel),
    sourceDocumentId: asString(document.id),
    sourceDocumentVersionId: version.id,
    // Povyšuje se jen jednostránková revize (viz kontrola `pageCount === 1`
    // výše), takže změřená 1. strana JE ta povyšovaná.
    widthUnits: asPositiveNumber(version.pageWidthUnits),
    heightUnits: asPositiveNumber(version.pageHeightUnits),
  };

  if (!matched) {
    const planId = newId();
    const planVersion = buildPlanVersion(planId, 1, nowIso, newId(), shared);
    const plan: StoredPlan = {
      id: planId,
      projectId: "", // doplní volající (zná cestu); drží se tvar klienta
      name: planName,
      folderPath: asString(document.folderPath),
      documentCode: asString(version.documentCode),
      kind: "plan",
      status: "approved",
      validVersionId: planVersion.id,
      currentVersionId: planVersion.id,
      versions: [planVersion],
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    return { kind: "write", created: true, plan, planVersionId: planVersion.id };
  }

  // Plán existuje. Nejdřív: nevznikla tahle revize výkresu už dřív (starým
  // klientským povýšením, které marker neuměl)? Pak jen znovu ukotvíme
  // platnou revizi a doplníme marker — žádná duplicitní revize nepřibude.
  const existingVersions = Array.isArray(matched.versions) ? matched.versions : [];
  const alreadyPromoted = existingVersions.find((planVersion) => {
    const samePage = (planVersion.sourcePage ?? 1) === 1;
    const sameSource = planVersion.sourceDocumentVersionId
      ? planVersion.sourceDocumentVersionId === version.id
      : true;
    return planVersion.fileUrl === fileUrl && samePage && sameSource;
  });

  if (alreadyPromoted) {
    const plan: StoredPlan = {
      ...matched,
      validVersionId: alreadyPromoted.id,
      currentVersionId: alreadyPromoted.id,
      updatedAt: nowIso,
    };
    return { kind: "write", created: false, plan, planVersionId: alreadyPromoted.id };
  }

  const versionNumber =
    Math.max(0, ...existingVersions.map((planVersion) => Number(planVersion.versionNumber) || 0)) + 1;
  const planVersion = buildPlanVersion(matched.id, versionNumber, nowIso, newId(), shared);
  const plan: StoredPlan = {
    ...matched,
    documentCode: asString(matched.documentCode) ?? asString(version.documentCode),
    versions: [
      ...existingVersions.map((existing) => ({
        ...existing,
        status:
          existing.status === "approved" || existing.status === "issued" ? "superseded" : existing.status,
      })),
      planVersion,
    ],
    validVersionId: planVersion.id,
    currentVersionId: planVersion.id,
    status: "approved",
    updatedAt: nowIso,
  };
  return { kind: "write", created: false, plan, planVersionId: planVersion.id };
}

function buildPlanVersion(
  planId: string,
  versionNumber: number,
  nowIso: string,
  versionId: string,
  shared: {
    fileUrl: string;
    fileName: string;
    thumbnailUrl?: string;
    uploadedBy?: string;
    uploadedByName?: string;
    uploadedAt?: string;
    revisionLabel?: string;
    sourceDocumentId?: string;
    sourceDocumentVersionId: string;
    widthUnits?: number;
    heightUnits?: number;
  }
): StoredPlanVersion {
  return {
    id: versionId,
    planId,
    versionNumber,
    // ⚠️ TÝŽ objekt ve Storage jako `DocumentVersion.filePath` — žádná kopie.
    fileUrl: shared.fileUrl,
    fileName: shared.fileName,
    thumbnailUrl: shared.thumbnailUrl,
    uploadedBy: shared.uploadedBy,
    uploadedByName: shared.uploadedByName,
    uploadedAt: shared.uploadedAt,
    revisionLabel: shared.revisionLabel || `R${String(versionNumber).padStart(2, "0")}`,
    issueDate: nowIso,
    status: "approved",
    sourceDocumentId: shared.sourceDocumentId,
    sourceDocumentVersionId: shared.sourceDocumentVersionId,
    widthUnits: shared.widthUnits,
    heightUnits: shared.heightUnits,
    createdAt: nowIso,
  };
}

// ── zápisová vrstva (Firestore admin SDK, obchází rules) ─────────────────────

export interface PromoteParams {
  workspaceId: string;
  projectId: string;
  versionId: string;
  now?: Date;
}

export interface PromoteResult {
  outcome: "promoted" | "revalidated" | "skipped";
  reason?: PromotionSkipReason;
  planId?: string;
  planVersionId?: string;
}

function projectBase(workspaceId: string, projectId: string) {
  return `workspaces/${workspaceId}/projects/${projectId}`;
}

/**
 * Povýší schválenou revizi do Plánů. Idempotentní.
 *
 * Idempotenci drží JEDNA transakce, která revizi nejdřív PŘEČTE a nakonec na ni
 * ZAPÍŠE marker: druhé souběžné spuštění (Firestore trigger doručuje
 * at-least-once) narazí na konflikt nad týmž dokumentem, transakce se zopakuje,
 * uvidí marker `promoted` a skončí bez zápisu. Proto se marker píše i u plánu,
 * který zakládáme — bez něj by dvě doručení vyrobila dva výkresy.
 */
export async function promoteApprovedDrawing(
  firestore: Firestore,
  params: PromoteParams
): Promise<PromoteResult> {
  const base = projectBase(params.workspaceId, params.projectId);
  const versionRef = firestore.doc(`${base}/documentVersions/${params.versionId}`);
  const now = params.now ?? new Date();

  return firestore.runTransaction(async (transaction) => {
    const versionSnapshot = await transaction.get(versionRef);
    if (!versionSnapshot.exists) {
      return { outcome: "skipped", reason: "version_missing" } as PromoteResult;
    }
    const versionData = versionSnapshot.data() ?? {};
    const version: SourceVersionRecord = { ...versionData, id: versionSnapshot.id };

    const documentId = asString(version.documentId);
    const documentSnapshot = documentId
      ? await transaction.get(firestore.doc(`${base}/documents/${documentId}`))
      : null;
    const document: SourceDocumentRecord | null =
      documentSnapshot && documentSnapshot.exists
        ? { ...(documentSnapshot.data() ?? {}), id: documentSnapshot.id }
        : null;

    // Levné předfiltry PŘED čtením celé kolekce plánů — u dokumentu, který není
    // jednostránkový výkres, se nesmí platit čtení celého registru výkresů.
    // Žádný z důvodů odmítnutí na `plans` nezávisí, takže je bezpečné rozhodnout
    // tady a kolekci vůbec nečíst.
    const preflight = decidePromotion({ version, document, plans: [], now });
    if (preflight.kind === "skip") {
      if (preflight.markSkip) {
        transaction.set(
          versionRef,
          { planPromotion: { status: "skipped", reason: preflight.reason, at: now.toISOString() } },
          { merge: true }
        );
      }
      return { outcome: "skipped", reason: preflight.reason, planId: preflight.planId } as PromoteResult;
    }

    const uploadedBy = asString(version.uploadedBy);
    const memberSnapshot = uploadedBy
      ? await transaction.get(firestore.doc(`${base}/members/${uploadedBy}`))
      : null;
    const uploadedByName =
      memberSnapshot && memberSnapshot.exists
        ? asString((memberSnapshot.data() ?? {}).displayName)
        : undefined;

    const plansSnapshot = await transaction.get(firestore.collection(`${base}/plans`));
    const plans: StoredPlan[] = plansSnapshot.docs.map(
      (planDoc) => ({ ...(planDoc.data() as StoredPlan), id: planDoc.id })
    );

    const decision = decidePromotion({ version, document, plans, uploadedByName, now });
    if (decision.kind === "skip") {
      if (decision.markSkip) {
        transaction.set(
          versionRef,
          { planPromotion: { status: "skipped", reason: decision.reason, at: now.toISOString() } },
          { merge: true }
        );
      }
      return { outcome: "skipped", reason: decision.reason, planId: decision.planId } as PromoteResult;
    }

    const plan: StoredPlan = { ...decision.plan, projectId: params.projectId };
    transaction.set(firestore.doc(`${base}/plans/${plan.id}`), stripUndefinedDeep(plan));
    transaction.set(
      versionRef,
      {
        planPromotion: stripUndefinedDeep({
          status: "promoted" as const,
          planId: plan.id,
          planVersionId: decision.planVersionId,
          at: now.toISOString(),
        }),
      },
      { merge: true }
    );

    return {
      outcome: decision.created ? "promoted" : "revalidated",
      planId: plan.id,
      planVersionId: decision.planVersionId,
    } as PromoteResult;
  });
}
