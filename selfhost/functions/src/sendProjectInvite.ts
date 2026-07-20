import { initializeApp, getApps, getApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import * as logger from "firebase-functions/logger";
import {
  MailNotConfiguredError,
  logMailSent,
  resolveMailFrom,
  resolveMailProvider,
  type MailMessage,
} from "./mailProvider";

/**
 * `sendProjectInvite` — odeslání zvacího odkazu e-mailem z FIREMNÍHO backendu.
 *
 * Proč tady a ne centrálně: centrální projekt (openbuildos) běží na Sparku a
 * e-maily posílat nemůže. Odesílání je proto **firemní-backendová schopnost** —
 * firma má vlastní Blaze projekt, vlastní doménu a vlastní SPF/DKIM, takže
 * pozvánka dorazí od NÍ, ne od centrálu. Viz docs/INVITE_FEDERATION_REDESIGN §3.4.
 *
 * Bezpečnostní model — funkce NEVĚŘÍ NIČEMU od klienta kromě identity:
 *  1. Volající musí být přihlášený do firemního backendu (přes token-exchange
 *     `authExchange`, takže uid == centrální uid).
 *  2. Volající musí být správce projektu — zrcadlí `canManageProject()`
 *     z firestore.rules (role 'admin' na projektu NEBO workspace owner/admin).
 *  3. Pozvánka `workspaces/{wid}/invites/{token}` musí SKUTEČNĚ existovat,
 *     patřit tomu projektu, být schválená (#367), nepoužitá a neexpirovaná.
 *     Bez toho by funkce byla otevřená relay na rozesílání čehokoli z ověřené
 *     firemní domény.
 *  4. `inviteUrl` se validuje proti allowlistu originů a musí obsahovat token —
 *     jinak by správce (nebo únos jeho session) rozeslal phishing podepsaný
 *     DKIM firmy.
 *
 * Nasazení vyžaduje Blaze + secret RESEND_API_KEY a odesílatele INVITE_MAIL_FROM.
 * Když mail není nakonfigurovaný, funkce vrací `failed-precondition` a FE spadne
 * zpět na dnešní „zkopírovat odkaz".
 */

const RESEND_API_KEY = defineSecret("RESEND_API_KEY");
const INVITE_MAIL_FROM = defineSecret("INVITE_MAIL_FROM");

/**
 * Povolené originy zvacího odkazu. Zrcadlí ALLOWED_ORIGINS v index.ts (authExchange).
 * Firma s vlastní doménou appky si je rozšíří přes env APP_ORIGINS (čárkou oddělené).
 */
const DEFAULT_APP_ORIGINS = [
  "https://openbuildos.web.app",
  "https://openbuildos-app.web.app",
  "https://app.openbuildos.org",
  "https://openbuildos.org",
];

function allowedOrigins(): Set<string> {
  const extra = (process.env.APP_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return new Set([...DEFAULT_APP_ORIGINS, ...extra]);
}

function getLocalApp() {
  return getApps().some((app) => app.name === "[DEFAULT]") ? getApp() : initializeApp();
}

/**
 * Zrcadlí `principal()` z firestore.rules: federovaný uživatel může přijít přes
 * OIDC identitu, jinak je principal rovnou uid custom tokenu.
 */
function principalFromToken(auth: { uid: string; token: Record<string, unknown> }): string {
  const firebase = auth.token.firebase as
    | { identities?: Record<string, unknown> }
    | undefined;
  const identity = firebase?.identities?.["oidc.openbuildos"];
  if (Array.isArray(identity) && typeof identity[0] === "string" && identity[0]) {
    return identity[0];
  }
  return auth.uid;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpsError("invalid-argument", `Chybí nebo je prázdné pole '${field}'.`);
  }
  return value.trim();
}

export function normalizeEmail(value: unknown): string {
  const email = requireString(value, "email").toLowerCase();
  // Záměrně volná validace — striktní regexy odmítají platné adresy. Skutečnou
  // kontrolu dělá mail provider; tady jen odsekáváme zjevný nesmysl a injektáž
  // hlaviček (CR/LF).
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || /[\r\n]/.test(email)) {
    throw new HttpsError("invalid-argument", "Neplatná e-mailová adresa.");
  }
  return email;
}

/**
 * Odkaz smí mířit JEN na známý origin appky a MUSÍ nést daný token. Tím je
 * zaručeno, že e-mail z firemní domény nemůže odvést jinam než do pozvánky,
 * kterou funkce právě ověřila.
 */
export function validateInviteUrl(rawUrl: unknown, token: string): string {
  const value = requireString(rawUrl, "inviteUrl");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new HttpsError("invalid-argument", "inviteUrl není platná URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new HttpsError("invalid-argument", "inviteUrl musí být https.");
  }
  if (!allowedOrigins().has(parsed.origin)) {
    throw new HttpsError(
      "invalid-argument",
      `Origin '${parsed.origin}' není v allowlistu appky. Rozšiř env APP_ORIGINS.`
    );
  }
  if (!value.includes(token)) {
    throw new HttpsError("invalid-argument", "inviteUrl neodpovídá pozvánce (chybí token).");
  }
  return value;
}

interface ProjectContext {
  workspaceId: string;
  /** `projects/{pid}.name` — jediný zdroj názvu projektu na firemní straně. */
  projectName: string;
}

/** Zrcadlí `canManageProject(wid, pid)` z firestore.rules. */
async function assertCanManageProject(
  projectId: string,
  principal: string
): Promise<ProjectContext> {
  const db = getFirestore(getLocalApp());
  const projectSnap = await db.doc(`projects/${projectId}`).get();
  if (!projectSnap.exists) {
    throw new HttpsError("not-found", "Projekt neexistuje.");
  }
  const project = projectSnap.data() ?? {};
  const workspaceId = typeof project.workspaceId === "string" ? project.workspaceId : "";
  if (!workspaceId) {
    throw new HttpsError("failed-precondition", "Projekt nemá workspaceId.");
  }
  const projectName = typeof project.name === "string" ? project.name : "";

  const roles = (project.roles ?? {}) as Record<string, string>;
  if (roles[principal] === "admin") {
    return { workspaceId, projectName };
  }

  const wsSnap = await db.doc(`workspaces/${workspaceId}`).get();
  const workspace = wsSnap.data() ?? {};
  const adminIds = Array.isArray(workspace.adminIds) ? (workspace.adminIds as string[]) : [];
  if (workspace.ownerId === principal || adminIds.includes(principal)) {
    return { workspaceId, projectName };
  }

  throw new HttpsError("permission-denied", "Pozvánky smí rozesílat jen správce projektu.");
}

/**
 * Ověří, že pozvánka existuje a je ve stavu, kdy se SMÍ rozeslat. Bez tohoto
 * kroku by šla funkce zneužít jako mail relay firemní domény.
 *
 * Pozn.: firemní invite doc drží jen `projectId`/`role`/`inviteeEmail`/… —
 * `projectName` ani `inviterName` na něm NEJSOU (ty žijí na centrálním
 * `pendingInvites`). Název projektu proto bereme z `projects/{pid}.name`
 * a jméno zvoucího z tokenu volajícího.
 */
async function verifyInvite(
  workspaceId: string,
  projectId: string,
  token: string,
  email: string
): Promise<void> {
  const db = getFirestore(getLocalApp());
  const snap = await db.doc(`workspaces/${workspaceId}/invites/${token}`).get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Pozvánka neexistuje.");
  }
  const invite = snap.data() ?? {};

  if (invite.projectId !== projectId) {
    throw new HttpsError("invalid-argument", "Pozvánka patří k jinému projektu.");
  }
  if (invite.usedBy) {
    throw new HttpsError("failed-precondition", "Pozvánka už byla použita.");
  }
  // Zpětná kompatibilita: staré pozvánky bez pole považujeme za 'approved'
  // (shodně s rules). Rozesílat nechceme nic, co čeká na schválení (#367).
  const approvalStatus = (invite.approvalStatus as string | undefined) ?? "approved";
  if (approvalStatus !== "approved") {
    throw new HttpsError(
      "failed-precondition",
      "Pozvánka ještě není schválená — nelze ji rozeslat."
    );
  }
  const expiresAt = invite.expiresAt as Timestamp | undefined;
  if (expiresAt && expiresAt.toDate().getTime() < Date.now()) {
    throw new HttpsError("failed-precondition", "Pozvánka expirovala.");
  }
  // Když je pozvánka adresná, e-mail MUSÍ sedět — jinak by adresný token šel
  // poslat cizí adrese. Pozvánka bez e-mailu je obecný odkaz a příjemce určuje
  // správce (na to oprávnění má).
  const inviteeEmail = (invite.inviteeEmail as string | null | undefined) ?? null;
  if (inviteeEmail && inviteeEmail.toLowerCase() !== email) {
    throw new HttpsError("permission-denied", "E-mail neodpovídá adresátovi pozvánky.");
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildMessage(
  to: string,
  inviteUrl: string,
  projectName: string,
  inviterName: string | null
): MailMessage {
  const project = projectName ? `projektu „${projectName}"` : "projektu";
  const by = inviterName ? ` od ${inviterName}` : "";
  const subject = projectName
    ? `Pozvánka do projektu ${projectName} — OpenBuildOS`
    : "Pozvánka do projektu — OpenBuildOS";

  const text = [
    `Dostal(a) jsi pozvánku${by} do ${project} v OpenBuildOS.`,
    "",
    "Připoj se přes tento odkaz:",
    inviteUrl,
    "",
    "Pokud pozvánku nečekáš, tento e-mail ignoruj.",
  ].join("\n");

  const html = [
    '<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.6;color:#111">',
    `<p>Dostal(a) jsi pozvánku${escapeHtml(by)} do ${escapeHtml(project)} v OpenBuildOS.</p>`,
    `<p><a href="${escapeHtml(inviteUrl)}" style="display:inline-block;padding:10px 18px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none">Připojit se k projektu</a></p>`,
    `<p style="color:#555;font-size:13px">Nebo zkopíruj odkaz:<br><span style="word-break:break-all">${escapeHtml(inviteUrl)}</span></p>`,
    '<p style="color:#777;font-size:13px">Pokud pozvánku nečekáš, tento e-mail ignoruj.</p>',
    "</div>",
  ].join("");

  return { to, subject, html, text };
}

export const sendProjectInvite = onCall<
  { projectId?: unknown; email?: unknown; token?: unknown; inviteUrl?: unknown },
  Promise<{ ok: true; provider: string }>
>(
  { region: "europe-west1", secrets: [RESEND_API_KEY, INVITE_MAIL_FROM] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Přihlas se do firemního backendu.");
    }
    const principal = principalFromToken(request.auth);

    const projectId = requireString(request.data?.projectId, "projectId");
    const token = requireString(request.data?.token, "token");
    const email = normalizeEmail(request.data?.email);
    const inviteUrl = validateInviteUrl(request.data?.inviteUrl, token);

    const { workspaceId, projectName } = await assertCanManageProject(projectId, principal);
    await verifyInvite(workspaceId, projectId, token, email);

    // Jméno zvoucího nese custom token z `authExchange` (claim `name`).
    const inviterName =
      typeof request.auth.token.name === "string" && request.auth.token.name
        ? request.auth.token.name
        : null;

    let provider;
    let from: string;
    try {
      provider = resolveMailProvider();
      from = resolveMailFrom();
    } catch (error) {
      if (error instanceof MailNotConfiguredError) {
        // FE na tohle spadne zpět na „zkopírovat odkaz".
        throw new HttpsError("failed-precondition", error.message);
      }
      throw error;
    }

    try {
      await provider.send(buildMessage(email, inviteUrl, projectName, inviterName), from);
    } catch (error) {
      logger.error("Odeslání pozvánky selhalo", {
        provider: provider.name,
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new HttpsError("internal", "E-mail se nepodařilo odeslat.");
    }

    logMailSent(provider, { projectId, workspaceId });
    return { ok: true, provider: provider.name };
  }
);
