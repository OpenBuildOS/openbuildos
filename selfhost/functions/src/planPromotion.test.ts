import assert from "node:assert/strict";
import test from "node:test";
import type { Firestore } from "firebase-admin/firestore";
import {
  decidePromotion,
  isApprovalTransition,
  promoteApprovedDrawing,
  readPromotionMarker,
  samePlanName,
  stripUndefinedDeep,
  toIsoOrUndefined,
  type SourceDocumentRecord,
  type SourceVersionRecord,
  type StoredPlan,
} from "./planPromotion";

const NOW = new Date("2026-08-06T10:00:00.000Z");
const FILE_URL = "https://firebasestorage.googleapis.com/v0/b/x/o/doc.pdf?alt=media&token=abc";

function makeVersion(overrides: Partial<SourceVersionRecord> = {}): SourceVersionRecord {
  return {
    id: "v1",
    documentId: "d1",
    status: "approved",
    filePath: FILE_URL,
    thumbnailUrl: "https://firebasestorage.googleapis.com/thumb.jpg",
    pageCount: 1,
    versionLabel: "B",
    uploadedBy: "principal-uploader",
    uploadedAt: "2026-08-01T08:00:00.000Z",
    ...overrides,
  };
}

function makeDocument(overrides: Partial<SourceDocumentRecord> = {}): SourceDocumentRecord {
  return {
    id: "d1",
    title: "D.1.1 Půdorys 1.NP",
    discipline: "DRAWING",
    folderPath: "D/D.1",
    ...overrides,
  };
}

/** Deterministické id, ať se dají výsledky porovnávat. */
function sequentialIds(prefix = "id") {
  let counter = 0;
  return () => `${prefix}-${(counter += 1)}`;
}

// ── gate triggeru ────────────────────────────────────────────────────────────

test("trigger pouští jen PŘECHOD do schváleného stavu", () => {
  assert.equal(isApprovalTransition("under_review", "approved"), true);
  assert.equal(isApprovalTransition("draft", "approved_with_comments"), true);
  assert.equal(isApprovalTransition(undefined, "approved"), true);
  assert.equal(isApprovalTransition("under_review", "rejected"), false);
  assert.equal(isApprovalTransition("approved", "superseded"), false);
});

test("zápis markeru nesmí roztočit smyčku: stejný stav → nic", () => {
  // Funkce si po povýšení zapíše `planPromotion` na tutéž revizi, čímž trigger
  // spustí podruhé. Tehdy se status nezměnil, takže se musí hned zastavit.
  assert.equal(isApprovalTransition("approved", "approved"), false);
  assert.equal(isApprovalTransition("approved_with_comments", "approved_with_comments"), false);
});

// ── podmínky povýšení (tytéž, které měl klient) ──────────────────────────────

test("nevýkres se nepovyšuje", () => {
  const decision = decidePromotion({
    version: makeVersion(),
    document: makeDocument({ discipline: "SPEC" }),
    plans: [],
    now: NOW,
  });
  assert.deepEqual(decision, { kind: "skip", reason: "not_a_drawing" });
});

test("vícestránkové PDF si vybírá strany člověk, ne server", () => {
  for (const pageCount of [2, 12, undefined, null, "1"]) {
    const decision = decidePromotion({
      version: makeVersion({ pageCount }),
      document: makeDocument(),
      plans: [],
      now: NOW,
    });
    assert.deepEqual(decision, { kind: "skip", reason: "not_single_page" }, `pageCount=${String(pageCount)}`);
  }
});

test("nedostupný soubor se NEPOVYŠUJE a nese si důvod pro UI", () => {
  const decision = decidePromotion({
    version: makeVersion({ filePath: "" }),
    document: makeDocument(),
    plans: [],
    now: NOW,
  });
  assert.equal(decision.kind, "skip");
  assert.equal(decision.kind === "skip" && decision.reason, "file_unavailable");
  assert.equal(decision.kind === "skip" && decision.markSkip, true);
});

test("interní firemní dokument do oficiálních Plánů nepatří", () => {
  const decision = decidePromotion({
    version: makeVersion({ scope: "company_internal" }),
    document: makeDocument(),
    plans: [],
    now: NOW,
  });
  assert.equal(decision.kind === "skip" && decision.reason, "company_internal");
});

test("neschválená revize se nepovyšuje", () => {
  const decision = decidePromotion({
    version: makeVersion({ status: "under_review" }),
    document: makeDocument(),
    plans: [],
    now: NOW,
  });
  assert.deepEqual(decision, { kind: "skip", reason: "version_not_approved" });
});

test("chybějící dokument nebo revize skončí odmítnutím, ne výjimkou", () => {
  assert.deepEqual(decidePromotion({ version: null, document: makeDocument(), plans: [], now: NOW }), {
    kind: "skip",
    reason: "version_missing",
  });
  assert.deepEqual(decidePromotion({ version: makeVersion(), document: null, plans: [], now: NOW }), {
    kind: "skip",
    reason: "document_missing",
  });
});

// ── založení nového výkresu ──────────────────────────────────────────────────

test("z jednostránkového výkresu vznikne nový plán s platnou revizí", () => {
  const decision = decidePromotion({
    version: makeVersion(),
    document: makeDocument(),
    plans: [],
    uploadedByName: "Jan Novák",
    now: NOW,
    newId: sequentialIds("plan"),
  });

  assert.equal(decision.kind, "write");
  if (decision.kind !== "write") return;
  assert.equal(decision.created, true);

  const plan = decision.plan;
  assert.equal(plan.name, "D.1.1 Půdorys 1.NP");
  assert.equal(plan.kind, "plan");
  assert.equal(plan.status, "approved");
  assert.equal(plan.folderPath, "D/D.1");
  assert.equal(plan.versions.length, 1);
  assert.equal(plan.validVersionId, plan.versions[0].id);
  assert.equal(plan.currentVersionId, plan.versions[0].id);
  assert.equal(plan.createdAt, NOW.toISOString());

  const version = plan.versions[0];
  assert.equal(version.versionNumber, 1);
  assert.equal(version.status, "approved");
  assert.equal(version.revisionLabel, "B");
  assert.equal(version.uploadedByName, "Jan Novák");
  assert.equal(version.sourceDocumentId, "d1");
  assert.equal(version.sourceDocumentVersionId, "v1");
  assert.equal(version.uploadedAt, "2026-08-01T08:00:00.000Z");
});

/**
 * 🔴 Nález z prokliknutí stagingu (27. 8. 2026), navazuje na #800.
 *
 * Rozměr listu je jediný podklad, podle kterého `planRevisionCarry` na klientu
 * pozná, že nová revize je na jinak tvarovaném listu a pin se na ni přenést
 * nesmí. Server PDF neotevírá — proto ho čte z revize dokumentu, kam ho zapsal
 * klient při příjmu. Když se sem nedonese, revize výkresu ho nemá vůbec a
 * kontrola padá na „přenes 1:1", tedy na tichý posun pinu na cizí místo.
 */
test("revize výkresu si nese rozměr listu změřený při příjmu dokumentu", () => {
  const decision = decidePromotion({
    version: makeVersion({ pageWidthUnits: 595, pageHeightUnits: 420 }),
    document: makeDocument(),
    plans: [],
    now: NOW,
    newId: sequentialIds("plan"),
  });

  assert.equal(decision.kind, "write");
  if (decision.kind !== "write") return;
  assert.equal(decision.plan.versions[0].widthUnits, 595);
  assert.equal(decision.plan.versions[0].heightUnits, 420);
});

test("nesmyslný rozměr se nepřevezme — radši žádný než nula", () => {
  // Nula by v poměru stran znamenala dělení nulou; text („595") zase porovnání
  // dvou nesouměřitelných hodnot. Obojí by z guardu udělalo náhodný generátor.
  const decision = decidePromotion({
    version: makeVersion({ pageWidthUnits: 0, pageHeightUnits: "420" }),
    document: makeDocument(),
    plans: [],
    now: NOW,
    newId: sequentialIds("plan"),
  });

  assert.equal(decision.kind, "write");
  if (decision.kind !== "write") return;
  assert.equal(decision.plan.versions[0].widthUnits, undefined);
  assert.equal(decision.plan.versions[0].heightUnits, undefined);
});

test("🔴 soubor se NEKOPÍRUJE — fileUrl je týž objekt jako filePath revize", () => {
  // Na tom závisí mazání revizí (`src/services/planFileReferences.ts`):
  // vazba plán↔objekt se hledá porovnáním fileUrl. Kopie by ji rozbila.
  const decision = decidePromotion({
    version: makeVersion(),
    document: makeDocument(),
    plans: [],
    now: NOW,
    newId: sequentialIds(),
  });
  assert.equal(decision.kind, "write");
  if (decision.kind !== "write") return;
  assert.equal(decision.plan.versions[0].fileUrl, FILE_URL);
  assert.equal(
    decision.plan.versions[0].thumbnailUrl,
    "https://firebasestorage.googleapis.com/thumb.jpg",
    "náhled se recykluje z dokumentu, negeneruje se znovu"
  );
});

test("chybějící label spadne na R01, R02… stejně jako klient", () => {
  const decision = decidePromotion({
    version: makeVersion({ versionLabel: undefined }),
    document: makeDocument(),
    plans: [],
    now: NOW,
    newId: sequentialIds(),
  });
  assert.equal(decision.kind === "write" && decision.plan.versions[0].revisionLabel, "R01");
});

// ── navázání na existující výkres ────────────────────────────────────────────

function existingPlan(overrides: Partial<StoredPlan> = {}): StoredPlan {
  return {
    id: "plan-existing",
    projectId: "p1",
    name: "  d.1.1 půdorys 1.np  ",
    kind: "plan",
    status: "approved",
    validVersionId: "pv-old",
    currentVersionId: "pv-old",
    versions: [
      {
        id: "pv-old",
        planId: "plan-existing",
        versionNumber: 3,
        fileUrl: "https://storage/old.pdf",
        fileName: "old.pdf",
        status: "approved",
        sourceDocumentVersionId: "v0",
        createdAt: "2026-07-01T00:00:00.000Z",
      },
    ],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

test("shoda názvu je case/whitespace insensitive — nevzniká druhý výkres", () => {
  assert.equal(samePlanName("  D.1.1 Půdorys 1.NP ", "d.1.1 půdorys 1.np"), true);

  const decision = decidePromotion({
    version: makeVersion(),
    document: makeDocument(),
    plans: [existingPlan()],
    now: NOW,
    newId: sequentialIds("new"),
  });

  assert.equal(decision.kind, "write");
  if (decision.kind !== "write") return;
  assert.equal(decision.created, false);
  assert.equal(decision.plan.id, "plan-existing");
  assert.equal(decision.plan.versions.length, 2);
  assert.equal(decision.plan.versions[0].status, "superseded", "předchozí revize se překlopí na superseded");
  assert.equal(decision.plan.versions[1].versionNumber, 4);
  assert.equal(decision.plan.validVersionId, decision.plan.versions[1].id);
});

// ── idempotence ──────────────────────────────────────────────────────────────

test("marker `promoted` zastaví druhé spuštění", () => {
  const decision = decidePromotion({
    version: makeVersion({ planPromotion: { status: "promoted", planId: "plan-x", at: "2026-08-06T09:00:00.000Z" } }),
    document: makeDocument(),
    plans: [],
    now: NOW,
  });
  assert.deepEqual(decision, { kind: "skip", reason: "already_promoted", planId: "plan-x" });
});

test("revize povýšená starým klientem (bez markeru) jen znovu ukotví platnou revizi", () => {
  const plan = existingPlan({
    versions: [
      {
        id: "pv-from-v1",
        planId: "plan-existing",
        versionNumber: 4,
        fileUrl: FILE_URL,
        fileName: "x.pdf",
        status: "approved",
        sourceDocumentVersionId: "v1",
        createdAt: "2026-08-05T00:00:00.000Z",
      },
    ],
  });

  const decision = decidePromotion({
    version: makeVersion(),
    document: makeDocument(),
    plans: [plan],
    now: NOW,
    newId: sequentialIds("must-not-be-used"),
  });

  assert.equal(decision.kind, "write");
  if (decision.kind !== "write") return;
  assert.equal(decision.plan.versions.length, 1, "žádná duplicitní revize");
  assert.equal(decision.plan.validVersionId, "pv-from-v1");
  assert.equal(decision.planVersionId, "pv-from-v1");
});

test("marker `skipped` nebo `failed` povýšení NEBLOKUJE (jde o opakovatelné selhání)", () => {
  const decision = decidePromotion({
    version: makeVersion({ planPromotion: { status: "skipped", reason: "file_unavailable", at: "x" } }),
    document: makeDocument(),
    plans: [],
    now: NOW,
    newId: sequentialIds(),
  });
  assert.equal(decision.kind, "write");
});

test("poškozený marker se ignoruje", () => {
  assert.equal(readPromotionMarker(null), null);
  assert.equal(readPromotionMarker("promoted"), null);
  assert.equal(readPromotionMarker({ status: "nesmysl" }), null);
  assert.equal(readPromotionMarker({ status: "promoted", planId: "p" })?.planId, "p");
});

// ── tvar zápisu ──────────────────────────────────────────────────────────────

test("zapsaný plán nesmí obsahovat undefined ani Date (klient čte ISO řetězce)", () => {
  const decision = decidePromotion({
    version: makeVersion({ thumbnailUrl: undefined, uploadedBy: undefined }),
    document: makeDocument({ folderPath: undefined }),
    plans: [],
    now: NOW,
    newId: sequentialIds(),
  });
  assert.equal(decision.kind, "write");
  if (decision.kind !== "write") return;

  const stripped = stripUndefinedDeep(decision.plan) as Record<string, unknown>;
  const walk = (value: unknown, path: string) => {
    assert.ok(!(value instanceof Date), `${path} je Date, má být ISO řetězec`);
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
    } else if (value && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) {
        assert.notEqual(entry, undefined, `${path}.${key} je undefined`);
        walk(entry, `${path}.${key}`);
      }
    }
  };
  walk(stripped, "plan");
  assert.equal("thumbnailUrl" in (stripped.versions as Record<string, unknown>[])[0], false);
});

test("toIsoOrUndefined unese Timestamp, Date, ISO i nesmysl", () => {
  assert.equal(toIsoOrUndefined({ toDate: () => new Date("2026-01-02T03:04:05.000Z") }), "2026-01-02T03:04:05.000Z");
  assert.equal(toIsoOrUndefined(new Date("2026-01-02T03:04:05.000Z")), "2026-01-02T03:04:05.000Z");
  assert.equal(toIsoOrUndefined("2026-01-02T03:04:05.000Z"), "2026-01-02T03:04:05.000Z");
  assert.equal(toIsoOrUndefined("nesmysl"), undefined);
  assert.equal(toIsoOrUndefined(undefined), undefined);
});

// ── transakční vrstva nad falešným Firestorem ────────────────────────────────

interface FakeStore {
  docs: Map<string, Record<string, unknown>>;
  reads: string[];
}

/**
 * Minimální Firestore stub: `doc`, `collection`, `runTransaction`. Stačí na
 * ověření drátování transakce (co se čte, co se zapisuje) bez emulátoru.
 */
function fakeFirestore(seed: Record<string, Record<string, unknown>>): { store: FakeStore; firestore: Firestore } {
  const store: FakeStore = { docs: new Map(Object.entries(seed)), reads: [] };

  const docRef = (path: string) => ({
    __path: path,
    id: path.slice(path.lastIndexOf("/") + 1),
  });
  const collectionRef = (path: string) => ({ __collection: path });

  const firestore = {
    doc: docRef,
    collection: collectionRef,
    async runTransaction<T>(callback: (transaction: unknown) => Promise<T>): Promise<T> {
      const writes: Array<{ path: string; data: Record<string, unknown>; merge: boolean }> = [];
      const transaction = {
        async get(target: { __path?: string; __collection?: string }) {
          if (target.__path) {
            store.reads.push(target.__path);
            const data = store.docs.get(target.__path);
            return {
              exists: data !== undefined,
              id: target.__path.slice(target.__path.lastIndexOf("/") + 1),
              data: () => data,
            };
          }
          const prefix = `${target.__collection}/`;
          store.reads.push(target.__collection as string);
          const docs = [...store.docs.entries()]
            .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
            .map(([path, data]) => ({ id: path.slice(prefix.length), data: () => data }));
          return { docs };
        },
        set(target: { __path: string }, data: Record<string, unknown>, options?: { merge?: boolean }) {
          writes.push({ path: target.__path, data, merge: options?.merge === true });
        },
      };
      const result = await callback(transaction);
      for (const write of writes) {
        const previous = write.merge ? (store.docs.get(write.path) ?? {}) : {};
        store.docs.set(write.path, { ...previous, ...write.data });
      }
      return result;
    },
  };

  return { store, firestore: firestore as unknown as Firestore };
}

const BASE = "workspaces/w1/projects/p1";

function seedApprovedDrawing() {
  return {
    [`${BASE}/documentVersions/v1`]: {
      documentId: "d1",
      status: "approved",
      filePath: FILE_URL,
      pageCount: 1,
      versionLabel: "B",
      uploadedBy: "principal-uploader",
      uploadedAt: "2026-08-01T08:00:00.000Z",
    },
    [`${BASE}/documents/d1`]: {
      title: "D.1.1 Půdorys 1.NP",
      discipline: "DRAWING",
      folderPath: "D/D.1",
    },
    [`${BASE}/members/principal-uploader`]: { displayName: "Jan Novák", role: "editor" },
  } as Record<string, Record<string, unknown>>;
}

test("povýšení zapíše plán i marker na revizi", async () => {
  const { store, firestore } = fakeFirestore(seedApprovedDrawing());
  const result = await promoteApprovedDrawing(firestore, {
    workspaceId: "w1",
    projectId: "p1",
    versionId: "v1",
    now: NOW,
  });

  assert.equal(result.outcome, "promoted");
  assert.ok(result.planId);

  const plan = store.docs.get(`${BASE}/plans/${result.planId}`) as Record<string, unknown>;
  assert.ok(plan, "plán musí být ve Firestoru, ne v localStorage");
  assert.equal(plan.projectId, "p1");
  assert.equal(plan.name, "D.1.1 Půdorys 1.NP");
  const versions = plan.versions as Array<Record<string, unknown>>;
  assert.equal(versions[0].fileUrl, FILE_URL);
  assert.equal(versions[0].uploadedByName, "Jan Novák", "jméno se dotáhne z adresáře členů projektu");

  const marker = (store.docs.get(`${BASE}/documentVersions/v1`) as Record<string, unknown>).planPromotion as Record<
    string,
    unknown
  >;
  assert.equal(marker.status, "promoted");
  assert.equal(marker.planId, result.planId);
});

test("🔴 dvojí spuštění nesmí vyrobit dva plány", async () => {
  const { store, firestore } = fakeFirestore(seedApprovedDrawing());
  const first = await promoteApprovedDrawing(firestore, {
    workspaceId: "w1",
    projectId: "p1",
    versionId: "v1",
    now: NOW,
  });
  const second = await promoteApprovedDrawing(firestore, {
    workspaceId: "w1",
    projectId: "p1",
    versionId: "v1",
    now: NOW,
  });

  assert.equal(first.outcome, "promoted");
  assert.equal(second.outcome, "skipped");
  assert.equal(second.reason, "already_promoted");
  assert.equal(second.planId, first.planId);

  const planPaths = [...store.docs.keys()].filter((path) => path.startsWith(`${BASE}/plans/`));
  assert.deepEqual(planPaths, [`${BASE}/plans/${first.planId}`]);
});

test("registr plánů se nečte, když dokument není jednostránkový výkres", async () => {
  const seed = seedApprovedDrawing();
  seed[`${BASE}/documents/d1`] = { title: "Zpráva", discipline: "SPEC" };
  const { store, firestore } = fakeFirestore(seed);

  const result = await promoteApprovedDrawing(firestore, {
    workspaceId: "w1",
    projectId: "p1",
    versionId: "v1",
    now: NOW,
  });

  assert.equal(result.outcome, "skipped");
  assert.equal(result.reason, "not_a_drawing");
  assert.equal(store.reads.includes(`${BASE}/plans`), false, "kolekce plánů se nesmí číst zbytečně");
  assert.equal(
    "planPromotion" in (store.docs.get(`${BASE}/documentVersions/v1`) as Record<string, unknown>),
    false,
    "u nevýkresu se marker nezapisuje (jinak by se trigger budil pro nic)"
  );
});

test("nedostupný soubor se zapíše jako `skipped`, aby to šlo v UI ukázat", async () => {
  const seed = seedApprovedDrawing();
  seed[`${BASE}/documentVersions/v1`] = { ...seed[`${BASE}/documentVersions/v1`], filePath: "blob:local" };
  const { store, firestore } = fakeFirestore(seed);

  const result = await promoteApprovedDrawing(firestore, {
    workspaceId: "w1",
    projectId: "p1",
    versionId: "v1",
    now: NOW,
  });

  assert.equal(result.reason, "file_unavailable");
  const marker = (store.docs.get(`${BASE}/documentVersions/v1`) as Record<string, unknown>).planPromotion as Record<
    string,
    unknown
  >;
  assert.equal(marker.status, "skipped");
  assert.equal(marker.reason, "file_unavailable");
});

test("chybějící revize skončí odmítnutím bez zápisu", async () => {
  const { store, firestore } = fakeFirestore({});
  const result = await promoteApprovedDrawing(firestore, {
    workspaceId: "w1",
    projectId: "p1",
    versionId: "v1",
    now: NOW,
  });
  assert.equal(result.reason, "version_missing");
  assert.equal(store.docs.size, 0);
});
