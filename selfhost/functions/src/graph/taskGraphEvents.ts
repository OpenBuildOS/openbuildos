import type { Timestamp } from "firebase-admin/firestore";
import type { GraphEvent, GraphEventBase, GraphNodeRef, TimestampLike } from "./graphContract";

/**
 * `taskGraphEvents` — Fáze 0c projektového grafu (`docs/specs/projektovy-graf.md`
 * §3.4, §4.2): serverový trigger nad `tasks` emituje append-only `graphEvents`
 * z diffu `before`/`after`. Klientský `buildTaskChangeEvents()` zůstává jen pro
 * render vět v `activityLog` — tenhle soubor nic z appky nečte ani nemění.
 *
 * ⭐ ČISTÁ FUNKCE + TENKÝ TRIGGER. `computeTaskGraphEvents` nemá žádnou závislost
 * na `firebase-admin`/`firebase-functions` — jde testovat bez emulátoru (viz
 * `taskGraphEvents.test.ts`). Tenký wrapper v `index.ts` jen čte trigger snapshot,
 * dopočítá `committedAt` (serverový čas zápisu) a zapisuje `.create()`.
 *
 * ⭐ SDÍLENÝ SOUBOR jen zčásti: `graphContract.ts` vedle je BYTE IDENTICKÝ
 * s hlavním repem (viz `docs/REPO_BOUNDARIES.md`). Tenhle trigger sám sdílený
 * NENÍ — Fáze 0c žije jen v companionu (`docs/specs/projektovy-graf.md` §8):
 * trigger se registruje v projektu, který drží data workspace, a u self-hostu
 * je to vždy firemní (companion) projekt.
 */

/** Task dokument tak, jak leží ve Firestoru — jen pole, která diff potřebuje. */
export interface TaskDocLike {
  title?: unknown;
  status?: unknown;
  deletedAt?: unknown; // Timestamp | null | undefined
  updatedAt?: unknown; // ISO string (viz `src/services/tasks.ts` serializeTask)
  updatedByUserId?: unknown;
  visibility?: unknown;
  ownerCompanyId?: unknown;
  assignment?: { assigneeId?: unknown } | unknown;
  schedule?: { startDate?: unknown; endDate?: unknown } | unknown;
}

export interface TaskGraphEventRef {
  wid: string;
  pid: string;
  taskId: string;
}

/** Vstup čisté funkce — všechno, co trigger umí přečíst ze snapshotu bez dalšího čtení. */
export interface ComputeTaskGraphEventsInput {
  before: TaskDocLike | undefined; // undefined = !before.exists
  after: TaskDocLike | undefined; // undefined = !after.exists
  ref: TaskGraphEventRef;
  /** `event.id` z CloudEvent — základ deterministického `eventId` (idempotence napříč retry). */
  eventBaseId: string;
  /** `entityRev` (§3.4): `updateTime` zdrojového dokumentu v mikrosekundách — `after`, u delete `before`. */
  entityRevMicros: number;
  /** Fallback `occurredAt`, když dokument nemá použitelné `updatedAt` (offline zápis bez razítka). */
  fallbackOccurredAt: TimestampLike;
}

/**
 * `Omit` nad diskriminovanou unií `GraphEvent` by kolabovalo na průnik klíčů
 * napříč VŠEMI variantami (zůstalo by jen `action`, `tombstone`/`fromStatusId`/…
 * by zmizely) — distribuce přes `T extends unknown` udrží každou variantu zvlášť.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Návrh eventu BEZ `committedAt` — ten je serverový čas zápisu, doplní ho až trigger. */
export type GraphEventDraft = DistributiveOmit<GraphEvent, "committedAt">;

const TOMBSTONE_FALLBACK_LABEL = "(bez názvu)";

function isPlainString(value: unknown): value is string {
  return typeof value === "string";
}

/** Nenulový string, jinak `undefined` — bez toho by TS nešel spolehnout narrowing přes `obj?.field`. */
function stringOrUndefined(value: unknown): string | undefined {
  return isPlainString(value) && value.length > 0 ? value : undefined;
}

function readAssigneeId(assignment: TaskDocLike["assignment"]): string | undefined {
  if (!assignment || typeof assignment !== "object") return undefined;
  const raw = (assignment as { assigneeId?: unknown }).assigneeId;
  return isPlainString(raw) && raw.length > 0 ? raw : undefined;
}

function readScheduleDate(
  schedule: TaskDocLike["schedule"],
  field: "startDate" | "endDate"
): string | undefined {
  if (!schedule || typeof schedule !== "object") return undefined;
  const raw = (schedule as { startDate?: unknown; endDate?: unknown })[field];
  return isPlainString(raw) && raw.length > 0 ? raw : undefined;
}

function taskTitle(task: TaskDocLike | undefined): string {
  const title = task?.title;
  return isPlainString(title) && title.trim().length > 0 ? title : TOMBSTONE_FALLBACK_LABEL;
}

/** ISO string → `TimestampLike`; neplatný/chybějící vstup → `fallback`. */
export function isoToTimestampLike(iso: unknown, fallback: TimestampLike): TimestampLike {
  if (!isPlainString(iso)) return fallback;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return fallback;
  const seconds = Math.floor(ms / 1000);
  const nanoseconds = (ms - seconds * 1000) * 1_000_000;
  return { seconds, nanoseconds };
}

/** Admin SDK `Timestamp` → mikrosekundy (`entityRev`, §3.4). */
export function timestampToMicros(ts: Pick<Timestamp, "seconds" | "nanoseconds"> | undefined): number {
  if (!ts) return 0;
  return ts.seconds * 1_000_000 + Math.floor(ts.nanoseconds / 1000);
}

/** `undefined` klíče se do Firestore zapsat nedají — sestaví `DateRange` jen z toho, co je. */
function dateRangeOrUndefined(
  startDate: string | undefined,
  endDate: string | undefined
): { startDate?: string; endDate?: string } | undefined {
  if (!startDate && !endDate) return undefined;
  return {
    ...(startDate ? { startDate } : {}),
    ...(endDate ? { endDate } : {}),
  };
}

function isDeletedAtSet(value: unknown): boolean {
  return value !== null && value !== undefined;
}

function statusOf(task: TaskDocLike | undefined): string | undefined {
  return stringOrUndefined(task?.status);
}

function visibilityOf(before: TaskDocLike | undefined, after: TaskDocLike | undefined): string {
  const afterVis = after?.visibility;
  if (isPlainString(afterVis)) return afterVis;
  const beforeVis = before?.visibility;
  return isPlainString(beforeVis) ? beforeVis : "";
}

function ownerCompanyIdOf(before: TaskDocLike | undefined, after: TaskDocLike | undefined): string | undefined {
  const afterOwner = after?.ownerCompanyId;
  if (isPlainString(afterOwner) && afterOwner.length > 0) return afterOwner;
  const beforeOwner = before?.ownerCompanyId;
  return isPlainString(beforeOwner) && beforeOwner.length > 0 ? beforeOwner : undefined;
}

/**
 * Diff `before`/`after` na jedno nebo víc `GraphEvent` (§3.4). Čistá, bez I/O —
 * jeden zápis do `tasks` může vydat víc událostí (např. status i assignee
 * najednou), každá se svým `eventId = ${eventBaseId}-${action}`.
 */
export function computeTaskGraphEvents(input: ComputeTaskGraphEventsInput): GraphEventDraft[] {
  const { before, after, ref, eventBaseId, entityRevMicros, fallbackOccurredAt } = input;

  const entity: GraphNodeRef = { wid: ref.wid, pid: ref.pid, type: "task", taskId: ref.taskId };
  const actor =
    stringOrUndefined(after?.updatedByUserId) || stringOrUndefined(before?.updatedByUserId) || "unknown";
  const occurredAt = isoToTimestampLike(
    stringOrUndefined(after?.updatedAt) ?? stringOrUndefined(before?.updatedAt),
    fallbackOccurredAt
  );
  const ownerCompanyId = ownerCompanyIdOf(before, after);
  const vis: GraphEventBase["vis"] = {
    visibility: visibilityOf(before, after),
    ...(ownerCompanyId ? { ownerCompanyId } : {}),
  };

  const base: Omit<GraphEventBase, "eventId" | "committedAt"> = {
    schemaVersion: 1,
    entity,
    entityRev: entityRevMicros,
    actor,
    occurredAt,
    vis,
  };

  const events: GraphEventDraft[] = [];
  const withId = (action: string): string => `${eventBaseId}-${action}`;

  // ── vznik / zánik dokumentu ────────────────────────────────────────────
  if (!before && after) {
    events.push({ ...base, eventId: withId("created"), action: "created" });
    return events; // vznik nemá s čím diffovat dál
  }

  if (before && !after) {
    events.push({
      ...base,
      eventId: withId("deleted"),
      action: "deleted",
      tombstone: { label: taskTitle(before) },
    });
    return events; // tvrdé smazání nemá s čím diffovat dál
  }

  if (!before && !after) {
    return events; // nemělo by nastat (onDocumentWritten vždy nese aspoň jednu stranu)
  }

  // ── update: obě strany existují, diffujeme pole ──────────────────────────

  // Měkké smazání / obnova (`deletedAt` null↔set) — nezávislé na dalších polích.
  const beforeDeleted = isDeletedAtSet(before?.deletedAt);
  const afterDeleted = isDeletedAtSet(after?.deletedAt);
  if (!beforeDeleted && afterDeleted) {
    events.push({
      ...base,
      eventId: withId("deleted"),
      action: "deleted",
      tombstone: { label: taskTitle(after) },
    });
  } else if (beforeDeleted && !afterDeleted) {
    events.push({ ...base, eventId: withId("restored"), action: "restored" });
  }

  // Změna stavu — ID, nikdy labely (P5: labely jsou render).
  const beforeStatus = statusOf(before);
  const afterStatus = statusOf(after);
  if (beforeStatus !== undefined && afterStatus !== undefined && beforeStatus !== afterStatus) {
    events.push({
      ...base,
      eventId: withId("status_changed"),
      action: "status_changed",
      fromStatusId: beforeStatus,
      toStatusId: afterStatus,
    });
  }

  // Změna řešitele.
  const beforeAssignee = readAssigneeId(before?.assignment);
  const afterAssignee = readAssigneeId(after?.assignment);
  if (beforeAssignee !== afterAssignee) {
    events.push({
      ...base,
      eventId: withId("assigned"),
      action: "assigned",
      ...(beforeAssignee ? { fromPrincipal: beforeAssignee } : {}),
      ...(afterAssignee ? { toPrincipal: afterAssignee } : {}),
    });
  }

  // Změna termínu.
  const beforeStart = readScheduleDate(before?.schedule, "startDate");
  const beforeEnd = readScheduleDate(before?.schedule, "endDate");
  const afterStart = readScheduleDate(after?.schedule, "startDate");
  const afterEnd = readScheduleDate(after?.schedule, "endDate");
  if (beforeStart !== afterStart || beforeEnd !== afterEnd) {
    const from = dateRangeOrUndefined(beforeStart, beforeEnd);
    const to = dateRangeOrUndefined(afterStart, afterEnd);
    events.push({
      ...base,
      eventId: withId("schedule_changed"),
      action: "schedule_changed",
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    });
  }

  return events;
}
