/**
 * Úklid dožilých pozvánek do stavby — `workspaces/{wid}/invites/{token}`.
 *
 * ⭐ SDÍLENÝ SOUBOR. Musí být IDENTICKÝ v obou repech (viz docs/REPO_BOUNDARIES.md):
 *   hlavní repo `functions/src/inviteSweep.ts`
 *   companion   `selfhost/functions/src/inviteSweep.ts`
 * Pozvánky žijí v tom Firebase projektu, který drží data workspace — u
 * self-hostu firemní projekt (companion), u hostovaného centrální projekt.
 * Stejná úvaha jako u `trashSweep.ts`.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴 PROČ TO MUSÍ EXISTOVAT
 * ══════════════════════════════════════════════════════════════════════════
 * Pozvánka je BEARER TOKEN: id v odkazu je celé tajemství. Platnost 14 dní byla
 * vynucená u uplatnění (`allow update`), ale samotný DOKUMENT zůstával ležet a
 * `allow get: if isRealUser()` ho vydával komukoli přihlášenému, kdo odkaz
 * držel — navždy. Prošlá pozvánka z fotky chatu tak i po roce prozradila, na
 * jakou stavbu zněla, komu (`inviteeEmail`, `inviteeName`), s jakou rolí a od
 * koho. To je adresář zákazníka po částech.
 *
 * Pravidla od 22. 8. 2026 čtení prošlé pozvánky zavírají. Tenhle úklid dělá
 * druhou půlku: záznam po dožití SMAŽE, takže tu není ani k dispozici pro
 * budoucí chybu v pravidlech, ani se za něj neplatí.
 *
 * ⏱️ DENNÍ STAČÍ. Na rozdíl od `pendingInviteSweep` (klíč k cizímu backendu,
 * proto hodinově) tady dožitá pozvánka po zavření `get` nikomu nic nevydá —
 * mazání je úklid, ne obrana.
 *
 * ⏳ ODKLAD `INVITE_SWEEP_GRACE_DAYS`. Maže se až s odstupem po vypršení, ne
 * hned: `redeemInvite()` rozlišuje „prošlá" od „neexistuje" a člověku, který
 * klikl o den později, se má říct „platnost vypršela, požádej o novou" —
 * ne „pozvánka neexistuje", což zní jako překlep v adrese. Po odkladu už ten
 * rozdíl nikoho nezajímá.
 *
 * ✅ MAŽE I UPLATNĚNÉ. Pozvánka s `usedBy` je hotová věc; drží se jen kvůli
 * hlášce „už byla použita". Po odkladu je to jen řádek s cizím e-mailem.
 */

/** Kolik dní po vypršení (nebo uplatnění) se pozvánka teprve maže. */
export const INVITE_SWEEP_GRACE_DAYS = 30;

/**
 * Strop na jeden běh napříč všemi firmami. Zbytek se dobere zítra — u úklidu,
 * který nikoho nechrání v reálném čase, je fronta levnější než timeout.
 */
export const INVITE_SWEEP_MAX_ITEMS_PER_RUN = 500;

/** Kolik pozvánek si dotáhneme z jedné firmy v jednom běhu. */
export const INVITE_SWEEP_MAX_ITEMS_PER_WORKSPACE = 100;

export interface DeadInvite {
  workspaceId: string;
  token: string;
}

export interface InviteSweepStore {
  listWorkspaceIds(): Promise<string[]>;
  /** Pozvánky, které vypršely dřív než `before`. */
  listExpired(workspaceId: string, before: Date, limit: number): Promise<string[]>;
  /** Pozvánky uplatněné dřív než `before`. */
  listUsed(workspaceId: string, before: Date, limit: number): Promise<string[]>;
  deleteInvite(workspaceId: string, token: string): Promise<void>;
}

export interface InviteSweepSummary {
  workspaces: number;
  deleted: number;
  failed: number;
  hitRunLimit: boolean;
}

export interface InviteSweepHooks {
  onError?: (message: string, error: unknown) => void;
  onSummary?: (record: {
    severity: "info" | "warning";
    message: string;
    payload: Record<string, unknown>;
  }) => void;
}

export function inviteSweepCutoff(now: Date): Date {
  return new Date(now.getTime() - INVITE_SWEEP_GRACE_DAYS * 24 * 60 * 60 * 1000);
}

export async function runInviteSweep(
  store: InviteSweepStore,
  hooks: InviteSweepHooks = {},
  now: Date = new Date()
): Promise<InviteSweepSummary> {
  const summary: InviteSweepSummary = { workspaces: 0, deleted: 0, failed: 0, hitRunLimit: false };
  const cutoff = inviteSweepCutoff(now);

  let workspaceIds: string[];
  try {
    workspaceIds = await store.listWorkspaceIds();
  } catch (error) {
    hooks.onError?.("inviteSweep: nepodařilo se načíst seznam firem", error);
    summary.failed += 1;
    report(summary, hooks);
    return summary;
  }

  for (const workspaceId of workspaceIds) {
    if (summary.deleted + summary.failed >= INVITE_SWEEP_MAX_ITEMS_PER_RUN) {
      summary.hitRunLimit = true;
      break;
    }
    summary.workspaces += 1;

    let tokens: string[];
    try {
      // Dva dotazy, ne jeden: Firestore neumí OR přes dvě různá pole s
      // nerovností. `Set` je tu proto, že uplatněná pozvánka bývá zároveň
      // prošlá a smazat ji dvakrát by druhý pokus zbytečně počítal jako práci.
      const [expired, used] = await Promise.all([
        store.listExpired(workspaceId, cutoff, INVITE_SWEEP_MAX_ITEMS_PER_WORKSPACE),
        store.listUsed(workspaceId, cutoff, INVITE_SWEEP_MAX_ITEMS_PER_WORKSPACE),
      ]);
      tokens = [...new Set([...expired, ...used])];
    } catch (error) {
      hooks.onError?.(`inviteSweep: výpis pozvánek firmy selhal (${workspaceId})`, error);
      summary.failed += 1;
      continue;
    }

    for (const token of tokens) {
      if (summary.deleted + summary.failed >= INVITE_SWEEP_MAX_ITEMS_PER_RUN) {
        summary.hitRunLimit = true;
        break;
      }
      try {
        await store.deleteInvite(workspaceId, token);
        summary.deleted += 1;
      } catch (error) {
        hooks.onError?.(`inviteSweep: smazání pozvánky selhalo (${workspaceId}/${token})`, error);
        summary.failed += 1;
      }
    }
  }

  report(summary, hooks);
  return summary;
}

function report(summary: InviteSweepSummary, hooks: InviteSweepHooks): void {
  hooks.onSummary?.({
    severity: summary.failed > 0 ? "warning" : "info",
    message: `inviteSweep: hotovo (${summary.deleted} dožilých pozvánek smazáno)`,
    payload: { ...summary },
  });
}
