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
 * Po federaci navíc (best-effort): zdetekuje kapacity projektu (Blaze, Storage,
 * AI Logic/App Check), spustí krok Úložiště (openbuildos-storage-setup.mjs jako
 * child process) a zapíše `workspaces/{projectId}.modules` — mapu zapnutých
 * modulů, kterou čte appka (Nastavení → Moduly). Viz docs/CAPABILITIES.md.
 *
 * Použití:
 *   node scripts/openbuildos-setup.mjs --project <companyProjectId> \
 *        [--region europe-west1] [--firebase-account <email>] [--yes] \
 *        [--enable-all | --minimal]
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
  --yes                     přeskočí potvrzovací dotazy
  --enable-all              zapne všechny moduly, na které projekt má kapacity
                            (výchozí chování)
  --minimal                 zapne jen jádrové moduly; volitelné (Firemní
                            prostory, Hlasové úkoly) nechá vypnuté
  --help                    vypíše tuto nápovědu

CO DĚLÁ (idempotentně, lze pouštět opakovaně):
  1. Preflight: ověří firebase-tools, gcloud, aktivní gcloud účet.
  2. npm install ve functions/.
  3. Deploy firestore pravidel (retry/backoff).
  4. Deploy funkce authExchange (--force, retry/backoff) + vyparsuje URL.
  5. Zjistí runtime service account funkce.
  6. allUsers → roles/run.invoker na Cloud Run službě authexchange.
  7. roles/iam.serviceAccountTokenCreator runtime SA sám na sebe
     (+ 7b: zápis federační URL do config/public).
  8. Detekce kapacit projektu (Blaze / Storage bucket / AI Logic, App Check).
  9. Úložiště: spustí openbuildos-storage-setup.mjs (rules + CORS), když je
     Storage zapnuté; při selhání jen varování.
 10. Zapíše workspaces/<projectId>.modules (mapa modulů pro appku; existující
     nastavení se NEpřepisuje, jen se doplní chybějící moduly).
 11. Vypíše funkce URL + checklist pro moduly, které zapnout nešly.

Detaily a troubleshooting: docs/COMPANION_CLI.md, kapacity: docs/CAPABILITIES.md
`;

function parseCliArgs() {
  const { values } = parseArgs({
    options: {
      project: { type: "string" },
      region: { type: "string" },
      "firebase-account": { type: "string" },
      yes: { type: "boolean", default: false },
      "enable-all": { type: "boolean", default: false },
      minimal: { type: "boolean", default: false },
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
  step("Krok 1/11 — Preflight (kontrola nástrojů a přihlášení)");

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
  step("Krok 2/11 — npm install ve functions/");
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
  step("Krok 3/11 — Deploy Firestore pravidel");
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
  step("Krok 4/11 — Deploy funkce authExchange");
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
  step("Krok 5/11 — Zjišťování runtime service accountu funkce");
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
  step("Krok 6/11 — Veřejný invoker (allUsers → roles/run.invoker)");
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
  step("Krok 7/11 — Token Creator role (createCustomToken / signBlob)");
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

/**
 * KROK 7b: Zapíše federační URL do VEŘEJNÉHO `config/public` docu firemního
 * Firestore (přes REST + access token vlastníka). Appka si ji odtud při
 * připojení firmy načte SAMA (auto-discovery) — uživatel ji nikam neopisuje.
 * Nefatální: když selže, federace půjde dopojit ručně (Upravit připojení).
 */
function writeFederationConfig(gcloud, project, url) {
  step("Krok 7b — Zápis federační URL do config/public (auto-discovery v appce)");
  if (!url) {
    warn("Bez URL přeskakuji — appka si federaci nedoplní automaticky.");
    return;
  }
  try {
    const token = run(gcloud, ["auth", "print-access-token"]).stdout.trim();
    if (!token) {
      throw new Error("prázdný access token");
    }
    const docUrl =
      `https://firestore.googleapis.com/v1/projects/${project}` +
      `/databases/(default)/documents/config/public`;
    const body = JSON.stringify({
      fields: {
        authExchangeUrl: { stringValue: url },
        updatedAt: { timestampValue: new Date().toISOString() },
      },
    });
    const { stdout } = run("curl", [
      "-s",
      "-X",
      "PATCH",
      "-H",
      `Authorization: Bearer ${token}`,
      "-H",
      "Content-Type: application/json",
      "-d",
      body,
      docUrl,
    ]);
    if (/"error"/.test(stdout)) {
      throw new Error(stdout.split("\n").slice(0, 3).join(" "));
    }
    ok("config/public zapsán — appka si federační URL doplní sama při připojení firmy");
  } catch (err) {
    warn(
      `Zápis config/public selhal (nefatální): ${
        (err.combinedOutput || err.message || "").split("\n")[0]
      }`
    );
  }
}

// ---------------------------------------------------------------------------
// Detekce kapacit + moduly workspace (viz docs/CAPABILITIES.md)
// ---------------------------------------------------------------------------

/** Klíče jádrových modulů — vždy zapnuté (fungují na Sparku, jen Firestore). */
const CORE_MODULE_KEYS = ["tasks", "plans", "photos", "reports", "documents"];

/** Access token vlastníka pro REST volání (Firestore / Storage API). */
function ownerAccessToken(gcloud) {
  const token = run(gcloud, ["auth", "print-access-token"]).stdout.trim();
  if (!token) {
    throw new Error("prázdný access token (gcloud auth print-access-token)");
  }
  return token;
}

/** Vrátí HTTP status kód GET požadavku (curl), nebo null při selhání. */
function httpStatus(url, token) {
  try {
    const { stdout } = run("curl", [
      "-s",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      "-H",
      `Authorization: Bearer ${token}`,
      url,
    ]);
    const code = stdout.trim();
    return /^\d{3}$/.test(code) ? Number(code) : null;
  } catch {
    return null;
  }
}

/**
 * KROK 8: Best-effort detekce kapacit projektu. Nic nezapíná — jen zjišťuje,
 * co projekt umí. Hodnoty: true / false / null (= neznámé). Co je neznámé,
 * se NEzapíná a skončí v závěrečném checklistu.
 */
function detectCapabilities(gcloud, project, { functionsDeployed = false } = {}) {
  step("Krok 8/11 — Detekce kapacit projektu (Blaze / Storage / AI Logic)");
  const caps = {
    blaze: null,
    functions: functionsDeployed ? true : null,
    storage: null,
    aiLogic: null, // přes API nedetekovatelné
    appCheck: null, // přes API nedetekovatelné
  };

  // Blaze — heuristika: úspěšný deploy functions v TOMHLE běhu = Blaze určitě.
  if (functionsDeployed) {
    caps.blaze = true;
    ok("Blaze: ano (deploy functions v tomto běhu prošel)");
  } else {
    try {
      const { stdout } = run(gcloud, [
        "billing",
        "projects",
        "describe",
        project,
        "--format=value(billingEnabled)",
      ]);
      const value = stdout.trim().toLowerCase();
      if (value === "true") {
        caps.blaze = true;
        ok("Blaze: ano (billingEnabled)");
      } else if (value === "false") {
        caps.blaze = false;
        info("  Blaze: ne (projekt je na Sparku)");
      } else {
        info("  Blaze: neznámé (billing API nevrátilo stav)");
      }
    } catch {
      info("  Blaze: neznámé (gcloud billing není dostupný / chybí oprávnění)");
    }
  }

  // Storage — existence bucketu <pid>.firebasestorage.app přes REST.
  // 404 = bucket není (Storage vypnuté); 200/403 = bucket existuje
  // (403 jen znamená, že token nesmí listovat — bucket ale JE).
  try {
    const token = ownerAccessToken(gcloud);
    const code = httpStatus(
      `https://firebasestorage.googleapis.com/v0/b/${project}.firebasestorage.app/o?maxResults=1`,
      token
    );
    if (code === 404) {
      caps.storage = false;
      info("  Storage: ne (bucket neexistuje — Storage není zapnuté v konzoli)");
    } else if (code === 200 || code === 403) {
      caps.storage = true;
      ok(`Storage: ano (bucket ${project}.firebasestorage.app existuje)`);
    } else {
      info(`  Storage: neznámé (HTTP ${code ?? "—"})`);
    }
  } catch {
    info("  Storage: neznámé (dotaz na bucket selhal)");
  }

  info("  AI Logic / App Check: přes API nedetekovatelné → neznámé (viz checklist na konci)");
  return caps;
}

/**
 * KROK 9: Úložiště — spustí SDÍLENÝ skript openbuildos-storage-setup.mjs jako
 * child process (rules + CORS). Skript se NEmění (musí zůstat identický s kopií
 * v hlavním repu). Selhání je jen varování, ne fatal.
 */
async function runStorageSetup(project, caps, { yes }, repoRoot) {
  step("Krok 9/11 — Úložiště (openbuildos-storage-setup: storage.rules + CORS)");

  if (caps.storage === false) {
    warn(
      "Úložiště přeskočeno: Storage bucket neexistuje. Zapni Storage v konzoli " +
        `(https://console.firebase.google.com/project/${project}/storage, lokace EU/eur3, po zapnutí zdarma — Spark limity) ` +
        `a spusť: node scripts/openbuildos-storage-setup.mjs --project ${project}`
    );
    return;
  }
  if (caps.storage === null) {
    let proceed = false;
    if (!yes) {
      proceed = await confirm("  Stav Storage se nepodařilo zjistit. Spustit krok Úložiště i tak?");
    }
    if (!proceed) {
      warn(
        "Úložiště přeskočeno (stav Storage neznámý). Až Storage zapneš/ověříš, spusť: " +
          `node scripts/openbuildos-storage-setup.mjs --project ${project}`
      );
      return;
    }
  }

  info("  (spouštím openbuildos-storage-setup.mjs — výstup níže)");
  const script = join(repoRoot, "scripts", "openbuildos-storage-setup.mjs");
  const res = spawnSync(process.execPath, [script, "--project", project], {
    stdio: "inherit",
    cwd: repoRoot,
  });
  if (res.status === 0) {
    caps.storage = true;
    ok("úložiště připraveno (bucket + storage.rules + CORS)");
  } else {
    if (res.status === 2) {
      caps.storage = false; // exit 2 = bucket neexistuje
    }
    warn(
      `openbuildos-storage-setup skončil chybou (exit ${res.status ?? "?"}) — nefatální. ` +
        `Dokonči ručně: node scripts/openbuildos-storage-setup.mjs --project ${project}`
    );
  }
}

/** Převede JS hodnotu na Firestore REST Value (bool/string/number/map). */
function fsValue(value) {
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (value && typeof value === "object") {
    const fields = {};
    for (const [key, v] of Object.entries(value)) {
      fields[key] = fsValue(v);
    }
    return { mapValue: { fields } };
  }
  return { nullValue: null };
}

/**
 * Cílová mapa modulů podle detekovaných kapacit. Tvar MUSÍ sedět s appkou
 * (workspaces/{wid}.modules; ModuleState = { enabled, config? }):
 *   - jádro (tasks, plans, photos, reports, documents) vždy enabled:true,
 *   - companySpaces jen když blaze + functions + storage (a ne --minimal),
 *   - voiceTaskCapture vždy off (vyžaduje ruční AI Logic + App Check
 *     + souhlas admina v UI — zapíná se v appce Nastavení → Moduly).
 */
function computeDesiredModules(caps, minimal) {
  const modules = {};
  for (const key of CORE_MODULE_KEYS) {
    modules[key] = { enabled: true };
  }
  modules.companySpaces = {
    enabled: !minimal && caps.blaze === true && caps.functions === true && caps.storage === true,
  };
  modules.voiceTaskCapture = {
    enabled: false,
    config: { provider: "none", consentGiven: false },
  };
  return modules;
}

/**
 * Warning, když workspaces/{wid} doc ještě neexistuje. PATCH ho NESMÍ založit:
 * appčí `ensureWorkspaceDoc` zakládá doc (ownerId/adminIds/…) jen když
 * NEEXISTUJE — doc založený CLI jen s polem `modules` by znamenal, že se
 * vlastník už nikdy nezapíše a firma má rozbitá práva.
 */
function warnWorkspaceDocMissing() {
  warn(
    "Moduly: workspace dokument ještě neexistuje — otevři appku a aktivuj firmu " +
      "(založí se automaticky), pak moduly zapni v Nastavení → Moduly (nebo spusť setup znovu)."
  );
}

/**
 * KROK 10: Zapíše workspaces/{projectId}.modules přes REST (vzor
 * writeFederationConfig). Idempotentní a NEdestruktivní: když pole `modules`
 * už existuje, existující klíče NEpřepisuje — jen doplní chybějící přes
 * updateMask `modules.<key>`. Zápis má precondition `currentDocument.exists=true`
 * — dokument NIKDY nezakládá (viz warnWorkspaceDocMissing). Nefatální
 * (appka má Nastavení → Moduly).
 */
function seedWorkspaceModules(gcloud, project, caps, minimal) {
  step(`Krok 10/11 — Moduly workspace (workspaces/${project}.modules)`);
  const desired = computeDesiredModules(caps, minimal);
  if (minimal) {
    info("  (--minimal: volitelné moduly zůstávají vypnuté i při dostupných kapacitách)");
  }

  try {
    const token = ownerAccessToken(gcloud);
    const docUrl =
      `https://firestore.googleapis.com/v1/projects/${project}` +
      `/databases/(default)/documents/workspaces/${project}`;

    // Existující modules — čteme, ať slepě nepřepíšeme volby admina.
    let existing = null;
    try {
      const { stdout } = run("curl", [
        "-s",
        "-H",
        `Authorization: Bearer ${token}`,
        `${docUrl}?mask.fieldPaths=modules`,
      ]);
      const parsed = JSON.parse(stdout);
      if (parsed?.error) {
        if (parsed.error.code === 404) {
          // Doc neexistuje — NEZAKLÁDAT (viz warnWorkspaceDocMissing), přeskočit.
          warnWorkspaceDocMissing();
          return;
        }
        throw new Error(`čtení workspaces/${project} selhalo: ${parsed.error.message ?? parsed.error.code}`);
      }
      existing = parsed?.fields?.modules?.mapValue?.fields ?? null;
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error("čtení workspace dokumentu vrátilo neparsovatelnou odpověď");
      }
      throw err;
    }

    let patchUrl;
    let bodyFields;
    let writtenKeys;
    // Precondition currentDocument.exists=true: PATCH doc NIKDY nezaloží.
    const precondition = "currentDocument.exists=true";
    if (!existing) {
      // Pole modules zatím není → zapíšeme celou mapu naráz.
      patchUrl = `${docUrl}?${precondition}&updateMask.fieldPaths=modules`;
      bodyFields = { modules: fsValue(desired) };
      writtenKeys = Object.keys(desired);
    } else {
      // Merge: existující enabled/config zachovat, doplnit JEN chybějící klíče.
      const missing = Object.keys(desired).filter((key) => !(key in existing));
      if (missing.length === 0) {
        ok("modules už existuje a obsahuje všechny moduly — existující nastavení nepřepisuji");
        reportModuleChecklist(project, existing, desired, caps, minimal);
        return;
      }
      patchUrl =
        docUrl +
        `?${precondition}&` +
        missing.map((key) => `updateMask.fieldPaths=modules.${key}`).join("&");
      const fields = {};
      for (const key of missing) {
        fields[key] = fsValue(desired[key]);
      }
      bodyFields = { modules: { mapValue: { fields } } };
      writtenKeys = missing;
      info(`  modules už existuje — doplňuji jen chybějící: ${missing.join(", ")}`);
    }

    const { stdout } = run("curl", [
      "-s",
      "-X",
      "PATCH",
      "-H",
      `Authorization: Bearer ${token}`,
      "-H",
      "Content-Type: application/json",
      "-d",
      JSON.stringify({ fields: bodyFields }),
      patchUrl,
    ]);
    if (/"error"/.test(stdout)) {
      let errorCode = null;
      try {
        errorCode = JSON.parse(stdout)?.error?.code ?? null;
      } catch {
        // neparsovatelná odpověď → obecná chyba níže
      }
      if (errorCode === 400 || errorCode === 404) {
        // Precondition exists=true selhala — doc mezitím zmizel/neexistuje.
        warnWorkspaceDocMissing();
        return;
      }
      throw new Error(stdout.split("\n").slice(0, 3).join(" "));
    }
    const enabledNow = writtenKeys.filter((key) => desired[key].enabled);
    ok(
      `modules zapsáno (${writtenKeys.join(", ")}) — zapnuto: ${
        enabledNow.length ? enabledNow.join(", ") : "(nic nového)"
      }`
    );
    reportModuleChecklist(project, existing, desired, caps, minimal);
  } catch (err) {
    warn(
      `Zápis workspaces/${project}.modules selhal (nefatální): ${
        (err.combinedOutput || err.message || String(err)).split("\n")[0]
      } — moduly zapneš v appce: Nastavení → Moduly.`
    );
    reportModuleChecklist(project, null, desired, caps, minimal);
  }
}

/**
 * Per-feature checklist: pro každý NEzapnutý volitelný modul přidá varování
 * s důvodem a přesným ručním krokem (objeví se v závěrečném shrnutí).
 */
function reportModuleChecklist(project, existing, desired, caps, minimal) {
  const isEnabled = (key) => {
    const fromExisting = existing?.[key]?.mapValue?.fields?.enabled?.booleanValue;
    return typeof fromExisting === "boolean" ? fromExisting : desired[key]?.enabled === true;
  };

  if (!isEnabled("companySpaces")) {
    if (minimal) {
      warn(
        "Firemní prostory: vypnuto kvůli --minimal. Zapni v appce: Nastavení → Moduly."
      );
    } else {
      const missing = [];
      if (caps.blaze !== true) missing.push("plán Blaze");
      if (caps.functions !== true) missing.push("nasazené Cloud Functions (krok 4)");
      if (caps.storage !== true) missing.push("zapnuté Storage (krok 9)");
      warn(
        `Firemní prostory: chybí ${missing.length ? missing.join(" + ") : "ověření kapacit"}. ` +
          `Upgrade na Blaze (https://console.firebase.google.com/project/${project}/usage/details), ` +
          "zapni Storage a spusť setup znovu, pak v appce Nastavení → Moduly modul zapni."
      );
    }
  }

  if (!isEnabled("voiceTaskCapture")) {
    warn(
      "Hlasové úkoly (Gemini): v konzoli zapni Firebase AI Logic " +
        `(https://console.firebase.google.com/project/${project}/ailogic) a registruj App Check ` +
        `(https://console.firebase.google.com/project/${project}/appcheck), pak v appce ` +
        "Nastavení → Moduly modul zapni (vyžaduje souhlas admina). " +
        "Alternativa self-host: Blaze + deploy funkce aiParse + endpoint Ollama — viz docs/CAPABILITIES.md."
    );
  }
}

/** KROK 11: Závěr — federace je auto-discovery, URL jen pro kontrolu/fallback. */
function printConclusion(url) {
  step("Krok 11/11 — Hotovo");
  console.log("");
  console.log("  ┌──────────────────────────────────────────────────────────────┐");
  console.log("  │  FEDERAČNÍ BACKEND PŘIPRAVEN — appka si URL doplní sama         │");
  console.log("  └──────────────────────────────────────────────────────────────┘");
  console.log("");
  console.log(`      authExchange URL: ${url || "(nezjištěno — viz varování výše)"}`);
  console.log("");
  info("  V appce stačí připojit firmu vložením firebaseConfigu — federační URL");
  info("  se načte automaticky z config/public. Ručně ji zadávat NEMUSÍŠ.");
  info("  (Kdyby auto-discovery selhalo: Upravit připojení → „Zadat ručně“ → URL výše.)");
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
      "\nSkript nasadí pravidla + funkci, nastaví 2 IAM role, připraví úložiště" +
        "\na zapíše mapu modulů (workspaces/<projekt>.modules) v tomto projektu."
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
    writeFederationConfig(gcloud, project, url); // krok 7b — auto-discovery

    // krok 8 — detekce kapacit (deploy functions už prošel → Blaze jistý)
    const caps = detectCapabilities(gcloud, project, { functionsDeployed: true });
    await runStorageSetup(project, caps, { yes: args.yes }, repoRoot); // krok 9
    seedWorkspaceModules(gcloud, project, caps, args.minimal === true); // krok 10

    printConclusion(url); // krok 11
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
