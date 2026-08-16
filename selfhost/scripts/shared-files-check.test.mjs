import test from "node:test";
import assert from "node:assert/strict";

import { parseManifest, mirrorDeclaration, parseArgs, sha256 } from "./shared-files-check.mjs";
import { parseSharedFiles, parseNonSharedFiles, tableRowsUnderHeading } from "./shared-files-sync.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const manifest = (overrides = {}) =>
  JSON.stringify({
    shared: [{ main: "firestore.rules", companion: "selfhost/firestore.rules", mainSha256: HASH_A }],
    notShared: [],
    ...overrides,
  });

// ───────────────────────────── manifest ─────────────────────────────────────

test("manifest: platný projde a vrátí dvojice", () => {
  const out = parseManifest(manifest());
  assert.equal(out.error, undefined);
  assert.equal(out.shared.length, 1);
  assert.equal(out.shared[0].companion, "selfhost/firestore.rules");
});

test("manifest: nevalidní JSON je pojmenovaná chyba, ne pád", () => {
  assert.match(parseManifest("{neJSON").error, /není platný JSON/);
});

test("manifest: chybějící pole `shared`", () => {
  assert.match(parseManifest("{}").error, /nemá pole `shared`/);
});

// Tohle je ta věc, kvůli které se zarážky vypínají: prázdný seznam vypadá
// jako „nic ke kontrole“, a přitom je to zarážka bez zubů.
test("manifest: PRÁZDNÝ seznam je chyba, ne „nic ke kontrole“", () => {
  assert.match(parseManifest(manifest({ shared: [] })).error, /prázdné/);
});

test("manifest: položka bez `mainSha256` se pozná i s číslem řádku", () => {
  const bad = manifest({ shared: [{ main: "a", companion: "selfhost/a" }] });
  assert.match(parseManifest(bad).error, /#1.*mainSha256/s);
});

test("manifest: `mainSha256`, který není sha256, neprojde", () => {
  const bad = manifest({ shared: [{ main: "a", companion: "selfhost/a", mainSha256: "zkratka" }] });
  assert.match(parseManifest(bad).error, /není sha256/);
});

test("manifest: dvakrát tentýž companion soubor neprojde", () => {
  const dup = manifest({
    shared: [
      { main: "a", companion: "selfhost/a", mainSha256: HASH_A },
      { main: "b", companion: "selfhost/a", mainSha256: HASH_B },
    ],
  });
  assert.match(parseManifest(dup).error, /dvakrát/);
});

// ───────────────────────── přiznání zrcadlení ───────────────────────────────

test("Mirror-to-main: najde se v těle PR i mezi ostatním textem", () => {
  const body = "Mění pravidla.\n\nMirror-to-main: trpaslik444/construct-cloud-sync#667\n\nDalší odstavec.";
  assert.equal(mirrorDeclaration(body), "trpaslik444/construct-cloud-sync#667");
});

test("Mirror-to-main: velikost písmen ani odsazení nevadí", () => {
  assert.equal(mirrorDeclaration("  mirror-to-main:   #667  "), "#667");
});

test("Mirror-to-main: chybějící řádek vrátí null", () => {
  assert.equal(mirrorDeclaration("Jen popis změny."), null);
});

// Zaškrtávátko není přiznání — hodnota musí něco pojmenovat.
test("Mirror-to-main: prázdná nebo jen interpunkční hodnota neprojde", () => {
  assert.equal(mirrorDeclaration("Mirror-to-main:"), null);
  assert.equal(mirrorDeclaration("Mirror-to-main:   "), null);
  assert.equal(mirrorDeclaration("Mirror-to-main: -"), null);
  assert.equal(mirrorDeclaration("Mirror-to-main: ---"), null);
});

test("Mirror-to-main: `null`/`undefined` vstup nespadne", () => {
  assert.equal(mirrorDeclaration(null), null);
  assert.equal(mirrorDeclaration(undefined), null);
});

// ───────────────────────────── argumenty ────────────────────────────────────

test("--base bez hodnoty je chyba, ne tiché ignorování", () => {
  assert.match(parseArgs(["--base"]).error, /čeká ref/);
  assert.match(parseArgs(["--base", "--jiny"]).error, /čeká ref/);
});

test("--base s hodnotou projde", () => {
  assert.equal(parseArgs(["--base", "origin/main"]).base, "origin/main");
});

// ──────────────────── parsování Háčku 1 (generátor) ─────────────────────────

const DOC = `## ⚠️ Háček 1 — SDÍLENÉ soubory (drž je identické)

| Soubor | Kde v companionu |
| --- | --- |
| \`firestore.rules\` | \`selfhost/firestore.rules\` |
| \`functions/src/thumbnails.ts\` | \`selfhost/functions/src/thumbnails.ts\` |

### ❌ Co sdílené NENÍ a nikdy se kopírovat nesmí

| Soubor | Kde patří | Proč ne kopie |
| --- | --- | --- |
| \`scripts/openbuildos-setup.mjs\` | **jen companion** | Nekřísit. |
`;

test("Háček 1: přečtou se obě cesty, hlavička a oddělovač vypadnou", () => {
  assert.deepEqual(parseSharedFiles(DOC), [
    { main: "firestore.rules", companion: "selfhost/firestore.rules" },
    { main: "functions/src/thumbnails.ts", companion: "selfhost/functions/src/thumbnails.ts" },
  ]);
});

// Kdyby se sbíralo přes nadpis dál, spolkla by se tabulka pravého opaku.
test("Háček 1: tabulka „co sdílené NENÍ“ se do sdílených NEPŘILEPÍ", () => {
  const shared = parseSharedFiles(DOC);
  assert.ok(!shared.some((p) => p.main === "scripts/openbuildos-setup.mjs"));
  assert.deepEqual(parseNonSharedFiles(DOC), ["scripts/openbuildos-setup.mjs"]);
});

test("Háček 1: chybějící nadpis vrátí null (ne prázdný seznam)", () => {
  assert.equal(tableRowsUnderHeading("# Něco jiného\n", "SDÍLENÉ soubory"), null);
  assert.equal(parseSharedFiles("# Něco jiného\n"), null);
});

// ─────────────────────────────── otisk ──────────────────────────────────────

test("sha256 sedí na známou hodnotu a rozliší koncový \\n", () => {
  assert.equal(sha256(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.notEqual(sha256("a"), sha256("a\n"));
});
