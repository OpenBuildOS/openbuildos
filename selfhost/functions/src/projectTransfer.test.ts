import assert from "node:assert/strict";
import test from "node:test";
import { remapPath, rewriteStrings } from "./projectTransfer";

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
