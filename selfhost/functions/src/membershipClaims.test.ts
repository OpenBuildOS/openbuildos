import assert from "node:assert/strict";
import test from "node:test";
import type { Firestore } from "firebase-admin/firestore";
import {
  CLAIMS_BYTE_LIMIT,
  ClaimsTooLargeError,
  assertClaimsFit,
  belongsToWorkspace,
  buildMembershipClaims,
  claimsByteSize,
  computeMembershipClaims,
  loadMembershipInput,
  type MembershipInput,
} from "./membershipClaims";

const base: MembershipInput = {
  principal: "u1",
  adminWorkspaces: [],
  projects: [],
};

test("vlastník a admin firmy dostanou wsa", () => {
  const claims = buildMembershipClaims({
    ...base,
    adminWorkspaces: [
      { id: "W1", ownerId: "u1", adminIds: [] },
      { id: "W2", ownerId: "someone", adminIds: ["u1"] },
      { id: "W3", ownerId: "someone", adminIds: ["kdosi"] },
    ],
  });
  assert.deepEqual(claims.wsa, ["W1", "W2"]);
});

test("člen projektu dostane claim podle role", () => {
  const claims = buildMembershipClaims({
    ...base,
    projects: [
      { id: "P1", workspaceId: "W9", roles: { u1: "viewer" } },
      { id: "P2", workspaceId: "W9", roles: { u1: "editor" } },
      { id: "P3", workspaceId: "W9", roles: { u1: "admin" } },
      { id: "P4", workspaceId: "W9", roles: { u1: "company_lead" } },
      { id: "P5", workspaceId: "W9", roles: { u1: "reader" } },
    ],
  });
  // Plný zápis = oprávnění `edit` (#506 fáze 2). Legacy `company_lead` ho podle
  // migrační tabulky má — dřív dostával jen čtecí claim a mazání záznamu tak po
  // sobě nechávalo soubory (nález F5).
  assert.deepEqual(claims.pw, ["W9/P2", "W9/P3", "W9/P4"]);
  // `reader` (jen `read`) sdílí claim s `viewer` — Storage jemnější úroveň nemá.
  assert.deepEqual(claims.p, ["W9/P1", "W9/P5"]);
});

test("claim nese i workspace, ať neautorizuje cizí prefix", () => {
  const claims = buildMembershipClaims({
    ...base,
    projects: [{ id: "P1", workspaceId: "W1", roles: { u1: "editor" } }],
  });
  assert.deepEqual(claims.pw, ["W1/P1"]);
  assert.ok(!claims.pw?.includes("P1"), "holý pid by pustil workspaces/CIZI/projects/P1/…");
});

test("projekty pokryté adminstvím firmy se do claims nepíšou (šetří bajty)", () => {
  const claims = buildMembershipClaims({
    ...base,
    adminWorkspaces: [{ id: "W1", ownerId: "u1", adminIds: [] }],
    projects: [
      { id: "P1", workspaceId: "W1", roles: { u1: "viewer" } },
      { id: "P2", workspaceId: "W2", roles: { u1: "viewer" } },
    ],
  });
  assert.deepEqual(claims.wsa, ["W1"]);
  assert.deepEqual(claims.p, ["W2/P2"]);
});

// 🔴 REGRESE. Adresářový záznam `workspaces/{wid}/members/{principal}` zakládá
// `redeemInvite` KAŽDÉMU pozvanému včetně hosta z cizí firmy. Kdyby z něj plynul
// workspace-level claim, TDI pozvaný na jednu stavbu by dostal všech osm.
// Vstup výpočtu proto o firemním adresáři vůbec neví — a vědět nesmí.
test("členství se odvozuje JEN z projektů a adminství, ne z firemního adresáře", () => {
  const claims = buildMembershipClaims({
    ...base,
    projects: [{ id: "P1", workspaceId: "W1", roles: { u1: "viewer" } }],
  });
  // Pořadí záleží: `assert.deepEqual` je assertion funkce a typ tu zúží.
  assert.equal(claims.wsa, undefined, "host nesmí dostat workspace-level claim");
  assert.deepEqual(claims, { p: ["W1/P1"] });

  // MembershipInput nemá kam adresářový záznam předat — to je záměr, ne opomenutí.
  assert.deepEqual(Object.keys(base).sort(), ["adminWorkspaces", "principal", "projects"]);
});

// 🔴 REGRESE. Dokud přístup plynul z workspace, odebraný člen ztratil Firestore
// okamžitě a Storage nikdy. Claims teď zrcadlí `memberIds`, takže odebrání platí.
test("odebrání z projektu vezme claim (claims zrcadlí memberIds)", () => {
  const before = buildMembershipClaims({
    ...base,
    projects: [
      { id: "P1", workspaceId: "W1", roles: { u1: "editor" } },
      { id: "P2", workspaceId: "W1", roles: { u1: "editor" } },
    ],
  });
  assert.deepEqual(before.pw, ["W1/P1", "W1/P2"]);

  const after = buildMembershipClaims({
    ...base,
    projects: [{ id: "P1", workspaceId: "W1", roles: { u1: "editor" } }],
  });
  assert.deepEqual(after.pw, ["W1/P1"]);
});

test("neznámá role spadne do čtecího claimu, ne do zápisového", () => {
  const claims = buildMembershipClaims({
    ...base,
    projects: [
      { id: "P1", workspaceId: "W9", roles: {} },
      { id: "P2", workspaceId: "W9", roles: { u1: "neco_noveho" } },
    ],
  });
  assert.equal(claims.pw, undefined);
  assert.deepEqual(claims.p, ["W9/P1", "W9/P2"]);
});

test("prázdné členství = prázdné claims (uživatel se nikam nedostane)", () => {
  assert.deepEqual(buildMembershipClaims(base), {});
});

test("belongsToWorkspace pozná vlastní workspace a odmítne cizí", () => {
  const claims = buildMembershipClaims({
    ...base,
    projects: [{ id: "P1", workspaceId: "W1", roles: { u1: "editor" } }],
  });
  assert.equal(belongsToWorkspace(claims, "W1"), true);
  assert.equal(belongsToWorkspace(claims, "W2"), false);
  // Prefix se nesmí splést s jiným workspacem, který jím začíná.
  assert.equal(belongsToWorkspace(claims, "W"), false);
  assert.equal(belongsToWorkspace({ wsa: ["W5"] }, "W5"), true);
  assert.equal(belongsToWorkspace({}, "W1"), false);
});

test("claims v mezích projdou", () => {
  const claims = buildMembershipClaims({
    ...base,
    adminWorkspaces: [{ id: "workspace-with-a-fairly-long-id", ownerId: "u1", adminIds: [] }],
  });
  assert.doesNotThrow(() => assertClaimsFit({ ...claims, email: "a@b.cz", name: "Jan Novák" }));
});

test("přetečení je TVRDÁ chyba se srozumitelnou hláškou, ne tiché uříznutí", () => {
  const projects = Array.from({ length: 60 }, (_, index) => ({
    id: `project-uuid-${String(index).padStart(4, "0")}-abcdef`,
    workspaceId: "W9",
    roles: { u1: "viewer" },
  }));
  const claims = buildMembershipClaims({ ...base, projects });
  assert.equal(claims.p?.length, 60);

  let thrown: unknown;
  try {
    assertClaimsFit(claims);
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof ClaimsTooLargeError, "musí vyhodit ClaimsTooLargeError");
  const error = thrown as ClaimsTooLargeError;
  assert.ok(error.bytes > error.limit);
  assert.match(error.message, /60 projektů/);
  // Seznam zůstal celý — nic se tiše neuřízlo.
  assert.equal(claims.p?.length, 60);
});

test("rozpočet je pod tvrdým limitem Firebase", () => {
  const claims = buildMembershipClaims({
    ...base,
    projects: Array.from({ length: 20 }, (_, index) => ({
      id: `p${index}`,
      workspaceId: "W9",
      roles: { u1: "editor" },
    })),
  });
  assert.ok(claimsByteSize(claims) < CLAIMS_BYTE_LIMIT);
});

// ────────────────────────────────────────────────────────────────────────────
// `loadMembershipInput` — jediná cesta, jak se claim dostane do tokenu.
//
// Do 8. 8. 2026 na ni nevedl ANI JEDEN test: izolace Storage stála na
// konstrukci, ne na testu (docs/SECURITY_CLAIMS_DESIGN.md kap. 0). Po nasazení
// `storage.rules` na produkci je ztráta claimu ztráta souborů, takže „vypadl
// projekt z podkladů" už není nepříjemnost, ale odříznutí uživatele od dat.
//
// Fake Firestore níž je ZÁMĚRNĚ nedůvěřivý: cokoli jiného než tři očekávané
// indexované dotazy vyhodí. Tím test hlídá i to, co se čít NESMÍ — firemní
// adresář `workspaces/{wid}/members/{principal}`.
// ────────────────────────────────────────────────────────────────────────────

interface FakeDoc {
  id: string;
  data: Record<string, unknown>;
}

interface FakeSeed {
  workspaces?: FakeDoc[];
  projects?: FakeDoc[];
}

function matches(doc: FakeDoc, field: string, op: string, value: unknown): boolean {
  const raw = doc.data[field];
  if (op === "==") {
    return raw === value;
  }
  if (op === "array-contains") {
    return Array.isArray(raw) && raw.includes(value);
  }
  throw new Error(`Fake Firestore: neznámý operátor ${op}`);
}

/** Firestore, který umí právě to, co `loadMembershipInput` potřebuje — a nic víc. */
function fakeFirestore(seed: FakeSeed): { db: Firestore; queries: string[] } {
  const queries: string[] = [];

  const fake = {
    collection(path: string) {
      if (path !== "workspaces" && path !== "projects") {
        // Podkolekce (`workspaces/W1/members`) ani nic jiného se čít nesmí.
        throw new Error(`Fake Firestore: neočekávaná kolekce ${path}`);
      }
      const source = (path === "workspaces" ? seed.workspaces : seed.projects) ?? [];
      return {
        where(field: string, op: string, value: unknown) {
          return {
            async get() {
              queries.push(`${path} | ${field} ${op} ${String(value)}`);
              const docs = source
                .filter((doc) => matches(doc, field, op, value))
                .map((doc) => ({ id: doc.id, get: (f: string) => doc.data[f] }));
              return { docs };
            },
          };
        },
      };
    },
    doc(path: string) {
      throw new Error(`Fake Firestore: neočekávané čtení dokumentu ${path}`);
    },
    collectionGroup(path: string) {
      throw new Error(`Fake Firestore: neočekávaná collection group ${path}`);
    },
  };

  return { db: fake as unknown as Firestore, queries };
}

/** Odchytí, co kód řekl do logu — `loadMembershipInput` má zahození ohlásit. */
function captureConsole<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = { warn: console.warn, error: console.error, info: console.info };
  const record = (level: string) => (...args: unknown[]) => {
    lines.push(`${level}: ${args.map((arg) => String(arg)).join(" ")}`);
  };
  console.warn = record("warn");
  console.error = record("error");
  console.info = record("info");
  return fn()
    .then((result) => ({ result, lines }))
    .finally(() => {
      console.warn = original.warn;
      console.error = original.error;
      console.info = original.info;
    });
}

test("podklady se čtou třemi indexovanými dotazy — a ničím jiným", async () => {
  const { db, queries } = fakeFirestore({
    workspaces: [{ id: "W1", data: { ownerId: "u1", adminIds: [] } }],
    projects: [{ id: "P1", data: { workspaceId: "W1", memberIds: ["u1"], roles: { u1: "editor" } } }],
  });

  await loadMembershipInput(db, "u1");

  assert.deepEqual(queries.sort(), [
    "projects | memberIds array-contains u1",
    "workspaces | adminIds array-contains u1",
    "workspaces | ownerId == u1",
  ]);
});

// 🔴 REGRESE. Adresářový záznam `workspaces/{wid}/members/{principal}` zakládá
// `redeemInvite` KAŽDÉMU pozvanému včetně hosta z cizí firmy, a od #523 si do
// něj host smí sám napsat `membershipKind: "employee"` (rules pouštějí zápis
// vlastního záznamu). Kdyby z něj plynul claim, TDI pozvaný na jednu stavbu
// dostane všech osm. Fake Firestore proto na tu podkolekci vyhodí — tenhle test
// nespadne „na assertu", ale na tom, že se to vůbec zkusilo přečíst.
test("claims se odvozují JEN z členství v projektech, ne z firemního adresáře", async () => {
  const { db, queries } = fakeFirestore({
    // Host: v adresáři firmy W1 by záznam měl, ale členem projektu je jen v W2.
    workspaces: [{ id: "W1", data: { ownerId: "kdosi", adminIds: ["kdosi"] } }],
    projects: [{ id: "P9", data: { workspaceId: "W2", memberIds: ["host"], roles: { host: "viewer" } } }],
  });

  const claims = buildMembershipClaims(await loadMembershipInput(db, "host"));

  assert.deepEqual(claims, { p: ["W2/P9"] });
  assert.ok(
    !queries.some((query) => query.includes("members")),
    "firemní adresář se nesmí čít ani omylem"
  );
});

test("owner i admin téže firmy dají JEDEN záznam, ne dva", async () => {
  const { db } = fakeFirestore({
    workspaces: [
      { id: "W1", data: { ownerId: "u1", adminIds: ["u1", "kolega"] } },
      { id: "W2", data: { ownerId: "kdosi", adminIds: ["u1"] } },
      { id: "W3", data: { ownerId: "kdosi", adminIds: ["kdosi"] } },
    ],
  });

  const input = await loadMembershipInput(db, "u1");

  assert.deepEqual(
    input.adminWorkspaces.map((workspace) => workspace.id).sort(),
    ["W1", "W2"]
  );
  assert.equal(input.principal, "u1");
  assert.deepEqual(buildMembershipClaims(input).wsa, ["W1", "W2"]);
});

test("chybějící ownerId/adminIds se normalizují, ne aby spadly", async () => {
  const { db } = fakeFirestore({
    workspaces: [{ id: "W1", data: { adminIds: ["u1"] } }],
  });

  const input = await loadMembershipInput(db, "u1");

  assert.deepEqual(input.adminWorkspaces, [{ id: "W1", ownerId: null, adminIds: ["u1"] }]);
});

test("projekt bez pole roles dostane čtecí claim, ne výjimku", async () => {
  const { db } = fakeFirestore({
    projects: [{ id: "P1", data: { workspaceId: "W1", memberIds: ["u1"] } }],
  });

  const input = await loadMembershipInput(db, "u1");

  assert.deepEqual(input.projects, [{ id: "P1", workspaceId: "W1", roles: {} }]);
  assert.deepEqual(buildMembershipClaims(input), { p: ["W1/P1"] });
});

// 🔴 ZNÁMÁ MEZERA, kterou tenhle test POPISUJE, ne schvaluje.
//
// Projekt bez `workspaceId` se zahodí tichým `continue`. Zahodit ho je správně:
// claim má tvar `{wid}/{pid}` a holý `pid` by autorizoval
// `workspaces/CIZI-FIRMA/projects/MUJ-PROJEKT/…`. Špatně je, že se to NIKDE
// neohlásí — uživatel je členem projektu (je v `memberIds`), ale ve Storage se
// ke svým souborům nedostane a v logu po tom nezůstane ani řádek. Legacy data
// bez `workspaceId` reálně existují (`src/services/workspaceProjects.ts` s tím
// polem počítá jako s volitelným).
//
// ⚠️ Doplnit hlášení = změna zdroje (`membershipClaims.ts` je sdílený soubor,
// docs/REPO_BOUNDARIES.md) a patří do samostatné dávky. Až se to stane, tenhle
// test se MUSÍ upravit — `lines` přestane být prázdné. To je záměr: ať je fix
// vědomý, ne mimochodem.
test("🔴 projekt bez workspaceId se zahodí — a dnes se to NIKDE neohlásí", async () => {
  const { db } = fakeFirestore({
    projects: [
      { id: "P-legacy", data: { memberIds: ["u1"], roles: { u1: "editor" } } },
      { id: "P-prazdny", data: { workspaceId: "", memberIds: ["u1"], roles: { u1: "editor" } } },
      { id: "P-cislo", data: { workspaceId: 42, memberIds: ["u1"], roles: { u1: "editor" } } },
      { id: "P-ok", data: { workspaceId: "W1", memberIds: ["u1"], roles: { u1: "editor" } } },
    ],
  });

  const { result: input, lines } = await captureConsole(() => loadMembershipInput(db, "u1"));

  // Zahození je správně: bez wid není claim, který by šel bezpečně vydat.
  assert.deepEqual(input.projects.map((project) => project.id), ["P-ok"]);
  assert.deepEqual(buildMembershipClaims(input), { pw: ["W1/P-ok"] });

  // A tady je ta mezera: tři projekty zmizely bez jediného slova.
  assert.deepEqual(lines, [], "dnešní stav — až se hlášení doplní, tenhle assert se změní");
});

test("hostovaný prostor (`ws_…` wid) se do claims vejde i s podtržítkem", async () => {
  const hostedWid = "ws_abcdefghijklmnopqrst";
  const { db } = fakeFirestore({
    workspaces: [{ id: hostedWid, data: { ownerId: "kdosi", adminIds: ["kdosi"] } }],
    projects: [
      { id: "P1", data: { workspaceId: hostedWid, memberIds: ["u1"], roles: { u1: "editor" } } },
      { id: "P2", data: { workspaceId: hostedWid, memberIds: ["u1"], roles: { u1: "viewer" } } },
    ],
  });

  const claims = await computeMembershipClaims(db, "u1");

  assert.deepEqual(claims, { pw: [`${hostedWid}/P1`], p: [`${hostedWid}/P2`] });
  assert.equal(belongsToWorkspace(claims, hostedWid), true);
  // Legacy wid, který je prefixem hostovaného, se s ním nesmí splést.
  assert.equal(belongsToWorkspace(claims, "ws"), false);
  assert.equal(belongsToWorkspace(claims, hostedWid.slice(0, -1)), false);
});

test("admin hostované firmy dostane jeden záznam na celý prostor", async () => {
  const hostedWid = "ws_abcdefghijklmnopqrst";
  const { db } = fakeFirestore({
    workspaces: [{ id: hostedWid, data: { ownerId: "u1", adminIds: [] } }],
    projects: [
      { id: "P1", data: { workspaceId: hostedWid, memberIds: ["u1"], roles: { u1: "editor" } } },
      { id: "P2", data: { workspaceId: hostedWid, memberIds: ["u1"], roles: { u1: "viewer" } } },
    ],
  });

  const claims = await computeMembershipClaims(db, "u1");

  assert.deepEqual(claims, { wsa: [hostedWid] });
  assert.ok(claimsByteSize(claims) < CLAIMS_BYTE_LIMIT / 10, "admin se vejde s rezervou");
});

test("prázdné členství projde celou cestou až k prázdným claims", async () => {
  const { db } = fakeFirestore({
    workspaces: [{ id: "W1", data: { ownerId: "kdosi", adminIds: [] } }],
    projects: [{ id: "P1", data: { workspaceId: "W1", memberIds: ["kdosi"], roles: {} }}],
  });

  assert.deepEqual(await computeMembershipClaims(db, "nikdo"), {});
});

// 🔴 Strop tokenu je tvrdý limit Firebase (1000 B). Přetečení MUSÍ vyhodit,
// ne tiše uříznout seznam — uříznutý claim je ztráta souborů bez varování.
test("hostovaný prostor s mnoha stavbami narazí na strop tokenu, ne na tiché uříznutí", async () => {
  const hostedWid = "ws_abcdefghijklmnopqrst";
  const { db } = fakeFirestore({
    projects: Array.from({ length: 40 }, (_, index) => ({
      id: `project-uuid-${String(index).padStart(4, "0")}`,
      data: { workspaceId: hostedWid, memberIds: ["u1"], roles: { u1: "viewer" } },
    })),
  });

  const claims = await computeMembershipClaims(db, "u1");
  assert.equal(claims.p?.length, 40);

  let thrown: unknown;
  try {
    assertClaimsFit({ ...claims, email: "jan@example.cz", name: "Jan Novák" });
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof ClaimsTooLargeError, "musí vyhodit ClaimsTooLargeError");
  const error = thrown as ClaimsTooLargeError;
  assert.ok(error.bytes > error.limit);
  assert.ok(error.limit < CLAIMS_BYTE_LIMIT, "rozpočet musí mít rezervu pod tvrdým limitem");
  assert.match(error.message, /40 projektů/);
  // Seznam zůstal celý — nic se neuřízlo.
  assert.equal(claims.p?.length, 40);
});

/**
 * 🔴 STROP PRODUKTU, ZMĚŘENÝ. Hostovaný prostor platí za `ws_…` wid (23 znaků)
 * v KAŽDÉ položce claims, takže se do tokenu vejde MÍŇ staveb než self-hosteru
 * s krátkým wid (`bbfs` = 4 znaky). S realistickými hodnotami — Firestore
 * auto-id projektu (20 znaků) a profilová pole `email` + `name` — je hranice
 * OSMNÁCT staveb: na osmnácté `syncMemberClaims` vyhodí a uživatel se
 * nepřihlásí, dokud ho někdo neudělá adminem firmy (jedna položka na celý
 * prostor).
 *
 * Kdyby se tenhle test rozešel, znamená to, že se strop produktu POHNUL —
 * což je zpráva pro produkt, ne jen červený test. Číslo tu proto stojí přesně,
 * ne jako „přibližně".
 */
test("hostované firmě se do tokenu vejde 17 staveb, na 18. to řekne nahlas", async () => {
  const hostedWid = `ws_${"a".repeat(20)}`;
  const profile = { email: "jan.novak@example.cz", name: "Jan Novák" };

  async function claimsFor(count: number) {
    const { db } = fakeFirestore({
      projects: Array.from({ length: count }, (_, index) => ({
        // 20 znaků = tvar Firestore auto-id, jaké projekty reálně mají.
        id: `p${String(index).padStart(19, "0")}`,
        data: { workspaceId: hostedWid, memberIds: ["u1"], roles: { u1: "viewer" } },
      })),
    });
    return computeMembershipClaims(db, "u1");
  }

  let fits = 0;
  for (let count = 1; count <= 30; count += 1) {
    const claims = await claimsFor(count);
    assert.equal(claims.p?.length, count, "nic se nesmí tiše uříznout");
    try {
      assertClaimsFit({ ...claims, ...profile });
      fits = count;
    } catch {
      break;
    }
  }

  assert.equal(fits, 17, "hranice se pohnula — to je zpráva pro produkt, ne jen červený test");

  // Na 18. stavbě to musí být SROZUMITELNÉ: co se stalo a co s tím.
  const overflow = await claimsFor(18);
  let thrown: unknown;
  try {
    assertClaimsFit({ ...overflow, ...profile });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof ClaimsTooLargeError);
  assert.match((thrown as ClaimsTooLargeError).message, /18 projektů/);
  assert.match((thrown as ClaimsTooLargeError).message, /admina firmy/);

  // Rozpočet má rezervu pod tvrdým limitem Firebase — token se nesmí utrhnout
  // až u Firebase, kde by z toho byla neurčitá chyba.
  assert.ok(claimsByteSize({ ...(await claimsFor(17)), ...profile }) < CLAIMS_BYTE_LIMIT);
});
