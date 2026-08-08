import assert from "node:assert/strict";
import test from "node:test";
import {
  ShareLinkRotationError,
  canEditProjectContent,
  parseStorageObjectFromDownloadUrl,
  revokeShareLinkAndRotate,
  type ShareLinkRecord,
  type ShareLinkRotationStore,
} from "./shareLinkRotation";

// ⭐ SDÍLENÝ SOUBOR — identický v obou repech (docs/REPO_BOUNDARIES.md).

const FILE_URL =
  "https://firebasestorage.googleapis.com/v0/b/obos.firebasestorage.app/o/" +
  "workspaces%2Fws_1%2Fprojects%2Fp1%2Fphotos%2Fph1%2Ffoto.jpg?alt=media&token=old-token";

interface FakeStoreOptions {
  workspace?: { ownerId?: string; adminIds?: string[] } | null;
  project?: { workspaceId?: string; roles?: Record<string, string> } | null;
  shareLink?: ShareLinkRecord | null;
  rotateThrows?: Error;
}

function fakeStore(options: FakeStoreOptions = {}) {
  const calls = { rotated: [] as string[], revoked: [] as string[] };
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
  assert.deepEqual(result, { revoked: true, tokenRotated: true, wasAlreadyRevoked: false });
  assert.deepEqual(calls.rotated, [
    "obos.firebasestorage.app::workspaces/ws_1/projects/p1/photos/ph1/foto.jpg",
  ]);
  assert.deepEqual(calls.revoked, ["ws_1/p1/t1"]);
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
