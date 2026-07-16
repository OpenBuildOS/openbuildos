import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * OpenBuildOS Pulse — podpis agregovaného reportu (SYNCED FILE).
 *
 * ⚠️ Tento soubor musí zůstat BYTE-IDENTICKÝ s kopií ve companion repu
 * (`selfhost/functions/src/pulseSignature.ts`). Reporter (firma) i ingest
 * (centrální projekt) musí podepisovat/ověřovat naprosto stejně, jinak se
 * report zamítne. Žádné závislosti mimo `node:crypto` — ať je kopírování
 * triviální a bez rizika driftu.
 *
 * Model: firma spočítá agregát → podepíše HMAC-SHA256 svým instalačním
 * tajemstvím (Secret Manager, NIKDY v Gitu) → pošle centrálnímu endpointu.
 * Endpoint tajemství té firmy zná z registru `pulseWorkspaces/{workspaceId}`
 * a podpis ověří. Payload nese jen agregované počty, žádné názvy/obsah.
 */

export type PulseCounts = {
  projectsTotal?: number;
  tasksTotal?: number;
  photosTotal?: number;
  plansTotal?: number;
  documentsTotal?: number;
  membersTotal?: number;
  filesTotal?: number;
};

export type PulsePayload = {
  /** Stabilní pseudonym workspace (firebaseProjectId nebo jeho hash). */
  workspaceId: string;
  /** UTC den reportu ve formátu YYYY-MM-DD (idempotence klíč). */
  date: string;
  schemaVersion: number;
  kitVersion: string;
  counts: PulseCounts;
};

export type PulseEnvelope = {
  payload: PulsePayload;
  /** Čas podpisu v ms (bráníme replay – ingest kontroluje okno). */
  timestamp: number;
  /** HMAC-SHA256 hex nad canonicalize({ payload, timestamp }). */
  signature: string;
};

/**
 * Deterministická serializace: klíče objektů rekurzivně seřazené, aby obě
 * strany dostaly stejný řetězec bez ohledu na pořadí vložení. Pole si pořadí
 * drží. Undefined hodnoty se vynechají (stejně jako v JSON.stringify).
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

/** HMAC-SHA256 (hex) nad kanonickým `{ payload, timestamp }`. */
export function signPulse(secret: string, payload: PulsePayload, timestamp: number): string {
  const canonical = canonicalize({ payload, timestamp });
  return createHmac("sha256", secret).update(canonical).digest("hex");
}

/** Sestaví podepsanou obálku připravenou k odeslání. */
export function buildPulseEnvelope(
  secret: string,
  payload: PulsePayload,
  timestamp: number
): PulseEnvelope {
  return { payload, timestamp, signature: signPulse(secret, payload, timestamp) };
}

/** Timing-safe porovnání dvou hex podpisů stejné délky. */
export function signaturesEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) {
    return false;
  }
  const bufferA = Buffer.from(a, "hex");
  const bufferB = Buffer.from(b, "hex");
  if (bufferA.length !== bufferB.length || bufferA.length === 0) {
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

export type VerifyResult =
  | { ok: true; payload: PulsePayload; timestamp: number }
  | { ok: false; reason: "malformed" | "bad_signature" | "stale" };

/**
 * Ověří obálku: tvar → replay okno → podpis. `now`/`maxSkewMs` jsou injektované
 * kvůli testovatelnosti (žádné volání Date.now() uvnitř).
 */
export function verifyPulseEnvelope(
  secret: string,
  envelope: unknown,
  now: number,
  maxSkewMs: number
): VerifyResult {
  if (!isEnvelope(envelope)) {
    return { ok: false, reason: "malformed" };
  }
  if (!Number.isFinite(envelope.timestamp) || Math.abs(now - envelope.timestamp) > maxSkewMs) {
    return { ok: false, reason: "stale" };
  }
  const expected = signPulse(secret, envelope.payload, envelope.timestamp);
  if (!signaturesEqual(expected, envelope.signature)) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true, payload: envelope.payload, timestamp: envelope.timestamp };
}

function isEnvelope(value: unknown): value is PulseEnvelope {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.signature !== "string" || typeof candidate.timestamp !== "number") {
    return false;
  }
  const payload = candidate.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object") {
    return false;
  }
  return (
    typeof payload.workspaceId === "string"
    && payload.workspaceId.length > 0
    && typeof payload.date === "string"
    && /^\d{4}-\d{2}-\d{2}$/.test(payload.date as string)
    && typeof payload.schemaVersion === "number"
    && typeof payload.kitVersion === "string"
    && typeof payload.counts === "object"
    && payload.counts !== null
  );
}
