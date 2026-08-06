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
 *   2. Ověří, že v projektu BĚŽÍ funkce, které razí custom claims
 *      (`authExchange` + `syncMemberClaims`). Bez nich by krok 3 zamkl firmu
 *      ven — viz níže.
 *   3. Nasadí STORAGE RULES (storage.rules) — bez nich je bucket deny-all a
 *      appka nemůže nahrávat ani ověřit připojení (probe).
 *   4. Nastaví CORS (jinak preflight i upload z appky padají na CORS).
 *   5. Ověří CORS.
 *
 * 🔴 PROČ TEN KROK S FUNKCEMI (přidáno 6. 8. 2026)
 * Od #496 gatují `storage.rules` KAŽDOU cestu na custom claims `wsa`/`pw`/`p`.
 * Ty claims razí do tokenu firemní funkce `authExchange` / `syncMemberClaims`.
 * Nasadit tahle pravidla do projektu, kde ty funkce neběží, znamená, že claims
 * nemá NIKDO — a protože catch-all je `allow read, write: if false` a i
 * připojovací probe chce `isWorkspaceAdmin(wid)`, ztratí přístup k úložišti
 * i vlastník firmy. Není odkud se zachránit; tenhle skript umí jen deploy
 * pravidel, ne deploy funkcí. Proto se bez funkcí ODMÍTÁ spustit.
 * Pořadí je: nejdřív `openbuildos-setup` (krok 4 = funkce), pak úložiště.
 *
 * Budoucí: Google Drive / OneDrive (OAuth) — viz `runDriveSetup()` stub.
 *
 * Předpoklady: gcloud + firebase-tools (npx) + `gcloud auth login` a
 * `firebase login` jako vlastník firemního projektu.
 *
 * Spusť Z KOŘENE repa (potřebuje storage.rules + firebase.json):
 *   node scripts/openbuildos-storage-setup.mjs --project <firma-project-id>
 *   node scripts/openbuildos-storage-setup.mjs --project <id> --origin https://app.mojefirma.cz
 *
 * Exit kódy: 1 = špatné použití / chybí nástroje, 2 = bucket neexistuje,
 * 3 = deploy pravidel selhal, 4 = CORS selhalo, 5 = backend bez claims funkcí.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

/**
 * Funkce, které MUSÍ v cílovém projektu běžet, než tam smí jít claims-gated
 * `storage.rules`. `authExchange` razí claims při přihlášení, `syncMemberClaims`
 * je přerazí při změně členství. Bez obou je token bez claims = deny-all.
 */
const REQUIRED_CLAIMS_FUNCTIONS = ["authExchange", "syncMemberClaims"];
const FUNCTIONS_API = "https://cloudfunctions.googleapis.com/v2";

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

// ---------------------------------------------------------------------------
// Kontrola backendu (claims) — čisté funkce, ať jdou testovat bez sítě
// ---------------------------------------------------------------------------

/**
 * Gatují lokální `storage.rules` na custom claims? Kontrola je odvozená ze
 * SOUBORU, ne z data vydání: kdyby se pravidla někdy vrátila na `isRealUser()`,
 * brána zmizí sama a nebude nikomu překážet.
 */
export function rulesRequireClaims(source) {
  return /claim\(\s*['"](wsa|pw|p)['"]\s*\)|request\.auth\.token\.(wsa|pw|p)\b/.test(source ?? "");
}

/** ID funkcí (poslední segment `name`) z odpovědi Cloud Functions v2 API; jen běžící. */
export function activeFunctionIds(payload) {
  return (payload?.functions ?? [])
    .filter((fn) => !fn.state || fn.state === "ACTIVE")
    .map((fn) => String(fn?.name ?? "").split("/").pop())
    .filter(Boolean);
}

/**
 * Které z povinných funkcí v projektu chybí. Porovnání je case-insensitive:
 * Cloud Functions drží ID tak, jak se jmenuje export (`authExchange`), kdežto
 * Cloud Run službu pojmenuje malými písmeny (`authexchange`).
 */
export function missingClaimsFunctions(ids, required = REQUIRED_CLAIMS_FUNCTIONS) {
  const have = new Set((ids ?? []).map((id) => String(id).toLowerCase()));
  return required.filter((name) => !have.has(name.toLowerCase()));
}

/**
 * Vylistuje nasazené funkce přes Cloud Functions v2 API.
 * Vrací `{ ok: true, ids }` nebo `{ ok: false, reason }` — „nevím" se od
 * „nejsou tam" liší schválně, protože z každého plyne jiná rada.
 */
async function listDeployedFunctions(gcloud, project) {
  const tok = run(gcloud, ["auth", "print-access-token"]);
  if (!tok.ok) {
    return { ok: false, reason: "`gcloud auth print-access-token` selhalo — spusť `gcloud auth login`." };
  }
  const token = tok.stdout.trim();
  const ids = [];
  let pageToken = "";
  for (let page = 0; page < 5; page += 1) {
    const url =
      `${FUNCTIONS_API}/projects/${encodeURIComponent(project)}/locations/-/functions?pageSize=100` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
    let res;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    } catch (err) {
      return { ok: false, reason: `Cloud Functions API nejde zavolat (${err?.message ?? err}).` };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // Vypnuté API = v projektu se nikdy nic nenasadilo. To NENÍ „nevím“.
      if (res.status === 403 && /SERVICE_DISABLED|has not been used in project/i.test(body)) {
        return { ok: true, ids: [] };
      }
      return { ok: false, reason: `Cloud Functions API vrátilo HTTP ${res.status}. ${body.slice(0, 200)}` };
    }
    const json = await res.json().catch(() => null);
    ids.push(...activeFunctionIds(json));
    pageToken = json?.nextPageToken ?? "";
    if (!pageToken) break;
  }
  return { ok: true, ids };
}

function parseArgs() {
  const args = process.argv.slice(2);
  let project = "";
  let skipBackendCheck = false;
  const extraOrigins = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--project") project = args[i + 1] ?? "";
    // Havarijní východ. Pojmenovaný tak, aby se nedal odklepnout omylem —
    // kdo ho použije bez nasazených funkcí, přijde o přístup k úložišti.
    if (args[i] === "--skip-backend-check") skipBackendCheck = true;
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
  return { project, origins, skipBackendCheck };
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

/**
 * KROK 3: brána proti zamčení firmy ven. Když lokální `storage.rules` gatují na
 * claims, MUSÍ v cílovém projektu běžet funkce, které je razí. Ověřuje se
 * SKUTEČNÝ stav v projektu (Cloud Functions v2 API), ne příznak na disku.
 */
async function assertClaimsBackend(gcloud, project, { skipBackendCheck }) {
  step("Krok 3/5 — Backend, který razí claims (authExchange + syncMemberClaims)");

  let rulesSource = "";
  try {
    rulesSource = readFileSync(join(repoRoot, "storage.rules"), "utf8");
  } catch (err) {
    fail(`storage.rules nejde přečíst (${err?.message ?? err}). Spouštěj skript z kořene repa.`);
    process.exit(1);
  }
  if (!rulesRequireClaims(rulesSource)) {
    ok("storage.rules na claims negatují — brána se neuplatňuje");
    return;
  }

  if (skipBackendCheck) {
    warn("--skip-backend-check: kontrola PŘESKOČENA. Když funkce neběží, ztratíš přístup k úložišti.");
    return;
  }

  const listing = await listDeployedFunctions(gcloud, project);
  if (!listing.ok) {
    fail(`Nepodařilo se ověřit, jestli v projektu ${project} běží funkce pro claims.`);
    console.log(`  Důvod: ${listing.reason}`);
    printClaimsRemedy(project);
    console.log(
      "  → Když víš jistě, že funkce běží, a jde jen o oprávnění ke čtení,\n" +
        "    lze bránu obejít: --skip-backend-check (havarijní východ, ne běžný postup)."
    );
    process.exit(5);
  }

  const missing = missingClaimsFunctions(listing.ids);
  if (missing.length > 0) {
    fail(`V projektu ${project} neběží: ${missing.join(", ")}.`);
    console.log(
      "  Dnešní storage.rules pouštějí ke KAŽDÉMU souboru jen podle custom claims\n" +
        "  (wsa/pw/p), a ty razí právě tyhle funkce. Nasadit pravidla bez nich znamená,\n" +
        "  že claims nemá nikdo — o přístup k úložišti přijde i vlastník firmy.\n" +
        "  Deploy pravidel proto NEPROBĚHL (nic se nezměnilo)."
    );
    printClaimsRemedy(project);
    process.exit(5);
  }
  ok(`funkce běží: ${REQUIRED_CLAIMS_FUNCTIONS.join(", ")}`);
}

function printClaimsRemedy(project) {
  console.log(
    "  → Nejdřív nasaď backend firmy (krok 4 = funkce), pak úložiště:\n" +
      `      node scripts/openbuildos-setup.mjs --project ${project}\n` +
      "    Plný setup pustí tenhle skript sám jako krok 9, takže pak už ho ručně nepotřebuješ."
  );
}

async function main() {
  const { project, origins, skipBackendCheck } = parseArgs();
  console.log("OpenBuildOS — nastavení úložiště firmy (FÁZE B)\n");
  if (!project) {
    fail("Chybí --project <firma-project-id>.");
    process.exit(1);
  }

  step("Krok 1/5 — Kontrola nástrojů");
  const gsutil = resolveBin("gsutil");
  const gcloud = resolveBin("gcloud");
  if (!gcloud || !gsutil) {
    fail("gcloud/gsutil nenalezeny. Nainstaluj Google Cloud SDK a spusť `gcloud auth login`.");
    process.exit(1);
  }
  ok("gcloud + gsutil k dispozici");

  step("Krok 2/5 — Bucket Firebase Storage");
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

  await assertClaimsBackend(gcloud, project, { skipBackendCheck });

  step("Krok 4/5 — Nasazení storage pravidel (storage.rules)");
  const fb = resolveFirebase();
  const rules = run(fb.cmd, [...fb.prefix, "deploy", "--only", "storage", "--project", project], { cwd: repoRoot });
  if (!rules.ok) {
    fail("Deploy storage pravidel selhal:");
    console.log("  " + rules.stdout.trim().split("\n").slice(-4).join("\n  "));
    console.log("  → Ověř `firebase login` jako vlastník projektu a spusť znovu.");
    process.exit(3);
  }
  ok("storage.rules nasazeny (vč. povolení připojovacího probe)");

  step("Krok 5/5 — CORS (povolit nahrávání/stahování z appky)");
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

// `main()` jen při přímém spuštění — jinak by import v testu rozjel celý setup.
// Setup CLI skript spouští přes `spawnSync(process.execPath, [script, …])`,
// takže `process.argv[1]` je tenhle soubor a běh se chová beze změny.
const isDirectRun =
  Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((err) => {
    fail(String(err?.message ?? err));
    process.exit(1);
  });
}
