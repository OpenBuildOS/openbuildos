import assert from "node:assert/strict";
import test from "node:test";
import {
  collectPlanFileReferences,
  deletableVersionObjectPaths,
  describeSweepRun,
  isVersionFileUsedByPlan,
  photoStorageObjectPaths,
  sweepExpiredTrash,
  usageDeltaForVersions,
  versionStorageObjectPaths,
  createBucketTrashStorage,
  SWEEP_LOG_EVENT,
  type ExpiredItem,
  type PlanFileReferences,
  type ProjectRef,
  type SweepLogRecord,
  type SweepSummary,
  type TrashStore,
  type TrashStorage,
  type UsageDelta,
  type VersionRecord,
} from "./trashSweep";

const PROJECT: ProjectRef = { workspaceId: "ws_demo", projectId: "p1" };
const NOW = new Date("2026-09-10T02:00:00.000Z");

interface Recorded {
  deletedDocs: string[];
  deletedVersions: string[];
  deletedObjects: string[];
  usage: UsageDelta[];
}

function makeStore(
  overrides: {
    expired?: ExpiredItem[];
    versions?: VersionRecord[];
    plans?: PlanFileReferences | null;
    projects?: ProjectRef[];
  } = {}
): { store: TrashStore; storage: TrashStorage; recorded: Recorded } {
  const recorded: Recorded = { deletedDocs: [], deletedVersions: [], deletedObjects: [], usage: [] };

  const store: TrashStore = {
    listProjects: async () => overrides.projects ?? [PROJECT],
    listExpired: async () => overrides.expired ?? [],
    listVersions: async () => overrides.versions ?? [],
    listPlanFileReferences: async () =>
      overrides.plans === undefined
        ? { fileUrls: new Set<string>(), sourceVersionIds: new Set<string>() }
        : overrides.plans,
    deleteContentDoc: async (_project, type, id) => {
      recorded.deletedDocs.push(`${type}/${id}`);
    },
    deleteVersionDoc: async (_project, versionId) => {
      recorded.deletedVersions.push(versionId);
    },
    addUsage: async (_project, delta) => {
      recorded.usage.push(delta);
    },
  };

  const storage: TrashStorage = {
    deleteObjects: async (paths) => {
      recorded.deletedObjects.push(...paths);
      return paths.length;
    },
  };

  return { store, storage, recorded };
}

// ── čisté pomocníky ─────────────────────────────────────────────────────────

test("cesty fotky = plná verze + miniatura vedle ní", () => {
  assert.deepEqual(photoStorageObjectPaths("workspaces/ws/photos/a.jpg"), [
    "workspaces/ws/photos/a.jpg",
    "workspaces/ws/photos/thumb_a.jpg",
  ]);
  assert.deepEqual(photoStorageObjectPaths(undefined), []);
  assert.deepEqual(photoStorageObjectPaths("   "), []);
});

test("cesty revize = soubor, náhled i odvozené PDF s QR", () => {
  assert.deepEqual(
    versionStorageObjectPaths({
      id: "v1",
      fileId: "docs/p1/v1/document.pdf",
      thumbnailObjectPath: "docs/p1/v1/thumb.jpg",
      qrOverlayFilePath: "docs/p1/v1/verified/document.pdf",
    }),
    [
      "docs/p1/v1/document.pdf",
      "docs/p1/v1/thumbnails/preview.jpg",
      "docs/p1/v1/thumb.jpg",
      "docs/p1/v1/verified/document.pdf",
    ]
  );
});

test("neznámé Plány = soubor revize se NESMÍ smazat", () => {
  assert.equal(isVersionFileUsedByPlan(null, { id: "v1", filePath: "https://x/a.pdf" }), true);
  assert.deepEqual(deletableVersionObjectPaths(null, [{ id: "v1", fileId: "a/b.pdf" }]), []);
});

test("soubor, na který ukazuje výkres v Plánech, zůstává", () => {
  const references = collectPlanFileReferences([
    { versions: [{ fileUrl: "https://x/a.pdf", sourceDocumentVersionId: "v1" }] },
  ]);
  assert.equal(isVersionFileUsedByPlan(references, { id: "v1", filePath: "https://x/a.pdf" }), true);
  assert.equal(isVersionFileUsedByPlan(references, { id: "v2", filePath: "https://x/b.pdf" }), false);
  assert.deepEqual(
    deletableVersionObjectPaths(references, [
      { id: "v1", fileId: "a/keep.pdf", filePath: "https://x/a.pdf" },
      { id: "v2", fileId: "a/drop.pdf", filePath: "https://x/b.pdf" },
    ]),
    ["a/drop.pdf", "a/thumbnails/preview.jpg"]
  );
});

test("odečet za revize sčítá soubor i náhled a je záporný", () => {
  assert.deepEqual(
    usageDeltaForVersions([
      { id: "v1", sizeBytes: 1000, thumbnailSizeBytes: 20 },
      { id: "v2", sizeBytes: 500 },
    ]),
    { storageBytes: -1520, docCount: -2 }
  );
});

// ── doběh: záznam I blob ────────────────────────────────────────────────────

test("fotka: smaže se ZÁZNAM I OBA BLOBY a odečte se spotřeba", async () => {
  const { store, storage, recorded } = makeStore({
    expired: [
      {
        type: "photo",
        id: "photo-1",
        storagePath: "workspaces/ws_demo/projects/p1/photos/foto.jpg",
        sizeBytes: 2048,
      },
    ],
  });

  const summary = await sweepExpiredTrash(store, storage, { now: NOW });

  assert.deepEqual(recorded.deletedDocs, ["photo/photo-1"]);
  // Jádro B3: bez tohohle by blob ve Storage zůstal osiřelý napořád.
  assert.deepEqual(recorded.deletedObjects, [
    "workspaces/ws_demo/projects/p1/photos/foto.jpg",
    "workspaces/ws_demo/projects/p1/photos/thumb_foto.jpg",
  ]);
  assert.deepEqual(recorded.usage, [{ storageBytes: -2048, photoCount: -1 }]);
  assert.equal(summary.purged.photo, 1);
  assert.equal(summary.storageObjectsDeleted, 2);
  assert.equal(summary.failures, 0);
});

test("dokument: kaskáda na revize smaže docy revizí, jejich soubory i dokument", async () => {
  const { store, storage, recorded } = makeStore({
    expired: [{ type: "document", id: "doc-1" }],
    versions: [
      { id: "v1", fileId: "docs/v1/file.pdf", filePath: "https://x/v1.pdf", sizeBytes: 100 },
      { id: "v2", fileId: "docs/v2/file.pdf", filePath: "https://x/v2.pdf", sizeBytes: 200, thumbnailSizeBytes: 5 },
    ],
  });

  await sweepExpiredTrash(store, storage, { now: NOW });

  assert.deepEqual(recorded.deletedVersions, ["v1", "v2"]);
  assert.deepEqual(recorded.deletedDocs, ["document/doc-1"]);
  assert.deepEqual(recorded.deletedObjects, [
    "docs/v1/file.pdf",
    "docs/v1/thumbnails/preview.jpg",
    "docs/v2/file.pdf",
    "docs/v2/thumbnails/preview.jpg",
  ]);
  assert.deepEqual(recorded.usage, [{ storageBytes: -305, docCount: -2 }]);
});

test("dokument: soubor pod výkresem v Plánech se nesmaže, záznamy ano", async () => {
  const { store, storage, recorded } = makeStore({
    expired: [{ type: "document", id: "doc-1" }],
    versions: [{ id: "v1", fileId: "docs/v1/file.pdf", filePath: "https://x/v1.pdf", sizeBytes: 100 }],
    plans: collectPlanFileReferences([{ versions: [{ fileUrl: "https://x/v1.pdf" }] }]),
  });

  await sweepExpiredTrash(store, storage, { now: NOW });

  assert.deepEqual(recorded.deletedVersions, ["v1"]);
  assert.deepEqual(recorded.deletedObjects, []);
  // Odečet se dělá i tak — bajty pod výkresem přebírají Plány, které se neměří.
  assert.deepEqual(recorded.usage, [{ storageBytes: -100, docCount: -1 }]);
});

test("úkol nemá soubor ani spotřebu — jen záznam", async () => {
  const { store, storage, recorded } = makeStore({ expired: [{ type: "task", id: "t1" }] });

  await sweepExpiredTrash(store, storage, { now: NOW });

  assert.deepEqual(recorded.deletedDocs, ["task/t1"]);
  assert.deepEqual(recorded.deletedObjects, []);
  assert.deepEqual(recorded.usage, []);
});

test("selhání jedné položky nezastaví ostatní", async () => {
  const { store, storage, recorded } = makeStore({
    expired: [
      { type: "task", id: "boom" },
      { type: "task", id: "ok" },
    ],
  });
  const failing: TrashStore = {
    ...store,
    deleteContentDoc: async (project, type, id) => {
      if (id === "boom") {
        throw new Error("permission-denied");
      }
      await store.deleteContentDoc(project, type, id);
    },
  };
  const errors: string[] = [];

  const summary = await sweepExpiredTrash(failing, storage, {
    now: NOW,
    onError: (message) => errors.push(message),
  });

  assert.deepEqual(recorded.deletedDocs, ["task/ok"]);
  assert.equal(summary.failures, 1);
  assert.equal(summary.purged.task, 1);
  assert.equal(errors.length, 1);
});

test("strop na běh se dodrží a ohlásí, zbytek zůstane na příště", async () => {
  const { store, storage, recorded } = makeStore({
    expired: [
      { type: "task", id: "a" },
      { type: "task", id: "b" },
      { type: "task", id: "c" },
    ],
  });

  const summary = await sweepExpiredTrash(store, storage, { now: NOW, maxItems: 2 });

  assert.deepEqual(recorded.deletedDocs, ["task/a", "task/b"]);
  assert.equal(summary.reachedLimit, true);
});

test("nedostupný seznam projektů doběh nezhavaruje, jen ohlásí", async () => {
  const { store, storage } = makeStore();
  const broken: TrashStore = {
    ...store,
    listProjects: async () => {
      throw new Error("offline");
    },
  };

  const summary = await sweepExpiredTrash(broken, storage, { now: NOW });

  assert.equal(summary.failures, 1);
  assert.equal(summary.scannedProjects, 0);
});

// ── hlášení o běhu ──────────────────────────────────────────────────────────

function summaryOf(overrides: Partial<SweepSummary> = {}): SweepSummary {
  return {
    scannedProjects: 12,
    purged: { task: 0, photo: 0, document: 0 },
    storageObjectsDeleted: 0,
    failures: 0,
    reachedLimit: false,
    ...overrides,
  };
}

test("běh bez práce a běh, který mazal, NEJSOU v logu k nerozeznání", () => {
  const idle = describeSweepRun(summaryOf());
  const busy = describeSweepRun(
    summaryOf({ purged: { task: 1, photo: 2, document: 0 }, storageObjectsDeleted: 5 })
  );

  // Přesně ta vada, kvůli které tohle vzniklo: dřív obě věty zněly „sweepExpiredTrash".
  assert.notEqual(idle.message, busy.message);
  assert.match(idle.message, /prošel 12 projektů/);
  assert.match(idle.message, /nebylo co mazat/);
  assert.match(busy.message, /smazal 3 položky \(úkoly 1, fotky 2, dokumenty 0\) a 5 objektů/);

  assert.equal(idle.payload.purgedTotal, 0);
  assert.equal(busy.payload.purgedTotal, 3);
  assert.equal(busy.payload.storageObjectsDeleted, 5);
  // Značka pro filtr v Cloud Loggingu musí být na KAŽDÉM záznamu, i na tom nudném.
  assert.equal(idle.payload.event, SWEEP_LOG_EVENT);
  assert.equal(busy.payload.event, SWEEP_LOG_EVENT);
});

test("klidný běh je INFO, chyby a došlý strop jsou VÝŠ", () => {
  assert.equal(describeSweepRun(summaryOf()).severity, "info");
  // Nedodělaný úklid = část dat leží dál. Přesně to, co má funkce řešit.
  assert.equal(describeSweepRun(summaryOf({ reachedLimit: true })).severity, "warning");
  assert.equal(describeSweepRun(summaryOf({ failures: 2 })).severity, "error");
  // Když nastane obojí, vyhrává vyšší závažnost.
  assert.equal(describeSweepRun(summaryOf({ failures: 1, reachedLimit: true })).severity, "error");
});

test("chyby i došlý strop jsou vidět i ve větě, ne jen v poli", () => {
  const record = describeSweepRun(summaryOf({ failures: 2, reachedLimit: true }));

  assert.match(record.message, /Chyby: 2/);
  assert.match(record.message, /DOŠEL STROP BĚHU/);
  assert.equal(record.payload.failures, 2);
  assert.equal(record.payload.reachedLimit, true);
});

test("české číslovky: „smazal 3 položek“ se do logu nedostane", () => {
  assert.match(describeSweepRun(summaryOf({ purged: { task: 1, photo: 0, document: 0 } })).message, /smazal 1 položku/);
  assert.match(describeSweepRun(summaryOf({ purged: { task: 2, photo: 0, document: 0 } })).message, /smazal 2 položky/);
  assert.match(describeSweepRun(summaryOf({ purged: { task: 5, photo: 0, document: 0 } })).message, /smazal 5 položek/);
  assert.match(describeSweepRun(summaryOf({ scannedProjects: 1 })).message, /prošel 1 projekt,/);
});

test("doběh souhrn opravdu ohlásí — právě jednou a s tím, co udělal", async () => {
  const { store, storage } = makeStore({
    expired: [
      {
        type: "photo",
        id: "photo-1",
        storagePath: "workspaces/ws_demo/projects/p1/photos/foto.jpg",
        sizeBytes: 2048,
      },
    ],
  });
  const records: SweepLogRecord[] = [];

  await sweepExpiredTrash(store, storage, { now: NOW, onSummary: (record) => records.push(record) });

  assert.equal(records.length, 1);
  assert.equal(records[0].severity, "info");
  assert.equal(records[0].payload.purgedPhotos, 1);
  assert.equal(records[0].payload.storageObjectsDeleted, 2);
});

test("i běh, který se ani nerozjel, o sobě dá vědět — a jako ERROR", async () => {
  const { store, storage } = makeStore();
  const broken: TrashStore = {
    ...store,
    listProjects: async () => {
      throw new Error("offline");
    },
  };
  const records: SweepLogRecord[] = [];

  await sweepExpiredTrash(broken, storage, { now: NOW, onSummary: (record) => records.push(record) });

  // Tichý návrat na téhle větvi byl původní stav: doběh se přeskočil a nikdo nic nevěděl.
  assert.equal(records.length, 1);
  assert.equal(records[0].severity, "error");
  assert.equal(records[0].payload.scannedProjects, 0);
});

test("v souhrnu nejsou identifikátory ani cesty k souborům", async () => {
  const { store, storage } = makeStore({
    expired: [
      {
        type: "photo",
        id: "photo-tajne-jmeno",
        storagePath: "workspaces/ws_demo/projects/p1/photos/pepa-novak.jpg",
        sizeBytes: 10,
      },
    ],
  });
  const records: SweepLogRecord[] = [];

  await sweepExpiredTrash(store, storage, { now: NOW, onSummary: (record) => records.push(record) });

  // Log doběhu je agregát. Konkrétní projekt patří jen k chybě (onError), osobní údaje nikam.
  const dumped = JSON.stringify(records[0]);
  for (const leak of ["photo-tajne-jmeno", "pepa-novak", "ws_demo", "projects/p1"]) {
    assert.equal(dumped.includes(leak), false, `souhrn nesmí obsahovat "${leak}"`);
  }
});

// ── adaptér nad bucketem ────────────────────────────────────────────────────

test("chybějící objekt (404) není chyba, ostatní se ohlásí a nevyhodí", async () => {
  const attempted: string[] = [];
  const errors: string[] = [];
  const storage = createBucketTrashStorage(
    {
      file: (path: string) => ({
        delete: async () => {
          attempted.push(path);
          if (path.includes("missing")) {
            throw Object.assign(new Error("No such object"), { code: 404 });
          }
          if (path.includes("denied")) {
            throw Object.assign(new Error("forbidden"), { code: 403 });
          }
          return undefined;
        },
      }),
    },
    (message) => errors.push(message)
  );

  const deleted = await storage.deleteObjects(["a/ok.jpg", "a/missing.jpg", "a/denied.jpg", "a/ok.jpg"]);

  // Duplicity se zahazují — týž objekt se nemaže dvakrát.
  assert.deepEqual(attempted, ["a/ok.jpg", "a/missing.jpg", "a/denied.jpg"]);
  assert.equal(deleted, 1);
  assert.equal(errors.length, 1);
});
