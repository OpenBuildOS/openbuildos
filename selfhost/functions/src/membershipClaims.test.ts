import assert from "node:assert/strict";
import test from "node:test";
import {
  CLAIMS_BYTE_LIMIT,
  ClaimsTooLargeError,
  assertClaimsFit,
  buildMembershipClaims,
  claimsByteSize,
  type MembershipInput,
} from "./membershipClaims";

const base: MembershipInput = {
  principal: "u1",
  adminWorkspaces: [],
  memberWorkspaceIds: [],
  excludedProjectIds: [],
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
  assert.equal(claims.ws, undefined);
});

test("zaměstnanec firmy dostane ws, admin se nezdvojuje", () => {
  const claims = buildMembershipClaims({
    ...base,
    adminWorkspaces: [{ id: "W1", ownerId: "u1", adminIds: [] }],
    memberWorkspaceIds: ["W1", "W2"],
  });
  assert.deepEqual(claims.wsa, ["W1"]);
  assert.deepEqual(claims.ws, ["W2"]);
});

test("host dostane per-projekt claim podle role", () => {
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
  assert.equal(claims.ws, undefined);
});

test("hostovský claim nese i workspace, ať neautorizuje cizí prefix", () => {
  const claims = buildMembershipClaims({
    ...base,
    projects: [{ id: "P1", workspaceId: "W1", roles: { u1: "editor" } }],
  });
  assert.deepEqual(claims.pw, ["W1/P1"]);
  assert.ok(!claims.pw?.includes("P1"), "holý pid by pustil workspaces/CIZI/projects/P1/…");
});

test("projekty pokryté workspacem se do claims nepíšou (šetří bajty)", () => {
  const claims = buildMembershipClaims({
    ...base,
    memberWorkspaceIds: ["W1"],
    projects: [
      { id: "P1", workspaceId: "W1", roles: { u1: "viewer" } },
      { id: "P2", workspaceId: "W2", roles: { u1: "viewer" } },
    ],
  });
  assert.deepEqual(claims.ws, ["W1"]);
  assert.deepEqual(claims.p, ["W2/P2"]);
});

test("vyloučený projekt firmy jde do px", () => {
  const claims = buildMembershipClaims({
    ...base,
    memberWorkspaceIds: ["W1"],
    excludedProjectIds: ["P9"],
    projects: [{ id: "P1", workspaceId: "W1", roles: { u1: "editor" } }],
  });
  assert.deepEqual(claims.px, ["P9"]);
});

test("výjimka neplatí, když je člen přesto v memberIds (Storage nesmí být přísnější než Firestore)", () => {
  const claims = buildMembershipClaims({
    ...base,
    memberWorkspaceIds: ["W1"],
    excludedProjectIds: ["P1"],
    projects: [{ id: "P1", workspaceId: "W1", roles: { u1: "editor" } }],
  });
  assert.equal(claims.px, undefined);
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

test("claims v mezích projdou", () => {
  const claims = buildMembershipClaims({
    ...base,
    memberWorkspaceIds: ["workspace-with-a-fairly-long-id"],
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
  assert.match(error.message, /člena firmy/);
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
