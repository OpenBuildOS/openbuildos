import type { Firestore } from "firebase-admin/firestore";

/**
 * Výpočet custom claims s členstvím (docs/SECURITY_CLAIMS_DESIGN.md kap. 3).
 *
 * Storage rules nemají spolehlivý cross-service `firestore.get()`, takže
 * autorizace musí přijet v TOKENU. Tenhle modul spočítá z Firestore, kam
 * uživatel patří, a složí z toho claims:
 *
 *   wsa  vlastník / admin firmy   → všechny projekty té firmy
 *   pw   role editor / admin na projektu → plná práva na ten projekt
 *   p    ostatní členství (viewer, company_lead) → čtení + založení objektu
 *
 * ⭐ Claims ZÁMĚRNĚ zrcadlí `isProjectMember` z firestore.rules jedna ku jedné:
 *
 *     isProjectMember(wid, pid) = principal in projects/{pid}.memberIds
 *                              || isWsAdmin(wid)
 *
 * Nic víc, nic míň. Kdykoli se claims od tohohle vzorce odchýlí, vznikne
 * asymetrie mezi Firestore a Storage — a ta je vždycky díra na jednu nebo
 * druhou stranu.
 *
 * ⚠️ Položky `p`/`pw` jsou ve tvaru `"{wid}/{pid}"`, ne holé `pid`. Cestu ve
 * Storage si volí volající, takže holý `pid` by autorizoval
 * `workspaces/CIZI-FIRMA/projects/MUJ-PROJEKT/…` — psaní pod cizí prefix.
 *
 * 🔴 PROČ TU NENÍ CLAIM „ZAMĚSTNANEC FIRMY" (`ws`)
 *
 * Návrh počítal s `ws: [wid]` pro zaměstnance, odvozeným z existence dokumentu
 * `workspaces/{wid}/members/{principal}`. **Nejde to.** Ten dokument zakládá
 * `redeemInvite` KAŽDÉMU pozvanému — včetně hosta z cizí firmy (TDI, investor,
 * subdodavatel) — a zapisuje mu `workspaceRole: "member"`. Nic v něm hosta od
 * zaměstnance neodliší.
 *
 * Odvozovat z něj přístup by znamenalo, že TDI pozvaný na JEDNU stavbu dostane
 * read/write/delete na VŠECH osm staveb generálního dodavatele — přesně scénář,
 * kvůli kterému návrh workspace-level claims zamítl. A nebylo by to okno
 * zastaralosti, ale trvalý, správně spočítaný claim.
 *
 * Zaměstnanec proto claims dostává per projekt, stejně jako host. Je to přesné
 * a fail-closed; cenou je velikost tokenu, kterou hlídá `assertClaimsFit`
 * tvrdou chybou. Kdyby měl `ws` někdy vzniknout, musí mu předcházet EXPLICITNÍ
 * a nefalšovatelný příznak zaměstnaneckého vztahu — ne pouhá existence
 * adresářového záznamu.
 */

/** Tvrdý limit Firebase na developer claims v tokenu. */
export const CLAIMS_BYTE_LIMIT = 1000;

/**
 * Bezpečnostní rezerva pod limitem. Claims se skládají s `email`/`name`, jejichž
 * délku neřídíme — kdyby se token utrhl až u Firebase, dostali bychom neurčitou
 * chybu místo srozumitelné hlášky.
 */
export const CLAIMS_BYTE_BUDGET = 900;

/**
 * Role, které na projektu znamenají plný zápis do Storage (přepis i mazání).
 *
 * Zrcadlí oprávnění **`edit`** z modelu #506 (fáze 2) — tedy „smí měnit CIZÍ
 * obsah". Storage nemá jemnější rozlišení: claim `pw` je plný zápis, `p` je
 * čtení + založení nového objektu.
 *
 * `company_lead` je ZRUŠENÁ role, kterou drží už jen legacy data; migrační
 * tabulka jí dává `edit`, takže sem patří. Bez toho by měla ve Firestore právo
 * měnit cizí obsah, ale ve Storage ne — a mazání záznamu by po sobě nechávalo
 * soubory (nález F5).
 *
 * ⚠️ SDÍLENÝ SOUBOR (docs/REPO_BOUNDARIES.md). Tabulka je třetí kopií modelu
 * vedle `firestore.rules` (`rolePermissions`) a
 * `src/lib/permissions/projectPermissions.ts`. Když jednu měníš, měň všechny tři.
 *
 * 🟠 Známá mez: role `reader` (jen `read`) dostane `p`, takže smí do Storage
 * ZALOŽIT nový objekt, přestože ve Firestore k němu nesmí vytvořit záznam.
 * Osiřelý objekt je bez záznamu neviditelný a nedohledatelný; užší claim by
 * znamenal čtvrtou úroveň v tokenu a nasazení funkcí PŘED pravidly v každém
 * firemním projektu (docs/REPO_BOUNDARIES.md, Háček 3). Necháno vědomě.
 */
const FULL_WRITE_ROLES = new Set(["editor", "admin", "company_lead"]);

export interface WorkspaceFacts {
  id: string;
  ownerId?: string | null;
  adminIds?: string[] | null;
}

export interface ProjectFacts {
  id: string;
  workspaceId: string;
  roles?: Record<string, string> | null;
}

export interface MembershipInput {
  principal: string;
  /** Workspacy, kde je principal owner nebo v adminIds. */
  adminWorkspaces: WorkspaceFacts[];
  /** Projekty, kde je principal v `memberIds`. */
  projects: ProjectFacts[];
}

// Záměrně `type`, ne `interface` — jen tak je struktura přiřaditelná do
// `Record<string, unknown>`, což potřebuje payload tokenu (claims + email/name).
export type MembershipClaims = {
  wsa?: string[];
  pw?: string[];
  p?: string[];
};

/** Členství + profilová pole, jak se posílají do tokenu. */
export type TokenClaims = MembershipClaims & Record<string, unknown>;

export class ClaimsTooLargeError extends Error {
  readonly bytes: number;
  readonly limit: number;

  constructor(message: string, bytes: number, limit: number) {
    super(message);
    this.name = "ClaimsTooLargeError";
    this.bytes = bytes;
    this.limit = limit;
  }
}

function sortedUnique(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).filter((value) => value.length > 0).sort();
}

/**
 * Čistá část výpočtu — bez Firestore, ať jde otestovat unit testem.
 * Tuhle funkci používají i rules testy (`tests/rules/helpers.ts`), aby fixtura
 * nemohla „opravit" to, co produkční kód počítá jinak.
 */
export function buildMembershipClaims(input: MembershipInput): MembershipClaims {
  const { principal } = input;

  const wsa = new Set<string>();
  for (const workspace of input.adminWorkspaces) {
    if (
      workspace.ownerId === principal
      || (workspace.adminIds ?? []).includes(principal)
    ) {
      wsa.add(workspace.id);
    }
  }

  const pw = new Set<string>();
  const p = new Set<string>();
  for (const project of input.projects) {
    if (wsa.has(project.workspaceId)) {
      // Admin firmy má celý workspace — per-projektový claim by byl jen bajty navíc.
      continue;
    }
    const role = project.roles?.[principal] ?? "";
    const scoped = `${project.workspaceId}/${project.id}`;
    if (FULL_WRITE_ROLES.has(role)) {
      pw.add(scoped);
    } else {
      p.add(scoped);
    }
  }

  const claims: MembershipClaims = {};
  if (wsa.size) claims.wsa = sortedUnique(wsa);
  if (pw.size) claims.pw = sortedUnique(pw);
  if (p.size) claims.p = sortedUnique(p);
  return claims;
}

export function claimsByteSize(claims: unknown): number {
  return Buffer.byteLength(JSON.stringify(claims), "utf8");
}

/**
 * Ověří, že se claims vejdou do tokenu. TVRDÁ chyba se srozumitelnou hláškou —
 * tiché uříznutí seznamu projektů by znamenalo, že uživatel bez varování
 * ztratí přístup k části staveb (SECURITY_CLAIMS_DESIGN.md kap. 3).
 */
export function assertClaimsFit(
  claims: TokenClaims,
  limit: number = CLAIMS_BYTE_BUDGET
): void {
  const bytes = claimsByteSize(claims);
  if (bytes <= limit) {
    return;
  }

  const projectCount = (claims.p?.length ?? 0) + (claims.pw?.length ?? 0);
  throw new ClaimsTooLargeError(
    `Seznam přístupů se nevejde do přihlašovacího tokenu (${bytes} B, limit ${limit} B; `
      + `${projectCount} projektů). Firebase dovoluje nejvýš ${CLAIMS_BYTE_LIMIT} B. `
      + "Řešení: rozdělit práci na míň projektů, nebo z uživatele udělat admina "
      + "firmy (ten má jedinou položku na celý workspace).",
    bytes,
    limit
  );
}

/**
 * Načte podklady z Firestore. Dotazy jsou indexované (`ownerId ==`,
 * `adminIds array-contains`, `memberIds array-contains`), takže cena neroste
 * s velikostí tenantu, jen s počtem míst, kam uživatel opravdu patří.
 *
 * `workspaces/{wid}/members/{principal}` se ZÁMĚRNĚ nečte — viz komentář
 * v hlavičce modulu (zakládá ho i host, takže nic nedokazuje).
 */
export async function loadMembershipInput(
  db: Firestore,
  principal: string
): Promise<MembershipInput> {
  const [ownedSnap, adminSnap, projectSnap] = await Promise.all([
    db.collection("workspaces").where("ownerId", "==", principal).get(),
    db.collection("workspaces").where("adminIds", "array-contains", principal).get(),
    db.collection("projects").where("memberIds", "array-contains", principal).get(),
  ]);

  const adminWorkspaces = new Map<string, WorkspaceFacts>();
  for (const doc of [...ownedSnap.docs, ...adminSnap.docs]) {
    adminWorkspaces.set(doc.id, {
      id: doc.id,
      ownerId: (doc.get("ownerId") as string | undefined) ?? null,
      adminIds: (doc.get("adminIds") as string[] | undefined) ?? [],
    });
  }

  const projects: ProjectFacts[] = [];
  for (const doc of projectSnap.docs) {
    const workspaceId = doc.get("workspaceId");
    if (typeof workspaceId !== "string" || !workspaceId) {
      continue;
    }
    projects.push({
      id: doc.id,
      workspaceId,
      roles: (doc.get("roles") as Record<string, string> | undefined) ?? {},
    });
  }

  return { principal, adminWorkspaces: Array.from(adminWorkspaces.values()), projects };
}

/** Načte podklady a složí claims. */
export async function computeMembershipClaims(
  db: Firestore,
  principal: string
): Promise<MembershipClaims> {
  return buildMembershipClaims(await loadMembershipInput(db, principal));
}

/**
 * Patří uživatel vůbec do daného workspace? Brána pro `syncMemberClaims`:
 * bez ní by admin firmy A mohl poslat `revoke` na uživatele firmy B (odhlašovací
 * DoS napříč tenanty) nebo mu přes `createUser` založit Auth účet.
 */
export function belongsToWorkspace(claims: MembershipClaims, workspaceId: string): boolean {
  const prefix = `${workspaceId}/`;
  return (claims.wsa ?? []).includes(workspaceId)
    || (claims.pw ?? []).some((entry) => entry.startsWith(prefix))
    || (claims.p ?? []).some((entry) => entry.startsWith(prefix));
}
