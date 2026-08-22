import assert from "node:assert/strict";
import test from "node:test";
import type { Firestore } from "firebase-admin/firestore";
import type { Storage } from "firebase-admin/storage";
import {
  ShareLinkRotationError,
  buildDownloadUrl,
  canEditProjectContent,
  createFirestoreShareLinkStore,
  parseStorageObjectFromDownloadUrl,
  pointsAtStorageObject,
  refreshedUrlFields,
  refreshedUrlsInArray,
  revokeShareLinkAndRotate,
  type RefreshStoredDownloadUrlsInput,
  type ShareLinkRecord,
  type ShareLinkRotationStore,
} from "./shareLinkRotation";

// ⭐ SDÍLENÝ SOUBOR — identický v obou repech (docs/REPO_BOUNDARIES.md).

const FILE_URL =
  "https://firebasestorage.googleapis.com/v0/b/obos.firebasestorage.app/o/" +
  "workspaces%2Fws_1%2Fprojects%2Fp1%2Fphotos%2Fph1%2Ffoto.jpg?alt=media&token=old-token";

const OBJECT = {
  bucket: "obos.firebasestorage.app",
  objectPath: "workspaces/ws_1/projects/p1/photos/ph1/foto.jpg",
};

interface FakeStoreOptions {
  workspace?: { ownerId?: string; adminIds?: string[] } | null;
  project?: { workspaceId?: string; roles?: Record<string, string> } | null;
  shareLink?: ShareLinkRecord | null;
  rotateThrows?: Error;
  refreshThrows?: Error;
}

function fakeStore(options: FakeStoreOptions = {}) {
  const calls = {
    rotated: [] as string[],
    revoked: [] as string[],
    refreshed: [] as RefreshStoredDownloadUrlsInput[],
  };
  const store: ShareLinkRotationStore = {
    loadWorkspace: async () =>
      options.workspace === undefined ? { ownerId: "owner-1" } : options.workspace,
    loadProject: async () =>
      options.project === undefined ? { workspaceId: "ws_1", roles: {} } : options.project,
    loadShareLink: async () =>
      options.shareLink === undefined ? { fileUrl: FILE_URL, revoked: false } : options.shareLink,
    markShareLinkRevoked: async (wid, pid, token) => {
      calls.revoked.push(`${wid}/${pid}/${token}`);
    },
    rotateDownloadToken: async ({ bucket, objectPath }) => {
      if (options.rotateThrows) {
        throw options.rotateThrows;
      }
      calls.rotated.push(`${bucket}::${objectPath}`);
      return "novy-token";
    },
    refreshStoredDownloadUrls: async (input) => {
      if (options.refreshThrows) {
        throw options.refreshThrows;
      }
      calls.refreshed.push(input);
      return 2;
    },
  };
  return { store, calls };
}

const INPUT = { workspaceId: "ws_1", projectId: "p1", token: "t1", principal: "owner-1" };

async function expectCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ShareLinkRotationError, `čekal ShareLinkRotationError, přišlo ${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

test("parseStorageObjectFromDownloadUrl rozebere Firebase download URL", () => {
  assert.deepEqual(parseStorageObjectFromDownloadUrl(FILE_URL), {
    bucket: "obos.firebasestorage.app",
    objectPath: "workspaces/ws_1/projects/p1/photos/ph1/foto.jpg",
  });
});

test("parseStorageObjectFromDownloadUrl zvládne i přímou storage.googleapis.com adresu", () => {
  assert.deepEqual(
    parseStorageObjectFromDownloadUrl("https://storage.googleapis.com/bkt/a/b/c.pdf"),
    { bucket: "bkt", objectPath: "a/b/c.pdf" }
  );
});

test("parseStorageObjectFromDownloadUrl odmítne cizí i rozbitou adresu", () => {
  for (const value of ["https://example.com/soubor.jpg", "vůbec-ne-url", ""]) {
    assert.throws(
      () => parseStorageObjectFromDownloadUrl(value),
      (error: unknown) =>
        error instanceof ShareLinkRotationError && error.code === "failed-precondition"
    );
  }
});

test("buildDownloadUrl skládá adresu, kterou jde zpátky rozebrat", () => {
  const url = buildDownloadUrl(OBJECT, "t-2");
  assert.deepEqual(parseStorageObjectFromDownloadUrl(url), OBJECT);
  assert.equal(new URL(url).searchParams.get("token"), "t-2");
});

test("pointsAtStorageObject porovnává objekt, ne token v adrese", () => {
  // Jádro celé obnovy: po rotaci má uložená adresa JINÝ token, ale je to pořád
  // týž soubor. Kdyby se porovnávaly celé adresy, druhá rotace za sebou by už
  // uloženou adresu nenašla a nechala by ji mrtvou.
  assert.equal(pointsAtStorageObject(buildDownloadUrl(OBJECT, "jiny"), OBJECT), true);
  assert.equal(pointsAtStorageObject(FILE_URL, OBJECT), true);
  assert.equal(
    pointsAtStorageObject(buildDownloadUrl({ ...OBJECT, objectPath: "jina/cesta.jpg" }, "x"), OBJECT),
    false
  );
  for (const value of [undefined, null, "", "blob:https://app/abc", 42]) {
    assert.equal(pointsAtStorageObject(value, OBJECT), false, String(value));
  }
});

test("refreshedUrlFields přepíše jen pole, která na ten objekt ukazují", () => {
  const thumbnail = buildDownloadUrl({ ...OBJECT, objectPath: "…/thumb_foto.jpg" }, "t");
  const fresh = buildDownloadUrl(OBJECT, "novy");
  assert.deepEqual(
    refreshedUrlFields({ url: FILE_URL, thumbnailUrl: thumbnail }, ["url", "thumbnailUrl"], OBJECT, fresh),
    { url: fresh }
  );
  // Nic k přepsání = null, aby volající dokument vůbec nezapisoval.
  assert.equal(refreshedUrlFields({ url: fresh }, ["url"], OBJECT, fresh), null);
  assert.equal(refreshedUrlFields({}, ["url"], OBJECT, fresh), null);
});

test("refreshedUrlsInArray přepíše jen dotčenou položku pole a jinak vrátí null", () => {
  const fresh = buildDownloadUrl(OBJECT, "novy");
  const versions = [
    { id: "v1", fileUrl: "https://example.com/jiny.pdf" },
    { id: "v2", fileUrl: FILE_URL, revisionLabel: "R02" },
  ];
  assert.deepEqual(refreshedUrlsInArray(versions, ["fileUrl"], OBJECT, fresh), [
    { id: "v1", fileUrl: "https://example.com/jiny.pdf" },
    // Ostatní pole verze musí přežít — přepisuje se CELÉ pole, ne jedna hodnota.
    { id: "v2", fileUrl: fresh, revisionLabel: "R02" },
  ]);
  assert.equal(refreshedUrlsInArray([{ id: "v1" }], ["fileUrl"], OBJECT, fresh), null);
  assert.equal(refreshedUrlsInArray(undefined, ["fileUrl"], OBJECT, fresh), null);
  // Přílohy úkolu jsou totéž pole, jen jiná jména polí.
  assert.deepEqual(
    refreshedUrlsInArray([{ id: "a1", url: FILE_URL, name: "foto.jpg" }], ["url"], OBJECT, fresh),
    [{ id: "a1", url: fresh, name: "foto.jpg" }]
  );
});

test("canEditProjectContent: vlastník i admin firmy smí, cizí stavba ne", () => {
  const ws = { ownerId: "owner-1", adminIds: ["admin-1"] };
  const project = { workspaceId: "ws_1", roles: {} };
  assert.equal(canEditProjectContent(ws, project, "ws_1", "owner-1"), true);
  assert.equal(canEditProjectContent(ws, project, "ws_1", "admin-1"), true);
  // Stavba patří jiné firmě → admin firmy A o ní nerozhoduje.
  assert.equal(canEditProjectContent(ws, { workspaceId: "ws_2" }, "ws_1", "owner-1"), false);
});

test("canEditProjectContent kryje právě role, které mají ve firestore.rules `edit`", () => {
  const ws = { ownerId: "owner-1" };
  const withRole = (role: string) => ({ workspaceId: "ws_1", roles: { "user-1": role } });
  for (const role of ["admin", "editor", "company_lead"]) {
    assert.equal(canEditProjectContent(ws, withRole(role), "ws_1", "user-1"), true, role);
  }
  for (const role of ["reader", "viewer", "", "neznámá"]) {
    assert.equal(canEditProjectContent(ws, withRole(role), "ws_1", "user-1"), false, role);
  }
});

test("canEditProjectContent: chybějící firma nebo stavba = ne", () => {
  assert.equal(canEditProjectContent(null, { workspaceId: "ws_1" }, "ws_1", "owner-1"), false);
  assert.equal(canEditProjectContent({ ownerId: "owner-1" }, null, "ws_1", "owner-1"), false);
});

test("revokeShareLinkAndRotate přerazí token a označí záznam", async () => {
  const { store, calls } = fakeStore();
  const result = await revokeShareLinkAndRotate(store, INPUT);
  assert.deepEqual(result, {
    revoked: true,
    tokenRotated: true,
    wasAlreadyRevoked: false,
    refreshedUrls: 2,
  });
  assert.deepEqual(calls.rotated, [
    "obos.firebasestorage.app::workspaces/ws_1/projects/p1/photos/ph1/foto.jpg",
  ]);
  assert.deepEqual(calls.revoked, ["ws_1/p1/t1"]);
});

test("po rotaci se uložené adresy obnoví adresou s NOVÝM tokenem", async () => {
  const { store, calls } = fakeStore();
  await revokeShareLinkAndRotate(store, INPUT);

  assert.equal(calls.refreshed.length, 1);
  const [refresh] = calls.refreshed;
  assert.deepEqual(refresh.target, OBJECT);
  assert.equal(refresh.staleUrl, FILE_URL);
  assert.equal(refresh.revokedToken, "t1");
  // Nová adresa musí být tatáž, jakou by klientovi vrátilo `getDownloadURL` —
  // tedy TÝŽ objekt, jen s novým tokenem.
  assert.deepEqual(parseStorageObjectFromDownloadUrl(refresh.freshUrl), OBJECT);
  assert.equal(new URL(refresh.freshUrl).searchParams.get("token"), "novy-token");
  assert.notEqual(refresh.freshUrl, FILE_URL);
});

test("selhání obnovy adres se NEPOLYKÁ a nekončí zápisem `revoked`", async () => {
  // Spolknutá chyba by znamenala „odkaz zneplatněn" a fotku, která se v appce
  // nenačte — přesně to, kvůli čemu obnova vznikla.
  const { store, calls } = fakeStore({ refreshThrows: new Error("Firestore nedostupné") });
  await assert.rejects(revokeShareLinkAndRotate(store, INPUT), /Firestore nedostupné/);
  assert.deepEqual(calls.revoked, []);
});

test("opakované zneplatnění projde a rotuje znovu (idempotence)", async () => {
  const { store, calls } = fakeStore({ shareLink: { fileUrl: FILE_URL, revoked: true } });
  const result = await revokeShareLinkAndRotate(store, INPUT);
  assert.equal(result.wasAlreadyRevoked, true);
  assert.equal(calls.rotated.length, 1);
});

test("bez oprávnění se nerotuje ani nezapisuje", async () => {
  const { store, calls } = fakeStore({ project: { workspaceId: "ws_1", roles: { "owner-1": "reader" } }, workspace: { ownerId: "kdosi-jiny" } });
  await expectCode(revokeShareLinkAndRotate(store, INPUT), "permission-denied");
  assert.deepEqual(calls.rotated, []);
  assert.deepEqual(calls.revoked, []);
});

test("chybějící wid/pid/token je invalid-argument", async () => {
  const { store } = fakeStore();
  await expectCode(revokeShareLinkAndRotate(store, { ...INPUT, workspaceId: "" }), "invalid-argument");
  await expectCode(revokeShareLinkAndRotate(store, { ...INPUT, projectId: "" }), "invalid-argument");
  await expectCode(revokeShareLinkAndRotate(store, { ...INPUT, token: "" }), "invalid-argument");
});

test("neexistující odkaz je not-found, odkaz bez fileUrl failed-precondition", async () => {
  await expectCode(revokeShareLinkAndRotate(fakeStore({ shareLink: null }).store, INPUT), "not-found");
  await expectCode(
    revokeShareLinkAndRotate(fakeStore({ shareLink: { revoked: false } }).store, INPUT),
    "failed-precondition"
  );
});

test("selhání rotace NESMÍ skončit zápisem `revoked` — jinak by appka lhala", async () => {
  const { store, calls } = fakeStore({ rotateThrows: new Error("Storage nedostupné") });
  await assert.rejects(revokeShareLinkAndRotate(store, INPUT), /Storage nedostupné/);
  assert.deepEqual(calls.revoked, []);
});

// ───────────────────────────────────────────────────────────────────────────
// Napojení na Firestore. Čistá logika výš by prošla i tehdy, kdyby se hledalo
// ve špatné kolekci nebo podle pole, které se tam nejmenuje — a obnova by pak
// mlčky nepřepsala nic. Proto se store zkouší proti falešnému Firestoru.
// ───────────────────────────────────────────────────────────────────────────

const BASE = "workspaces/ws_1/projects/p1";
const FRESH_URL = buildDownloadUrl(OBJECT, "novy-token");

interface FakeDoc {
  id: string;
  data: Record<string, unknown>;
}

function fakeFirestore(collections: Record<string, FakeDoc[]>) {
  const writes: Array<{ path: string; patch: Record<string, unknown> }> = [];
  const reads: string[] = [];
  let commits = 0;

  const asQuery = (path: string, docs: FakeDoc[]) => ({
    where: (field: string, _op: string, value: unknown) =>
      asQuery(
        path,
        docs.filter((entry) => entry.data[field] === value)
      ),
    get: async () => {
      reads.push(path);
      return {
        docs: docs.map((entry) => ({
          id: entry.id,
          ref: { path: `${path}/${entry.id}` },
          data: () => entry.data,
        })),
      };
    },
  });

  /**
   * Podkolekce firemního prostoru. `listDocuments()` vrací REFERENCE, ne data —
   * úklid firemních prostorů se ptá právě jím, protože id firem předem nezná.
   */
  const asSpaceRef = (path: string) => ({
    collection: (name: string) => asQuery(`${path}/${name}`, collections[`${path}/${name}`] ?? []),
  });

  const firestore = {
    collection: (path: string) => ({
      ...asQuery(path, collections[path] ?? []),
      listDocuments: async () =>
        // Firemní prostory se nepoznají z dat, ale z existence podkolekcí —
        // ve falešném Firestoru tedy z klíčů, které pod tou cestou začínají.
        [
          ...new Set(
            Object.keys(collections)
              .filter((key) => key.startsWith(`${path}/`))
              .map((key) => key.slice(path.length + 1).split("/")[0])
          ),
        ].map((id) => asSpaceRef(`${path}/${id}`)),
    }),
    doc: (path: string) => ({
      get: async () => {
        reads.push(path);
        const [collectionPath, id] = [
          path.slice(0, path.lastIndexOf("/")),
          path.slice(path.lastIndexOf("/") + 1),
        ];
        const found = (collections[collectionPath] ?? []).find((entry) => entry.id === id);
        return { data: () => found?.data };
      },
      path,
    }),
    batch: () => ({
      update: (ref: { path: string }, patch: Record<string, unknown>) => {
        writes.push({ path: ref.path, patch });
      },
      commit: async () => {
        commits += 1;
      },
    }),
  } as unknown as Firestore;

  const storage = {} as unknown as Storage;
  return { store: createFirestoreShareLinkStore(firestore, storage), writes, reads, commits: () => commits };
}

const REFRESH_INPUT = {
  workspaceId: "ws_1",
  projectId: "p1",
  target: OBJECT,
  staleUrl: FILE_URL,
  freshUrl: FRESH_URL,
  revokedToken: "t1",
};

test("obnova najde fotku podle `storagePath` i legacy fotku podle staré adresy", async () => {
  const { store, writes } = fakeFirestore({
    [`${BASE}/photos`]: [
      { id: "ph1", data: { storagePath: OBJECT.objectPath, url: FILE_URL } },
      // Fotka nahraná před zavedením `storagePath` — dohledatelná jen adresou.
      { id: "legacy", data: { url: FILE_URL } },
      { id: "jina", data: { storagePath: "jina/cesta.jpg", url: "https://example.com/x.jpg" } },
    ],
  });

  const refreshed = await store.refreshStoredDownloadUrls(REFRESH_INPUT);

  assert.equal(refreshed, 2);
  assert.deepEqual(writes, [
    { path: `${BASE}/photos/ph1`, patch: { url: FRESH_URL } },
    { path: `${BASE}/photos/legacy`, patch: { url: FRESH_URL } },
  ]);
});

test("obnova sáhne na revizi dokumentu, verzi výkresu i přílohu úkolu", async () => {
  const { store, writes } = fakeFirestore({
    // Revize se hledá podle `fileId` — tam upload ukládá cestu k objektu.
    [`${BASE}/documentVersions`]: [{ id: "v1", data: { fileId: OBJECT.objectPath, filePath: FILE_URL } }],
    // TÝŽ objekt visí i v Plánech (povýšená revize) — musí se přepsat obojí.
    [`${BASE}/plans`]: [{ id: "pl1", data: { versions: [{ id: "pv1", fileUrl: FILE_URL }] } }],
    [`${BASE}/photos`]: [{ id: "ph1", data: { storagePath: OBJECT.objectPath, url: FILE_URL } }],
    [`${BASE}/tasks`]: [
      { id: "t-1", data: { relations: { attachments: [{ id: "a1", url: FILE_URL }] } } },
      { id: "t-2", data: { relations: { attachments: [] } } },
    ],
  });

  const refreshed = await store.refreshStoredDownloadUrls(REFRESH_INPUT);

  assert.equal(refreshed, 4);
  assert.deepEqual(
    writes.map((write) => write.path),
    [`${BASE}/photos/ph1`, `${BASE}/documentVersions/v1`, `${BASE}/plans/pl1`, `${BASE}/tasks/t-1`]
  );
  assert.deepEqual(writes[2].patch, { versions: [{ id: "pv1", fileUrl: FRESH_URL }] });
  assert.deepEqual(writes[3].patch, { "relations.attachments": [{ id: "a1", url: FRESH_URL }] });
});

test("úkoly se čtou jen kvůli fotce — u sdíleného dokumentu se vynechají", async () => {
  // Sdílený dokument (nejčastější případ, QR verifikace revize): do příloh
  // úkolu se kopírují jen knihovní fotky, takže průchod stovkami úkolů by
  // tady byl zbytečný.
  const documentObject = {
    bucket: OBJECT.bucket,
    objectPath: "workspaces/ws_1/projects/p1/documents/d1/v1/vykres.pdf",
  };
  const documentUrl = buildDownloadUrl(documentObject, "stary");
  const { store, reads, writes } = fakeFirestore({
    [`${BASE}/documentVersions`]: [
      { id: "v1", data: { fileId: documentObject.objectPath, filePath: documentUrl } },
    ],
    [`${BASE}/tasks`]: [{ id: "t-1", data: { relations: { attachments: [] } } }],
  });

  await store.refreshStoredDownloadUrls({
    ...REFRESH_INPUT,
    target: documentObject,
    staleUrl: documentUrl,
  });

  assert.deepEqual(
    writes.map((write) => write.path),
    [`${BASE}/documentVersions/v1`]
  );
  assert.equal(reads.includes(`${BASE}/tasks`), false);
});

test("ostatní ŽIVÝ odkaz na týž soubor se obnoví, zneplatňovaný a mrtvý ne", async () => {
  const { store, writes } = fakeFirestore({
    [`${BASE}/shareLinks`]: [
      { id: "t1", data: { fileUrl: FILE_URL, revoked: false } },
      { id: "t2", data: { fileUrl: FILE_URL, revoked: false } },
      { id: "t3", data: { fileUrl: FILE_URL, revoked: true } },
    ],
  });

  const refreshed = await store.refreshStoredDownloadUrls(REFRESH_INPUT);

  assert.equal(refreshed, 1);
  assert.deepEqual(writes, [{ path: `${BASE}/shareLinks/t2`, patch: { fileUrl: FRESH_URL } }]);
});

test("když není co přepsat, nezapisuje se vůbec nic", async () => {
  const { store, writes, commits } = fakeFirestore({
    [`${BASE}/photos`]: [{ id: "ph1", data: { storagePath: "jina/cesta.jpg", url: "https://example.com/x.jpg" } }],
  });

  assert.equal(await store.refreshStoredDownloadUrls(REFRESH_INPUT), 0);
  assert.deepEqual(writes, []);
  assert.equal(commits(), 0);
});

/**
 * 🔴 FIREMNÍ PROSTORY LEŽÍ POD STAVBOU, ALE MIMO `${BASE}/documentVersions`.
 * Do 22. 8. 2026 je obnova míjela, a následek nebyl „neuklizený odkaz":
 * rotace tokenu je vlastnost OBJEKTU, takže zneplatnění sdíleného dokumentu
 * tiše rozbilo tentýž soubor v interním registru firmy — mrtvá dlaždice bez
 * vysvětlení.
 */
test("obnova sáhne i do firemního prostoru (verze i plán)", async () => {
  const { store, writes } = fakeFirestore({
    [`${BASE}/companySpaces/c1/documentVersions`]: [
      { id: "v1", data: { fileId: OBJECT.objectPath, filePath: FILE_URL } },
      { id: "jina", data: { fileId: "jina/cesta.pdf", filePath: "https://example.com/x.pdf" } },
    ],
    [`${BASE}/companySpaces/c1/plans`]: [
      { id: "pl1", data: { versions: [{ fileUrl: FILE_URL }] } },
    ],
    // Druhá firma na téže stavbě se nesmí zapomenout.
    [`${BASE}/companySpaces/c2/documentVersions`]: [
      { id: "v2", data: { fileId: OBJECT.objectPath, filePath: FILE_URL } },
    ],
  });

  const refreshed = await store.refreshStoredDownloadUrls(REFRESH_INPUT);

  assert.equal(refreshed, 3);
  assert.deepEqual(writes.map((write) => write.path).sort(), [
    `${BASE}/companySpaces/c1/documentVersions/v1`,
    `${BASE}/companySpaces/c1/plans/pl1`,
    `${BASE}/companySpaces/c2/documentVersions/v2`,
  ]);
});

/**
 * 🔴 LOGO FIRMY je taky capability URL s tokenem, jen o patro výš než celá
 * obnova. Dokud tu nebylo, nešlo ho zneplatnit vůbec — rotace tokenu by ho jen
 * tiše rozbila v reportech všech staveb.
 */
test("obnova přepíše i logo firmy, ale jen u objektu z `branding/`", async () => {
  const brandingObject = { bucket: OBJECT.bucket, objectPath: "workspaces/ws_1/branding/logo-1.png" };
  const staleLogoUrl = buildDownloadUrl(brandingObject, "stary-token");
  const freshLogoUrl = buildDownloadUrl(brandingObject, "novy-token");
  const { store, writes } = fakeFirestore({
    workspaces: [{ id: "ws_1", data: { logo: { url: staleLogoUrl, format: "png" } } }],
  });

  const refreshed = await store.refreshStoredDownloadUrls({
    ...REFRESH_INPUT,
    target: brandingObject,
    staleUrl: staleLogoUrl,
    freshUrl: freshLogoUrl,
  });

  assert.equal(refreshed, 1);
  assert.deepEqual(writes, [{ path: "workspaces/ws_1", patch: { "logo.url": freshLogoUrl } }]);
});

test("běžná rotace fotky dokument firmy vůbec nečte", async () => {
  const { store, reads } = fakeFirestore({
    workspaces: [{ id: "ws_1", data: { logo: { url: FILE_URL } } }],
  });

  await store.refreshStoredDownloadUrls(REFRESH_INPUT);

  assert.ok(
    !reads.includes("workspaces/ws_1"),
    "zneplatnění fotky nemá vytěžovat dokument firmy"
  );
});
