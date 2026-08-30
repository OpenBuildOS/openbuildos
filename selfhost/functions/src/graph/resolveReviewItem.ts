import type { GraphNodeRef, ReviewItem } from "./graphContract";

/**
 * `resolveReviewItem` — Fáze 2b projektového grafu (`docs/specs/projektovy-graf.md`
 * §3.5): jediná cesta, kudy se `ReviewItem` mění ze `pending` na finální stav.
 * Klient nemá na `reviewItems` `allow update` (viz `firestore.rules`), takže
 * VŠECHNA rozhodnutí (potvrzení, oprava, zamítnutí) jdou přes tenhle modul
 * a tenký `onCall` wrapper v `index.ts` obou repů.
 *
 * ⭐ ČISTÁ FUNKCE + TENKÝ WRAPPER, stejný vzor jako `graph/taskGraphEvents.ts`:
 * `planReviewResolution` nemá žádnou závislost na `firebase-admin` — jde
 * testovat bez emulátoru (viz `resolveReviewItem.test.ts`). Wrapper v `index.ts`
 * čte `reviewItems/{itemId}` a případnou cílovou entitu v JEDNÉ transakci
 * (Firestore transakce vyžaduje všechna `get()` PŘED prvním zápisem), zavolá
 * tuhle funkci a zapíše, co vrátí.
 *
 * ⭐ SDÍLENÝ SOUBOR. Musí být BYTE IDENTICKÝ v obou repech (viz
 * `docs/REPO_BOUNDARIES.md` Háček 1):
 *   hlavní repo `functions/src/graph/resolveReviewItem.ts`
 *   companion   `selfhost/functions/src/graph/resolveReviewItem.ts`
 * Review item žije v tom Firebase projektu, který drží data workspace — u
 * self-hostu firemní projekt (companion), u hostovaného/staging workspace
 * centrální projekt (hlavní repo). Kdyby se soubory rozešly, stejný návrh by
 * self-host firma a hostovaný zákazník mohli vyřešit JINAK.
 *
 * ⚠️ `at` v `resolutionPatch.resolution` je ISO řetězec z parametru `nowIso`,
 * NE hodnota, která se nakonec zapíše do Firestoru. Wrapper při zápisu pole
 * `resolution.at` PŘEPÍŠE na `FieldValue.serverTimestamp()` (serverový čas
 * commitu, ne klientovy/funkce hodiny) — `nowIso` slouží jen k tomu, aby tahle
 * čistá funkce mohla vrátit hotovou odpověď volajícímu HNED, bez čekání na
 * snapshot listener. Stejné rozdělení jako `occurredAt`/`committedAt`
 * v `taskGraphEvents.ts`.
 *
 * ⚠️ v1 podporuje JEDINOU kombinaci cíl×pole: `document_version.discipline`.
 * `entityPatch` míří na RODIČOVSKÝ dokument (`documents/{documentId}`), ne na
 * verzi samotnou — klasifikace (`discipline`) je vlastnost DOKUMENTU napříč
 * jeho revizemi (viz `src/modules/documents/types/document.ts`), ne jedné
 * konkrétní verze. Cokoli jiného je „poctivé odmítnutí" (`unsupported_field`),
 * ne tichý úspěch, který by se nikde neprojevil.
 */

// ---------------------------------------------------------------------------
// Vstup
// ---------------------------------------------------------------------------

export type ReviewResolutionAction = "confirmed" | "rejected";

// ---------------------------------------------------------------------------
// Výstup
// ---------------------------------------------------------------------------

export type ReviewResolutionErrorCode = "unknown_field" | "unsupported_field" | "unsupported_payload";

export interface ReviewResolutionError {
  code: ReviewResolutionErrorCode;
  message: string;
}

/** Finální stav položky — nikdy `pending`/`expired` (ty sem nevedou). */
export type ReviewResolutionStatus = "confirmed" | "corrected" | "rejected";

export interface ReviewResolutionPatch {
  status: ReviewResolutionStatus;
  resolution: {
    by: string;
    /** ISO řetězec — viz poznámka o `nowIso` v hlavičce souboru. */
    at: string;
    /** Cílová entita, na kterou `entityPatch` reálně mířil (jen když nějaký je). */
    applied?: GraphNodeRef;
    /** Pairing (`entity_draft`) zamítnutý jako špatné párování — náprava mimo rozsah 2b. */
    note?: "pairing_disputed";
  };
}

/** Zápis do cílové entity — `null`, když se nic neaplikuje (zamítnutí, pairing, prázdné pole). */
export interface ReviewEntityPatch {
  collectionPath: string;
  docId: string;
  fields: Record<string, unknown>;
}

export type PlanReviewResolutionResult =
  | { kind: "already_resolved" }
  | { kind: "error"; error: ReviewResolutionError }
  | {
      kind: "resolved";
      resolutionPatch: ReviewResolutionPatch;
      entityPatch: ReviewEntityPatch | null;
      finalStatus: ReviewResolutionStatus;
    };

// ---------------------------------------------------------------------------
// v1 mapa podporovaných cílů pro `field_values`
// ---------------------------------------------------------------------------

interface SupportedFieldTarget {
  collectionPath: string;
  docId: string;
  applied: GraphNodeRef;
}

/**
 * Jediná podporovaná kombinace v1 (viz hlavička souboru): `document_version`
 * + pole `discipline` → rodičovský `documents/{documentId}`. Vrací `null` pro
 * cokoli jiného, volající si z toho postaví `unsupported_field`.
 */
function supportedFieldTarget(target: GraphNodeRef, field: string): SupportedFieldTarget | null {
  if (target.type !== "document_version" || field !== "discipline") {
    return null;
  }
  return {
    collectionPath: `workspaces/${target.wid}/projects/${target.pid}/documents`,
    docId: target.documentId,
    applied: { wid: target.wid, pid: target.pid, type: "document", documentId: target.documentId },
  };
}

function unsupportedFieldError(field: string, target: GraphNodeRef): PlanReviewResolutionResult {
  return {
    kind: "error",
    error: {
      code: "unsupported_field",
      message: `Pole "${field}" na cíli typu "${target.type}" nejde ve Fázi 2b aplikovat.`,
    },
  };
}

function unknownFieldError(field: string): PlanReviewResolutionResult {
  return {
    kind: "error",
    error: {
      code: "unknown_field",
      message: `ReviewItem pole "${field}" nenavrhuje — nejde ho opravit.`,
    },
  };
}

// ---------------------------------------------------------------------------
// payload.kind === "field_values"
// ---------------------------------------------------------------------------

function planFieldValuesResolution(
  target: GraphNodeRef,
  payload: Extract<ReviewItem["payload"], { kind: "field_values" }>,
  corrections: Record<string, unknown> | undefined,
  finalStatus: ReviewResolutionStatus,
  principal: string,
  nowIso: string
): PlanReviewResolutionResult {
  const isCorrected = corrections !== undefined;
  const entries: Array<[string, unknown]> = isCorrected
    ? Object.entries(corrections)
    : Object.entries(payload.fields).map(([key, attributed]) => [key, attributed.value]);

  // Korekce smí měnit jen pole, která ReviewItem sám navrhl — cizí klíč je
  // chyba dřív, než se vůbec řeší, jestli je podporovaný (§3.5).
  if (isCorrected) {
    for (const [key] of entries) {
      if (!(key in payload.fields)) {
        return unknownFieldError(key);
      }
    }
  }

  const fields: Record<string, unknown> = {};
  let resolvedTarget: SupportedFieldTarget | null = null;
  for (const [key, value] of entries) {
    const supported = supportedFieldTarget(target, key);
    if (!supported) {
      return unsupportedFieldError(key, target);
    }
    resolvedTarget = supported;
    fields[key] = value;
  }

  const entityPatch: ReviewEntityPatch | null =
    resolvedTarget && Object.keys(fields).length > 0
      ? { collectionPath: resolvedTarget.collectionPath, docId: resolvedTarget.docId, fields }
      : null;

  return {
    kind: "resolved",
    resolutionPatch: {
      status: finalStatus,
      resolution: {
        by: principal,
        at: nowIso,
        ...(entityPatch && resolvedTarget ? { applied: resolvedTarget.applied } : {}),
      },
    },
    entityPatch,
    finalStatus,
  };
}

// ---------------------------------------------------------------------------
// Hlavní rozhodovací funkce
// ---------------------------------------------------------------------------

/**
 * Naplánuje rozhodnutí o jednom `ReviewItem` (§3.5). Čistá, bez I/O — wrapper
 * v `index.ts` výsledek zapíše v transakci.
 *
 * - `item.status !== "pending"` → `{ kind: "already_resolved" }` (item už byl
 *   vyřešený, opakované volání je no-op, ne chyba — idempotence).
 * - `action === "rejected"` → nikdy žádný `entityPatch`; u `entity_draft`
 *   (párování) se navíc do `resolution.note` zapíše `"pairing_disputed"`
 *   (párování bylo špatně — NÁPRAVA je mimo rozsah 2b).
 * - `action === "confirmed"` s `corrections` → finální stav `"corrected"`,
 *   aplikují se HODNOTY z `corrections`, jen pro klíče, které `payload.fields`
 *   navrhuje (cizí klíč → `unknown_field`).
 * - `action === "confirmed"` bez `corrections` → finální stav `"confirmed"`,
 *   aplikují se `payload.fields[*].value`.
 * - `payload.kind === "entity_draft"` → žádný `entityPatch`, jen audit
 *   rozhodnutí (§3.5 — pairing draft se v 2b nematerializuje).
 * - `payload.kind === "edge_proposal"` s `action === "confirmed"` →
 *   `unsupported_payload` (producent hran zatím neexistuje). Zamítnutí
 *   takového návrhu projde normálně (zamítnutí nic nematerializuje).
 * - `payload.kind === "field_values"` mimo podporovanou kombinaci
 *   (`document_version.discipline`) → `unsupported_field`.
 */
export function planReviewResolution(
  item: ReviewItem,
  action: ReviewResolutionAction,
  corrections: Record<string, unknown> | undefined,
  principal: string,
  nowIso: string
): PlanReviewResolutionResult {
  if (item.status !== "pending") {
    return { kind: "already_resolved" };
  }

  if (action === "rejected") {
    const note = item.payload.kind === "entity_draft" ? ("pairing_disputed" as const) : undefined;
    return {
      kind: "resolved",
      resolutionPatch: {
        status: "rejected",
        resolution: { by: principal, at: nowIso, ...(note ? { note } : {}) },
      },
      entityPatch: null,
      finalStatus: "rejected",
    };
  }

  // action === "confirmed"
  const finalStatus: ReviewResolutionStatus = corrections !== undefined ? "corrected" : "confirmed";

  switch (item.payload.kind) {
    case "entity_draft":
      // Pairing se v 2b nematerializuje ani při potvrzení — potvrzení jen
      // stvrzuje, že párování bylo správné (audit), nezakládá žádnou hranu.
      return {
        kind: "resolved",
        resolutionPatch: { status: finalStatus, resolution: { by: principal, at: nowIso } },
        entityPatch: null,
        finalStatus,
      };
    case "edge_proposal":
      return {
        kind: "error",
        error: {
          code: "unsupported_payload",
          message: 'ReviewItem s payload.kind "edge_proposal" zatím nejde potvrdit — producent hran ještě neexistuje.',
        },
      };
    case "field_values":
      return planFieldValuesResolution(item.target, item.payload, corrections, finalStatus, principal, nowIso);
    default: {
      const exhaustive: never = item.payload;
      throw new Error(`planReviewResolution: neznámý payload.kind ${(exhaustive as { kind: string }).kind}`);
    }
  }
}
