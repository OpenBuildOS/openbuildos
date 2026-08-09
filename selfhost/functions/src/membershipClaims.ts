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
 * ⚠️ `p`/`pw` jsou MAPY `{ "{wid}": ["{pid}", …] }`, ne ploché seznamy holých
 * `pid`. Cestu ve Storage si volí volající, takže holý `pid` bez vazby na firmu
 * by autorizoval `workspaces/CIZI-FIRMA/projects/MUJ-PROJEKT/…` — psaní pod cizí
 * prefix. Klíč mapy JE workspace, takže tu vazbu drží ze své podstaty (dřív ji
 * držela jen konvence uvnitř řetězce `"{wid}/{pid}"`).
 *
 * 📦 PROČ MAPA A NE SEZNAM (#565 → #566). Plochý seznam opakoval `wid`
 * u KAŽDÉHO projektu. Hostovaný prostor má `wid` s prefixem `ws_` (23 znaků),
 * takže se do rozpočtu vešlo jen 17 staveb (`docs/ai/token-ceiling-staging.md`,
 * měřeno proti běžícímu stagingu). Seskupení podle firmy platí `wid` jednou za
 * firmu místo jednou za projekt — strop se tím zvedl na 34 (test v
 * `membershipClaims.test.ts` ho drží jako přesné číslo, protože je to údaj pro
 * produkt, ne implementační detail).
 *
 * ⚠️ Změna tvaru claims se musí stát NARÁZ v claims, ve `storage.rules` a v obou
 * repech (docs/REPO_BOUNDARIES.md) — asymetrie mezi nimi je díra na jednu nebo
 * druhou stranu. Tokeny navíc žijí hodinu, takže po nasazení chvíli koluje
 * obojí: `storage.rules` mají přechodnou větev na starý tvar a klient si podle
 * `cv` (viz `CLAIMS_VERSION`) vynutí přepočet.
 *
 * 🔴 PROČ TU NENÍ CLAIM „ZAMĚSTNANEC FIRMY" (`ws`)
 *
 * Návrh počítal s `ws: [wid]` pro zaměstnance, odvozeným z existence dokumentu
 * `workspaces/{wid}/members/{principal}`. **Nejde to.** Ten dokument zakládá
 * `redeemInvite` KAŽDÉMU pozvanému — včetně hosta z cizí firmy (TDI, investor,
 * subdodavatel) — takže jeho pouhá existence hosta od zaměstnance neodliší.
 * Od #523 v něm sice je pole `membershipKind` (`employee` / `guest`) a
 * `redeemInvite` novým lidem zapisuje `"guest"`, jenže rules u
 * `workspaces/{wid}/members/{memberPrincipal}` pouštějí zápis VLASTNÍHO záznamu
 * (`principal() == memberPrincipal`), takže si host `"employee"` napíše sám.
 * Ten příznak je tedy explicitní, ale FALŠOVATELNÝ — je popisný (kdo u firmy
 * doopravdy pracuje) a podklad pro claim z něj není.
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
 * Verze TVARU claims. Razí se do tokenu jako `cv`, aby klient poznal, že drží
 * token ze starého kódu, a vynutil si přepočet (`refreshMembershipClaims`).
 *
 * Bez toho by se starý tvar nikdy nepřepsal sám: `setCustomUserClaims` zapisuje
 * jen backend a `getIdToken(true)` jen vyzvedne, co tam už leží. Uživatel by
 * tedy zůstal na plochém seznamu (a tím i na starém stropu) libovolně dlouho.
 *
 * 1 = plochý seznam `["{wid}/{pid}", …]` (do 8/2026, bez `cv`)
 * 2 = mapa `{ "{wid}": ["{pid}", …] }`
 */
export const CLAIMS_VERSION = 2;

/**
 * Rezerva na profilová pole, která do tokenu razí `authExchange` navíc oproti
 * `syncMemberClaims` (`email` + `name`). Strop se tím liší podle TOPOLOGIE
 * firmy — federovaný tenant má o dva projekty míň než hostovaný prostor.
 *
 * Produktová zarážka nesmí být na jedno číslo v jedné topologii; počítá proto
 * vždy s tou přísnější. 120 B je s přehledem nad naměřenými 51 B pro
 * `jan.novak@example.cz` + `Jan Novák` (docs/ai/token-ceiling-staging.md).
 */
export const CLAIMS_PROFILE_RESERVE = 120;

/**
 * Kolik volných míst musí zbýt, aby šlo člověka pozvat na další stavbu.
 *
 * NENÍ to magické číslo vedle stropu — strop se počítá `projectSlotsLeft()` ze
 * skutečných identifikátorů, tohle je jen polštář na to, co při zvaní ještě
 * nevíme: `pid` příští stavby může být delší, uživatel může mezitím přijmout
 * jinou pozvánku, a `authExchange` si ukousne podle délky jména a e-mailu.
 */
export const PROJECT_SLOT_RESERVE = 2;

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

/**
 * Značka pro filtr v Cloud Loggingu: `jsonPayload.event="membership_project_skipped"`.
 *
 * ⭐ PROČ TOHLE EXISTUJE. Projekt bez pole `workspaceId` se z podkladů ZAHODIT
 * musí — claim má tvar `{wid}/{pid}` a holý `pid` by autorizoval
 * `workspaces/CIZI-FIRMA/projects/MUJ-PROJEKT/…`. Do 8/2026 se ale zahazoval
 * TIŠE: uživatel je v `memberIds`, takže projekt ve Firestore vidí, jenže ve
 * Storage se ke svým souborům nedostane — a v logu po tom nezůstal ani řádek.
 * Po nasazení `storage.rules` na produkci je ztráta claimu ztráta souborů, a
 * legacy data bez `workspaceId` reálně existují (`src/services/workspaceProjects.ts`
 * s tím polem počítá jako s volitelným). Tichý fail-closed se nedá odladit;
 * hlášený ano.
 */
export const SKIPPED_PROJECT_LOG_EVENT = "membership_project_skipped";

/**
 * Pole záznamu. ZÁMĚRNĚ jen identifikátory a TYP vadné hodnoty — do logu nepatří
 * obsah dokumentu (název stavby, adresa, jména členů). K dohledání stačí
 * `projectId`: podle něj se dokument najde v konzoli, kde na něj práva jsou.
 */
export interface SkippedProjectLogPayload {
  severity: "WARNING";
  event: typeof SKIPPED_PROJECT_LOG_EVENT;
  /** Věta, kterou uvidí člověk v `gcloud functions logs read`. */
  message: string;
  principal: string;
  projectId: string;
  /** `"undefined"` / `"number"` / `"empty-string"` — nikdy samotná hodnota. */
  workspaceIdType: string;
}

function describeSkippedProject(
  principal: string,
  projectId: string,
  workspaceId: unknown
): SkippedProjectLogPayload {
  return {
    severity: "WARNING",
    event: SKIPPED_PROJECT_LOG_EVENT,
    message:
      `Projekt ${projectId} nemá použitelné pole workspaceId, takže se do claims `
      + "nepromítl: uživatel ho ve Firestore vidí, ale ve Storage se ke svým "
      + "souborům nedostane. Doplnit workspaceId na dokumentu projektu.",
    principal,
    projectId,
    workspaceIdType: workspaceId === "" ? "empty-string" : typeof workspaceId,
  };
}

/**
 * Jeden řádek do Cloud Loggingu. `console.warn` ZÁMĚRNĚ, ne `firebase-functions/logger`:
 * tenhle modul importují i rules testy hlavního repa (`tests/rules/helpers.ts`),
 * aby fixtura nemohla „opravit" to, co produkční kód počítá jinak — a tam
 * `firebase-functions` nainstalované není. Payload jde jako JEDEN JSON řetězec,
 * ať ho Cloud Logging načte jako `jsonPayload` včetně závažnosti.
 */
function warnSkippedProject(principal: string, projectId: string, workspaceId: unknown): void {
  console.warn(JSON.stringify(describeSkippedProject(principal, projectId, workspaceId)));
}

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
/**
 * Projektová oprávnění seskupená podle firmy: `{ "{wid}": ["{pid}", …] }`.
 * `storage.rules` čtou `request.auth.token.p[wid]`, takže vazba `wid` → `pid`
 * je vynucená tvarem, ne konvencí.
 */
export type ProjectGrants = Record<string, string[]>;

export type MembershipClaims = {
  wsa?: string[];
  pw?: ProjectGrants;
  p?: ProjectGrants;
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

/** Deterministické pořadí klíčů i hodnot — jinak by se claims „měnily" bez změny. */
function toGrants(grouped: Map<string, Set<string>>): ProjectGrants {
  const grants: ProjectGrants = {};
  for (const workspaceId of Array.from(grouped.keys()).sort()) {
    const projectIds = sortedUnique(grouped.get(workspaceId) ?? []);
    if (projectIds.length) {
      grants[workspaceId] = projectIds;
    }
  }
  return grants;
}

function addGrant(grouped: Map<string, Set<string>>, workspaceId: string, projectId: string): void {
  const existing = grouped.get(workspaceId);
  if (existing) {
    existing.add(projectId);
    return;
  }
  grouped.set(workspaceId, new Set([projectId]));
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

  const pw = new Map<string, Set<string>>();
  const p = new Map<string, Set<string>>();
  for (const project of input.projects) {
    if (wsa.has(project.workspaceId)) {
      // Admin firmy má celý workspace — per-projektový claim by byl jen bajty navíc.
      continue;
    }
    if (!project.workspaceId || !project.id) {
      // Bez obou složek není co orazítkovat — holý `pid` (nebo prázdný `wid`)
      // by ve Storage ukázal na cizí prefix. Viz SKIPPED_PROJECT_LOG_EVENT.
      continue;
    }
    const role = project.roles?.[principal] ?? "";
    addGrant(FULL_WRITE_ROLES.has(role) ? pw : p, project.workspaceId, project.id);
  }

  const claims: MembershipClaims = {};
  if (wsa.size) claims.wsa = sortedUnique(wsa);
  if (pw.size) claims.pw = toGrants(pw);
  if (p.size) claims.p = toGrants(p);
  return claims;
}

/** Kolik projektů claims nesou (napříč firmami — strop je společný). */
export function countProjectGrants(claims: MembershipClaims): number {
  return [claims.p, claims.pw].reduce(
    (total, grants) =>
      total + Object.values(grants ?? {}).reduce((sum, ids) => sum + ids.length, 0),
    0
  );
}

/**
 * Přečte claims uložené na uživateli. Tolerantně: zvládne i STARÝ plochý tvar
 * `["{wid}/{pid}", …]` a převede ho na mapu.
 *
 * Musí to umět, protože `shrinkClaimsToFit()` porovnává nově spočítané claims
 * s tím, co na uživateli reálně leží — a v přechodném období tam leží starý
 * tvar. Kdyby se starý tvar četl jako „nic", vypadalo by odebrání z projektu
 * jako „nebylo co odebrat" a zůstal by v platnosti (přesně ta vada, kterou
 * tenhle PR zavírá).
 */
export function parseStoredMembershipClaims(raw: unknown): MembershipClaims {
  const source = (raw ?? {}) as Record<string, unknown>;
  const claims: MembershipClaims = {};

  const wsa = Array.isArray(source.wsa)
    ? sortedUnique(source.wsa.filter((value): value is string => typeof value === "string"))
    : [];
  if (wsa.length) claims.wsa = wsa;

  for (const key of ["p", "pw"] as const) {
    const value = source[key];
    const grouped = new Map<string, Set<string>>();

    if (Array.isArray(value)) {
      // Legacy tvar: `"{wid}/{pid}"`. `pid` může teoreticky obsahovat lomítko,
      // takže dělíme na PRVNÍM — `wid` je vždycky jeden segment.
      for (const entry of value) {
        if (typeof entry !== "string") continue;
        const slash = entry.indexOf("/");
        if (slash <= 0 || slash === entry.length - 1) continue;
        addGrant(grouped, entry.slice(0, slash), entry.slice(slash + 1));
      }
    } else if (value && typeof value === "object") {
      for (const [workspaceId, ids] of Object.entries(value as Record<string, unknown>)) {
        if (!workspaceId || !Array.isArray(ids)) continue;
        for (const id of ids) {
          if (typeof id === "string" && id) addGrant(grouped, workspaceId, id);
        }
      }
    }

    const grants = toGrants(grouped);
    if (Object.keys(grants).length) claims[key] = grants;
  }

  return claims;
}

function intersectGrants(next: ProjectGrants, stored: ProjectGrants): ProjectGrants {
  const grouped = new Map<string, Set<string>>();
  for (const [workspaceId, ids] of Object.entries(next)) {
    const storedIds = new Set(stored[workspaceId] ?? []);
    for (const id of ids) {
      if (storedIds.has(id)) addGrant(grouped, workspaceId, id);
    }
  }
  return toGrants(grouped);
}

/**
 * Průnik nově spočítaných a už uložených claims.
 *
 * 🔴 K ČEMU TO JE. Když se claims nevejdou do rozpočtu, `assertClaimsFit` je
 * odmítne a DO 8/2026 se pak nezapsalo NIC. U uživatele nad stropem tím přestala
 * fungovat REVOKACE: `syncMemberClaims(revoke)` po odebrání z projektu skončil
 * na `resource-exhausted`, starý claim přežil až do vypršení refresh tokenu a
 * odebraný člověk měl dál přístup ke Storage té stavby. Firestore ho odřízl
 * hned, Storage ne — takže to nebyla jen kapacitní mez, ale bezpečnostní vada.
 *
 * Průnik ji zavírá a nemůže přitom nic přidat:
 *  - ⊆ `next`   → nikdy nepustí dál, než kam uživatel podle Firestore patří,
 *  - ⊆ `stored` → nikdy nepřidá nic, co v tokenu ještě není (růst nad strop
 *                 zůstane „zamrzlý", což je bezpečné směrem nahoru),
 *  - a protože `stored` se do rozpočtu kdysi vešly, vejde se i průnik.
 *
 * Odebrání z projektu tedy dopadne i nad stropem: odebraná položka v `next`
 * není, takže z průniku vypadne.
 */
export function intersectMembershipClaims(
  next: MembershipClaims,
  stored: MembershipClaims
): MembershipClaims {
  const claims: MembershipClaims = {};

  const wsa = (next.wsa ?? []).filter((id) => (stored.wsa ?? []).includes(id));
  if (wsa.length) claims.wsa = wsa;

  for (const key of ["p", "pw"] as const) {
    const grants = intersectGrants(next[key] ?? {}, stored[key] ?? {});
    if (Object.keys(grants).length) claims[key] = grants;
  }

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

  const projectCount = countProjectGrants(claims);
  throw new ClaimsTooLargeError(
    `Seznam přístupů se nevejde do přihlašovacího tokenu (${bytes} B, limit ${limit} B; `
      + `${projectCount} projektů). Firebase dovoluje nejvýš ${CLAIMS_BYTE_LIMIT} B. `
      + "Řešení: rozdělit práci na míň projektů, nebo z uživatele udělat admina "
      + "firmy (ten má jedinou položku na celý workspace).",
    bytes,
    limit
  );
}

/** Claims tak, jak se reálně razí do tokenu — velikost se měří VČETNĚ režie. */
function stamped(claims: MembershipClaims, extra: Record<string, unknown> = {}): TokenClaims {
  return { src: "openbuildos", cv: CLAIMS_VERSION, ...claims, ...extra };
}

/**
 * Kolik DALŠÍCH staveb se uživateli ještě vejde do tokenu.
 *
 * ⭐ Odvozuje se ze SKUTEČNÝCH identifikátorů, ne z konstanty: měří se tak, že
 * se do claims zkusmo přidávají projekty té délky, jakou má `sample.projectId`,
 * dokud se vejdou. Když se změní tvar `pid` nebo `wid` (a strop se tím pohne —
 * naměřeno v `docs/ai/token-ceiling-staging.md`), pohne se s ním i tohle číslo.
 * Zarážka se tedy nemůže rozejít se skutečností.
 *
 * ⚠️ Počítá NAPŘÍČ FIRMAMI dohromady, protože strop je společný — v hostovaném
 * modelu leží projekty všech firem v jednom Firebase projektu a `p`/`pw` je
 * nesou v jednom tokenu. Per-firma počítání by šlo obejít pozvánkami z různých
 * firem.
 *
 * @returns `null` = bez omezení (admin firmy má `wsa` na celý prostor, takže
 *   každá další stavba té firmy stojí nula bajtů — proto se strop správce firmy
 *   netýká; je to i doporučené řešení v hlášce o přetečení).
 */
export function projectSlotsLeft(
  claims: MembershipClaims,
  sample: { workspaceId: string; projectId: string },
  budget: number = CLAIMS_BYTE_BUDGET - CLAIMS_PROFILE_RESERVE
): number | null {
  if ((claims.wsa ?? []).includes(sample.workspaceId)) {
    return null;
  }

  const existing = claims.p?.[sample.workspaceId] ?? [];
  const added: string[] = [];
  const width = Math.max(sample.projectId.length, 1);

  // Syntetické `pid` mají DÉLKU vzorku — na obsahu nezáleží, na bajtech ano.
  // Prefix ` ` nepatří do žádného skutečného id, takže se nemůže potkat
  // s existující položkou a „zdarma" se zduplikovat.
  for (let slot = 0; slot < 1000; slot += 1) {
    const filler = ` ${String(slot)}`.padEnd(width, "0").slice(0, width);
    const probe: MembershipClaims = {
      ...claims,
      p: { ...(claims.p ?? {}), [sample.workspaceId]: [...existing, ...added, filler] },
    };
    if (claimsByteSize(stamped(probe)) > budget) {
      return added.length;
    }
    added.push(filler);
  }
  return added.length;
}

/**
 * Ořeže claims tak, aby se daly bezpečně ZAPSAT, i když se celé nevejdou.
 *
 * Vrací vždy množinu, která není širší než `next` ani než `stored` — nikdy tedy
 * nerozšíří práva. Pořadí pokusů je od nejužitečnějšího k nejbezpečnějšímu:
 *
 *  1. `next` celé (běžný případ — vejde se),
 *  2. průnik `next` × `stored` (nad stropem: růst zamrzne, ODEBRÁNÍ PROJDE),
 *  3. jen `wsa` (kdyby ani průnik neseděl — stavu, kdy `stored` samo přeteklo),
 *  4. prázdno (fail-closed: radši bez Storage než s claimem, který už neplatí).
 *
 * `fits === false` znamená, že se celé `next` nevešlo — volající to má ohlásit
 * (`resource-exhausted` / HTTP 413), ale AŽ POTOM, co se ořezaná verze zapsala.
 */
export function shrinkClaimsToFit(
  next: MembershipClaims,
  stored: MembershipClaims,
  extra: Record<string, unknown> = {},
  limit: number = CLAIMS_BYTE_BUDGET
): { claims: MembershipClaims; fits: boolean } {
  const candidates: MembershipClaims[] = [
    next,
    intersectMembershipClaims(next, stored),
    next.wsa?.length ? { wsa: next.wsa } : {},
    {},
  ];

  for (let index = 0; index < candidates.length; index += 1) {
    if (claimsByteSize(stamped(candidates[index], extra)) <= limit) {
      return { claims: candidates[index], fits: index === 0 };
    }
  }
  return { claims: {}, fits: false };
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
      // Zahodit se musí (bez wid není claim, který by šel bezpečně vydat), ale
      // ne mlčky — viz SKIPPED_PROJECT_LOG_EVENT.
      warnSkippedProject(principal, doc.id, workspaceId);
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
  if (!workspaceId) {
    return false;
  }
  // Mapa drží workspace jako KLÍČ, takže se tu už nesrovnávají prefixy řetězců:
  // u plochého seznamu musel test končit lomítkem, aby "W1" neprošel na "W10".
  return (claims.wsa ?? []).includes(workspaceId)
    || Object.prototype.hasOwnProperty.call(claims.pw ?? {}, workspaceId)
    || Object.prototype.hasOwnProperty.call(claims.p ?? {}, workspaceId);
}
