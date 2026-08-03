import type { Firestore } from "firebase-admin/firestore";

/**
 * Výpočet custom claims s členstvím (docs/SECURITY_CLAIMS_DESIGN.md kap. 3).
 *
 * Storage rules nemají spolehlivý cross-service `firestore.get()`, takže
 * autorizace musí přijet v TOKENU. Tenhle modul spočítá z Firestore, kam
 * uživatel patří, a složí z toho claims:
 *
 *   wsa  vlastník / admin firmy      → celý workspace, plná práva
 *   ws   zaměstnanec firmy           → celý workspace, plná práva
 *   px   projekty firmy, ze kterých je zaměstnanec VYLOUČEN (excludedProjectIds)
 *   pw   host s rolí editor/admin    → plná práva na konkrétní projekt
 *   p    ostatní hosté (viewer, company_lead) → čtení + založení nového objektu
 *
 * ⚠️ Položky `p`/`pw` jsou ve tvaru `"{wid}/{pid}"`, ne holé `pid`. Cestu ve
 * Storage si volí volající, takže holý `pid` by autorizoval `workspaces/CIZI-
 * FIRMA/projects/MUJ-PROJEKT/…` — útočník by sice nečetl cizí data, ale mohl by
 * psát pod cizí prefix. `px` naopak jen ODEBÍRÁ a vyhodnocuje se až uvnitř
 * známého `wid`, takže holé `pid` tam stačí.
 *
 * Proč `company_lead` spadá do `p` a ne do `pw`: ve Firestore smí mazat obsah
 * SVÉ firmy, ale Storage rules o firmách nic nevědí — `pw` by mu dovolilo
 * smazat i cizí binárku. Vytvořit nový objekt smí (nová revize = nová cesta),
 * takže reálný dopad je nanejvýš osiřelá binárka, ne ztráta cizích dat.
 */

/** Tvrdý limit Firebase na developer claims v tokenu. */
export const CLAIMS_BYTE_LIMIT = 1000;

/**
 * Bezpečnostní rezerva pod limitem. Claims se skládají s `email`/`name`, jejichž
 * délku neřídíme — kdyby se token utrhl až u Firebase, dostali bychom neurčitou
 * chybu místo srozumitelné hlášky.
 */
export const CLAIMS_BYTE_BUDGET = 900;

/** Role, které na projektu znamenají plný zápis (přepis i mazání souborů). */
const FULL_WRITE_ROLES = new Set(["editor", "admin"]);

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
  /** Workspacy s firemním member docem `workspaces/{wid}/members/{principal}`. */
  memberWorkspaceIds: string[];
  /** Sjednocení `excludedProjectIds` z těch firemních member doců. */
  excludedProjectIds: string[];
  /** Projekty, kde je principal v `memberIds`. */
  projects: ProjectFacts[];
}

// Záměrně `type`, ne `interface` — jen tak je struktura přiřaditelná do
// `Record<string, unknown>`, což potřebuje payload tokenu (claims + email/name).
export type MembershipClaims = {
  wsa?: string[];
  ws?: string[];
  px?: string[];
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

  // `ws` je doplněk k `wsa` — admin už má všechno, není důvod platit bajty dvakrát.
  const ws = new Set<string>();
  for (const wid of input.memberWorkspaceIds) {
    if (wid && !wsa.has(wid)) {
      ws.add(wid);
    }
  }

  const workspaceWide = new Set<string>([...wsa, ...ws]);
  const memberProjectIds = new Set(input.projects.map((project) => project.id));

  // Vyloučené projekty ubírají z `ws`/`wsa`. Kdyby admin projektu člena do
  // `memberIds` přesto přidal, Firestore ho pustí — pak výjimku neuplatňujeme,
  // ať se Storage nechová PŘÍSNĚJI než živá autorita.
  const px = new Set<string>();
  for (const pid of input.excludedProjectIds) {
    if (pid && !memberProjectIds.has(pid)) {
      px.add(pid);
    }
  }

  const pw = new Set<string>();
  const p = new Set<string>();
  for (const project of input.projects) {
    if (workspaceWide.has(project.workspaceId)) {
      // Pokrytí přes workspace — per-projektový claim by byl jen bajty navíc.
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
  if (ws.size) claims.ws = sortedUnique(ws);
  if (px.size) claims.px = sortedUnique(px);
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
      + `${projectCount} projektů jako host). Firebase dovoluje nejvýš ${CLAIMS_BYTE_LIMIT} B. `
      + "Řešení: udělejte z uživatele člena firmy (workspaces/{wid}/members) místo hosta "
      + "na jednotlivých projektech — členovi firmy stačí jediná položka na celý workspace.",
    bytes,
    limit
  );
}

/**
 * Načte podklady z Firestore. Dotazy jsou indexované (`ownerId ==`,
 * `adminIds array-contains`, `memberIds array-contains`), takže cena neroste
 * s velikostí tenantu, jen s počtem míst, kam uživatel opravdu patří.
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
  const candidateWorkspaceIds = new Set<string>(adminWorkspaces.keys());
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
    candidateWorkspaceIds.add(workspaceId);
  }

  // Firemní příslušnost se ověřuje jen u workspaců, které přicházejí v úvahu —
  // tedy tam, kde je uživatel admin nebo má aspoň jeden projekt. Zaměstnanec
  // úplně bez projektů žádné soubory nemá, takže mu claim nechybí.
  const memberWorkspaceIds: string[] = [];
  const excludedProjectIds: string[] = [];
  const candidates = Array.from(candidateWorkspaceIds);
  if (candidates.length > 0) {
    const memberDocs = await db.getAll(
      ...candidates.map((wid) => db.doc(`workspaces/${wid}/members/${principal}`))
    );
    for (const doc of memberDocs) {
      if (!doc.exists) {
        continue;
      }
      const wid = doc.ref.parent.parent?.id;
      if (!wid) {
        continue;
      }
      memberWorkspaceIds.push(wid);
      const excluded = doc.get("excludedProjectIds");
      if (Array.isArray(excluded)) {
        for (const pid of excluded) {
          if (typeof pid === "string" && pid) {
            excludedProjectIds.push(pid);
          }
        }
      }
    }
  }

  return {
    principal,
    adminWorkspaces: Array.from(adminWorkspaces.values()),
    memberWorkspaceIds,
    excludedProjectIds,
    projects,
  };
}

/** Načte podklady a složí claims. Vyhodí `ClaimsTooLargeError`, když se nevejdou. */
export async function computeMembershipClaims(
  db: Firestore,
  principal: string
): Promise<MembershipClaims> {
  return buildMembershipClaims(await loadMembershipInput(db, principal));
}
