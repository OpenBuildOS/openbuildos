import assert from "node:assert/strict";
import test from "node:test";
import {
  createBucketReportStorage,
  runReportSweep,
  REPORT_SWEEP_MAX_ITEMS_PER_RUN,
  type ExpiredReport,
  type ProjectRef,
  type ReportStorage,
  type ReportStore,
} from "./reportSweep";

const PROJECT: ProjectRef = { workspaceId: "ws_demo", projectId: "p1" };

/** Falešná datová vrstva, která si zapisuje POŘADÍ volání — na něm tenhle úklid stojí. */
function makeStore(reports: ExpiredReport[], overrides: Partial<ReportStore> = {}) {
  const calls: string[] = [];
  const usage: number[] = [];
  const store: ReportStore = {
    async listProjects() {
      return [PROJECT];
    },
    async listExpired() {
      return reports;
    },
    async deleteReportDoc(_project, reportId) {
      calls.push(`doc:${reportId}`);
    },
    async deleteShareLink(_project, token) {
      calls.push(`share:${token}`);
    },
    async addUsage(_project, delta) {
      usage.push(delta.storageBytes);
    },
    ...overrides,
  };
  return { store, calls, usage };
}

function makeStorage(calls: string[]): ReportStorage {
  return {
    async deleteObjects(paths) {
      for (const path of paths) {
        calls.push(`object:${path}`);
      }
      return paths.length;
    },
  };
}

test("🔴 objekt se maže PŘED záznamem — opačné pořadí by při selhání vyrobilo sirotka", async () => {
  const { store, calls } = makeStore([{ id: "r1", storagePath: "ws/p1/reports/r1/report.pdf", sizeBytes: 100 }]);
  const storage = makeStorage(calls);

  await runReportSweep(store, storage);

  assert.deepEqual(calls, ["object:ws/p1/reports/r1/report.pdf", "doc:r1"]);
});

test("smaže i sdílecí odkaz, ať po reportu nezůstane živý /share/…", async () => {
  const { store, calls } = makeStore([
    { id: "r1", storagePath: "ws/p1/reports/r1/report.pdf", sizeBytes: 10, shareToken: "tok" },
  ]);

  await runReportSweep(store, makeStorage(calls));

  assert.deepEqual(calls, ["object:ws/p1/reports/r1/report.pdf", "share:tok", "doc:r1"]);
});

test("🔴 odečet spotřeby visí na smazání ZÁZNAMU — když selže, spotřeba se neodečte", async () => {
  const { store, usage } = makeStore([{ id: "r1", storagePath: "path", sizeBytes: 2_048 }], {
    async deleteReportDoc() {
      throw new Error("Firestore je pryč");
    },
  });

  const summary = await runReportSweep(store, { async deleteObjects() { return 1; } });

  // Kdyby se odečetlo i tak, počítadlo by se po opakovaném běhu propadlo pod
  // skutečnost — položku totiž další běh najde znovu a odečetl by ji podruhé.
  assert.deepEqual(usage, []);
  assert.equal(summary.deletedReports, 0);
  assert.equal(summary.failed, 1);
  assert.equal(summary.freedBytes, 0);
});

test("úspěšný úklid odečte přesně velikost souboru, a to jednou", async () => {
  const { store, usage } = makeStore([
    { id: "r1", storagePath: "a", sizeBytes: 1_000 },
    { id: "r2", storagePath: "b", sizeBytes: 500 },
  ]);

  const summary = await runReportSweep(store, { async deleteObjects() { return 1; } });

  assert.deepEqual(usage, [-1_000, -500]);
  assert.equal(summary.freedBytes, 1_500);
  assert.equal(summary.deletedReports, 2);
});

test("záznam bez cesty k objektu úklid NEZHATÍ — jen se nemá co mazat", async () => {
  const { store, calls } = makeStore([{ id: "r1", sizeBytes: 10 }]);

  const summary = await runReportSweep(store, makeStorage(calls));

  assert.deepEqual(calls, ["doc:r1"]);
  assert.equal(summary.deletedReports, 1);
  assert.equal(summary.deletedObjects, 0);
});

test("selhání jednoho reportu nezastaví ostatní", async () => {
  let first = true;
  const { store } = makeStore([
    { id: "r1", storagePath: "a", sizeBytes: 1 },
    { id: "r2", storagePath: "b", sizeBytes: 2 },
  ], {
    async deleteReportDoc() {
      if (first) {
        first = false;
        throw new Error("první spadl");
      }
    },
  });

  const summary = await runReportSweep(store, { async deleteObjects() { return 1; } });

  assert.equal(summary.failed, 1);
  assert.equal(summary.deletedReports, 1);
});

test("běh se zastaví na stropu a přizná to, aby zbytek nezmizel bez stopy", async () => {
  const many: ExpiredReport[] = Array.from({ length: REPORT_SWEEP_MAX_ITEMS_PER_RUN + 10 }, (_, index) => ({
    id: `r${index}`,
    storagePath: `path-${index}`,
    sizeBytes: 1,
  }));
  const { store } = makeStore(many);

  const summary = await runReportSweep(store, { async deleteObjects() { return 1; } });

  assert.equal(summary.deletedReports, REPORT_SWEEP_MAX_ITEMS_PER_RUN);
  assert.equal(summary.hitRunLimit, true);
});

test("nedostupné projekty skončí hlášeným selháním, ne tichým prázdným během", async () => {
  const errors: string[] = [];
  const summary = await runReportSweep(
    {
      async listProjects() {
        throw new Error("bez sítě");
      },
      async listExpired() {
        return [];
      },
      async deleteReportDoc() {},
      async deleteShareLink() {},
      async addUsage() {},
    },
    { async deleteObjects() { return 0; } },
    { onError: (message) => errors.push(message) }
  );

  assert.equal(summary.failed, 1);
  assert.equal(errors.length, 1);
});

test("souhrn běhu nese závažnost podle výsledku — tichý log u mazání dat je jako žádný", async () => {
  const records: { severity: string; payload: Record<string, unknown> }[] = [];
  const { store } = makeStore([{ id: "r1", storagePath: "a", sizeBytes: 5 }]);

  await runReportSweep(store, { async deleteObjects() { return 1; } }, {
    onSummary: (record) => records.push(record),
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].severity, "info");
  assert.equal(records[0].payload.event, "report_sweep_finished");
});

test("chybějící objekt (404) není chyba — úklid mohl minule doběhnout jen zpola", async () => {
  const errors: string[] = [];
  const storage = createBucketReportStorage(
    {
      file() {
        return {
          async delete() {
            throw Object.assign(new Error("not found"), { code: 404 });
          },
        };
      },
    },
    (message) => errors.push(message)
  );

  assert.equal(await storage.deleteObjects(["chybi.pdf"]), 0);
  assert.deepEqual(errors, []);
});
