#!/usr/bin/env node
/**
 * shared-files-check — companion strana zarážky na sdílené soubory.
 *
 * Třináct souborů (pravidla, storage setup CLI a Cloud Functions, které běží
 * u self-hostu i v centrále) je ZÁMĚRNĚ duplikovaných v tomhle repu a v repu
 * appky. Musí zůstat identické. Rozdíl se NEPROJEVÍ V UI ani na jedné straně:
 * obě aplikace fungují, jen jedna vymáhá něco, co druhá ne.
 *
 * 🔴 CO SE STALO. 15. 8. 2026 byl `selfhost/firestore.rules` 495 řádků pozadu
 * a chybělo mu celé zmrazení stavby po dobu předání (`projectFrozen`). U
 * self-hostované firmy by se během předání tiše ztrácela data. Nenašla to
 * kontrola, našla to náhoda při bezpečnostní revizi.
 *
 * ── PROČ TOHLE NEUMÍ „prostě stáhnout hlavní repo" ─────────────────────────
 * Hlavní repo `trpaslik444/construct-cloud-sync` je PRIVÁTNÍ, tenhle companion
 * VEŘEJNÝ. Companion CI se tedy na jeho obsah nedostane bez tokenu — a token
 * s přístupem do privátního repa uložený v tajemstvích veřejného repa je horší
 * vada než ta, kterou by hlídal. Navíc by nefungoval tam, kde je nejvíc
 * potřeba: PR z forku tajemství NEDOSTANE, takže by kontrola u cizích příspěvků
 * mlčky neběžela. Rozhodnutí a odmítnuté varianty: `docs/SHARED_FILES.md`.
 *
 * Proto se porovnává proti ZRCADLENÉ TABULCE otisků (`shared-files.manifest.json`),
 * kterou drží aktuální blokující job `shared-files` v CI hlavního repa. Tenhle
 * skript nepotřebuje síť, token ani tajemství — běží i na PR z forku.
 *
 * ── CO JE ČERVENÁ A CO JEN VAROVÁNÍ (a proč zrovna takhle) ─────────────────
 * Pořadí práce z `docs/REPO_BOUNDARIES.md` je „uprav companion → slouč ho →
 * zrcadli do hlavního repa". Companion se tedy mění PRVNÍ a v okamžiku svého
 * PR je hlavní repo POZADU ZE ZÁSADY. Tvrdá kontrola „musí se rovnat hlavnímu
 * repu" by proto svítila červeně na KAŽDÉ poctivé změně sdíleného souboru —
 * a takovou zarážku někdo do týdne vypne. Rozděluje se tedy podle toho, kdo to
 * může spravit v tomhle PR:
 *
 *   ČERVENÁ (způsobil to tenhle PR a tenhle PR to umí spravit):
 *     • manifest chybí, nejde přečíst, nebo je prázdný — zarážka, která nic
 *       nehlídá, je horší než žádná, takže se NIKDY nepropouští jako „nic
 *       ke kontrole",
 *     • sdílený soubor v companionu CHYBÍ (smazaný/přejmenovaný bez zápisu),
 *     • PR mění sdílený soubor, ale NEPŘIZNÁVÁ zrcadlení (`Mirror-to-main:`).
 *
 *   VAROVÁNÍ (pravda, ale tenhle PR za to nemůže):
 *     • sdílený soubor se od hlavního repa liší a PR na něj nesáhl — to je dluh
 *       na zrcadlení z dřívějška. Shazovat kvůli němu cizí PR by znamenalo
 *       zablokovat repo, dokud to někdo nezrcadlí. Vypíše se do shrnutí jobu
 *       a blokující autoritou pro tenhle směr zůstává CI hlavního repa.
 *
 * `Mirror-to-main:` je vědomé přiznání, ne zaškrtávátko: pojmenuje konkrétní
 * protějšek, který si člověk umí otevřít. Že se dluh SKUTEČNĚ splatil, ověří
 * job `shared-files` v hlavním repu — ten porovnává bajt po bajtu. Tyhle dvě
 * kontroly se doplňují: tady se závazek ZAPÍŠE ve chvíli změny, tam se vymáhá.
 *
 * Použití:
 *   node scripts/shared-files-check.mjs                  # jen manifest vs. disk
 *   node scripts/shared-files-check.mjs --base origin/main   # + co PR mění
 */
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST_PATH = "selfhost/shared-files.manifest.json";
export const MAIN_REPO = "trpaslik444/construct-cloud-sync";

/** Kořen repa: skript leží v `selfhost/scripts/`. */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

// ───────────────────────────── manifest ─────────────────────────────────────

/**
 * Manifest → `{ shared, notShared }`, nebo `{ error }`.
 *
 * Každá chyba je POJMENOVANÁ. „Manifest se nepovedlo načíst" pošle člověka
 * hádat; „v položce 3 chybí mainSha256" ho pošle na řádek.
 */
export function parseManifest(json) {
  let data;
  try {
    data = JSON.parse(json);
  } catch (err) {
    return { error: `manifest není platný JSON (${err.message})` };
  }
  if (!Array.isArray(data.shared)) {
    return { error: "manifest nemá pole `shared`" };
  }
  if (data.shared.length === 0) {
    // Prázdný seznam NENÍ „nic ke kontrole". Přesně takhle vypadá zarážka,
    // kterou někdo vyprázdnil, aby mu prošel PR.
    return { error: "pole `shared` je prázdné — to se NEBERE jako „nic ke kontrole“" };
  }
  for (const [i, entry] of data.shared.entries()) {
    for (const key of ["main", "companion", "mainSha256"]) {
      if (typeof entry?.[key] !== "string" || !entry[key]) {
        return { error: `položka #${i + 1} v \`shared\` nemá \`${key}\`` };
      }
    }
    if (!/^[0-9a-f]{64}$/.test(entry.mainSha256)) {
      return { error: `položka \`${entry.companion}\` má \`mainSha256\`, který není sha256` };
    }
  }
  const seen = new Set();
  for (const entry of data.shared) {
    if (seen.has(entry.companion)) {
      return { error: `\`${entry.companion}\` je v \`shared\` dvakrát` };
    }
    seen.add(entry.companion);
  }
  return { shared: data.shared, notShared: data.notShared ?? [], generatedFrom: data.generatedFrom ?? {} };
}

// ───────────────────────── přiznání zrcadlení ───────────────────────────────

/**
 * `Mirror-to-main: <odkaz>` v těle PR nebo ve zprávě commitu.
 *
 * Hodnota musí být neprázdná a musí mít aspoň jeden neprázdný znak mimo
 * interpunkci — `Mirror-to-main: -` je zaškrtávátko, ne přiznání.
 */
export function mirrorDeclaration(text) {
  const m = String(text ?? "").match(/^[ \t]*Mirror-to-main:[ \t]*(.+)$/im);
  if (!m) return null;
  const value = m[1].trim();
  return /[\p{L}\p{N}]/u.test(value) ? value : null;
}

// ────────────────────────────── git ─────────────────────────────────────────

function git(args) {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * Soubory, na které tenhle PR sáhl, proti `base`.
 *
 * `null` = nepodařilo se zjistit (mělký checkout, chybějící base). Volající to
 * MUSÍ odlišit od prázdného seznamu: „PR nesáhl na nic" a „nevím, na co sáhl"
 * vedou k opačnému verdiktu, a tiše zvolit ten mírnější je právě ten druh
 * vypnuté zarážky, kvůli které tenhle soubor vznikl.
 */
export function changedFiles(base) {
  if (!base) return null;
  if (git(["rev-parse", "--verify", `${base}^{commit}`]) === null) return null;
  const out = git(["diff", "--name-only", `${base}...HEAD`]);
  return out === null ? null : out.split("\n").filter(Boolean);
}

// ────────────────────────────── běh ─────────────────────────────────────────

export function parseArgs(argv) {
  const i = argv.indexOf("--base");
  if (i === -1) return { base: null, error: null };
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) {
    return { base: null, error: "--base čeká ref, žádný nepřišel." };
  }
  return { base: value, error: null };
}

function main(argv, env) {
  const args = parseArgs(argv);
  if (args.error) {
    console.error(`[shared-files] ❌ ${args.error}`);
    return 1;
  }

  const manifestFull = join(repoRoot, MANIFEST_PATH);
  if (!existsSync(manifestFull)) {
    console.error(
      `[shared-files] ❌ chybí ${MANIFEST_PATH} — bez něj není seznam sdílených souborů.\n` +
        `    Je to zrcadlo Háčku 1 z ${MAIN_REPO}:docs/REPO_BOUNDARIES.md. Nemazat.`
    );
    return 1;
  }

  const parsed = parseManifest(readFileSync(manifestFull, "utf8"));
  if (parsed.error) {
    console.error(
      `[shared-files] ❌ ${MANIFEST_PATH}: ${parsed.error}.\n` +
        `    Zarážka, která nic nehlídá, je horší než žádná — proto tohle padá, ne propouští.`
    );
    return 1;
  }
  const { shared, generatedFrom } = parsed;

  const touched = changedFiles(args.base);
  if (args.base && touched === null) {
    console.error(
      `[shared-files] ❌ nejde zjistit, co PR mění proti \`${args.base}\` (mělký checkout? chybějící ref?).\n` +
        `    Bez toho by se změna sdíleného souboru tvářila jako cizí dluh a prošla by jako varování.\n` +
        `    V CI to řeší \`fetch-depth: 0\` u actions/checkout.`
    );
    return 1;
  }
  const touchedSet = new Set(touched ?? []);

  const from = generatedFrom.ref
    ? `${MAIN_REPO}@${String(generatedFrom.ref).slice(0, 12)}${generatedFrom.date ? ` (${generatedFrom.date})` : ""}`
    : MAIN_REPO;
  console.log(`[shared-files] ověřuji ${shared.length} sdílených souborů proti otiskům z ${from}`);
  if (touched === null) {
    console.log(`[shared-files] ⓘ  bez \`--base\`: nekontroluje se přiznání zrcadlení, jen dluh vůči hlavnímu repu.`);
  }

  const missing = [];
  const needsMirror = [];
  const staleDebt = [];

  for (const pair of shared) {
    const full = join(repoRoot, pair.companion);
    if (!existsSync(full)) {
      missing.push(pair);
      continue;
    }
    if (sha256(readFileSync(full, "utf8")) === pair.mainSha256) continue;
    (touchedSet.has(pair.companion) ? needsMirror : staleDebt).push(pair);
  }

  let failures = 0;

  for (const pair of missing) {
    console.error(
      `[shared-files] ❌ ${pair.companion} — sdílený soubor v companionu CHYBÍ.\n` +
        `    Háček 1 ho vede jako protějšek \`${pair.main}\` v hlavním repu. Smazat nebo přejmenovat\n` +
        `    ho jde jen SOUČASNĚ s úpravou Háčku 1 v ${MAIN_REPO} — jinak si firmy na self-hostu\n` +
        `    při příštím \`setup\` nasadí backend bez něj.`
    );
    failures += 1;
  }

  // Změna sdíleného souboru je podle pořadí práce SPRÁVNĚ (companion je
  // kanonický a jde první). Vadou není změna, vadou je nezapsaný závazek —
  // právě ten se dosud ztrácel mezi „sloučeno tady" a „zrcadleno tam".
  if (needsMirror.length > 0) {
    const declared = mirrorDeclaration(env.PR_BODY) ?? mirrorDeclaration(git(["log", "-1", "--format=%B"]) ?? "");
    if (declared) {
      console.log(
        `[shared-files] ✅ PR mění ${needsMirror.length} sdílených souborů a zrcadlení přiznává: ${declared}`
      );
      for (const pair of needsMirror) console.log(`               ↳ ${pair.companion} → ${pair.main}`);
    } else {
      console.error(
        `[shared-files] ❌ PR mění ${needsMirror.length} SDÍLENÝCH souborů, ale nepřiznává zrcadlení:`
      );
      for (const pair of needsMirror) console.error(`    • ${pair.companion} → ${MAIN_REPO}:${pair.main}`);
      console.error(
        `\n    Tyhle soubory existují dvakrát a musí zůstat identické. Companion je kanonický,\n` +
          `    takže tahle změna je v pořádku — ale dokud se nezrcadlí do hlavního repa, vymáhá\n` +
          `    každá strana něco jiného. To se neprojeví v UI ani na jedné z nich.\n` +
          `\n    Dopiš do těla PR (nebo do zprávy commitu) řádek s protějškem:\n` +
          `        Mirror-to-main: ${MAIN_REPO}#<číslo PR>\n` +
          `    Že se zrcadlení opravdu stalo, ověří bajt po bajtu job \`shared-files\` v CI hlavního repa.`
      );
      failures += 1;
    }
  }

  // Dluh z dřívějška. Pravda, ale tenhle PR za něj nemůže — shodit ho tady by
  // znamenalo zablokovat repo komukoli, dokud to někdo nezrcadlí.
  if (staleDebt.length > 0) {
    console.warn(
      `\n[shared-files] ⚠️  ${staleDebt.length} sdílených souborů se liší od otisku z hlavního repa,\n` +
        `    ale tenhle PR na ně nesáhl — je to dluh na zrcadlení z dřívějška:`
    );
    for (const pair of staleDebt) console.warn(`    • ${pair.companion} ↔ ${pair.main}`);
    console.warn(
      `    Blokující autoritou pro tenhle směr je job \`shared-files\` v CI hlavního repa.\n` +
        `    Až se zrcadlení dokončí, přepočítej otisky: \`npm run shared-files:sync\`.`
    );
  }

  if (failures > 0) {
    console.error(
      `\n[shared-files] ❌ ${failures} nález(ů). Rozdíl ve sdíleném souboru se neprojeví v UI ani na jedné\n` +
        `    straně — jedna aplikace prostě vymáhá něco, co druhá ne (15. 8. 2026: chybějící zmrazení\n` +
        `    při předání = tichá ztráta dat u self-hostované firmy).`
    );
    return 1;
  }

  const clean = shared.length - missing.length - needsMirror.length - staleDebt.length;
  console.log(`[shared-files] ✅ ${clean} z ${shared.length} sdílených souborů sedí s hlavním repem (sha256).`);
  return 0;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
