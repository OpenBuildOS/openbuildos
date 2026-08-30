import assert from "node:assert/strict";
import test from "node:test";

import { planReviewResolution } from "./resolveReviewItem";
import type { GraphNodeRef, ReviewItem } from "./graphContract";

const NOW = "2026-08-29T10:00:00.000Z";
const PRINCIPAL = "uid-1";

const DOCUMENT_VERSION_TARGET: GraphNodeRef = {
  wid: "ws1",
  pid: "p1",
  type: "document_version",
  documentId: "doc-1",
  versionId: "ver-1",
};

function fieldValuesItem(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    schemaVersion: 1,
    source: "doc_classification",
    target: DOCUMENT_VERSION_TARGET,
    payload: {
      kind: "field_values",
      fields: {
        discipline: {
          value: "DRAWING",
          provenance: {
            kind: "heuristic",
            rule: "classifyForBatchUpload:filename",
            confidence: 0.65,
            evidence: { quote: "01_pudorys.pdf" },
          },
        },
      },
    },
    status: "pending",
    reviewers: "target_editors",
    createdAt: { seconds: 0, nanoseconds: 0 },
    vis: { visibility: "" },
    dedupeKey: "doc_classification|doc-1|ver-1",
    ...overrides,
  };
}

function pairingItem(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    schemaVersion: 1,
    source: "pairing",
    target: DOCUMENT_VERSION_TARGET,
    payload: { kind: "entity_draft", draft: { candidateIds: ["doc-9"] } },
    status: "pending",
    reviewers: "target_editors",
    createdAt: { seconds: 0, nanoseconds: 0 },
    vis: { visibility: "" },
    dedupeKey: "pairing|doc-1|ver-1",
    ...overrides,
  };
}

function edgeProposalItem(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    schemaVersion: 1,
    source: "ai_edge",
    target: DOCUMENT_VERSION_TARGET,
    payload: {
      kind: "edge_proposal",
      edge: {
        type: "similar_to",
        from: DOCUMENT_VERSION_TARGET,
        to: DOCUMENT_VERSION_TARGET,
        provenance: { kind: "ai_semantic", model: "m1", embeddingVersion: "v1", confidence: 0.65 },
      },
    },
    status: "pending",
    reviewers: "target_editors",
    createdAt: { seconds: 0, nanoseconds: 0 },
    vis: { visibility: "" },
    dedupeKey: "ai_edge|doc-1|ver-1",
    ...overrides,
  };
}

// ── field_values: confirmed / corrected / rejected ─────────────────────────

test("field_values confirmed: aplikuje fields[*].value na rodičovský dokument", () => {
  const result = planReviewResolution(fieldValuesItem(), "confirmed", undefined, PRINCIPAL, NOW);
  assert.equal(result.kind, "resolved");
  if (result.kind !== "resolved") return;
  assert.equal(result.finalStatus, "confirmed");
  assert.deepEqual(result.entityPatch, {
    collectionPath: "workspaces/ws1/projects/p1/documents",
    docId: "doc-1",
    fields: { discipline: "DRAWING" },
  });
  assert.equal(result.resolutionPatch.status, "confirmed");
  assert.equal(result.resolutionPatch.resolution.by, PRINCIPAL);
  assert.equal(result.resolutionPatch.resolution.at, NOW);
  assert.deepEqual(result.resolutionPatch.resolution.applied, {
    wid: "ws1",
    pid: "p1",
    type: "document",
    documentId: "doc-1",
  });
});

test("field_values corrected: aplikuje HODNOTY z corrections, ne z payloadu", () => {
  const result = planReviewResolution(
    fieldValuesItem(),
    "confirmed",
    { discipline: "SPEC" },
    PRINCIPAL,
    NOW
  );
  assert.equal(result.kind, "resolved");
  if (result.kind !== "resolved") return;
  assert.equal(result.finalStatus, "corrected");
  assert.deepEqual(result.entityPatch?.fields, { discipline: "SPEC" });
});

test("field_values rejected: nikdy žádný entityPatch", () => {
  const result = planReviewResolution(fieldValuesItem(), "rejected", undefined, PRINCIPAL, NOW);
  assert.equal(result.kind, "resolved");
  if (result.kind !== "resolved") return;
  assert.equal(result.finalStatus, "rejected");
  assert.equal(result.entityPatch, null);
  assert.equal(result.resolutionPatch.resolution.note, undefined);
});

test("corrections s cizím klíčem → unknown_field, nic se neaplikuje", () => {
  const result = planReviewResolution(
    fieldValuesItem(),
    "confirmed",
    { locationId: "loc-1" },
    PRINCIPAL,
    NOW
  );
  assert.equal(result.kind, "error");
  if (result.kind !== "error") return;
  assert.equal(result.error.code, "unknown_field");
});

test("field_values na nepodporovaném cíli → unsupported_field", () => {
  const item = fieldValuesItem({
    target: { wid: "ws1", pid: "p1", type: "task", taskId: "t1" },
  });
  const result = planReviewResolution(item, "confirmed", undefined, PRINCIPAL, NOW);
  assert.equal(result.kind, "error");
  if (result.kind !== "error") return;
  assert.equal(result.error.code, "unsupported_field");
});

test("field_values s nepodporovaným polem na jinak podporovaném cíli → unsupported_field", () => {
  const item = fieldValuesItem({
    payload: {
      kind: "field_values",
      fields: {
        locationId: {
          value: "loc-1",
          provenance: { kind: "human", by: PRINCIPAL, at: { seconds: 0, nanoseconds: 0 } },
        },
      },
    },
  });
  const result = planReviewResolution(item, "confirmed", undefined, PRINCIPAL, NOW);
  assert.equal(result.kind, "error");
  if (result.kind !== "error") return;
  assert.equal(result.error.code, "unsupported_field");
});

// ── entity_draft (pairing) ──────────────────────────────────────────────────

test("pairing confirmed: žádný entityPatch, jen audit rozhodnutí", () => {
  const result = planReviewResolution(pairingItem(), "confirmed", undefined, PRINCIPAL, NOW);
  assert.equal(result.kind, "resolved");
  if (result.kind !== "resolved") return;
  assert.equal(result.entityPatch, null);
  assert.equal(result.finalStatus, "confirmed");
});

test("pairing rejected: entityPatch null a resolution.note = pairing_disputed", () => {
  const result = planReviewResolution(pairingItem(), "rejected", undefined, PRINCIPAL, NOW);
  assert.equal(result.kind, "resolved");
  if (result.kind !== "resolved") return;
  assert.equal(result.entityPatch, null);
  assert.equal(result.resolutionPatch.resolution.note, "pairing_disputed");
});

// ── edge_proposal ────────────────────────────────────────────────────────────

test("edge_proposal confirmed → unsupported_payload (producent zatím neexistuje)", () => {
  const result = planReviewResolution(edgeProposalItem(), "confirmed", undefined, PRINCIPAL, NOW);
  assert.equal(result.kind, "error");
  if (result.kind !== "error") return;
  assert.equal(result.error.code, "unsupported_payload");
});

test("edge_proposal rejected: projde normálně, entityPatch nikdy nevzniká", () => {
  const result = planReviewResolution(edgeProposalItem(), "rejected", undefined, PRINCIPAL, NOW);
  assert.equal(result.kind, "resolved");
  if (result.kind !== "resolved") return;
  assert.equal(result.entityPatch, null);
  assert.equal(result.finalStatus, "rejected");
});

// ── non-pending (idempotence) ────────────────────────────────────────────────

test("already confirmed item → already_resolved, ne throw", () => {
  const result = planReviewResolution(
    fieldValuesItem({ status: "confirmed" }),
    "confirmed",
    undefined,
    PRINCIPAL,
    NOW
  );
  assert.deepEqual(result, { kind: "already_resolved" });
});

test("already rejected item → already_resolved i při jiné akci", () => {
  const result = planReviewResolution(
    pairingItem({ status: "rejected" }),
    "confirmed",
    undefined,
    PRINCIPAL,
    NOW
  );
  assert.deepEqual(result, { kind: "already_resolved" });
});

test("expired item → already_resolved (2b jen jednou vyřeší, nerozlišuje důvod)", () => {
  const result = planReviewResolution(
    fieldValuesItem({ status: "expired" }),
    "rejected",
    undefined,
    PRINCIPAL,
    NOW
  );
  assert.deepEqual(result, { kind: "already_resolved" });
});
