import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPulseEnvelope,
  canonicalize,
  signPulse,
  signaturesEqual,
  verifyPulseEnvelope,
  type PulsePayload,
} from "./pulseSignature";

const SECRET = "install-secret-abc";
const NOW = 1_700_000_000_000;
const SKEW = 10 * 60 * 1000;

function samplePayload(): PulsePayload {
  return {
    workspaceId: "firma-bbfs",
    date: "2026-07-16",
    schemaVersion: 1,
    kitVersion: "1.4.0",
    counts: { projectsTotal: 3, tasksTotal: 42, photosTotal: 10 },
  };
}

test("canonicalize je nezávislý na pořadí klíčů", () => {
  const a = canonicalize({ b: 1, a: 2, c: { y: 1, x: 2 } });
  const b = canonicalize({ c: { x: 2, y: 1 }, a: 2, b: 1 });
  assert.equal(a, b);
});

test("canonicalize zachová pořadí polí a vynechá undefined", () => {
  assert.equal(canonicalize({ list: [3, 1, 2], skip: undefined, keep: 0 }), '{"keep":0,"list":[3,1,2]}');
});

test("signPulse je deterministický a citlivý na tajemství", () => {
  const p = samplePayload();
  assert.equal(signPulse(SECRET, p, NOW), signPulse(SECRET, p, NOW));
  assert.notEqual(signPulse(SECRET, p, NOW), signPulse("jiny-secret", p, NOW));
  assert.notEqual(signPulse(SECRET, p, NOW), signPulse(SECRET, p, NOW + 1));
});

test("round-trip: podepsaná obálka se ověří", () => {
  const env = buildPulseEnvelope(SECRET, samplePayload(), NOW);
  const result = verifyPulseEnvelope(SECRET, env, NOW + 1000, SKEW);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.payload.workspaceId, "firma-bbfs");
    assert.equal(result.timestamp, NOW);
  }
});

test("zmanipulovaný počet → bad_signature", () => {
  const env = buildPulseEnvelope(SECRET, samplePayload(), NOW);
  env.payload.counts.tasksTotal = 999_999;
  const result = verifyPulseEnvelope(SECRET, env, NOW, SKEW);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "bad_signature");
});

test("špatné tajemství → bad_signature", () => {
  const env = buildPulseEnvelope(SECRET, samplePayload(), NOW);
  const result = verifyPulseEnvelope("utocnikuv-secret", env, NOW, SKEW);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "bad_signature");
});

test("replay mimo okno → stale", () => {
  const env = buildPulseEnvelope(SECRET, samplePayload(), NOW);
  const result = verifyPulseEnvelope(SECRET, env, NOW + SKEW + 1, SKEW);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "stale");
});

test("podpis z minulosti v okně stále projde (idempotentní re-send)", () => {
  const env = buildPulseEnvelope(SECRET, samplePayload(), NOW);
  const result = verifyPulseEnvelope(SECRET, env, NOW + SKEW - 1, SKEW);
  assert.equal(result.ok, true);
});

test("chybný tvar → malformed", () => {
  for (const bad of [null, {}, { payload: {}, timestamp: NOW, signature: "x" }, { payload: samplePayload(), signature: "x" }]) {
    const result = verifyPulseEnvelope(SECRET, bad, NOW, SKEW);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "malformed");
  }
});

test("neplatný formát data → malformed", () => {
  const env = buildPulseEnvelope(SECRET, { ...samplePayload(), date: "16.7.2026" }, NOW);
  const result = verifyPulseEnvelope(SECRET, env, NOW, SKEW);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "malformed");
});

test("signaturesEqual: různá délka/prázdné → false", () => {
  assert.equal(signaturesEqual("aa", "aabb"), false);
  assert.equal(signaturesEqual("", ""), false);
  assert.equal(signaturesEqual("ab", "ab"), true);
});
