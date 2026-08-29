/**
 * Kanonický kontrakt projektového grafu — čisté typy a čisté funkce.
 *
 * Zdroj pravdy: `docs/specs/projektovy-graf.md` §3. Tenhle soubor má BYTE
 * IDENTICKÉ zrcadlo na `functions/src/graph/graphContract.ts` (hlídá
 * `scripts/check-graph-contract.mjs`, zapojený v `npm run check` i CI) —
 * appka a Cloud Functions musí vidět tentýž tvar dat. Proto tu záměrně NENÍ
 * žádný import z firebase, react ani jiného runtime balíčku: jen typy
 * a deterministické funkce nad nimi.
 *
 * Kdo mění tenhle soubor, musí stejnou změnu udělat i ve zrcadle — kontrola
 * to ohlídá, ale needěla to za vás.
 */

// ---------------------------------------------------------------------------
// Timestamp
// ---------------------------------------------------------------------------

/**
 * Strukturální náhrada za Firestore `Timestamp` — vyhovuje jak client SDK,
 * tak Admin SDK instanci (obě mají `seconds`/`nanoseconds`), aniž by tenhle
 * soubor musel jeden z balíčků importovat.
 */
export interface TimestampLike {
  seconds: number;
  nanoseconds: number;
}

/** ISO datum (bez času) — pro rozsahy plánování v `schedule_changed` a plánech. */
export interface DateRange {
  startDate?: string;
  endDate?: string;
}

// ---------------------------------------------------------------------------
// 3.1 Reference na uzel
// ---------------------------------------------------------------------------

export interface RefBase {
  wid: string; // workspace
  pid: string; // projekt; cross-project reference jsou zakázané (firemní vrstva #695)
}

/**
 * Diskriminovaný union podle `type` — jeden měkký tvar `{type, id}` nestačí,
 * protože embedded entity (subtask, chunk, plan_version…) potřebují víc než
 * jedno identifikační pole. Verzované typy mají `versionId` povinné přímo
 * v typu, ne volitelné na obecném tvaru, aby to vynucoval kompilátor (P3).
 *
 * `floor`/`building` jsou odvozené skupiny (`floorKey`/`buildingKey` =
 * `normalizeFloorKey()`), nikdy nepředstírají identitu místnosti.
 *
 * Fáze 4+ (rezervováno, zatím mimo union — přibývají s funkcemi, které je
 * zakládají): message, gantt_dependency, gantt_condition, protocol, defect,
 * knowledge_entry, need, rfi, change_request.
 */
export type GraphNodeRef =
  | (RefBase & { type: "task"; taskId: string })
  | (RefBase & { type: "subtask"; taskId: string; checklistItemId: string })
  | (RefBase & { type: "comment"; taskId: string; commentId: string })
  | (RefBase & { type: "plan"; planId: string })
  | (RefBase & { type: "plan_version"; planId: string; versionId: string; page?: number })
  | (RefBase & { type: "document"; documentId: string })
  | (RefBase & { type: "document_version"; documentId: string; versionId: string; page?: number })
  | (RefBase & { type: "photo"; photoId: string })
  | (RefBase & { type: "photo_pin"; pinId: string })
  | (RefBase & { type: "annotation"; annotationId: string })
  | (RefBase & { type: "chunk"; documentId: string; versionId: string; chunkId: string })
  | (RefBase & { type: "location"; roomOrZoneId: string })
  | (RefBase & { type: "floor"; floorKey: string })
  | (RefBase & { type: "building"; buildingKey: string })
  | (RefBase & { type: "person"; principal: string })
  | (RefBase & { type: "company"; companyId: string })
  | (RefBase & { type: "diary_entry"; entryId: string })
  | (RefBase & { type: "voice_note"; noteId: string });

// ---------------------------------------------------------------------------
// 3.2 Provenience a atributy
// ---------------------------------------------------------------------------

/** Diskrétní rubrika jistoty — nikdy libovolné procento. */
export type Confidence = 0.95 | 0.85 | 0.75 | 0.65 | 0.55 | 0.3;

/** Pod tímto prahem se odvozený údaj nikdy neaplikuje přímo, jen nabízí (§3.2, §3.3). */
export const SUGGEST_ONLY_THRESHOLD = 0.75;

const CONFIDENCE_VALUES: ReadonlySet<Confidence> = new Set([0.95, 0.85, 0.75, 0.65, 0.55, 0.3]);

/** Runtime kontrola rubriky — typ `Confidence` sám o sobě nezaručí platnou hodnotu za běhu. */
function isValidConfidence(value: number): value is Confidence {
  return CONFIDENCE_VALUES.has(value as Confidence);
}

/**
 * Doslovný úryvek nebo odkaz, ze kterého odvozený údaj vzniknul. `ai_*` bez
 * evidence se zahazuje (pravidlo z denního zápisu povýšené na celou vrstvu).
 */
export interface Evidence {
  quote?: string; // doslovný úryvek, ověřitelný substring testem
  ref?: GraphNodeRef; // zdrojový uzel (zpráva, verze+strana, chunk)
  chunkId?: string;
  charRange?: [number, number];
  sourceHash?: string; // hash normalizovaného chunku — evidence přežije novou extrakci/OCR
}

/**
 * Jeden tvar pro všechny odvozené údaje (§3.2) — sjednocuje čtyři dnešní
 * varianty (denní zápis, CDE intake, command-center, graphify).
 */
export type Provenance =
  | { kind: "human"; by: string; at: TimestampLike } // tier extracted, 1.0
  | { kind: "system_fk" } // tier extracted, 1.0
  | {
      kind: "heuristic"; // parser názvu, razítko…
      rule: string;
      confidence: Confidence;
      evidence: Evidence;
    }
  | {
      kind: "ai_extraction";
      model: string;
      promptVersion: string;
      confidence: Confidence;
      evidence: Evidence;
    }
  | {
      kind: "ai_semantic";
      model: string;
      embeddingVersion: string;
      confidence: Confidence;
      evidence?: Evidence; // výjimka: evidencí je dvojice porovnaných uzlů
    }
  | { kind: "system_context"; from: GraphNodeRef }; // kontext obrazovky (#783) — nikdy do diktátu

/** Hodnota s viditelnou provenience a nepřepisujícím potvrzením. */
export interface Attributed<T> {
  value: T;
  provenance: Provenance;
  confirmation?: {
    by: string;
    at: TimestampLike;
    action: "confirmed" | "corrected";
  };
}

// ---------------------------------------------------------------------------
// 3.3 Hrany
// ---------------------------------------------------------------------------

export type GraphEdgeType =
  // extracted (odvozené z FK, směr from→to, nepersistované — skládá je vrstva A)
  | "located_in" // task|photo|diary_entry → location ; 1:1
  | "pinned_on" // task|photo|photo_pin|annotation → plan_version ; N:1
  | "in_context_of" // photo_pin → task|plan ; N:1
  | "attached_to" // photo|document → task ; N:M
  | "supersedes" // document_version → document_version ; 1:1
  | "sourced_from" // plan_version → document_version ; 1:1
  | "merged_from" // diary_entry → voice_note ; 1:N
  | "mentions" // comment → person ; N:M
  | "part_of" // subtask → task ; N:1
  | "assigned_to" // task → person ; 1:1
  | "member_of" // person → company ; N:M
  // inferred/ambiguous (vždy přes ReviewItem, po potvrzení materializované)
  | "refers_to" // message|voice_note → task|location|document_version
  | "similar_to" // task ↔ task, document_version ↔ document_version — symetrická
  | "maybe_belongs_to" // photo → task
  | "answers"; // message → message|comment

export interface GraphEdge {
  type: GraphEdgeType;
  from: GraphNodeRef;
  to: GraphNodeRef;
  provenance: Provenance;
}

// ---------------------------------------------------------------------------
// 3.4 Append-only události (graphEvents)
// ---------------------------------------------------------------------------

export interface GraphEventBase {
  schemaVersion: 1;
  eventId: string; // deterministické: z Functions trigger event ID
  entity: GraphNodeRef;
  entityRev: number; // updateTime zdrojového dokumentu (µs) — per entita monotónní
  actor: string; // updatedByUserId; bez metadat → "unknown"
  occurredAt: TimestampLike; // updatedAt z dat (offline zápis)
  committedAt: TimestampLike; // serverový čas zápisu eventu
  vis: SecurityEnvelope;
}

export type GraphEvent = GraphEventBase &
  (
    | { action: "created" }
    | { action: "status_changed"; fromStatusId: string; toStatusId: string }
    | { action: "assigned"; fromPrincipal?: string; toPrincipal?: string }
    | { action: "schedule_changed"; from?: DateRange; to?: DateRange }
    | { action: "linked" | "unlinked"; edge: GraphEdge }
    | { action: "version_added"; versionRef: GraphNodeRef }
    | { action: "confirmed" | "rejected"; reviewItemId: string }
    // lifecycle — bez nich zůstanou po smazání jen díry (§4.6)
    | { action: "deleted"; tombstone: { label: string } }
    | { action: "restored" }
    | { action: "renamed"; fromLabel: string; toLabel: string }
    | { action: "merged_into"; canonicalRef: GraphNodeRef }
    | { action: "scope_changed"; fromScope: string; toScope: string }
    | { action: "redacted"; fields: string[] } // GDPR (§7)
  );

// ---------------------------------------------------------------------------
// 3.5 ReviewItem — jedna potvrzovací mechanika
// ---------------------------------------------------------------------------

export interface ReviewItem {
  schemaVersion: 1;
  source: "voice" | "message" | "doc_classification" | "pairing" | "ai_edge" | "ai_tag";
  target: GraphNodeRef; // čeho se návrh týká
  payload:
    | { kind: "field_values"; fields: Record<string, Attributed<unknown>> }
    | { kind: "edge_proposal"; edge: GraphEdge; alternatives?: GraphEdge[] }
    | { kind: "entity_draft"; draft: unknown }; // typ dle target.type
  status: "pending" | "confirmed" | "corrected" | "rejected" | "expired";
  resolution?: { by: string; at: TimestampLike; applied?: GraphNodeRef };
  reviewers: string[] | "target_editors";
  createdAt: TimestampLike;
  expiresAt?: TimestampLike;
  vis: SecurityEnvelope;
  dedupeKey: string; // idempotence opakovaného zpracování
}

// ---------------------------------------------------------------------------
// 3.6 Security envelope
// ---------------------------------------------------------------------------

/** Denormalizovaná viditelnost zdrojové entity — nese ji každý odvozený dokument. */
export interface SecurityEnvelope {
  visibility: string; // stejný tvar jako contentVisibility.ts
  ownerCompanyId?: string;
  allowedPrincipalIds?: string[];
  authorOnly?: string; // pro data z dailyVoiceNotes apod.
}

// ---------------------------------------------------------------------------
// 3.7 Serializovatelný dotaz
// ---------------------------------------------------------------------------

/** Část dotazu vykonatelná přímo Firestore dotazem; limit a sort jsou povinné. */
export interface FirestoreQueryPlan {
  statusIds?: string[];
  assigneeId?: string;
  endDateFrom?: string;
  endDateTo?: string;
  sort: { field: "endDate" | "updatedAt" | "taskNumber"; dir: "asc" | "desc" };
  limit: number;
}

export interface SavedQuery {
  schemaVersion: 1;
  entity: "task"; // MVP jen task
  plan: FirestoreQueryPlan; // visibility NENÍ součástí uloženého planu — přidává ho
  // vyhodnocovač vždy sám z aktuálních práv žadatele
  //
  // ⚠️ ODCHYLKA OD SPECU: spec definuje `postFilter: TaskRouteFilters`
  // (`src/types/filters.ts`). Tenhle soubor má ale byte-identické zrcadlo
  // ve `functions/src/graph/graphContract.ts` a functions nemají alias
  // `@/` ani přístup k `src/types/filters.ts` — import by rozbil identitu
  // zrcadel nebo vyžádal duplicitní typ. Necháváme `unknown` a zúžení na
  // `TaskRouteFilters` dělá až volající v `src/`.
  postFilter?: unknown; // zbytek (substring q, OR kombinace, tagy) — vyhodnocený sdílenou fn
  anchor: { timezone: string }; // relativní data se kotví při vyhodnocení
  scanBudget: number; // max načtených dokumentů; překročení = chyba
  audience: "me" | "my_company" | "project";
  createdBy: string;
}

// ---------------------------------------------------------------------------
// Čisté funkce
// ---------------------------------------------------------------------------

/**
 * Kanonický řetězec pro referenci — stabilní bez ohledu na pořadí vlastností
 * objektu, protože pole bere v pevném pořadí dle varianty, ne z `Object.keys`.
 * Tvar: `wid/pid/type/pole1|pole2|…`. `page` (plan_version/document_version)
 * chybějící vs. `0` musí dát různý klíč, proto `page ?? ""`, ne `page ?? 0`.
 */
export function refKey(ref: GraphNodeRef): string {
  return `${ref.wid}/${ref.pid}/${ref.type}/${refFields(ref).join("|")}`;
}

function refFields(ref: GraphNodeRef): string[] {
  switch (ref.type) {
    case "task":
      return [ref.taskId];
    case "subtask":
      return [ref.taskId, ref.checklistItemId];
    case "comment":
      return [ref.taskId, ref.commentId];
    case "plan":
      return [ref.planId];
    case "plan_version":
      return [ref.planId, ref.versionId, ref.page === undefined ? "" : String(ref.page)];
    case "document":
      return [ref.documentId];
    case "document_version":
      return [ref.documentId, ref.versionId, ref.page === undefined ? "" : String(ref.page)];
    case "photo":
      return [ref.photoId];
    case "photo_pin":
      return [ref.pinId];
    case "annotation":
      return [ref.annotationId];
    case "chunk":
      return [ref.documentId, ref.versionId, ref.chunkId];
    case "location":
      return [ref.roomOrZoneId];
    case "floor":
      return [ref.floorKey];
    case "building":
      return [ref.buildingKey];
    case "person":
      return [ref.principal];
    case "company":
      return [ref.companyId];
    case "diary_entry":
      return [ref.entryId];
    case "voice_note":
      return [ref.noteId];
    default: {
      // Exhaustivní strážce — nový varianta GraphNodeRef bez řádku tady spadne na typecheck.
      const exhaustive: never = ref;
      throw new Error(`refKey: neznámý typ reference ${(exhaustive as GraphNodeRef).type}`);
    }
  }
}

/** Hrany, kde A→B a B→A jsou tatáž hrana — konce se před hashem seřadí (§3.3). */
export const SYMMETRIC_EDGE_TYPES: ReadonlySet<GraphEdgeType> = new Set(["similar_to"]);

// FNV-1a 64bit bez externí závislosti (žádný `crypto`, žádný `TextEncoder` —
// ten by v `functions/` (lib: es2020, bez `dom`) potřeboval ambientní typy
// navíc). UTF-8 kódování ručně z code pointů.
const FNV64_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

function utf8Bytes(input: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const codePoint = input.codePointAt(i);
    if (codePoint === undefined) continue;
    if (codePoint > 0xffff) i++; // surogátní pár zabral dvě UTF-16 jednotky
    if (codePoint < 0x80) {
      bytes.push(codePoint);
    } else if (codePoint < 0x800) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return bytes;
}

function fnv1a64(input: string): bigint {
  let hash = FNV64_OFFSET_BASIS;
  for (const byte of utf8Bytes(input)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV64_PRIME) & MASK_64;
  }
  return hash;
}

/**
 * Deterministické id hrany: `hash(type | keyA | keyB)`. U symetrických typů
 * (`SYMMETRIC_EDGE_TYPES`) se `refKey(from)`/`refKey(to)` před hashem seřadí
 * lexikograficky, aby A→B a B→A dostaly stejné id.
 */
export function makeEdgeId(type: GraphEdgeType, from: GraphNodeRef, to: GraphNodeRef): string {
  const keyFrom = refKey(from);
  const keyTo = refKey(to);
  let keyA = keyFrom;
  let keyB = keyTo;
  if (SYMMETRIC_EDGE_TYPES.has(type) && keyB < keyA) {
    keyA = keyTo;
    keyB = keyFrom;
  }
  return fnv1a64(`${type}|${keyA}|${keyB}`).toString(16);
}

/**
 * Validace provenience nad rámec typového systému (§3.2): `ai_extraction`
 * a `heuristic` musí nést evidenci, `heuristic` musí mít pravidlo a `confidence`
 * (kde existuje) musí být z diskrétní rubriky — kontrolováno runtime hodnotou,
 * ne jen typem (JSON z Firestore nemá typovou kontrolu).
 */
export function validateProvenance(p: Provenance): string[] {
  const errors: string[] = [];

  if (p.kind === "ai_extraction" || p.kind === "heuristic") {
    const hasEvidence = Boolean(p.evidence && (p.evidence.quote || p.evidence.ref));
    if (!hasEvidence) {
      errors.push(`${p.kind}: evidence musí mít alespoň quote nebo ref`);
    }
  }

  if (p.kind === "heuristic" && p.rule.trim().length === 0) {
    errors.push("heuristic: rule nesmí být prázdné");
  }

  if ("confidence" in p && !isValidConfidence(p.confidence)) {
    errors.push(`confidence ${p.confidence} není v rubrice Confidence`);
  }

  return errors;
}

/**
 * Tier provenience (§3.2, princip P8): `human`/`system_fk`/`system_context`
 * jsou vždy „extracted"; u heuristik a AI rozhoduje `confidence` — pod 0.55
 * je výsledek „ambiguous", jinak „inferred".
 */
export function provenanceTier(p: Provenance): "extracted" | "inferred" | "ambiguous" {
  switch (p.kind) {
    case "human":
    case "system_fk":
    case "system_context":
      return "extracted";
    case "heuristic":
    case "ai_extraction":
    case "ai_semantic":
      return p.confidence >= 0.55 ? "inferred" : "ambiguous";
    default: {
      const exhaustive: never = p;
      throw new Error(`provenanceTier: neznámý kind ${(exhaustive as Provenance).kind}`);
    }
  }
}

/**
 * Kdo smí zapsat přímo, a kdo jen navrhnout (§3.3): `human`/`system_fk`/
 * `system_context` vždy; `heuristic` jen nad `SUGGEST_ONLY_THRESHOLD`;
 * `ai_extraction`/`ai_semantic` nikdy (výjimka capture-first hlasu #404 se
 * řeší mimo tenhle kontrakt, ne tady).
 */
export function canApplyDirectly(p: Provenance): boolean {
  switch (p.kind) {
    case "human":
    case "system_fk":
    case "system_context":
      return true;
    case "heuristic":
      return p.confidence >= SUGGEST_ONLY_THRESHOLD;
    case "ai_extraction":
    case "ai_semantic":
      return false;
    default: {
      const exhaustive: never = p;
      throw new Error(`canApplyDirectly: neznámý kind ${(exhaustive as Provenance).kind}`);
    }
  }
}
