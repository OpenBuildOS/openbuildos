#!/usr/bin/env node
/**
 * openbuildos-setup — companion CLI pro asistovaný self-host onboarding firmy.
 *
 * Zautomatizuje přesně ten ruční „asistovaný setup" federačního backendu, který
 * je popsán v `docs/SELF_HOST_ONBOARDING_LOG.md`. Nasadí firestore pravidla a
 * token-exchange funkci `authExchange` do firemního Firebase projektu (Blaze) a
 * nastaví dvě IAM role, bez kterých federace nefunguje:
 *   1) allUsers → roles/run.invoker na Cloud Run službě authexchange
 *      (jinak Cloud Run vrací 403 a browser federaci nezavolá),
 *   2) roles/iam.serviceAccountTokenCreator runtime SA sám na sebe
 *      (jinak createCustomToken → signBlob denied → 401).
 *
 * Skript je IDEMPOTENTNÍ — lze ho spustit opakovaně. Nepoužívá žádné nové npm
 * závislosti; volá lokální `npx firebase` a `gcloud`.
 *
 * Použití:
 *   node scripts/openbuildos-setup.mjs --project <companyProjectId> \
 *        [--region europe-west1] [--firebase-account <email>] [--yes]
 *
 * Bez --project se na projekt zeptá interaktivně.
 *
 * Předpoklady (musí zajistit člověk PŘEDEM, viz docs/COMPANION_CLI.md):
 *   - Node + firebase-tools (přes npx) + gcloud nainstalované,
 *   - `gcloud auth login` jako vlastník firemního projektu,
 *   - firemní Firebase projekt na plánu Blaze, zapnutý Firestore + Authentication.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Logování (čeština, jednoduché značky stavu)
// ---------------------------------------------------------------------------

const OK = "✓";
const FAIL = "✗";
const WARN = "⚠";

/** Varování nasbíraná během běhu — vypíšeme je v závěrečném shrnutí. */
const warnings = [];

function info(msg) {
  console.log(msg);
}
function step(msg) {
  console.log(`\n» ${msg}`);
}
function ok(msg) {
  console.log(`  ${OK} ${msg}`);
}
function fail(msg) {
  console.log(`  ${FAIL} ${msg}`);
}
function warn(msg) {
  console.log(`  ${WARN} ${msg}`);
  warnings.push(msg);
}

// ---------------------------------------------------------------------------
// Lokace nástrojů
// ---------------------------------------------------------------------------

/** Najde gcloud na PATH, jinak zkusí ~/google-cloud-sdk/bin/gcloud. */
function resolveGcloud() {
  const onPath = spawnSync("gcloud", ["--version"], { stdio: "ignore" });
  if (onPath.status === 0) {
    return "gcloud";
  }
  const fallback = join(homedir(), "google-cloud-sdk", "bin", "gcloud");
  if (existsSync(fallback)) {
    return fallback;
  }
  return null;
}

/**
 * Najde firebase CLI. V prostředích jako Google Cloud Shell je `firebase`
 * GLOBÁLNÍ binárka na PATH (a `npx firebase` selže s „could not determine
 * executable"). Lokálně bývá dostupná přes `npx firebase`. Vrací { cmd, prefix }
 * pro spouštění: globální → { cmd:"firebase", prefix:[] }, jinak fallback na npx.
 */
function resolveFirebase() {
  const onPath = spawnSync("firebase", ["--version"], { stdio: "ignore" });
  if (onPath.status === 0) {
    return { cmd: "firebase", prefix: [] };
  }
  return { cmd: "npx", prefix: ["firebase"] };
}

// ---------------------------------------------------------------------------
// Spouštění příkazů s retry/backoffem
// ---------------------------------------------------------------------------

/**
 * Spustí příkaz a vrátí { stdout, stderr }. Při nenulovém exit kódu vyhodí
 * chybu. Volitelně retry s exponenciálním backoffem (na propagaci API/IAM).
 *
 * @param {string} cmd            spustitelný soubor (gcloud / npx)
 * @param {string[]} args         argumenty
 * @param {object} [opts]
 * @param {number} [opts.retries] počet OPAKOVÁNÍ navíc (0 = bez retry)
 * @param {number} [opts.baseDelayMs] základ backoffu (default 4000)
 * @param {boolean} [opts.quiet]  nevypisovat živý výstup
 */
function run(cmd, args, opts = {}) {
  const retries = opts.retries ?? 0;
  const baseDelayMs = opts.baseDelayMs ?? 4000;
  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const stdout = execFileSync(cmd, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 32 * 1024 * 1024,
      });
      return { stdout: stdout ?? "", stderr: "" };
    } catch (err) {
      // execFileSync přidává stdout/stderr na error objekt.
      lastErr = err;
      const stderr = (err.stderr ? String(err.stderr) : "") + (err.stdout ? String(err.stdout) : "");
      lastErr.combinedOutput = stderr;
      if (attempt < retries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        warn(`pokus ${attempt + 1} selhal, zkouším znovu za ${Math.round(delay / 1000)}s (propagace API/IAM)`);
        sleepSync(delay);
      }
    }
  }
  throw lastErr;
}

/** Synchronní spánek bez závislostí (busy-free přes Atomics.wait). */
function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

/** Vrátí kombinovaný výstup z chyby run() bezpečně (může chybět). */
function errOutput(err) {
  return err?.combinedOutput || err?.message || String(err);
}

// ---------------------------------------------------------------------------
// Interaktivní prompty
// ---------------------------------------------------------------------------

async function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise((resolve) => rl.question(question, resolve));
  } finally {
    rl.close();
  }
}

async function confirm(question) {
  const ans = (await prompt(`${question} [a/N] `)).trim().toLowerCase();
  return ans === "a" || ans === "ano" || ans === "y" || ans === "yes";
}

// ---------------------------------------------------------------------------
// Detekce org policy (Domain Restricted Sharing)
// ---------------------------------------------------------------------------

/** True, pokud výstup ukazuje na blokaci org policy DRS (allowedPolicyMemberDomains). */
function isOrgPolicyError(text) {
  const t = (text || "").toLowerCase();
  return (
    t.includes("allowedpolicymemberdomains") ||
    t.includes("domain restricted sharing") ||
    (t.includes("org policy") && t.includes("constraint")) ||
    t.includes("constraints/iam.allowedpolicymemberdomains")
  );
}

// ---------------------------------------------------------------------------
// Parsování funkce URL z výstupu deploye
// ---------------------------------------------------------------------------

/** Vytáhne první https://...run.app nebo cloudfunctions.net URL z textu. */
function parseFunctionUrl(text) {
  if (!text) return null;
  const m = text.match(/https:\/\/[^\s"')]+\.run\.app[^\s"')]*/i) ||
    text.match(/https:\/\/[^\s"')]*cloudfunctions\.net\/authExchange[^\s"')]*/i);
  return m ? m[0] : null;
}

// ---------------------------------------------------------------------------
// CLI argumenty + nápověda
// ---------------------------------------------------------------------------

const HELP = `
openbuildos-setup — companion CLI pro self-host onboarding firmy

POUŽITÍ:
  node scripts/openbuildos-setup.mjs --project <companyProjectId> [volby]

VOLBY:
  --project <id>            ID firemního Firebase projektu (povinné; jinak dotaz)
  --region <region>         region funkce (default: europe-west1)
  --firebase-account <mail> e-mail účtu pro firebase-tools (--account)
  --yes                     přeskočí potvrzovací dotaz
  --help                    vypíše tuto nápovědu

CO DĚLÁ (idempotentně, lze pouštět opakovaně):
  1. Preflight: ověří firebase-tools, gcloud, aktivní gcloud účet.
  2. npm install ve functions/.
  3. Deploy firestore pravidel (retry/backoff).
  4. Deploy funkce authExchange (--force, retry/backoff) + vyparsuje URL.
  5. Zjistí runtime service account funkce.
  6. allUsers → roles/run.invoker na Cloud Run službě authexchange.
  7. roles/iam.serviceAccountTokenCreator runtime SA sám na sebe.
  8. Vypíše funkce URL + návod k vložení do appky.

Detaily a troubleshooting: docs/COMPANION_CLI.md
`;

function parseCliArgs() {
  const { values } = parseArgs({
    options: {
      project: { type: "string" },
      region: { type: "string" },
      "firebase-account": { type: "string" },
      yes: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  return values;
}

// ---------------------------------------------------------------------------
// Jednotlivé kroky
// ---------------------------------------------------------------------------

/** KROK 1: Preflight — nástroje a aktivní gcloud účet. */
function preflight(gcloud, fb) {
  step("Krok 1/8 — Preflight (kontrola nástrojů a přihlášení)");

  // firebase-tools — globální `firebase` (Cloud Shell) nebo `npx firebase`.
  try {
    const { stdout } = run(fb.cmd, [...fb.prefix, "--version"]);
    const how = fb.cmd === "firebase" ? "globální" : "npx";
    ok(`firebase-tools ${stdout.trim().split("\n").pop()} (${how})`);
  } catch (err) {
    fail("firebase-tools nedostupné (ani globální `firebase`, ani `npx firebase`).");
    throw new Error(
      `Nainstaluj firebase-tools (npm i -g firebase-tools) nebo se ujisti, že je na PATH.\n${errOutput(err)}`
    );
  }

  // gcloud
  if (!gcloud) {
    fail("gcloud nenalezen na PATH ani v ~/google-cloud-sdk/bin/gcloud.");
    throw new Error("Nainstaluj Google Cloud SDK (gcloud) a spusť `gcloud auth login`.");
  }
  try {
    const { stdout } = run(gcloud, ["--version"]);
    ok(`gcloud ${stdout.trim().split("\n")[0]}`);
  } catch (err) {
    fail("gcloud --version selhalo.");
    throw new Error(errOutput(err));
  }

  // aktivní účet
  let activeAccount = null;
  try {
    const { stdout } = run(gcloud, [
      "auth",
      "list",
      "--filter=status:ACTIVE",
      "--format=value(account)",
    ]);
    activeAccount = stdout.trim().split("\n").filter(Boolean)[0] || null;
  } catch (err) {
    fail("gcloud auth list selhalo.");
    throw new Error(errOutput(err));
  }
  if (!activeAccount) {
    fail("Žádný aktivní gcloud účet.");
    throw new Error("Spusť `gcloud auth login` (jako vlastník firemního projektu) a zkus to znovu.");
  }
  ok(`aktivní gcloud účet: ${activeAccount}`);
  return activeAccount;
}

/** KROK 2: npm install ve functions/. */
function npmInstallFunctions(repoRoot) {
  step("Krok 2/8 — npm install ve functions/");
  try {
    run("npm", ["install", "--prefix", join(repoRoot, "functions")]);
    ok("functions/node_modules připraveny");
  } catch (err) {
    fail("npm install ve functions/ selhal.");
    throw new Error(errOutput(err));
  }
}

/** Sestaví firebase invokaci: { cmd, args } včetně případného --account. */
function firebaseInvocation(fb, account) {
  const args = [...fb.prefix];
  if (account) {
    args.push("--account", account);
  }
  return { cmd: fb.cmd, args };
}

/** KROK 3: Deploy firestore rules s retry. */
function deployRules(project, account, fb) {
  step("Krok 3/8 — Deploy Firestore pravidel");
  const { cmd, args } = firebaseInvocation(fb, account);
  try {
    run(cmd, [...args, "deploy", "--only", "firestore:rules", "--project", project], {
      retries: 2,
    });
    ok("firestore.rules nasazena");
  } catch (err) {
    fail("Deploy firestore pravidel selhal i po retry.");
    throw new Error(errOutput(err));
  }
}

/** KROK 4: Deploy funkce s --force a retry; vrátí vyparsovanou URL nebo null. */
function deployFunctions(project, account, fb) {
  step("Krok 4/8 — Deploy funkce authExchange");
  info("  (čerstvý Blaze projekt: 1. pokus může selhat na build service account — retry to vyřeší)");
  const { cmd, args } = firebaseInvocation(fb, account);
  try {
    const { stdout } = run(
      cmd,
      [...args, "deploy", "--only", "functions", "--project", project, "--force"],
      { retries: 2, baseDelayMs: 8000 }
    );
    ok("funkce authExchange nasazena (--force nastavil i artifact cleanup policy)");
    const url = parseFunctionUrl(stdout);
    if (url) {
      ok(`URL z deploy výstupu: ${url}`);
    }
    return url;
  } catch (err) {
    fail("Deploy funkce selhal i po retry.");
    throw new Error(errOutput(err));
  }
}

/** Vytáhne funkce URL z Cloud Run, když ji deploy nevrátil. */
function describeRunUrl(gcloud, project, region) {
  try {
    const { stdout } = run(gcloud, [
      "run",
      "services",
      "describe",
      "authexchange",
      "--region",
      region,
      "--project",
      project,
      "--format=value(status.url)",
    ]);
    return stdout.trim() || null;
  } catch (err) {
    warn(`Nepodařilo se zjistit URL přes gcloud run describe: ${errOutput(err).split("\n")[0]}`);
    return null;
  }
}

/** KROK 5: Zjistí runtime SA funkce; fallback na default compute SA. */
function resolveRuntimeServiceAccount(gcloud, project, region) {
  step("Krok 5/8 — Zjišťování runtime service accountu funkce");
  let sa = null;
  try {
    const { stdout } = run(gcloud, [
      "run",
      "services",
      "describe",
      "authexchange",
      "--region",
      region,
      "--project",
      project,
      "--format=value(spec.template.spec.serviceAccountName)",
    ]);
    sa = stdout.trim() || null;
  } catch (err) {
    warn(`run describe (serviceAccountName) selhalo: ${errOutput(err).split("\n")[0]}`);
  }

  if (sa) {
    ok(`runtime SA: ${sa}`);
    return sa;
  }

  // Fallback: default compute SA = <projectNumber>-compute@developer.gserviceaccount.com
  try {
    const { stdout } = run(gcloud, [
      "projects",
      "describe",
      project,
      "--format=value(projectNumber)",
    ]);
    const projectNumber = stdout.trim();
    if (!projectNumber) {
      throw new Error("prázdné projectNumber");
    }
    sa = `${projectNumber}-compute@developer.gserviceaccount.com`;
    ok(`runtime SA (default compute): ${sa}`);
    return sa;
  } catch (err) {
    fail("Nepodařilo se zjistit runtime service account.");
    throw new Error(errOutput(err));
  }
}

/** KROK 6: allUsers → roles/run.invoker na Cloud Run službě authexchange. */
function grantPublicInvoker(gcloud, project, region) {
  step("Krok 6/8 — Veřejný invoker (allUsers → roles/run.invoker)");
  try {
    run(gcloud, [
      "run",
      "services",
      "add-iam-policy-binding",
      "authexchange",
      "--region",
      region,
      "--member=allUsers",
      "--role=roles/run.invoker",
      "--project",
      project,
    ]);
    ok("allUsers má roles/run.invoker (neověřená volání povolena)");
  } catch (err) {
    const out = errOutput(err);
    if (isOrgPolicyError(out)) {
      fail("Org policy (Domain Restricted Sharing) zablokovala allUsers.");
      warn(
        "Firemní org policy 'constraints/iam.allowedPolicyMemberDomains' brání přidat allUsers. " +
          "Admin organizace musí policy upravit (povolit allUsers / public), NEBO zvolit jiný přístup " +
          "(API Gateway / Hosting rewrite). Federace bez veřejného invokeru vrací 403."
      );
      return; // nespadnout tiše — pokračujeme dál, varování je v shrnutí
    }
    fail("Grant veřejného invokeru selhal.");
    throw new Error(out);
  }
}

/** KROK 7: roles/iam.serviceAccountTokenCreator runtime SA sám na sebe. */
function grantTokenCreator(gcloud, project, sa) {
  step("Krok 7/8 — Token Creator role (createCustomToken / signBlob)");
  try {
    run(gcloud, [
      "iam",
      "service-accounts",
      "add-iam-policy-binding",
      sa,
      `--member=serviceAccount:${sa}`,
      "--role=roles/iam.serviceAccountTokenCreator",
      "--project",
      project,
    ]);
    ok(`${sa} smí podepisovat (signBlob) — createCustomToken bude fungovat`);
    info("  (pozn.: IAM propagace ~1–2 min)");
  } catch (err) {
    fail("Grant Token Creator role selhal.");
    throw new Error(errOutput(err));
  }
}

/** KROK 8: Závěr — vypíše URL a návod. */
function printConclusion(url) {
  step("Krok 8/8 — Hotovo");
  console.log("");
  console.log("  ┌──────────────────────────────────────────────────────────────┐");
  console.log("  │  FUNKCE URL (ověřovací endpoint federace):                     │");
  console.log("  └──────────────────────────────────────────────────────────────┘");
  console.log("");
  console.log(`      ${url || "(URL se nepodařilo zjistit — viz varování výše)"}`);
  console.log("");
  info("  Vlož tuto URL v appce do připojení firmy:");
  info("    Upravit připojení → „URL ověřovací funkce“ → vlož URL výše,");
  info("    a přihlas se přes OpenBuildOS účet.");
}

/** Závěrečné shrnutí. */
function printSummary({ project, region, url, success }) {
  console.log("\n──────────────────────── SHRNUTÍ ────────────────────────");
  console.log(`Projekt:  ${project}`);
  console.log(`Region:   ${region}`);
  console.log(`Stav:     ${success ? `${OK} dokončeno` : `${FAIL} přerušeno chybou`}`);
  if (url) {
    console.log(`URL:      ${url}`);
  }
  if (warnings.length) {
    console.log(`\nVarování (${warnings.length}):`);
    for (const w of warnings) {
      console.log(`  ${WARN} ${w}`);
    }
  } else if (success) {
    console.log("Žádná varování. Federační backend firmy je připraven.");
  }
  console.log("──────────────────────────────────────────────────────────\n");
}

// ---------------------------------------------------------------------------
// Hlavní tok
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCliArgs();

  if (args.help) {
    console.log(HELP);
    return 0;
  }

  // Repo root = nadřazený adresář scripts/ (skript běží přes node z repa).
  const repoRoot = process.cwd();

  const region = args.region || "europe-west1";
  const account = args["firebase-account"] || null;

  // Projekt — interaktivně, pokud chybí.
  let project = args.project;
  if (!project) {
    project = (await prompt("Zadej ID firemního Firebase projektu (--project): ")).trim();
  }
  if (!project) {
    console.error(`${FAIL} Chybí --project. Bez něj nelze pokračovat.`);
    return 1;
  }

  console.log("\n=== openbuildos-setup — asistovaný self-host onboarding ===");
  console.log(`Repo:     ${repoRoot}`);
  console.log(`Projekt:  ${project}`);
  console.log(`Region:   ${region}`);
  if (account) {
    console.log(`Účet FB:  ${account}`);
  }

  const gcloud = resolveGcloud();
  const fb = resolveFirebase();

  // Potvrzení (pokud není --yes).
  if (!args.yes) {
    console.log(
      "\nSkript nasadí pravidla + funkci a nastaví 2 IAM role v tomto projektu."
    );
    const proceed = await confirm("Pokračovat?");
    if (!proceed) {
      info("Zrušeno uživatelem.");
      return 0;
    }
  }

  let url = null;
  try {
    preflight(gcloud, fb); // krok 1 (gcloud null se zde řeší)
    npmInstallFunctions(repoRoot); // krok 2
    deployRules(project, account, fb); // krok 3
    url = deployFunctions(project, account, fb); // krok 4

    if (!url) {
      url = describeRunUrl(gcloud, project, region);
      if (url) {
        ok(`URL z gcloud run describe: ${url}`);
      } else {
        warn("Funkce URL se nepodařilo zjistit z deploye ani z gcloud.");
      }
    }

    const sa = resolveRuntimeServiceAccount(gcloud, project, region); // krok 5
    grantPublicInvoker(gcloud, project, region); // krok 6 (org policy se řeší uvnitř)
    grantTokenCreator(gcloud, project, sa); // krok 7

    printConclusion(url); // krok 8
    printSummary({ project, region, url, success: true });
    return 0;
  } catch (err) {
    console.error(`\n${FAIL} Setup přerušen: ${err.message}`);
    printSummary({ project, region, url, success: false });
    return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`${FAIL} Neočekávaná chyba: ${err?.message || err}`);
    process.exit(1);
  });
