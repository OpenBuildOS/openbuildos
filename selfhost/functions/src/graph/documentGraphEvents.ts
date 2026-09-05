import type { GraphEventBase, GraphNodeRef, TimestampLike } from "./graphContract";
import type { GraphEventDraft } from "./taskGraphEvents";

/**
 * `documentGraphEvents` — F4 souladu CDE s ISO 19650: **připisovací (append-only)
 * záznam událostí dokumentu**, který nikdo z klientů nemůže změnit ani smazat.
 *
 * 🔴 PROČ SERVER, A NE KLIENT. Norma chce auditní stopu „kdo, kdy, jaký
 * přechod" trvale a nezpochybnitelně. `emitDocumentEvent`
 * (`src/modules/documents/events/documentEvents.ts`) je paměťová sběrnice pro
 * upozornění — nikam se nezapisuje a nikdo ji neposlouchá. Kdyby zapisovala,
 * byl by to záznam podvrhnutelný tím, kdo ho vyrábí, a navíc by u člověka bez
 * práva zápisu spadl na `permission-denied` přesně ve chvíli, kdy je stopa
 * nejpotřebnější. Zapisuje proto SERVER z diffu `before`/`after`, do TÉŽE
 * kolekce `graphEvents` jako úkoly (`docs/specs/projektovy-graf.md` §3.4);
 * pravidla tam mají jen `allow read`.
 *
 * ⭐ ČISTÁ FUNKCE + TENKÝ TRIGGER — stejný vzor jako `taskGraphEvents.ts` vedle.
 * Tenhle soubor nemá závislost na `firebase-admin`/`firebase-functions`, takže
 * jde testovat bez emulátoru (`documentGraphEvents.test.ts`). Wrappery
 * v `index.ts` jen čtou snapshot, dopočítají `committedAt` a zapisují batch.
 *
 * ⭐ ŽÁDNÉ DRUHÉ ČTENÍ. Všechno (actor, čas, viditelnost, popisky) se bere
 * z diffu. Dohledávat k události název dokumentu by znamenalo dotaz navíc na
 * entitu, která mezitím mohla zmizet — a u smazané revize by nešel dohledat
 * vůbec. Proto `label` na události (§3.4) a `tombstone.label` u smazání.
 *
 * ⭐ SDÍLENÝ SOUBOR s companionem (`docs/REPO_BOUNDARIES.md`, Háček 1) —
 * stejně jako `graphContract.ts` a `taskGraphEvents.ts` vedle. Registrace
 * triggerů sdílená NENÍ, ta žije v `index.ts` každého repa zvlášť.
 */

// ---------------------------------------------------------------------------
// Tvary dokumentů tak, jak leží ve Firestoru — jen pole, která diff potřebuje
// ---------------------------------------------------------------------------

/**
 * `workspaces/{wid}/projects/{pid}/documentVersions/{versionId}`.
 *
 * ⚠️ Časová pole NEJSOU ISO řetězce jako u úkolů: `documentService.ts` je píše
 * `serverTimestamp()`, takže v Admin SDK dorazí jako `Timestamp`. Proto
 * `toTimestampLike()` níž umí obojí — kdyby uměla jen ISO (jako
 * `isoToTimestampLike` u úkolů), spadl by KAŽDÝ `occurredAt` na fallback
 * a proud událostí by se tvářil, že se všechno stalo v čase doručení.
 */
export interface DocumentVersionDocLike {
  documentId?: unknown;
  versionLabel?: unknown;
  status?: unknown;
  scope?: unknown; // project_official | company_internal
  ownerCompanyId?: unknown;
  uploadedBy?: unknown;
  createdBy?: unknown;
  uploadedAt?: unknown;
  updatedAt?: unknown;
  statusChangedAt?: unknown;
  statusChangedBy?: unknown;
  reviewedAt?: unknown;
  reviewedBy?: unknown;
  approvals?: unknown; // Record<principal, ApprovalDecision>
}

/** `workspaces/{wid}/projects/{pid}/documents/{documentId}`. */
export interface DocumentDocLike {
  title?: unknown;
  status?: unknown; // active | archived
  currentVersionId?: unknown; // platná revize — pro TDI nejdůležitější pole
  deletedAt?: unknown; // koš (měkké smazání)
  deletedBy?: unknown;
  scope?: unknown;
  ownerCompanyId?: unknown;
  createdBy?: unknown;
  updatedAt?: unknown;
  createdAt?: unknown;
  identityChanges?: unknown; // stopa po ruční opravě názvu/čísla (N11)
}

export interface DocumentVersionEventRef {
  wid: string;
  pid: string;
  versionId: string;
}

export interface DocumentEventRef {
  wid: string;
  pid: string;
  documentId: string;
}

interface ComputeInputBase {
  /** `event.id` z CloudEventu — základ deterministického `eventId` (idempotence napříč retry). */
  eventBaseId: string;
  /** `entityRev` (§3.4): `updateTime` zdrojového dokumentu v mikrosekundách. */
  entityRevMicros: number;
  /** Čas doručení CloudEventu — fallback `occurredAt`, když data razítko nemají. */
  fallbackOccurredAt: TimestampLike;
}

export interface ComputeDocumentVersionGraphEventsInput extends ComputeInputBase {
  before: DocumentVersionDocLike | undefined; // undefined = !before.exists
  after: DocumentVersionDocLike | undefined; // undefined = !after.exists
  ref: DocumentVersionEventRef;
}

export interface ComputeDocumentGraphEventsInput extends ComputeInputBase {
  before: DocumentDocLike | undefined;
  after: DocumentDocLike | undefined;
  ref: DocumentEventRef;
}

// ---------------------------------------------------------------------------
// Drobné čtečky nad `unknown` — data z Firestore nikdy nevěříme na slovo
// ---------------------------------------------------------------------------

const FALLBACK_LABEL = "(bez názvu)";

/**
 * Sentinel viditelnosti, který nematchne žádný čtenář (`graphEventVisible`
 * v `firestore.rules` porovnává `vis.visibility` s firmou člena). Stejný vzor
 * a stejný důvod jako u legacy interních úkolů v `taskGraphEvents.ts`.
 */
const UNREADABLE_INTERNAL = "__internal_unreadable__";

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Časové razítko z dat na `TimestampLike`. Umí čtyři tvary, protože každý
 * z nich v datech opravdu je: `Timestamp` z Admin SDK (`serverTimestamp()`),
 * `Date`, ISO řetězec (`ApprovalDecision.at`) a epocha v ms. Cokoli jiného
 * (a NaN) padá na `fallback` — nikdy se nevymýšlí čas.
 */
export function toTimestampLike(value: unknown, fallback: TimestampLike): TimestampLike {
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? fallback : fromMillis(ms);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? fromMillis(value) : fallback;
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? fallback : fromMillis(ms);
  }
  if (value && typeof value === "object") {
    const seconds = (value as { seconds?: unknown; _seconds?: unknown }).seconds
      ?? (value as { _seconds?: unknown })._seconds;
    const nanoseconds = (value as { nanoseconds?: unknown; _nanoseconds?: unknown }).nanoseconds
      ?? (value as { _nanoseconds?: unknown })._nanoseconds;
    if (typeof seconds === "number" && Number.isFinite(seconds)) {
      return {
        seconds,
        nanoseconds: typeof nanoseconds === "number" && Number.isFinite(nanoseconds) ? nanoseconds : 0,
      };
    }
  }
  return fallback;
}

function fromMillis(ms: number): TimestampLike {
  const seconds = Math.floor(ms / 1000);
  return { seconds, nanoseconds: (ms - seconds * 1000) * 1_000_000 };
}

/** První použitelné razítko z pořadí priorit; `undefined` = žádné, použije se fallback. */
function firstTimestamp(values: unknown[], fallback: TimestampLike): TimestampLike {
  for (const value of values) {
    const resolved = toTimestampLike(value, fallback);
    if (resolved !== fallback) return resolved;
  }
  return fallback;
}

/**
 * 🔴 FAIL-CLOSED viditelnost (§3.6). `""` znamená „obsah celé stavby", takže
 * default `""` by u INTERNÍHO dokumentu firmy otevřel všem členům i popisky
 * v tombstone. Dokumenty ani revize nenesou denormalizované pole `visibility`
 * (to má jen `tasks`/`photos`/`photoPins`, viz `src/services/contentVisibility.ts`),
 * takže se odvozuje ze `scope`/`ownerCompanyId` — a interní bez `ownerCompanyId`
 * dostane sentinel, který nikdo nepřečte.
 */
function visibilityOf(scope: unknown, ownerCompanyId: unknown): string {
  if (scope === "company_internal") {
    return stringOrUndefined(ownerCompanyId) ?? UNREADABLE_INTERNAL;
  }
  return "";
}

function envelopeOf(scope: unknown, ownerCompanyId: unknown): GraphEventBase["vis"] {
  const owner = stringOrUndefined(ownerCompanyId);
  return {
    visibility: visibilityOf(scope, ownerCompanyId),
    ...(owner ? { ownerCompanyId: owner } : {}),
  };
}

/** `deletedAt` má význam „v koši" jen u hodnot, které klient reálně zapisuje. */
function isDeletedAtSet(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === "") return false;
  return typeof value === "string" || typeof value === "number" || typeof value === "object";
}

/** Rozhodnutí schvalovatelů jako čitelná mapa; cokoli jiného než objekt = prázdno. */
function approvalsOf(value: unknown): Record<string, { decision?: unknown; comment?: unknown }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, { decision?: unknown; comment?: unknown }>;
}

// ---------------------------------------------------------------------------
// documentVersions — revize dokumentu
// ---------------------------------------------------------------------------

/**
 * Diff revize dokumentu na `GraphEvent` drafty. Jeden zápis smí vydat víc
 * událostí (nahrání = `created` na revizi + `version_added` na dokumentu;
 * schválení = `decision_recorded` za každého rozhodnuvšího + `status_changed`),
 * každá s vlastním `eventId`.
 */
export function computeDocumentVersionGraphEvents(
  input: ComputeDocumentVersionGraphEventsInput
): GraphEventDraft[] {
  const { before, after, ref, eventBaseId, entityRevMicros, fallbackOccurredAt } = input;
  const doc = after ?? before;
  if (!doc) {
    return []; // nemělo by nastat (onDocumentWritten nese aspoň jednu stranu)
  }

  // Bez `documentId` se nedá složit `GraphNodeRef` (§3.1: verzované typy mají
  // `documentId` i `versionId` povinné) — a událost, která neví, ke které
  // entitě patří, je horší než žádná: nikdo ji nenajde a v přehledech šumí.
  const documentId = stringOrUndefined(after?.documentId) ?? stringOrUndefined(before?.documentId);
  if (!documentId) {
    return [];
  }

  const { wid, pid, versionId } = ref;
  const versionEntity: GraphNodeRef = { wid, pid, type: "document_version", documentId, versionId };
  const documentEntity: GraphNodeRef = { wid, pid, type: "document", documentId };

  const label = stringOrUndefined(after?.versionLabel) ?? stringOrUndefined(before?.versionLabel) ?? FALLBACK_LABEL;
  const vis = envelopeOf(
    after?.scope ?? before?.scope,
    after?.ownerCompanyId ?? before?.ownerCompanyId
  );

  const events: GraphEventDraft[] = [];
  const withId = (action: string): string => `${eventBaseId}-${action}`;

  // ── vznik revize ─────────────────────────────────────────────────────────
  if (!before && after) {
    const occurredAt = firstTimestamp([after.uploadedAt, after.updatedAt], fallbackOccurredAt);
    const actor = stringOrUndefined(after.uploadedBy) ?? stringOrUndefined(after.createdBy) ?? "unknown";
    const base = { schemaVersion: 1 as const, entityRev: entityRevMicros, actor, occurredAt, vis, label };
    events.push({ ...base, entity: versionEntity, eventId: withId("created"), action: "created" });
    // Druhá událost z téhož zápisu, na RODIČI: bez ní by v proudu dokumentu
    // („co je nového od včera") nahrání nové revize nebylo vidět jako změna
    // dokumentu, jen jako vznik cizí entity.
    events.push({
      ...base,
      entity: documentEntity,
      eventId: withId("version_added"),
      action: "version_added",
      versionRef: versionEntity,
    });
    return events;
  }

  // ── tvrdé smazání revize ─────────────────────────────────────────────────
  if (before && !after) {
    const status = stringOrUndefined(before.status);
    // ⚠️ `occurredAt` je čas DORUČENÍ, ne `before.updatedAt`: smazání nastalo
    // teď, kdežto `updatedAt` nese poslední editaci. Se starým razítkem by
    // událost „smazáno" v proudu řazeném podle `occurredAt` skončila PŘED
    // událostmi, které smazání předcházely.
    // ⚠️ `actor` je „unknown": kdo mazal, ví jen zápis do RODIČE
    // (`documents.revisionRemovals[].removedBy`, `documentService.deleteVersion`),
    // a druhé čtení tahle vrstva zásadně nedělá.
    events.push({
      schemaVersion: 1,
      entity: versionEntity,
      entityRev: entityRevMicros,
      actor: "unknown",
      occurredAt: fallbackOccurredAt,
      vis,
      label,
      eventId: withId("deleted"),
      action: "deleted",
      tombstone: { label: status ? `${label} (${status})` : label },
    });
    return events;
  }

  if (!before || !after) {
    return events;
  }

  // ── update ───────────────────────────────────────────────────────────────
  const occurredAt = firstTimestamp(
    [after.updatedAt, after.statusChangedAt, after.reviewedAt, after.uploadedAt],
    fallbackOccurredAt
  );

  // Actor se bere z toho, co se v TOMHLE zápisu pohnulo. `statusChangedBy`
  // i `reviewedBy` v datech ZŮSTÁVAJÍ i po dalších změnách, takže brát je
  // bezpodmínečně by pozdější úpravy připsalo tomu, kdo naposledy rozhodoval.
  // Rozhoduje proto pohyb doprovodného razítka, ne hodnota jména.
  const statusStampMoved = !sameTimestampField(before.statusChangedAt, after.statusChangedAt);
  const reviewStampMoved = !sameTimestampField(before.reviewedAt, after.reviewedAt);
  const newDecisions = newDecisionPrincipals(before.approvals, after.approvals);
  const actor =
    (statusStampMoved ? stringOrUndefined(after.statusChangedBy) : undefined) ??
    (reviewStampMoved ? stringOrUndefined(after.reviewedBy) : undefined) ??
    newDecisions[0] ??
    "unknown";

  const base = { schemaVersion: 1 as const, entity: versionEntity, entityRev: entityRevMicros, actor, occurredAt, vis, label };

  // Změna stavu — ID, nikdy labely (P5: labely jsou render). Touhle cestou jde
  // schválení i zamítnutí, odsun do `superseded`, archivace i ruční oprava
  // evidence (#734).
  const beforeStatus = stringOrUndefined(before.status);
  const afterStatus = stringOrUndefined(after.status);
  if (beforeStatus && afterStatus && beforeStatus !== afterStatus) {
    events.push({
      ...base,
      eventId: withId("status_changed"),
      action: "status_changed",
      fromStatusId: beforeStatus,
      toStatusId: afterStatus,
    });
  }

  // Rozhodnutí jednotlivých schvalovatelů. Jedna událost na každého, kdo
  // rozhodl nově — u vícenásobného schvalování je to jediné místo, kde je
  // vidět, KDO co řekl; `status_changed` nese jen výsledek podle politiky.
  //
  // `eventId` se rozlišuje POŘADÍM ve setříděném seznamu, ne principalem:
  // principal je cizí řetězec (OIDC subject) a jako součást ID dokumentu by
  // mohl nést znaky, které Firestore v ID nepřijme. Setřídění drží pořadí
  // deterministické i při opakovaném doručení téhož zápisu.
  newDecisions.forEach((principal, index) => {
    const entry = approvalsOf(after.approvals)[principal] ?? {};
    const decision = stringOrUndefined(entry.decision);
    const comment = stringOrUndefined(entry.comment);
    events.push({
      ...base,
      actor: principal, // rozhodl on, ne ten, kdo zápis odeslal
      eventId: withId(`decision_recorded-${index}`),
      action: "decision_recorded",
      decision: decision ?? "unknown",
      byPrincipal: principal,
      ...(comment ? { comment } : {}),
    });
  });

  // Přejmenování revize (oprava označení „R02" → „R2.1").
  const beforeLabel = stringOrUndefined(before.versionLabel);
  const afterLabel = stringOrUndefined(after.versionLabel);
  if (beforeLabel && afterLabel && beforeLabel !== afterLabel) {
    events.push({
      ...base,
      eventId: withId("renamed"),
      action: "renamed",
      fromLabel: beforeLabel,
      toLabel: afterLabel,
    });
  }

  // Přesun mezi oficiální a interní dokumentací.
  const beforeScope = stringOrUndefined(before.scope);
  const afterScope = stringOrUndefined(after.scope);
  if (beforeScope && afterScope && beforeScope !== afterScope) {
    events.push({
      ...base,
      eventId: withId("scope_changed"),
      action: "scope_changed",
      fromScope: beforeScope,
      toScope: afterScope,
    });
  }

  return events;
}

/**
 * Principálové, kteří v tomhle zápisu rozhodli NOVĚ (setřídění kvůli
 * deterministickému `eventId`). Změna už existujícího rozhodnutí se
 * nezapočítává: rozhodnutí se v `recordApproval` nepřepisují a druhá událost
 * o témž rozhodnutí by v auditní stopě lhala o počtu.
 */
function newDecisionPrincipals(before: unknown, after: unknown): string[] {
  const previous = approvalsOf(before);
  const current = approvalsOf(after);
  return Object.keys(current)
    .filter((principal) => !(principal in previous))
    .sort();
}

/** Porovná dvě časová pole na shodu; `undefined` na obou stranách = beze změny. */
function sameTimestampField(before: unknown, after: unknown): boolean {
  const sentinel: TimestampLike = { seconds: -1, nanoseconds: -1 };
  const left = toTimestampLike(before, sentinel);
  const right = toTimestampLike(after, sentinel);
  return left.seconds === right.seconds && left.nanoseconds === right.nanoseconds;
}

// ---------------------------------------------------------------------------
// documents — dokument sám
// ---------------------------------------------------------------------------

/**
 * Diff dokumentu na `GraphEvent` drafty: vznik, koš a návrat z něj, tvrdé
 * smazání (vysypání koše), přejmenování, archivace a — pro TDI to nejdůležitější
 * — změna PLATNÉ revize.
 */
export function computeDocumentGraphEvents(input: ComputeDocumentGraphEventsInput): GraphEventDraft[] {
  const { before, after, ref, eventBaseId, entityRevMicros, fallbackOccurredAt } = input;
  const doc = after ?? before;
  if (!doc) {
    return [];
  }

  const { wid, pid, documentId } = ref;
  const entity: GraphNodeRef = { wid, pid, type: "document", documentId };
  const label = stringOrUndefined(after?.title) ?? stringOrUndefined(before?.title) ?? FALLBACK_LABEL;
  const vis = envelopeOf(after?.scope ?? before?.scope, after?.ownerCompanyId ?? before?.ownerCompanyId);

  const events: GraphEventDraft[] = [];
  const withId = (action: string): string => `${eventBaseId}-${action}`;

  // ── vznik dokumentu ──────────────────────────────────────────────────────
  if (!before && after) {
    return [
      {
        schemaVersion: 1,
        entity,
        entityRev: entityRevMicros,
        actor: stringOrUndefined(after.createdBy) ?? "unknown",
        occurredAt: firstTimestamp([after.createdAt, after.updatedAt], fallbackOccurredAt),
        vis,
        label,
        eventId: withId("created"),
        action: "created",
      },
    ];
    // `currentVersionId` se při vzniku nastavuje spolu s první revizí —
    // `current_version_changed` by tu byl duplicitní k `created`.
  }

  // ── tvrdé smazání (vysypání koše / purge) ────────────────────────────────
  if (before && !after) {
    return [
      {
        schemaVersion: 1,
        entity,
        entityRev: entityRevMicros,
        actor: stringOrUndefined(before.deletedBy) ?? "unknown",
        occurredAt: fallbackOccurredAt, // smazání nastalo teď (viz revize výš)
        vis,
        label,
        eventId: withId("deleted"),
        action: "deleted",
        tombstone: { label },
      },
    ];
  }

  if (!before || !after) {
    return events;
  }

  // ── update ───────────────────────────────────────────────────────────────
  const occurredAt = firstTimestamp([after.updatedAt, after.deletedAt], fallbackOccurredAt);

  // Dokument nenese `updatedByUserId` jako úkol. Co z diffu jde přečíst:
  // `deletedBy` u koše a `identityChanges[].changedBy` u ruční opravy identity
  // (N11). U ostatních změn (typicky přepnutí platné revize) zůstává „unknown"
  // — kdo rozhodoval, je vidět na událostech REVIZE, které vznikají ze stejné
  // transakce (`recordApproval` mění revizi i ukazatel dokumentu naráz).
  const beforeDeleted = isDeletedAtSet(before.deletedAt);
  const afterDeleted = isDeletedAtSet(after.deletedAt);
  const renameActor = newIdentityChangeActor(before.identityChanges, after.identityChanges);
  const actor =
    (afterDeleted && !beforeDeleted ? stringOrUndefined(after.deletedBy) : undefined) ??
    renameActor ??
    "unknown";

  const base = { schemaVersion: 1 as const, entity, entityRev: entityRevMicros, actor, occurredAt, vis, label };

  // Koš a návrat z něj (měkké smazání — stejný vzor jako u úkolu).
  if (!beforeDeleted && afterDeleted) {
    events.push({ ...base, eventId: withId("deleted"), action: "deleted", tombstone: { label } });
  } else if (beforeDeleted && !afterDeleted) {
    events.push({ ...base, eventId: withId("restored"), action: "restored" });
  }

  // Přejmenování dokumentu (N11: mění vstup do párování příštích revizí).
  const beforeTitle = stringOrUndefined(before.title);
  const afterTitle = stringOrUndefined(after.title);
  if (beforeTitle && afterTitle && beforeTitle !== afterTitle) {
    events.push({
      ...base,
      eventId: withId("renamed"),
      action: "renamed",
      fromLabel: beforeTitle,
      toLabel: afterTitle,
    });
  }

  // Archivace / návrat dokumentu (`documents.status` = active | archived).
  const beforeStatus = stringOrUndefined(before.status);
  const afterStatus = stringOrUndefined(after.status);
  if (beforeStatus && afterStatus && beforeStatus !== afterStatus) {
    events.push({
      ...base,
      eventId: withId("status_changed"),
      action: "status_changed",
      fromStatusId: beforeStatus,
      toStatusId: afterStatus,
    });
  }

  // Změna PLATNÉ revize — podle ní se staví, takže je to nejsledovanější
  // změna na dokumentu. `currentVersionId` je `string | null`, obě strany
  // volitelné: dokument bez platné revize je legitimní stav.
  const beforeCurrent = stringOrUndefined(before.currentVersionId);
  const afterCurrent = stringOrUndefined(after.currentVersionId);
  if (beforeCurrent !== afterCurrent) {
    events.push({
      ...base,
      eventId: withId("current_version_changed"),
      action: "current_version_changed",
      ...(beforeCurrent ? { fromVersionId: beforeCurrent } : {}),
      ...(afterCurrent ? { toVersionId: afterCurrent } : {}),
    });
  }

  return events;
}

/**
 * Kdo doplnil poslední položku do `identityChanges` — jediná stopa autora
 * ruční opravy názvu/čísla dokumentu, kterou diff unese bez druhého čtení.
 * Bere se jen tehdy, když pole v TOMHLE zápisu narostlo.
 */
function newIdentityChangeActor(before: unknown, after: unknown): string | undefined {
  const previous = Array.isArray(before) ? before.length : 0;
  if (!Array.isArray(after) || after.length <= previous) return undefined;
  const last = after[after.length - 1];
  if (!last || typeof last !== "object") return undefined;
  return stringOrUndefined((last as { changedBy?: unknown }).changedBy);
}
