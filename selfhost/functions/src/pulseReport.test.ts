import { test } from "node:test";
import assert from "node:assert/strict";
import { pulseReportDate, resolveReporterConfig } from "./pulseReport";

test("resolveReporterConfig: bez opt-in flagu je vypnutý", () => {
  const c = resolveReporterConfig({ PULSE_INGEST_URL: "https://x", PULSE_INSTALL_SECRET: "s", GCLOUD_PROJECT: "firma" });
  assert.equal(c.enabled, false);
});

test("resolveReporterConfig: chybějící URL nebo secret → vypnuto", () => {
  assert.equal(resolveReporterConfig({ PULSE_REPORT_ENABLED: "true", PULSE_INSTALL_SECRET: "s", GCLOUD_PROJECT: "firma" }).enabled, false);
  assert.equal(resolveReporterConfig({ PULSE_REPORT_ENABLED: "true", PULSE_INGEST_URL: "https://x", GCLOUD_PROJECT: "firma" }).enabled, false);
});

test("resolveReporterConfig: kompletní env → zapnuto s odvozeným workspaceId", () => {
  const c = resolveReporterConfig({
    PULSE_REPORT_ENABLED: "true",
    PULSE_INGEST_URL: "https://ingest.example/pulseIngest",
    PULSE_INSTALL_SECRET: "install-secret",
    GCLOUD_PROJECT: "firma-bbfs",
    PULSE_KIT_VERSION: "1.4.0",
  });
  assert.equal(c.enabled, true);
  if (c.enabled) {
    assert.equal(c.workspaceId, "firma-bbfs");
    assert.equal(c.ingestUrl, "https://ingest.example/pulseIngest");
    assert.equal(c.kitVersion, "1.4.0");
  }
});

test("resolveReporterConfig: explicitní PULSE_WORKSPACE_ID přebíjí project id", () => {
  const c = resolveReporterConfig({
    PULSE_REPORT_ENABLED: "true",
    PULSE_INGEST_URL: "https://x",
    PULSE_INSTALL_SECRET: "s",
    PULSE_WORKSPACE_ID: "stabilni-pseudonym",
    GCLOUD_PROJECT: "firma-bbfs",
  });
  assert.equal(c.enabled && c.workspaceId, "stabilni-pseudonym");
});

test("pulseReportDate: UTC YYYY-MM-DD", () => {
  assert.equal(pulseReportDate(new Date("2026-07-16T23:59:00.000Z")), "2026-07-16");
  assert.equal(pulseReportDate(new Date("2026-01-02T00:00:00.000Z")), "2026-01-02");
});
