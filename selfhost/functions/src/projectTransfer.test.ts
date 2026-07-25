import assert from "node:assert/strict";
import test from "node:test";
import {
  collectReferencedCompanyIds,
  remapPath,
  rewriteStrings,
  sanitizeImportedData,
  validateBackupSourceUrl,
  validateManifest,
} from "./projectTransfer";

const manifest = {
  format: "openbuildos-project-backup" as const,
  version: 1,
  createdAt: "2026-07-12T00:00:00.000Z",
  sourceWorkspaceId: "source-workspace",
  sourceProjectId: "source-project",
  sourceBucket: "source.appspot.com",
  documents: [],
  files: [],
};

test("přemapuje kořenový i workspace projekt", () => {
  assert.equal(remapPath("projects/source-project/task_audit/a1", manifest, "target-workspace", "target-project"), "projects/target-project/task_audit/a1");
  assert.equal(remapPath("workspaces/source-workspace/projects/source-project/tasks/t1", manifest, "target-workspace", "target-project"), "workspaces/target-workspace/projects/target-project/tasks/t1");
});

test("přepíše raw i URL-encoded Storage cestu a bucket", () => {
  const raw = "workspaces/source-workspace/projects/source-project/files/a.pdf";
  const value = {
    storagePath: raw,
    url: `https://firebasestorage.googleapis.com/v0/b/source.appspot.com/o/${encodeURIComponent(raw)}?alt=media`,
  };
  assert.deepEqual(rewriteStrings(value, manifest, "target-workspace", "target-project", "target.appspot.com"), {
    storagePath: "workspaces/target-workspace/projects/target-project/files/a.pdf",
    url: `https://firebasestorage.googleapis.com/v0/b/target.appspot.com/o/${encodeURIComponent("workspaces/target-workspace/projects/target-project/files/a.pdf")}?alt=media`,
  });
});

test("odmítne soubor mimo projektový prefix", () => {
  assert.throws(() => validateManifest({
    ...manifest,
    files: [{ entry: "storage/stolen.pdf", sourcePath: "workspaces/other/projects/p/files/stolen.pdf", size: 1, sha256: "a".repeat(64) }],
  }));
});

test("odmítne manifest s ID obsahujícím cestu", () => {
  assert.throws(() => validateManifest({ ...manifest, sourceProjectId: "project/foreign" }));
});

test("povolí pouze podepsanou URL Google Storage", () => {
  assert.equal(validateBackupSourceUrl("https://storage.googleapis.com/bucket/file?X-Goog-Signature=abc").hostname, "storage.googleapis.com");
  assert.throws(() => validateBackupSourceUrl("https://example.com/backup?X-Goog-Signature=abc"));
  assert.throws(() => validateBackupSourceUrl("https://storage.googleapis.com/bucket/file"));
});

test("remapPath přemapuje i workspace-level firemní adresář", () => {
  assert.equal(
    remapPath("workspaces/source-workspace/companies/c1", manifest, "target-workspace", "target-project"),
    "workspaces/target-workspace/companies/c1",
  );
  // Cesta mimo zdrojový workspace zůstane beze změny.
  assert.equal(remapPath("workspaces/other/companies/c1", manifest, "target-workspace", "target-project"), "workspaces/other/companies/c1");
});

test("sanitizeImportedData přepíše skalární workspaceId/projectId a strhne verifikační pole", () => {
  const input = {
    workspaceId: "source-workspace",
    projectId: "source-project",
    title: "Výkres",
    verificationTargetUrl: "https://app/share/source-workspace/tok?k=SECRET&p=source-project",
    verificationShareToken: "tok",
    qrOverlayFilePath: "workspaces/source-workspace/projects/source-project/documents/d/v/verified/document.pdf",
    approvals: { "principal-a": { decision: "approved" } },
    nested: { workspaceId: "source-workspace", other: "keep" },
  };
  const out = sanitizeImportedData(input, "source-workspace", "target-workspace", "source-project", "target-project") as Record<string, unknown>;
  assert.equal(out.workspaceId, "target-workspace");
  assert.equal(out.projectId, "target-project");
  assert.equal(out.title, "Výkres");
  assert.ok(!("verificationTargetUrl" in out), "verificationTargetUrl se strhne (zdrojový apiKey)");
  assert.ok(!("verificationShareToken" in out));
  assert.ok(!("qrOverlayFilePath" in out));
  // Principaly (klíče approvals) se u Scénáře A zachovají živé.
  assert.deepEqual(out.approvals, { "principal-a": { decision: "approved" } });
  assert.deepEqual(out.nested, { workspaceId: "target-workspace", other: "keep" });
});

test("collectReferencedCompanyIds posbírá ownerCompanyId, companyId i mapu companies", () => {
  const documents = [
    { path: "projects/p", data: { companies: { "principal-a": "co-1", "principal-b": "co-2" } } },
    { path: "workspaces/w/projects/p/documents/d", data: { ownerCompanyId: "co-3" } },
    { path: "workspaces/w/projects/p/members/m", data: { companyId: "co-1", nested: [{ ownerCompanyId: "co-4" }] } },
  ];
  const ids = collectReferencedCompanyIds(documents as unknown as Parameters<typeof collectReferencedCompanyIds>[0]);
  assert.deepEqual([...ids].sort(), ["co-1", "co-2", "co-3", "co-4"]);
});
