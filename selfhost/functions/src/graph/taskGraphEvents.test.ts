import assert from "node:assert/strict";
import test from "node:test";

import {
  computeTaskGraphEvents,
  isoToTimestampLike,
  timestampToMicros,
  type ComputeTaskGraphEventsInput,
  type TaskDocLike,
} from "./taskGraphEvents";

const REF = { wid: "ws1", pid: "p1", taskId: "t1" };
const FALLBACK = { seconds: 100, nanoseconds: 0 };

function input(
  before: TaskDocLike | undefined,
  after: TaskDocLike | undefined,
  overrides: Partial<ComputeTaskGraphEventsInput> = {}
): ComputeTaskGraphEventsInput {
  return {
    before,
    after,
    ref: REF,
    eventBaseId: "evt-1",
    entityRevMicros: 42,
    fallbackOccurredAt: FALLBACK,
    ...overrides,
  };
}

test("vznik dokumentu → jediný created event s eventId z event.id", () => {
  const events = computeTaskGraphEvents(
    input(undefined, { title: "Nový úkol", status: "open", visibility: "" })
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "created");
  assert.equal(events[0].eventId, "evt-1-created");
  assert.deepEqual(events[0].entity, { wid: "ws1", pid: "p1", type: "task", taskId: "t1" });
});

test("tvrdé smazání dokumentu → deleted s tombstone z `before.title`", () => {
  const events = computeTaskGraphEvents(
    input({ title: "Zbourat příčku", visibility: "" }, undefined)
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "deleted");
  if (events[0].action === "deleted") {
    assert.equal(events[0].tombstone.label, "Zbourat příčku");
  }
});

test("smazání beze jména → tombstone padá na fallback popisek", () => {
  const events = computeTaskGraphEvents(input({ visibility: "" }, undefined));
  assert.equal(events[0].action, "deleted");
  if (events[0].action === "deleted") {
    assert.equal(events[0].tombstone.label, "(bez názvu)");
  }
});

test("žádná změna mezi before/after → žádné události", () => {
  const task: TaskDocLike = { title: "X", status: "open", visibility: "" };
  const events = computeTaskGraphEvents(input(task, { ...task }));
  assert.deepEqual(events, []);
});

test("změna statusu → status_changed s ID, ne s labelem", () => {
  const events = computeTaskGraphEvents(
    input({ status: "open", visibility: "" }, { status: "in_progress", visibility: "" })
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "status_changed");
  if (events[0].action === "status_changed") {
    assert.equal(events[0].fromStatusId, "open");
    assert.equal(events[0].toStatusId, "in_progress");
  }
});

test("přiřazení řešitele → assigned s from/to principal", () => {
  const events = computeTaskGraphEvents(
    input(
      { visibility: "", assignment: {} },
      { visibility: "", assignment: { assigneeId: "u2" } }
    )
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "assigned");
  if (events[0].action === "assigned") {
    assert.equal(events[0].fromPrincipal, undefined);
    assert.equal(events[0].toPrincipal, "u2");
  }
});

test("odebrání řešitele → assigned bez toPrincipal (undefined klíč se nezapisuje)", () => {
  const events = computeTaskGraphEvents(
    input(
      { visibility: "", assignment: { assigneeId: "u2" } },
      { visibility: "", assignment: {} }
    )
  );
  assert.equal(events[0].action, "assigned");
  if (events[0].action === "assigned") {
    assert.equal(events[0].fromPrincipal, "u2");
    assert.ok(!("toPrincipal" in events[0]), "toPrincipal nesmí být zapsané jako undefined klíč");
  }
});

test("posun termínu → schedule_changed s ISO stringy", () => {
  const events = computeTaskGraphEvents(
    input(
      { visibility: "", schedule: { startDate: "2026-01-01T00:00:00.000Z" } },
      {
        visibility: "",
        schedule: { startDate: "2026-01-01T00:00:00.000Z", endDate: "2026-02-01T00:00:00.000Z" },
      }
    )
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "schedule_changed");
  if (events[0].action === "schedule_changed") {
    assert.deepEqual(events[0].from, { startDate: "2026-01-01T00:00:00.000Z" });
    assert.deepEqual(events[0].to, {
      startDate: "2026-01-01T00:00:00.000Z",
      endDate: "2026-02-01T00:00:00.000Z",
    });
  }
});

test("měkké smazání (deletedAt null→set) → deleted s tombstone z `after.title`", () => {
  const events = computeTaskGraphEvents(
    input(
      { title: "Osadit okno", visibility: "", deletedAt: null },
      { title: "Osadit okno", visibility: "", deletedAt: { seconds: 1, nanoseconds: 0 } }
    )
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "deleted");
  if (events[0].action === "deleted") {
    assert.equal(events[0].tombstone.label, "Osadit okno");
  }
});

test("obnova z koše (deletedAt set→null) → restored", () => {
  const events = computeTaskGraphEvents(
    input(
      { visibility: "", deletedAt: { seconds: 1, nanoseconds: 0 } },
      { visibility: "", deletedAt: null }
    )
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "restored");
});

test("jeden zápis vydá VÍC událostí najednou (status + assignee), s odlišnými eventId", () => {
  const events = computeTaskGraphEvents(
    input(
      { status: "open", visibility: "", assignment: {} },
      { status: "done", visibility: "", assignment: { assigneeId: "u9" } }
    )
  );
  const actions = events.map((e) => e.action).sort();
  assert.deepEqual(actions, ["assigned", "status_changed"]);
  const ids = new Set(events.map((e) => e.eventId));
  assert.equal(ids.size, events.length, "eventId musí být unikátní napříč událostmi jednoho zápisu");
});

test("actor: přednost má `after.updatedByUserId`, fallback `before`, jinak 'unknown'", () => {
  const withAfter = computeTaskGraphEvents(
    input(
      { status: "open", visibility: "", updatedByUserId: "u-before" },
      { status: "done", visibility: "", updatedByUserId: "u-after" }
    )
  );
  assert.equal(withAfter[0].actor, "u-after");

  const withoutAfterActor = computeTaskGraphEvents(
    input(
      { status: "open", visibility: "", updatedByUserId: "u-before" },
      { status: "done", visibility: "" }
    )
  );
  assert.equal(withoutAfterActor[0].actor, "u-before");

  const noActor = computeTaskGraphEvents(
    input({ status: "open", visibility: "" }, { status: "done", visibility: "" })
  );
  assert.equal(noActor[0].actor, "unknown");
});

test("vis.visibility se přebírá z úkolu (interní vs. projektový)", () => {
  const events = computeTaskGraphEvents(
    input(
      { status: "open", visibility: "company-1", ownerCompanyId: "company-1" },
      { status: "done", visibility: "company-1", ownerCompanyId: "company-1" }
    )
  );
  assert.equal(events[0].vis.visibility, "company-1");
  assert.equal(events[0].vis.ownerCompanyId, "company-1");
});

test("occurredAt vychází z `updatedAt` dat, ne z fallbacku, když je k dispozici", () => {
  const events = computeTaskGraphEvents(
    input(
      { status: "open", visibility: "", updatedAt: "2026-01-01T12:00:00.000Z" },
      { status: "done", visibility: "", updatedAt: "2026-01-02T12:00:00.000Z" }
    )
  );
  assert.deepEqual(events[0].occurredAt, isoToTimestampLike("2026-01-02T12:00:00.000Z", FALLBACK));
});

test("occurredAt padá na fallback, když `updatedAt` chybí nebo je neplatný", () => {
  const events = computeTaskGraphEvents(
    input({ status: "open", visibility: "" }, { status: "done", visibility: "", updatedAt: "not-a-date" })
  );
  assert.deepEqual(events[0].occurredAt, FALLBACK);
});

test("isoToTimestampLike: platný ISO string se převede na seconds/nanoseconds", () => {
  const result = isoToTimestampLike("2026-01-01T00:00:00.000Z", FALLBACK);
  assert.equal(result.seconds, Math.floor(Date.parse("2026-01-01T00:00:00.000Z") / 1000));
});

test("timestampToMicros: Timestamp → mikrosekundy; chybějící vstup → 0", () => {
  assert.equal(timestampToMicros({ seconds: 1, nanoseconds: 500_000 }), 1_000_500);
  assert.equal(timestampToMicros(undefined), 0);
});

// ── opravy z bezpečnostního review (Codex, 29. 8.) ─────────────────────────

test("🔴 legacy interní úkol BEZ visibility → vis se odvodí ze scope (fail-closed, žádný únik)", () => {
  const events = computeTaskGraphEvents(
    input(
      { title: "Interní", status: "open", scope: "company_internal", ownerCompanyId: "firma-a" },
      undefined
    )
  );
  assert.equal(events[0].vis.visibility, "firma-a");
});

test("🔴 legacy interní úkol bez visibility I ownerCompanyId → sentinel, který nikdo nepřečte", () => {
  const events = computeTaskGraphEvents(
    input({ title: "Interní", scope: "company_internal" }, undefined)
  );
  assert.equal(events[0].vis.visibility, "__internal_unreadable__");
});

test("legacy projektový úkol bez visibility → prázdný string (celá stavba)", () => {
  const events = computeTaskGraphEvents(
    input({ title: "Projektový", scope: "project_official" }, undefined)
  );
  assert.equal(events[0].vis.visibility, "");
});

test("deletedAt=false ani prázdný string NEjsou smazání (žádný falešný deleted)", () => {
  const before: TaskDocLike = { title: "T", status: "open", deletedAt: null, visibility: "" };
  assert.equal(
    computeTaskGraphEvents(input(before, { ...before, deletedAt: false })).length,
    0
  );
  assert.equal(
    computeTaskGraphEvents(input(before, { ...before, deletedAt: "" })).length,
    0
  );
});

test("update s rozbitým after.updatedAt → occurredAt padá na fallback, NE na staré before.updatedAt", () => {
  const events = computeTaskGraphEvents(
    input(
      { title: "T", status: "open", updatedAt: "2026-08-01T06:00:00.000Z", visibility: "" },
      { title: "T", status: "done", updatedAt: 12345, visibility: "" }
    )
  );
  assert.deepEqual(events[0].occurredAt, FALLBACK);
});
