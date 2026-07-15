#!/usr/bin/env node
/**
 * openbuildos-storage-setup — FÁZE B onboardingu firmy: ÚLOŽIŠTĚ.
 *
 * Samostatný companion skript (oddělený od `openbuildos-setup`, který řeší
 * FÁZI A = federace/backend). Úložiště je vlastní koncern + do budoucna sem
 * přibude Google Drive / OneDrive (OAuth), ať má vlastní tok.
 *
 * Co dělá DNES (Firebase Storage):
 *   1. Ověří bucket `<project>.firebasestorage.app`. Když NEexistuje, navede
 *      zapnout Storage v konzoli (Build → Storage → Get started) — EU location
 *      kvůli GDPR, region NEJDE změnit zpět.
 *   2. Nasadí STORAGE RULES (storage.rules) — bez nich je bucket deny-all a
 *      appka nemůže nahrávat ani ověřit připojení (probe).
 *   3. Nastaví CORS (jinak preflight i upload z appky padají na CORS).
 *   4. Ověří CORS.
 *
 * Budoucí: Google Drive / OneDrive (OAuth) — viz `runDriveSetup()` stub.
 *
 * Předpoklady: gcloud + firebase-tools (npx) + `gcloud auth login` a
 * `firebase login` jako vlastník firemního projektu.
 *
 * Spusť Z KOŘENE repa (potřebuje storage.rules + firebase.json):
 *   node scripts/openbuildos-storage-setup.mjs --project <firma-project-id>
 *   node scripts/openbuildos-storage-setup.mjs --project <id> --origin https://app.mojefirma.cz
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OK = "✓";
const FAIL = "✗";
const WARN = "⚠";
// Origins povolené v CORS. Hostovaný OpenBuildOS běží na obou doménách zároveň
// (výchozí Hosting doména + kanonická custom doména), proto MUSÍ být obě —
// jinak přechod na app.openbuildos.org tiše rozbije Storage (fetch PDF spadne
// na CORS). Self-host firma přidá svou doménu přes opakovatelný `--origin`.
const DEFAULT_ORIGINS = ["https://openbuildos-app.web.app", "https://app.openbuildos.org"];
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const step = (m) => console.log(`\n» ${m}`);
const ok = (m) => console.log(`  ${OK} ${m}`);
const fail = (m) => console.log(`  ${FAIL} ${m}`);
const warn = (m) => console.log(`  ${WARN} ${m}`);

function resolveBin(name) {
  const verArgs = name === "gsutil" ? ["version"] : ["--version"];
  if (spawnSync(name, verArgs, { stdio: "ignore" }).status === 0) return name;
  const fallback = join(homedir(), "google-cloud-sdk", "bin", name);
  if (spawnSync(fallback, verArgs, { stdio: "ignore" }).status === 0) return fallback;
  return null;
}

/**
 * Detekce firebase-tools: globální `firebase` (Cloud Shell ho má) má přednost
 * před `npx firebase` (ten by v Cloud Shellu stahoval balík / mohl selhat).
 * Shodné s openbuildos-setup.mjs.
 */
function resolveFirebase() {
  if (spawnSync("firebase", ["--version"], { stdio: "ignore" }).status === 0) {
    return { cmd: "firebase", prefix: [] };
  }
  return { cmd: "npx", prefix: ["firebase"] };
}

function run(cmd, args, opts = {}) {
  try {
    const stdout = execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
    return { ok: true, stdout };
  } catch (err) {
    return { ok: false, stdout: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  let project = "";
  const extraOrigins = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--project") project = args[i + 1] ?? "";
    // `--origin` lze zopakovat i zadat čárkou oddělený seznam; přidává se
    // k výchozím doménám (nenahrazuje je).
    if (args[i] === "--origin" && args[i + 1]) {
      for (const value of args[i + 1].split(",")) {
        const trimmed = value.trim();
        if (trimmed) extraOrigins.push(trimmed);
      }
    }
  }
  const origins = [...new Set([...DEFAULT_ORIGINS, ...extraOrigins])];
  return { project, origins };
}

const bucketUrl = (project) => `gs://${project}.firebasestorage.app`;

function setCors(gsutil, project, origins) {
  const file = join(mkdtempSync(join(tmpdir(), "obos-cors-")), "cors.json");
  writeFileSync(
    file,
    JSON.stringify(
      [
        {
          origin: origins,
          method: ["GET", "POST", "PUT", "DELETE", "HEAD"],
          responseHeader: ["Content-Type", "Authorization", "Content-Range", "Range", "x-goog-resumable"],
          maxAgeSeconds: 3600,
        },
      ],
      null,
      2
    )
  );
  return run(gsutil, ["cors", "set", file, bucketUrl(project)]);
}

/** Placeholder pro budoucí variantu vlastního úložiště (Google Drive / OneDrive). */
function runDriveSetup() {
  warn("Google Drive / OneDrive: integrace se připravuje — zatím Firebase Storage.");
}

async function main() {
  const { project, origins } = parseArgs();
  console.log("OpenBuildOS — nastavení úložiště firmy (FÁZE B)\n");
  if (!project) {
    fail("Chybí --project <firma-project-id>.");
    process.exit(1);
  }

  step("Krok 1/4 — Kontrola nástrojů");
  const gsutil = resolveBin("gsutil");
  if (!resolveBin("gcloud") || !gsutil) {
    fail("gcloud/gsutil nenalezeny. Nainstaluj Google Cloud SDK a spusť `gcloud auth login`.");
    process.exit(1);
  }
  ok("gcloud + gsutil k dispozici");

  step("Krok 2/4 — Bucket Firebase Storage");
  if (!run(gsutil, ["ls", "-b", bucketUrl(project)]).ok) {
    fail(`Bucket ${bucketUrl(project)} neexistuje — Firebase Storage není zapnuté.`);
    console.log(
      "  → Zapni ho v konzoli: Firebase → Build → Storage → Get started.\n" +
        "    Doporučená location: EU (europe-west / eur3) kvůli GDPR. POZOR: region NEJDE změnit zpět.\n" +
        "    Pak spusť tenhle skript znovu."
    );
    process.exit(2);
  }
  ok(`bucket ${bucketUrl(project)} existuje`);

  step("Krok 3/4 — Nasazení storage pravidel (storage.rules)");
  const fb = resolveFirebase();
  const rules = run(fb.cmd, [...fb.prefix, "deploy", "--only", "storage", "--project", project], { cwd: repoRoot });
  if (!rules.ok) {
    fail("Deploy storage pravidel selhal:");
    console.log("  " + rules.stdout.trim().split("\n").slice(-4).join("\n  "));
    console.log("  → Ověř `firebase login` jako vlastník projektu a spusť znovu.");
    process.exit(3);
  }
  ok("storage.rules nasazeny (vč. povolení připojovacího probe)");

  step("Krok 4/4 — CORS (povolit nahrávání/stahování z appky)");
  const cors = setCors(gsutil, project, origins);
  if (!cors.ok) {
    fail("Nastavení CORS selhalo:");
    console.log("  " + cors.stdout.trim().split("\n").slice(0, 4).join("\n  "));
    process.exit(4);
  }
  ok(`CORS nastaveno pro ${origins.join(", ")}`);
  const verify = run(gsutil, ["cors", "get", bucketUrl(project)]);
  if (verify.ok) console.log("  " + verify.stdout.trim());

  console.log(`\n${OK} Hotovo. V appce vyber Firebase Storage (Nastavení firmy → Úložiště) — připojí se.`);
  void runDriveSetup;
}

main().catch((err) => {
  fail(String(err?.message ?? err));
  process.exit(1);
});
