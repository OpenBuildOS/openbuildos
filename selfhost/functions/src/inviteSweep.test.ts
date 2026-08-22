import assert from "node:assert/strict";
import test from "node:test";

import {
  INVITE_SWEEP_GRACE_DAYS,
  INVITE_SWEEP_MAX_ITEMS_PER_RUN,
  inviteSweepCutoff,
  runInviteSweep,
  type InviteSweepStore,
} from "./inviteSweep";

const NOW = new Date("2026-08-22T04:00:00Z");

function storeOf(
  data: Record<string, { expired?: string[]; used?: string[] }>,
  overrides: Partial<InviteSweepStore> = {}
): { store: InviteSweepStore; deleted: string[] } {
  const deleted: string[] = [];
  const store: InviteSweepStore = {
    listWorkspaceIds: async () => Object.keys(data),
    listExpired: async (wid) => data[wid]?.expired ?? [],
    listUsed: async (wid) => data[wid]?.used ?? [],
    deleteInvite: async (wid, token) => {
      deleted.push(`${wid}/${token}`);
    },
    ...overrides,
  };
  return { store, deleted };
}

test("inviteSweepCutoff: maže se až s odstupem, ne v okamžiku vypršení", () => {
  const cutoff = inviteSweepCutoff(NOW);
  assert.equal(
    Math.round((NOW.getTime() - cutoff.getTime()) / 86_400_000),
    INVITE_SWEEP_GRACE_DAYS
  );
  assert.ok(cutoff < NOW, "hranice leží v minulosti");
});

test("runInviteSweep: smaže prošlé i uplatněné napříč firmami", async () => {
  const { store, deleted } = storeOf({
    "ws-a": { expired: ["t1", "t2"], used: ["t3"] },
    "ws-b": { expired: [], used: ["t4"] },
    "ws-c": {},
  });

  const summary = await runInviteSweep(store, {}, NOW);

  assert.deepEqual(deleted.sort(), ["ws-a/t1", "ws-a/t2", "ws-a/t3", "ws-b/t4"]);
  assert.equal(summary.deleted, 4);
  assert.equal(summary.workspaces, 3);
  assert.equal(summary.failed, 0);
  assert.equal(summary.hitRunLimit, false);
});

test("runInviteSweep: pozvánka prošlá I uplatněná se maže jen jednou", async () => {
  const { store, deleted } = storeOf({ "ws-a": { expired: ["t1"], used: ["t1"] } });

  const summary = await runInviteSweep(store, {}, NOW);

  assert.deepEqual(deleted, ["ws-a/t1"], "dvě větve dotazu, jedno smazání");
  assert.equal(summary.deleted, 1);
});

test("runInviteSweep: selhání jedné firmy nezastaví ostatní", async () => {
  const { store, deleted } = storeOf(
    { "ws-rozbita": { expired: ["t1"] }, "ws-ok": { expired: ["t2"] } },
    {
      listExpired: async (wid) => {
        if (wid === "ws-rozbita") throw new Error("boom");
        return ["t2"];
      },
    }
  );
  const errors: string[] = [];

  const summary = await runInviteSweep(store, { onError: (message) => errors.push(message) }, NOW);

  assert.deepEqual(deleted, ["ws-ok/t2"]);
  assert.equal(summary.failed, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /ws-rozbita/);
});

test("runInviteSweep: selhání seznamu firem shodí běh, ale ne funkci", async () => {
  const { store } = storeOf({}, {
    listWorkspaceIds: async () => {
      throw new Error("nedostupné");
    },
  });
  const records: { severity: string }[] = [];

  const summary = await runInviteSweep(store, { onSummary: (record) => records.push(record) }, NOW);

  assert.equal(summary.failed, 1);
  assert.equal(summary.deleted, 0);
  assert.equal(records[0]?.severity, "warning", "prázdný běh se nesmí tvářit jako v pořádku");
});

test("runInviteSweep: strop na běh se drží a hlásí", async () => {
  const many = Array.from({ length: INVITE_SWEEP_MAX_ITEMS_PER_RUN + 40 }, (_, i) => `t${i}`);
  const { store, deleted } = storeOf({ "ws-a": { expired: many } });

  const summary = await runInviteSweep(store, {}, NOW);

  assert.equal(deleted.length, INVITE_SWEEP_MAX_ITEMS_PER_RUN);
  assert.equal(summary.hitRunLimit, true, "zbytek se dobere zítra, ale musí být vidět");
});
