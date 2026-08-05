import assert from "node:assert/strict";
import test from "node:test";
import {
  CLAIMS_BYTE_LIMIT,
  ClaimsTooLargeError,
  assertClaimsFit,
  belongsToWorkspace,
  buildMembershipClaims,
  claimsByteSize,
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
    ],
  });
  assert.deepEqual(claims.pw, ["W9/P2", "W9/P3"]);
  // company_lead smí zakládat, ale ne mazat cizí binárky → čtecí claim.
  assert.deepEqual(claims.p, ["W9/P1", "W9/P4"]);
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
