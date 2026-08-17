#!/usr/bin/env node
/**
 * shared-files-sync — přepočítá `shared-files.manifest.json` z hlavního repa.
 *
 * Manifest je ZRCADLO Háčku 1 z `docs/REPO_BOUNDARIES.md`. Hlavní repo je
 * privátní, takže tenhle skript NEBĚŽÍ v CI companionu — pouští ho člověk,
 * který má oba klony na disku, ve chvíli, kdy dokončil zrcadlení.
 *
 * ── SEZNAM SE NEOPISUJE ────────────────────────────────────────────────────
 * Zdroj pravdy zůstává tabulka v hlavním repu; tenhle skript ji PARSUJE. Kdyby
 * se sem seznam přepisoval ručně, vznikla by třetí kopie pravdy — přesně ta
 * věc, kvůli které celá zarážka existuje. Když se tabulka nedá přečíst nebo
 * vyjde prázdná, skript SPADNE a manifest nechá být.
 *
 * ── ČTE SE `origin/main`, NE PRACOVNÍ STROM ────────────────────────────────
 * Otisky mají popisovat stav, ze kterého se doopravdy deployuje. Pracovní strom
 * klonu umí obojí — rozdělanou práci i zapomenutý `git fetch` — a manifest
 * zapsaný z něj by companion CI uklidnil dřív, než se změna vůbec někam dostala.
 *
 * Použití:
 *   node scripts/shared-files-sync.mjs                    # klon na obvyklé cestě
 *   node scripts/shared-files-sync.mjs --main /cesta/ke/klonu
 *   node scripts/shared-files-sync.mjs --check            # jen ohlásí rozdíl, nezapisuje
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256, MANIFEST_PATH, MAIN_REPO } from "./shared-files-check.mjs";

const BOUNDARIES_DOC = "docs/REPO_BOUNDARIES.md";
const MAIN_REF = process.env.OBOS_MAIN_REF ?? "origin/main";

/** Kde hlavní repo obvykle leží. `REPO_BOUNDARIES.md` uvádí tuhle cestu. */
const MAIN_LOCAL_CANDIDATES = [process.env.OBOS_MAIN_PATH, "/Users/anit/Documents/openbuildos"].filter(Boolean);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ─────────────── parsování Háčku 1 (stejný tvar jako v hlavním repu) ────────

const tableCells = (line) => {
  const t = line.trim();
  return t.startsWith("|") && t.endsWith("|") ? t.slice(1, -1).split("|").map((c) => c.trim()) : null;
};

const backtickedPath = (cell) => cell?.match(/^`([^`]+)`$/)?.[1] ?? null;

/**
 * Řádky tabulky pod nadpisem obsahujícím `needle`, do PRVNÍHO dalšího nadpisu.
 * Kdyby se sbíralo dál, spolkla by se i tabulka „co sdílené NENÍ“, tedy pravý opak.
 */
export function tableRowsUnderHeading(markdown, needle) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{2,4}\s/.test(l) && l.includes(needle));
  if (start === -1) return null;
  const rows = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{1,6}\s/.test(lines[i])) break;
    const cells = tableCells(lines[i]);
    if (cells) rows.push(cells);
  }
  return rows;
}

export function parseSharedFiles(markdown) {
  const rows = tableRowsUnderHeading(markdown, "SDÍLENÉ soubory");
  if (!rows) return null;
  return rows
    .map(([main, companion]) => ({ main: backtickedPath(main), companion: backtickedPath(companion) }))
    .filter((p) => p.main && p.companion);
}

export function parseNonSharedFiles(markdown) {
  const rows = tableRowsUnderHeading(markdown, "sdílené NENÍ");
  if (!rows) return [];
  return rows.map(([path]) => backtickedPath(path)).filter(Boolean);
}

// ───────────────────────────────── běh ──────────────────────────────────────

function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

function main(argv) {
  const checkOnly = argv.includes("--check");
  const flag = argv.indexOf("--main");
  if (flag !== -1 && (argv[flag + 1] === undefined || argv[flag + 1].startsWith("--"))) {
    console.error("[shared-files-sync] ❌ --main čeká cestu ke klonu hlavního repa, žádná nepřišla.");
    return 1;
  }
  const explicit = flag === -1 ? null : argv[flag + 1];
  const mainRoot = explicit ?? MAIN_LOCAL_CANDIDATES.find((p) => existsSync(join(p, BOUNDARIES_DOC)));

  if (!mainRoot || !existsSync(join(mainRoot, BOUNDARIES_DOC))) {
    console.error(
      `[shared-files-sync] ❌ klon hlavního repa se nenašel${explicit ? ` na ${explicit}` : ""}.\n` +
        `    ${MAIN_REPO} je privátní, takže manifest umí přepočítat jen ten, kdo ho má na disku.\n` +
        `    Cestu lze předat: --main /cesta/ke/klonu (nebo OBOS_MAIN_PATH).`
    );
    return 1;
  }

  const markdown = git(mainRoot, ["show", `${MAIN_REF}:${BOUNDARIES_DOC}`]);
  if (!markdown) {
    console.error(
      `[shared-files-sync] ❌ nejde přečíst ${MAIN_REF}:${BOUNDARIES_DOC} v ${mainRoot}.\n` +
        `    Chybí ref? Zkus \`git -C ${mainRoot} fetch origin\`.`
    );
    return 1;
  }

  const shared = parseSharedFiles(markdown);
  if (!shared || shared.length === 0) {
    console.error(
      `[shared-files-sync] ❌ v ${BOUNDARIES_DOC} se nenašla tabulka sdílených souborů (Háček 1).\n` +
        `    Buď se přejmenoval nadpis, nebo se rozpadl tvar tabulky. Manifest zůstal beze změny —\n` +
        `    přepsat ho prázdným seznamem by zarážku tiše vypnulo.`
    );
    return 1;
  }

  const entries = [];
  for (const pair of shared) {
    const text = git(mainRoot, ["show", `${MAIN_REF}:${pair.main}`]);
    if (text === null) {
      console.error(
        `[shared-files-sync] ❌ ${pair.main} v ${MAIN_REF} NENÍ, přitom ho Háček 1 vede jako sdílený.\n` +
          `    Doplň ho, nebo ho z tabulky vyřaď — manifest se z rozbitého seznamu negeneruje.`
      );
      return 1;
    }
    entries.push({ main: pair.main, companion: pair.companion, mainSha256: sha256(text) });
  }

  const ref = git(mainRoot, ["rev-parse", MAIN_REF])?.trim() ?? null;
  const date = git(mainRoot, ["log", "-1", "--format=%cI", MAIN_REF])?.trim().slice(0, 10) ?? null;

  const manifestFull = join(repoRoot, MANIFEST_PATH);
  const current = JSON.parse(readFileSync(manifestFull, "utf8"));
  const next = {
    ...current,
    generatedFrom: { repo: MAIN_REPO, doc: BOUNDARIES_DOC, section: "Háček 1 — SDÍLENÉ soubory", ref, date },
    shared: entries,
    notShared: parseNonSharedFiles(markdown),
  };

  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  const unchanged = serialized === readFileSync(manifestFull, "utf8");

  if (checkOnly) {
    if (unchanged) {
      console.log(`[shared-files-sync] ✅ ${MANIFEST_PATH} odpovídá ${MAIN_REF} (${entries.length} souborů).`);
      return 0;
    }
    console.error(
      `[shared-files-sync] ❌ ${MANIFEST_PATH} neodpovídá ${MAIN_REF} — pusť \`npm run shared-files:sync\`.`
    );
    return 1;
  }

  if (unchanged) {
    console.log(`[shared-files-sync] ✅ beze změny — ${MANIFEST_PATH} už odpovídá ${MAIN_REF}.`);
    return 0;
  }
  writeFileSync(manifestFull, serialized);
  console.log(
    `[shared-files-sync] ✅ zapsáno: ${entries.length} sdílených souborů z ${MAIN_REPO}@${ref?.slice(0, 12)} (${date}).`
  );
  return 0;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
