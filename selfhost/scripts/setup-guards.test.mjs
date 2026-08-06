// Brány, které mají firmě zabránit rozbít si vlastní backend:
//   1) claims-gated storage.rules se nesmí nasadit do projektu bez funkcí,
//      které claims razí (jinak ztratí úložiště i vlastník),
//   2) deploy funkcí nesmí nic smazat (starší klon = tichá ztráta backendu),
//   3) selhání kroku Úložiště se nesmí ohlásit jako úspěch.
//
// Spuštění: node --test scripts/*.test.mjs   (z adresáře selfhost/)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  activeFunctionIds,
  missingClaimsFunctions,
  rulesRequireClaims,
} from "./openbuildos-storage-setup.mjs";
import {
  isCleanupPolicyOnlyFailure,
  isEventarcAgentPropagation,
  storageSummaryLine,
} from "./openbuildos-setup.mjs";

const selfhostRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("storage.rules v kitu jsou claims-gated → brána se uplatní", () => {
  const source = readFileSync(join(selfhostRoot, "storage.rules"), "utf8");
  assert.equal(rulesRequireClaims(source), true);
});

test("na starých pravidlech (jen přihlášený uživatel) se brána neuplatní", () => {
  const legacy = "match /workspaces/{wid}/{rest=**} { allow read, write: if request.auth != null; }";
  assert.equal(rulesRequireClaims(legacy), false);
});

test("prázdný projekt → chybí obě povinné funkce", () => {
  assert.deepEqual(missingClaimsFunctions([]), ["authExchange", "syncMemberClaims"]);
});

test("backend bez #496 → chybí syncMemberClaims", () => {
  assert.deepEqual(missingClaimsFunctions(["authExchange", "companyFile"]), ["syncMemberClaims"]);
});

test("plný backend projde", () => {
  assert.deepEqual(missingClaimsFunctions(["authExchange", "syncMemberClaims"]), []);
});

test("nefunkční (FAILED/DEPLOYING) funkce se nepočítají", () => {
  const ids = activeFunctionIds({
    functions: [
      { name: "projects/p/locations/eu/functions/authExchange", state: "ACTIVE" },
      { name: "projects/p/locations/eu/functions/syncMemberClaims", state: "FAILED" },
    ],
  });
  assert.deepEqual(missingClaimsFunctions(ids), ["syncMemberClaims"]);
});

test("chyba jen kolem cleanup policy = deploy PROŠEL", () => {
  const out =
    "Functions successfully deployed but could not set up cleanup policy in location europe-west1.";
  assert.equal(isCleanupPolicyOnlyFailure(out), true);
});

test("skutečné selhání deploye se za cleanup policy nevydává", () => {
  assert.equal(isCleanupPolicyOnlyFailure("Build failed: npm install exited with 1"), false);
  assert.equal(
    isCleanupPolicyOnlyFailure(
      "The following functions are found in your project but do not exist in your local source code"
    ),
    false
  );
});

test("shrnutí nehlásí zabezpečené úložiště, když zabezpečené není", () => {
  assert.match(storageSummaryLine({ storage: true }), /zabezpečeno/);
  assert.doesNotMatch(storageSummaryLine({ storage: false }), /^✓/);
  assert.doesNotMatch(storageSummaryLine(null), /^✓/);
});

// Firestore trigger (promoteApprovedDrawingToPlan) potřebuje Eventarc Service
// Agenta. Na projektu, kde se 2. generace funkcí nasazuje poprvé, deploy jednou
// spadne — to se NESMÍ hlásit jako „rozbitý klon" nebo „chybí oprávnění firmy".
test("propagace Eventarc agenta se pozná a odliší od ostatních selhání", () => {
  const eventarc =
    'HTTP Error: 400, Validation failed for trigger projects/x/locations/eur3/triggers/y: '
    + 'Invalid resource state for "": Permission denied while using the Eventarc Service Agent.';
  assert.equal(isEventarcAgentPropagation(eventarc), true);
  assert.equal(isEventarcAgentPropagation("could not set up cleanup policy"), false);
  assert.equal(isEventarcAgentPropagation("do not exist in your local source code"), false);
  assert.equal(isEventarcAgentPropagation(""), false);
  assert.equal(isEventarcAgentPropagation(undefined), false);
});
