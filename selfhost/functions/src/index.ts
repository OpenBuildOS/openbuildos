import { initializeApp, getApps, getApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { HttpsError, onCall, onRequest, type Request } from "firebase-functions/v2/https";
import { onDocumentCreated, onDocumentUpdated } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import type { Response } from "express";

// Serverové povýšení schválené revize výkresu do Plánů (viz planPromotion.ts).
import { isApprovalTransition, promoteApprovedDrawing } from "./planPromotion";
import {
  createBucketTrashStorage,
  createFirestoreTrashStore,
  sweepExpiredTrash as runTrashSweep,
  type SweepLogRecord,
} from "./trashSweep";

// Odesílání pozvánek e-mailem (samostatný modul, viz sendProjectInvite.ts).
export { sendProjectInvite } from "./sendProjectInvite";

// Přenos projektu mezi Firebase backendy (#291, viz projectTransfer.ts).
export {
  exportProjectBackup,
  prepareProjectBackupImport,
  importProjectBackup,
  deleteProjectPermanently,
} from "./projectTransfer";

import {
  CLAIMS_VERSION,
  ClaimsTooLargeError,
  PROJECT_SLOT_RESERVE,
  assertClaimsFit,
  belongsToWorkspace,
  computeMembershipClaims,
  countProjectGrants,
  parseStoredMembershipClaims,
  projectSlotsLeft,
  shrinkClaimsToFit,
  type MembershipClaims,
} from "./membershipClaims";
// Zneplatnění sdílecího odkazu vč. rotace download tokenu — SDÍLENÝ modul
// s hlavním repem (viz docs/REPO_BOUNDARIES.md).
import {
  ShareLinkRotationError,
  createFirestoreShareLinkStore,
  revokeShareLinkAndRotate,
} from "./shareLinkRotation";
// Serverové miniatury — SDÍLENÝ modul s hlavním repem (viz docs/REPO_BOUNDARIES.md).
import {
  decideThumbnail,
  generateThumbnail,
  thumbnailFailureMarker,
  type ThumbnailDeps,
  type ThumbnailKind,
  type ThumbnailSourceRecord,
} from "./thumbnails";

/**
 * Token-exchange Cloud Function `authExchange` pro OpenBuildOS federaci.
 *
 * Princip (BEZ OIDC/Identity Platform):
 *  1. Frontend má ID token z CENTRÁLNÍHO projektu (openbuildos).
 *  2. Pošle ho sem (POST { idToken }).
 *  3. Funkce ověří token přes admin app inicializovanou JEN s projectId
 *     centrálního projektu — k ověření stačí veřejné project id, Google
 *     podepisuje tokeny veřejnými klíči (žádný secret/service-account soubor).
 *  4. Z dekódovaného tokenu vyrobí LOKÁLNÍ custom token (createCustomToken)
 *     s uid = centrální uid. Deployovaná funkce má automaticky práva service
 *     accountu SVÉHO projektu, takže createCustomToken funguje bez klíče.
 *  5. Frontend zavolá signInWithCustomToken → přihlášen do firemního backendu
 *     se STEJNÝM uid jako centrálně → membership rules podle uid sedí napříč.
 *
 * Self-host: nasaďte do svého Firebase projektu (`firebase deploy --only
 * functions --project <firma>`). Vyžaduje plán Blaze, je zdarma do free tier.
 * Funkce důvěřuje POUZE tokenům z projektu openbuildos (CENTRAL_PROJECT_ID).
 */

const CENTRAL_PROJECT_ID = process.env.CENTRAL_PROJECT_ID || "openbuildos";

/** Povolené originy (frontend OpenBuildOS). */
const ALLOWED_ORIGINS = new Set<string>([
  "https://openbuildos.web.app",
  "https://openbuildos-app.web.app",
  "https://openbuildos.org",
  "https://www.openbuildos.org",
  "https://app.openbuildos.org",
  // 🔴 STAGING TU MUSÍ BÝT. Když origin v seznamu není, `resolveCorsOrigin`
  // vrátí bezpečný default (produkční doménu) — prohlížeč pak preflight
  // odmítne a token-exchange NEPROBĚHNE. Výsledkem není hláška „nemáte
  // právo", ale rozsypaná appka: workspace klient zůstane nepřihlášený, takže
  // tiše selže všechno, co sahá na firemní data (21. 8. 2026 se to projevilo
  // jako „nejde uložit šablona reportu").
  "https://openbuildos-staging.web.app",
  "http://localhost:5173",
]);

/**
 * Admin app pro OVĚŘENÍ centrálního tokenu — inicializovaná JEN s projectId
 * centrálního projektu. Žádné credentials nejsou potřeba: verifyIdToken stahuje
 * veřejné podpisové klíče Googlu a kontroluje, že token patří CENTRAL_PROJECT_ID.
 */
const CENTRAL_APP_NAME = "central-verify";

function getCentralApp() {
  const existing = getApps().find((app) => app.name === CENTRAL_APP_NAME);
  if (existing) {
    return existing;
  }
  return initializeApp({ projectId: CENTRAL_PROJECT_ID }, CENTRAL_APP_NAME);
}

/**
 * Default admin app = LOKÁLNÍ projekt (firemní backend), automatické credentials
 * z prostředí Cloud Functions. Používá se na createCustomToken (podpis service
 * accountem lokálního projektu).
 */
function getLocalApp() {
  return getApps().some((app) => app.name === "[DEFAULT]") ? getApp() : initializeApp();
}

function resolveCorsOrigin(origin: string | undefined): string {
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    return origin;
  }
  // Bezpečný default — nepovolíme libovolný origin s credentials.
  return "https://openbuildos.web.app";
}

function setCors(
  req: Request,
  res: Response,
  methods: string
) {
  const origin = req.headers.origin as string | undefined;
  res.set("Access-Control-Allow-Origin", resolveCorsOrigin(origin));
  res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Methods", `${methods}, OPTIONS`);
  res.set("Access-Control-Allow-Headers", "Authorization, Content-Type, Range");
  res.set("Access-Control-Expose-Headers", "Accept-Ranges, Content-Length, Content-Range");
  res.set("Access-Control-Max-Age", "3600");
}

export const authExchange = onRequest({ region: "europe-west1" }, async (req, res) => {
  setCors(req, res, "POST");

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const idToken: unknown = req.body?.idToken;
  if (typeof idToken !== "string" || idToken.length === 0) {
    res.status(401).json({ error: "Chybí idToken." });
    return;
  }

  try {
    const decoded = await getAuth(getCentralApp()).verifyIdToken(idToken);
    const uid = decoded.uid;
    const email = decoded.email ?? null;
    const name = (decoded.name as string | undefined) ?? null;

    // Členství se razí do tokenu — Storage rules ho jinak nemají jak zjistit
    // (cross-service firestore.get() je nespolehlivý). Viz membershipClaims.ts.
    const membership = await computeMembershipClaims(getFirestore(getLocalApp()), uid);
    const claims = { email, name, src: "openbuildos", cv: CLAIMS_VERSION, ...membership };

    // Claims musí přežít i OBNOVU tokenu, ne jen tohle přihlášení. Developer
    // claims z custom tokenu platí pro tuhle session; `setCustomUserClaims` je
    // zapíše na uživatele, takže `getIdToken(true)` po změně členství přinese
    // nové hodnoty (invalidace podle SECURITY_CLAIMS_DESIGN.md kap. 3).
    //
    // 🔴 POŘADÍ: zapsat DŘÍV, než se přetečení ohlásí. Nad stropem se dřív
    // nezapsalo nic, takže odebranému uživateli zůstal v platnosti STARÝ claim
    // až do vypršení refresh tokenu — Firestore ho odřízl hned, Storage ne.
    // `shrinkClaimsToFit` zapíše nanejvýš průnik nového a uloženého stavu
    // (nikdy tedy víc práv), takže odebrání projde i nad stropem.
    const stored = await readStoredMembershipClaims(uid);
    const persisted = shrinkClaimsToFit(membership, stored, { email, name });
    await persistMembershipClaims(uid, persisted.claims, { email, name }, { allowCreate: true });

    assertClaimsFit(claims);

    const customToken = await getAuth(getLocalApp()).createCustomToken(uid, claims);

    logger.info("authExchange OK", {
      uid,
      hasEmail: Boolean(email),
      adminWorkspaces: membership.wsa?.length ?? 0,
      projects: countProjectGrants(membership),
    });
    res.status(200).json({ customToken });
  } catch (error) {
    if (error instanceof ClaimsTooLargeError) {
      // TVRDÁ chyba, ne tiché uříznutí seznamu — jinak by uživatel bez varování
      // přišel o přístup k části staveb.
      logger.error("authExchange: claims se nevejdou do tokenu", {
        bytes: error.bytes,
        limit: error.limit,
      });
      res.status(413).json({ error: error.message });
      return;
    }
    logger.error("authExchange selhalo", error);
    res.status(401).json({ error: "Ověření centrálního tokenu selhalo." });
  }
});

/**
 * Zapíše členství na uživatele lokálního projektu. Uživatel při PRVNÍM
 * přihlášení ještě neexistuje (vzniká až `signInWithCustomToken`), takže ho
 * musíme založit — jinak by `setCustomUserClaims` spadlo na user-not-found a
 * claims by přežily jen do vypršení prvního tokenu.
 */
async function persistMembershipClaims(
  uid: string,
  membership: MembershipClaims,
  profile: { email: string | null; name: string | null },
  { allowCreate = false }: { allowCreate?: boolean } = {}
): Promise<void> {
  const auth = getAuth(getLocalApp());
  try {
    await auth.getUser(uid);
  } catch {
    // Zakládat uživatele smíme JEN při vlastním přihlášení (authExchange).
    // Na cizí cíl ne — jinak by šlo přes `syncMemberClaims` zakládat libovolné
    // Auth účty s uid, které si útočník zvolí.
    if (!allowCreate) {
      logger.info("persistMembershipClaims: cílový uživatel neexistuje, přeskakuji", { uid });
      return;
    }
    try {
      // Bez e-mailu záměrně: kdyby tentýž e-mail už patřil jinému uid, založení
      // by spadlo a shodilo by celé přihlášení. Uid je jediné, na čem záleží.
      await auth.createUser({ uid, displayName: profile.name ?? undefined });
    } catch (createError) {
      logger.warn("persistMembershipClaims: uživatele nelze založit", createError);
      return;
    }
  }
  await auth.setCustomUserClaims(uid, {
    src: "openbuildos",
    cv: CLAIMS_VERSION,
    ...membership,
  });
}

/**
 * Členství, které na uživateli LEŽÍ (ne to, co by mu podle Firestore náleželo).
 *
 * Potřebuje to `shrinkClaimsToFit`: nad tokenovým stropem se zapisuje průnik
 * nového a uloženého stavu, aby odebrání z projektu prošlo, ale nic nepřibylo.
 * Uložený tvar může být ještě PLOCHÝ (token starší než CLAIMS_VERSION 2) —
 * `parseStoredMembershipClaims` si s ním poradí, protože kdyby se starý tvar
 * četl jako „nic", vypadalo by každé odebrání jako „nebylo co odebrat".
 */
async function readStoredMembershipClaims(uid: string): Promise<MembershipClaims> {
  try {
    const user = await getAuth(getLocalApp()).getUser(uid);
    return parseStoredMembershipClaims(user.customClaims);
  } catch {
    // Uživatel ještě neexistuje (první přihlášení) — nic uloženého není.
    return {};
  }
}

type CompanyAccess = {
  principal: string;
  role: string;
  isLead: boolean;
};

const MAX_COMPANY_FILE_BYTES = 200 * 1024 * 1024;

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeFileName(value: string): string {
  return value.replace(/[\\/\u0000-\u001f\u007f]+/g, "_").slice(0, 180) || "soubor.pdf";
}

// Firestore/Storage segmenty stavíme z klientských ID — dovol jen bezpečný tvar
// (UUID/nanoid), ať se do cesty nedostane '/', '..' ani řídicí znak.
function isSafeId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

// Whitelist content-typů pro upload. Interní soubory jsou PDF, náhledy JPEG;
// cokoli jiného (např. text/html) by se přes `inline` download mohlo zneužít.
function safeContentType(kind: "file" | "thumbnail", value: string): string {
  const allowed = kind === "thumbnail" ? ["image/jpeg"] : ["application/pdf"];
  return allowed.includes(value) ? value : allowed[0];
}

async function verifyWorkspaceBearer(req: Request) {
  const authorization = req.headers.authorization ?? "";
  if (!authorization.startsWith("Bearer ")) {
    throw new Error("Chybí workspace autorizační token.");
  }
  return getAuth(getLocalApp()).verifyIdToken(authorization.slice("Bearer ".length));
}

async function authorizeCompany(
  workspaceId: string,
  projectId: string,
  companyId: string,
  principal: string
): Promise<CompanyAccess> {
  const project = await getFirestore(getLocalApp()).doc(`projects/${projectId}`).get();
  const data = project.data();
  const companies = (data?.companies ?? {}) as Record<string, unknown>;
  const roles = (data?.roles ?? {}) as Record<string, unknown>;
  const memberIds = Array.isArray(data?.memberIds) ? data.memberIds : [];

  if (
    !project.exists
    || data?.workspaceId !== workspaceId
    || !memberIds.includes(principal)
    || companies[principal] !== companyId
  ) {
    throw new Error("Uživatel není členem této firmy na projektu.");
  }

  // Kill switch: když je beta na projektu explicitně vypnutá, brána odmítne i
  // přímé volání (feature flag tak není jen UI, ale i bezpečnostní vypínač).
  if (data?.companySpacesBetaEnabled === false) {
    throw new Error("Beta firemních prostorů je na tomto projektu vypnutá.");
  }

  const role = typeof roles[principal] === "string" ? String(roles[principal]) : "viewer";
  return {
    principal,
    role,
    isLead: ["company_editor", "editor", "admin"].includes(role),
  };
}

function canReadAccessRecord(access: CompanyAccess, data: Record<string, unknown>): boolean {
  if (access.isLead || data.accessMode === "company_all") {
    return true;
  }
  return data.accessMode === "restricted"
    && Array.isArray(data.allowedPrincipalIds)
    && data.allowedPrincipalIds.includes(access.principal);
}

async function assertFolderAccess(
  workspaceId: string,
  projectId: string,
  companyId: string,
  folderId: string,
  access: CompanyAccess
) {
  if (!folderId) {
    return { accessMode: "company_all", allowedPrincipalIds: [] as string[] };
  }
  const folder = await getFirestore(getLocalApp())
    .doc(`workspaces/${workspaceId}/projects/${projectId}/companySpaces/${companyId}/folders/${folderId}`)
    .get();
  const data = folder.data() as Record<string, unknown> | undefined;
  if (!folder.exists || !data || !canReadAccessRecord(access, data)) {
    throw new Error("Ke zvolené složce nemáte přístup.");
  }
  return {
    accessMode: data.accessMode,
    allowedPrincipalIds: Array.isArray(data.allowedPrincipalIds) ? data.allowedPrincipalIds.map(String) : [],
  };
}

function companySpacePrefix(workspaceId: string, projectId: string, companyId: string) {
  return `workspaces/${workspaceId}/projects/${projectId}/companySpaces/${companyId}/`;
}

function parseRange(rangeHeader: string | undefined, size: number) {
  const match = rangeHeader?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) {
    return null;
  }
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
}

async function handleCompanyUpload(
  req: Request,
  res: Response,
  access: CompanyAccess,
  workspaceId: string,
  projectId: string,
  companyId: string
) {
  const documentId = stringValue(req.body?.documentId);
  const versionId = stringValue(req.body?.versionId);
  const folderId = stringValue(req.body?.folderId);
  const requestedName = safeFileName(stringValue(req.body?.fileName));
  const kind = req.body?.kind === "thumbnail" ? "thumbnail" : "file";
  const contentType = safeContentType(kind, stringValue(req.body?.contentType));
  const size = Number(req.body?.size);
  if (
    !isSafeId(documentId)
    || !isSafeId(versionId)
    || (folderId && !isSafeId(folderId))
    || !Number.isFinite(size)
    || size <= 0
    || size > MAX_COMPANY_FILE_BYTES
  ) {
    res.status(400).json({ error: "Neplatná metadata souboru nebo překročený limit 200 MB." });
    return;
  }

  await assertFolderAccess(workspaceId, projectId, companyId, folderId, access);
  const suffix = kind === "thumbnail" ? "thumbnails/preview.jpg" : `files/${requestedName}`;
  const objectPath = `${companySpacePrefix(workspaceId, projectId, companyId)}documents/${documentId}/${versionId}/${suffix}`;
  const file = getStorage(getLocalApp()).bucket().file(objectPath);
  const [uploadUrl] = await file.createResumableUpload({
    origin: resolveCorsOrigin(req.headers.origin as string | undefined),
    metadata: {
      contentType,
      metadata: { projectId, companyId, documentId, versionId, uploadedBy: access.principal },
    },
  });
  res.status(200).json({ uploadUrl, objectPath });
}

async function handleCompanyDownload(
  req: Request,
  res: Response,
  access: CompanyAccess,
  workspaceId: string,
  projectId: string,
  companyId: string
) {
  const documentId = stringValue(req.query.documentId);
  const versionId = stringValue(req.query.versionId);
  const kind = req.query.kind === "thumbnail" ? "thumbnail" : "file";
  if (!isSafeId(documentId) || !isSafeId(versionId)) {
    res.status(400).json({ error: "Chybí documentId nebo versionId." });
    return;
  }

  const version = await getFirestore(getLocalApp())
    .doc(`workspaces/${workspaceId}/projects/${projectId}/companySpaces/${companyId}/documentVersions/${versionId}`)
    .get();
  const data = version.data() as Record<string, unknown> | undefined;
  if (!version.exists || !data || data.documentId !== documentId || !canReadAccessRecord(access, data)) {
    res.status(404).json({ error: "Soubor nebyl nalezen." });
    return;
  }

  // ACL zdroj pravdy = složka, ne denormalizované pole na verzi. Klientská
  // propagace ACL (updateCompanyFolderAccess) není atomická; kdyby doběhla jen
  // zčásti, verze by mohla nést zastaralé `company_all`. Ověř aktuální ACL
  // složky, aby odebraný člen nestáhl binárku přes zastaralé pole na verzi.
  await assertFolderAccess(workspaceId, projectId, companyId, stringValue(data.folderId), access);

  const objectPath = stringValue(kind === "thumbnail" ? data.thumbnailObjectPath : data.fileObjectPath);
  const prefix = companySpacePrefix(workspaceId, projectId, companyId);
  if (!objectPath.startsWith(prefix)) {
    res.status(404).json({ error: "Soubor nebyl nalezen." });
    return;
  }

  const file = getStorage(getLocalApp()).bucket().file(objectPath);
  const [metadata] = await file.getMetadata();
  const size = Number(metadata.size ?? 0);
  const range = parseRange(req.headers.range, size);
  res.set("Cache-Control", "private, no-store");
  res.set("Accept-Ranges", "bytes");
  res.set("Content-Type", metadata.contentType || "application/octet-stream");
  res.set("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(stringValue(data.fileName) || "soubor.pdf")}`);

  if (req.method === "HEAD") {
    res.set("Content-Length", String(size));
    res.status(200).end();
    return;
  }

  if (range) {
    res.status(206);
    res.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
    res.set("Content-Length", String(range.end - range.start + 1));
  } else {
    res.status(200);
    res.set("Content-Length", String(size));
  }

  await new Promise<void>((resolve, reject) => {
    const stream = file.createReadStream(range ?? undefined);
    stream.on("error", reject);
    res.on("finish", resolve);
    res.on("close", resolve);
    stream.pipe(res);
  });
}

/**
 * Autorizovaná datová brána firemního prostoru.
 * POST vytvoří krátkodobou resumable upload session; GET/HEAD streamuje objekt
 * až po ověření projektu, firmy a ACL uloženého version dokumentu.
 */
export const companyFile = onRequest({ region: "europe-west1", timeoutSeconds: 300 }, async (req, res) => {
  setCors(req, res, "GET, HEAD, POST");
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  if (!["GET", "HEAD", "POST"].includes(req.method)) {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const decoded = await verifyWorkspaceBearer(req);
    const workspaceId = stringValue(req.method === "POST" ? req.body?.workspaceId : req.query.workspaceId);
    const projectId = stringValue(req.method === "POST" ? req.body?.projectId : req.query.projectId);
    const companyId = stringValue(req.method === "POST" ? req.body?.companyId : req.query.companyId);
    if (!workspaceId || !projectId || !companyId) {
      res.status(400).json({ error: "Chybí workspaceId, projectId nebo companyId." });
      return;
    }
    const access = await authorizeCompany(workspaceId, projectId, companyId, decoded.uid);
    if (req.method === "POST") {
      await handleCompanyUpload(req, res, access, workspaceId, projectId, companyId);
    } else {
      await handleCompanyDownload(req, res, access, workspaceId, projectId, companyId);
    }
  } catch (error) {
    logger.warn("companyFile zamítl request", error);
    res.status(403).json({ error: "K firemnímu souboru nemáte přístup." });
  }
});

function principalFromAuth(auth: { uid: string; token: Record<string, unknown> }): string {
  const firebase = auth.token.firebase as { identities?: Record<string, unknown> } | undefined;
  const identities = firebase?.identities?.["oidc.openbuildos"];
  if (Array.isArray(identities) && typeof identities[0] === "string" && identities[0]) {
    return identities[0];
  }
  return auth.uid;
}

/**
 * `revokeShareLinkAndRotateToken` — „Zneplatnit odkaz" opravdu zneplatní odkaz.
 *
 * Sdílecí odkaz vede přes `/share/{wid}/{token}` na PŘÍMOU download URL souboru.
 * Kdo si tu adresu zkopíroval, tomu `revoked = true` ve Firestoru nevezme nic —
 * Storage servíruje objekt podle tokenu v URL, mimo rules. Zneplatnit jde tedy
 * jen rotací `firebaseStorageDownloadTokens`.
 *
 * 🔴 Logika je od 8. 8. 2026 ve SDÍLENÉM `shareLinkRotation.ts`, protože ji do
 * té doby měl JEN tenhle (firemní) backend. Klient hostovaného zákazníka dostal
 * z centrálního projektu `functions/not-found` a spadl na
 * `updateDoc({ revoked: true })` — zneplatnění tam mlčky nedělalo nic
 * podstatného. Modul se proto MUSÍ držet identický v obou repech
 * (viz docs/REPO_BOUNDARIES.md), ať se ta dvě prostředí nemůžou znovu rozejít.
 *
 * Součástí rotace je úklid po ní: download token je vlastnost OBJEKTU, takže
 * přeražení zabije i adresu uloženou u položky (`photos.url`,
 * `documentVersions.filePath`, `plans.versions[].fileUrl`). Modul ji proto
 * přepíše novou — jinak by zneplatnění odkazu shodilo zobrazení té položky
 * v aplikaci.
 */
export const revokeShareLinkAndRotateToken = onCall<
  { wid?: string; pid?: string; token?: string }
>({ region: "europe-west1" }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Chybí přihlášení do workspace.");
  }

  const principal = principalFromAuth(request.auth);
  const store = createFirestoreShareLinkStore(
    getFirestore(getLocalApp()),
    getStorage(getLocalApp())
  );

  try {
    const result = await revokeShareLinkAndRotate(store, {
      workspaceId: typeof request.data?.wid === "string" ? request.data.wid : "",
      projectId: typeof request.data?.pid === "string" ? request.data.pid : "",
      token: typeof request.data?.token === "string" ? request.data.token : "",
      principal,
    });
    logger.info("revokeShareLinkAndRotateToken OK", {
      workspaceId: request.data?.wid,
      projectId: request.data?.pid,
      principal,
      wasAlreadyRevoked: result.wasAlreadyRevoked,
      // Kolik uložených adres se po rotaci přepsalo na novou. Trvalá 0 u fotek
      // a dokumentů je signál, že se obnova nechytá (viz `STORED_URL_COLLECTIONS`).
      refreshedUrls: result.refreshedUrls,
    });
    return {
      revoked: result.revoked,
      tokenRotated: result.tokenRotated,
      refreshedUrls: result.refreshedUrls,
    };
  } catch (error) {
    if (error instanceof ShareLinkRotationError) {
      throw new HttpsError(error.code, error.message);
    }
    // Rotace selhala z jiného důvodu (Storage, IAM). Klient NESMÍ spadnout na
    // „jen Firestore" fallback — `functions/internal` mezi fallbackové kódy
    // nepatří, takže se chyba dostane až k uživateli.
    logger.error("revokeShareLinkAndRotateToken selhalo", {
      workspaceId: request.data?.wid,
      projectId: request.data?.pid,
      principal,
      error,
    });
    throw new HttpsError("internal", "Zneplatnění odkazu se nepodařilo dokončit.");
  }
});

async function isWorkspaceAdmin(workspaceId: string, principal: string): Promise<boolean> {
  const snap = await getFirestore(getLocalApp()).doc(`workspaces/${workspaceId}`).get();
  const data = snap.data() as { ownerId?: string; adminIds?: string[] } | undefined;
  if (!snap.exists || !data) {
    return false;
  }
  return data.ownerId === principal || (data.adminIds ?? []).includes(principal);
}

/**
 * Přepočítá custom claims a (u cizího uživatele) shodí jeho token.
 *
 * Claims jsou v tokenu s pevnou platností 1 h, takže po změně členství by byly
 * až hodinu zastaralé (SECURITY_CLAIMS_DESIGN.md kap. 3). Tahle funkce to
 * zkracuje na sekundy:
 *  - `{ }` nebo `{ principal: já }` — SEBEOBSLUHA. Smí ji volat kdokoli
 *    přihlášený; přepočet čte Firestore, takže nemůže udělit víc, než co už
 *    tam stojí. Klient ji volá po přijetí pozvánky a pak si dá getIdToken(true).
 *  - `{ wid, principal: někdo jiný }` — jen vlastník/admin té firmy. Kromě
 *    přepočtu bumpne SIGNÁLNÍ dokument, kterého si všimne klient dotčeného
 *    uživatele a vynutí si obnovu tokenu.
 *  - `{ wid, principal, revoke: true }` — navíc `revokeRefreshTokens`, tedy
 *    tvrdé vyhození při odebrání z firmy.
 *  - `{ wid, principal, probe: true, projectId }` — NIC NEMĚNÍ, jen spočítá,
 *    kolik dalších staveb se cíli ještě vejde do tokenu. Od toho je produktová
 *    zarážka při zvaní: kapacita je konečná, tak ať se to dozví TEN, KDO ZVE,
 *    a ne pozvaný ve chvíli, kdy mu po přihlášení tiše nejede Storage.
 */
export const syncMemberClaims = onCall<
  { wid?: string; principal?: string; revoke?: boolean; probe?: boolean; projectId?: string }
>({ region: "europe-west1" }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Chybí přihlášení do workspace.");
  }

  const caller = principalFromAuth(request.auth);
  const target = typeof request.data?.principal === "string" && request.data.principal
    ? request.data.principal
    : caller;
  const workspaceId = typeof request.data?.wid === "string" ? request.data.wid : "";
  const revoke = request.data?.revoke === true;
  const isSelf = target === caller;

  if (request.data?.probe === true) {
    return probeProjectCapacity({ caller, target, workspaceId, isSelf, request });
  }

  if (!isSelf || revoke) {
    if (!workspaceId) {
      throw new HttpsError("invalid-argument", "Chybí wid.");
    }
    if (!(await isWorkspaceAdmin(workspaceId, caller))) {
      throw new HttpsError(
        "permission-denied",
        "Přepočet přístupů cizího uživatele smí vyvolat jen vlastník nebo admin firmy."
      );
    }
  }

  const db = getFirestore(getLocalApp());
  const membership = await computeMembershipClaims(db, target);

  // Cizí cíl musí mít k TOMUHLE workspace vztah. Bez téhle brány by admin firmy
  // A mohl poslat `revoke` na uživatele firmy B — odhlašovací DoS napříč tenanty.
  //
  // ⚠️ Nestačí `belongsToWorkspace`: nejčastější volání je PRÁVĚ PO odebrání
  // z projektu, kdy už cíl nikam nepatří — a to je ten okamžik, kdy se claims
  // musí přepočítat nejvíc. Proto bereme i adresářový záznam firmy, který
  // odebrání z projektu nemaže.
  //
  // Ten záznam tu slouží jako důkaz VZTAHU k firmě, ne jako důkaz oprávnění —
  // zakládá ho i host, takže na udělení přístupu se použít nesmí (viz
  // membershipClaims.ts). Na omezení dosahu adminů je ale přesně správný.
  if (!isSelf) {
    const associated = belongsToWorkspace(membership, workspaceId)
      || (await db.doc(`workspaces/${workspaceId}/members/${target}`).get()).exists;
    if (!associated) {
      throw new HttpsError("permission-denied", "Uživatel k tomuto workspace nepatří.");
    }
  }

  // 🔴 POŘADÍ JE TU BEZPEČNOSTNÍ VLASTNOST. Do 8/2026 se nad tokenovým stropem
  // vyhodilo `resource-exhausted` DŘÍV, než se cokoli zapsalo — takže volání
  // `syncMemberClaims(revoke)` po odebrání člena neudělalo NIC a jeho starý
  // claim přežil až do vypršení refresh tokenu. Firestore ho odřízl okamžitě,
  // Storage vůbec. Revokace tedy u uživatele nad stropem nefungovala.
  //
  // Teď se nejdřív provede všechno, co odebrání vynucuje (zápis ořezaných
  // claims, signální dokument, zneplatnění refresh tokenů), a přetečení se
  // ohlásí až nakonec. `shrinkClaimsToFit` nikdy nezapíše víc, než co je
  // ZÁROVEŇ v novém výpočtu a v už uloženém stavu — růst nad strop tedy pořád
  // „zamrzne", ale odebrání projde.
  const stored = await readStoredMembershipClaims(target);
  const persisted = shrinkClaimsToFit(membership, stored);

  await persistMembershipClaims(target, persisted.claims, { email: null, name: null });

  if (workspaceId && !isSelf) {
    // Signál pro klienta dotčeného uživatele — onSnapshot → getIdToken(true).
    await db.doc(`workspaces/${workspaceId}/accessSignals/${target}`).set(
      {
        rev: FieldValue.increment(1),
        updatedAt: new Date().toISOString(),
        reason: revoke ? "revoked" : "membership",
      },
      { merge: true }
    );
  }

  if (revoke) {
    // Tvrdé vyhození: uživatel se musí přihlásit znovu (což u federace znamená
    // nový token-exchange, tedy i nové claims). Chybějící uživatel není chyba —
    // odebíráme někoho, kdo se do firemního backendu nikdy nepřihlásil.
    try {
      await getAuth(getLocalApp()).revokeRefreshTokens(target);
    } catch (error) {
      logger.warn("syncMemberClaims: revokeRefreshTokens selhalo", { target, error });
    }
  }

  if (!persisted.fits) {
    // Až TEĎ, když jsou všechny účinky odebrání na místě. Klient z toho udělá
    // trvalý banner, ať se to nepozná až ze stížnosti uživatele.
    try {
      assertClaimsFit({ src: "openbuildos", cv: CLAIMS_VERSION, ...membership });
    } catch (error) {
      if (error instanceof ClaimsTooLargeError) {
        logger.error("syncMemberClaims: claims se nevejdou do tokenu", {
          target,
          bytes: error.bytes,
          limit: error.limit,
          projects: countProjectGrants(membership),
        });
        throw new HttpsError("resource-exhausted", error.message);
      }
      throw error;
    }
  }

  logger.info("syncMemberClaims OK", {
    caller,
    target,
    workspaceId,
    revoke,
    adminWorkspaces: membership.wsa?.length ?? 0,
    projects: countProjectGrants(membership),
  });

  return { synced: true, revoked: revoke };
});

/**
 * `promoteUnapprovedDrawingOnUpload` — výkres nahraný na stavbě BEZ schvalování.
 *
 * 🔑 Proč druhý trigger, a ne `retry`/`onDocumentWritten` u toho vedle:
 * `promoteApprovedDrawingToPlan` je `onDocumentUpdated` a pojistkou proti
 * zacyklení mu je `before.status !== after.status`. Jenže stavba s vypnutým
 * schvalováním (`projects/{pid}.documentApproval === "off"`) zakládá revizi
 * rovnou jako `approved` — a tam žádný přechod stavu NENASTANE, dokument se
 * jen vytvoří. Bez tohohle triggeru by taková firma měla trvale prázdné Plány
 * a nedozvěděla se proč. Přepsat sousedovi podmínku na `onDocumentWritten` by
 * naopak znamenalo sáhnout na cestu, kterou dnes chodí každé schválení.
 *
 * Rozhodování i zápis dělá TÁŽ funkce `promoteApprovedDrawing` (idempotentní,
 * zamyká se markerem `planPromotion`), takže obě cesty vyrábějí stejný výkres.
 * Region se ze stejného důvodu jako u souseda NEURČUJE.
 */
export const promoteUnapprovedDrawingOnUpload = onDocumentCreated(
  {
    document: "workspaces/{workspaceId}/projects/{projectId}/documentVersions/{versionId}",
  },
  async (event) => {
    const created = event.data?.data();
    // `isApprovalTransition(undefined, status)` = „vzniklo rovnou ve schváleném
    // stavu". Revize založená jako `draft` (stavba SE schvalováním) sem nespadne
    // a počká na schvalovatele, jak má.
    if (!created || !isApprovalTransition(undefined, created.status)) {
      return;
    }

    const { workspaceId, projectId, versionId } = event.params;

    try {
      const result = await promoteApprovedDrawing(getFirestore(getLocalApp()), {
        workspaceId,
        projectId,
        versionId,
      });
      logger.info("promoteUnapprovedDrawingOnUpload", { workspaceId, projectId, versionId, ...result });
    } catch (error) {
      logger.error("promoteUnapprovedDrawingOnUpload selhalo", { workspaceId, projectId, versionId, error });
      await getFirestore(getLocalApp())
        .doc(`workspaces/${workspaceId}/projects/${projectId}/documentVersions/${versionId}`)
        .set(
          {
            planPromotion: {
              status: "failed",
              reason: error instanceof Error ? error.message : String(error),
              at: new Date().toISOString(),
            },
          },
          { merge: true }
        )
        .catch(() => undefined);
      throw error;
    }
  }
);

/**
 * `promoteApprovedDrawingToPlan` — schválený jednostránkový výkres se povýší
 * do Plánů na SERVERU (#506, fáze 2).
 *
 * ⭐ PROČ TRIGGER, NE CALLABLE.
 *  1. Smyslem změny je, aby povýšení NEZÁVISELO na prohlížeči schvalovatele.
 *     Callable by se pořád volala z jeho záložky — kdyby ji zavřel, ztratil
 *     signál nebo mu vypršel token mezi schválením a druhým voláním, revize by
 *     byla schválená a výkres by v Plánech nebyl. Trigger vychází z DAT: jakmile
 *     je schválení commitnuté ve Firestoru, důsledek nastane nezávisle na tom,
 *     co dělá klient.
 *  2. Selhání zůstane VIDĚT v datech (marker na revizi) i v logu backendu;
 *     u callable by zmizelo s tou záložkou, ve které se stalo.
 *  3. Callable by si musela sama ověřit, že volající SMÍ schvalovat — tedy
 *     zduplikovat `isApprover` z firestore.rules do TypeScriptu. Trigger žádné
 *     nové rozhodnutí o oprávnění nedělá: čte stav, který pravidly už prošel.
 *  4. Schválení se zapisuje z několika míst klienta; trigger je zachytí všechna,
 *     aniž by se sahalo na `src/` (kde souběžně běží fáze 1).
 *
 * Cena horší chybové zpětné vazby (hlavní výhoda callable) se platí zápisem
 * výsledku zpátky na revizi (`documentVersions/{id}.planPromotion`), takže UI
 * má co ukázat a odmítnuté povýšení nemůže skončit tiše — viz „nulté pravidlo"
 * v #506.
 *
 * ⚠️ REGION SE ZÁMĚRNĚ NEURČUJE (na rozdíl od ostatních funkcí v tomhle souboru).
 * Eventarc trigger MUSÍ ležet v téže lokaci jako databáze Firestore; firebase-tools
 * si lokaci databáze zjistí a region funkce z ní odvodí (`eur3` → `europe-west1`,
 * tedy totéž, co má zbytek). Natvrdo psaný region by se rozešel s triggerem
 * v každém zákaznickém projektu, kde si firma zvolila jinou lokaci databáze —
 * a tenhle kit se nasazuje právě do nich.
 */
export const promoteApprovedDrawingToPlan = onDocumentUpdated(
  {
    document: "workspaces/{workspaceId}/projects/{projectId}/documentVersions/{versionId}",
    // ⚠️ ŽÁDNÉ `retry: true`, i když by se sem hodilo (funkce JE idempotentní).
    // firebase-tools odmítne nasadit failure policy bez `--force` — a `--force`
    // v self-host setupu použít NESMÍME: odklepl by zároveň smazání funkcí,
    // které v klonu nejsou. Přesně tak přišla firma o sedm funkcí, než se to
    // 6. 8. 2026 zakázalo (docs/REPO_BOUNDARIES.md). Platí tedy
    // `RETRY_POLICY_DO_NOT_RETRY`; selhání není tiché — zůstane po něm marker
    // `planPromotion.status = "failed"`, který UI ukáže.
  },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!after || !isApprovalTransition(before?.status, after.status)) {
      // Sem spadne i vlastní zápis markeru — status se nezměnil, takže se
      // trigger nemůže zacyklit.
      return;
    }

    const { workspaceId, projectId, versionId } = event.params;

    try {
      const result = await promoteApprovedDrawing(getFirestore(getLocalApp()), {
        workspaceId,
        projectId,
        versionId,
      });
      logger.info("promoteApprovedDrawingToPlan", { workspaceId, projectId, versionId, ...result });
    } catch (error) {
      logger.error("promoteApprovedDrawingToPlan selhalo", { workspaceId, projectId, versionId, error });
      // Uživatel se to musí dozvědět, i když trigger doběhne s chybou.
      await getFirestore(getLocalApp())
        .doc(`workspaces/${workspaceId}/projects/${projectId}/documentVersions/${versionId}`)
        .set(
          {
            planPromotion: {
              status: "failed",
              reason: error instanceof Error ? error.message : String(error),
              at: new Date().toISOString(),
            },
          },
          { merge: true }
        )
        .catch(() => undefined);
      throw error;
    }
  }
);

/**
 * Souhrn doběhu koše → JEDEN záznam v Cloud Loggingu.
 *
 * ⚠️ ZÁVAŽNOST URČUJE `describeSweepRun`, ne tenhle přepínač. Do 8/2026 tu stálo
 * `logger.info("sweepExpiredTrash", summary)` — a protože `gcloud functions logs
 * read` ukazuje jen textovou hlášku, dalo se z logu přečíst pouze jméno funkce:
 * běh, který smazal padesát položek, vypadal stejně jako běh, který neudělal nic,
 * i jako běh, kterému se všechno rozsypalo. U funkce, která MAŽE DATA, je tichý
 * log to samé jako žádný. Věta jde do hlášky, čísla do `jsonPayload`
 * (filtr `jsonPayload.event="trash_sweep_finished"`).
 */
function logSweepSummary(record: SweepLogRecord): void {
  if (record.severity === "error") {
    logger.error(record.message, record.payload);
    return;
  }
  if (record.severity === "warning") {
    logger.warn(record.message, record.payload);
    return;
  }
  logger.info(record.message, record.payload);
}

/**
 * `sweepExpiredTrash` — po 30 dnech se smazaný obsah OPRAVDU smaže (B3).
 *
 * ⭐ PROČ NAPLÁNOVANÁ FUNKCE. Do 8/2026 dělal doběh koše prohlížeč správce
 * (`sweepExpiredTrash` v `src/services/trash.ts`), a to jen v okamžiku, kdy si
 * někdo s právy otevřel stránku Koš. Na stavbě, kde do Koše nikdo nechodí, se
 * doběh nespustil nikdy — přestože UI i zásady ochrany osobních údajů slibují
 * „po 30 dnech se smaže natrvalo". Slib, který plní náhodné klikání, není slib.
 *
 * ⚠️ PROČ NE FIRESTORE TTL. TTL policy nad `purgeAt` by smazala jen Firestore
 * dokument. Objekt ve Storage by nechala osiřelý (fotky s osobními údaji, na
 * které už nic neukazuje) a počítadlo spotřeby by neodečetla. Doběh proto musí
 * mazat záznam I blob — to umí jen kód, viz `trashSweep.ts`.
 *
 * Klientský doběh v `src/services/trash.ts` ZŮSTÁVÁ jako druhá kolej: uklidí
 * hned, co správce v Koši vidí, a kryje projekty, kde tahle funkce (ještě)
 * neběží — třeba self-host, který nespustil setup CLI. Obě cesty používají
 * totéž pořadí (záznam → objekt) a jsou idempotentní, takže si nepřekáží.
 *
 * ⚠️ ŽÁDNÝ `retry`. Stejný důvod jako u `promoteApprovedDrawingToPlan`: failure
 * policy jde nasadit jen s `--force`, které v self-host setupu nesmí padnout.
 * Nevadí to — běh je denní a co nestihne (strop `SWEEP_MAX_ITEMS_PER_RUN`),
 * dobere zítra.
 */
export const sweepExpiredTrash = onSchedule(
  {
    // 03:20 místního času: mimo špičku na stavbě a mimo okno týdenního exportu.
    schedule: "20 3 * * *",
    timeZone: "Europe/Prague",
    region: "europe-west1",
    timeoutSeconds: 540,
  },
  async () => {
    const firestore = getFirestore(getLocalApp());
    await runTrashSweep(
      createFirestoreTrashStore(firestore),
      createBucketTrashStorage(getStorage(getLocalApp()).bucket(), (message, error) =>
        logger.warn(message, { error })
      ),
      {
        onError: (message, error) => logger.warn(message, { error }),
        // Jediná stopa, kterou po sobě běh nechá — návratovou hodnotu tu nikdo nečte.
        onSummary: logSweepSummary,
      }
    );
  }
);

/**
 * Read-only větev `syncMemberClaims`: kolik dalších staveb se cíli vejde do
 * tokenu. Nic nezapisuje.
 *
 * ⚠️ Počítá NAPŘÍČ FIRMAMI — strop je společný pro celý Firebase projekt, takže
 * per-firma počítání by šlo obejít pozvánkami z různých firem. To je zároveň
 * jediné, co odpověď prozrazuje: počet staveb cíle v tomhle backendu. Volat ji
 * proto smí jen ten, kdo do daného workspace sám patří, a jen na někoho, kdo
 * k tomu workspace má vztah — tedy o lidech, které v adresáři firmy stejně vidí.
 */
async function probeProjectCapacity(context: {
  caller: string;
  target: string;
  workspaceId: string;
  isSelf: boolean;
  request: { data?: { projectId?: string } };
}): Promise<{ probe: true; projects: number; slotsLeft: number | null; reserve: number }> {
  const { caller, target, workspaceId, isSelf, request } = context;
  if (!workspaceId) {
    throw new HttpsError("invalid-argument", "Chybí wid.");
  }

  const db = getFirestore(getLocalApp());

  if (!isSelf) {
    const callerMembership = await computeMembershipClaims(db, caller);
    if (!belongsToWorkspace(callerMembership, workspaceId)) {
      throw new HttpsError(
        "permission-denied",
        "Kapacitu přístupů smí zjišťovat jen člen téhle firmy."
      );
    }
  }

  const membership = await computeMembershipClaims(db, target);
  if (!isSelf) {
    const associated = belongsToWorkspace(membership, workspaceId)
      || (await db.doc(`workspaces/${workspaceId}/members/${target}`).get()).exists;
    if (!associated) {
      throw new HttpsError("permission-denied", "Uživatel k tomuto workspace nepatří.");
    }
  }

  // Vzorek `pid` určuje délku položky, a tím i strop — proto se bere skutečné
  // id stavby, do které se zve. Bez něj model odhadne dnešní tvar (`proj-` +
  // 13 číslic), ať se zarážka nerozpadne, jen zhrubne.
  const projectId = typeof request.data?.projectId === "string" && request.data.projectId
    ? request.data.projectId
    : "proj-0000000000000";

  return {
    probe: true,
    projects: countProjectGrants(membership),
    slotsLeft: projectSlotsLeft(membership, { workspaceId, projectId }),
    reserve: PROJECT_SLOT_RESERVE,
  };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Serverové miniatury — `generatePhotoThumbnail`, `generateDocumentThumbnail`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Rozhodování a kódování je ve SDÍLENÉM `thumbnails.ts` (tam je i odůvodnění,
 * proč vlastní funkce a ne rozšíření `storage-resize-images`, a proč Firestore
 * trigger a ne `onObjectFinalized`). Tady zůstává jen napojení na Firestore.
 *
 * ⚠️ REGION SE ZÁMĚRNĚ NEURČUJE — stejný důvod jako u
 * `promoteApprovedDrawingToPlan`: Eventarc trigger musí ležet v lokaci databáze
 * a firebase-tools si ji zjistí sám. Natvrdo psaný region by se v projektu
 * s jinak umístěnou databází s triggerem rozešel — a tenhle soubor má
 * protějšek v companionu, který se nasazuje do ZÁKAZNICKÝCH projektů.
 *
 * ⚠️ ŽÁDNÝ `retry: true`. Failure policy jde nasadit jen s `--force`, které
 * v self-host setupu padnout nesmí (odklepl by smazání funkcí, které v klonu
 * nejsou — viz `promoteApprovedDrawingToPlan`). Co se nepovede, dožene
 * `scripts/backfill-thumbnails.mjs`; navíc po sobě selhání nechá marker.
 *
 * `memory` je zvednutá schválně: dekódovat fotku z mobilu do bitmapy stojí
 * násobek velikosti souboru a ve výchozích 256 MiB by to padalo právě na těch
 * největších snímcích — tedy tam, kde na miniatuře záleží nejvíc.
 */
const THUMBNAIL_RUNTIME = { memory: "512MiB", timeoutSeconds: 120 } as const;

/**
 * `sharp` se načítá až uvnitř běhu (`await import`), ne staticky.
 *
 * Je to nativní modul o desítkách MB a načtení stojí čas při STUDENÉM STARTU.
 * Statický import v `index.ts` by ho natáhl do KAŽDÉ funkce v tomhle souboru —
 * tedy i do `authExchange`, který je na cestě přihlášení a jehož latenci
 * uživatel vidí. Takhle ho zaplatí jen ty dvě funkce, které ho opravdu potřebují.
 */
async function createThumbnailDeps(): Promise<ThumbnailDeps> {
  const { default: sharp } = await import("sharp");
  const storage = getStorage(getLocalApp());

  return {
    encoder: {
      async toWebp(input, width, quality) {
        return sharp(input)
          // `withoutEnlargement` — malý originál se nenafukuje na 320 px.
          // Zvětšená miniatura by byla větší než předloha a přitom rozmazaná.
          .rotate() // respektuj EXIF orientaci, ať náhled neleží na boku
          .resize({ width, withoutEnlargement: true })
          .webp({ quality })
          .toBuffer();
      },
    },
    storage: {
      async download({ bucket, objectPath }) {
        const [buffer] = await storage.bucket(bucket).file(objectPath).download();
        return buffer;
      },
      async upload({ bucket, objectPath }, body, meta) {
        await storage.bucket(bucket).file(objectPath).save(body, {
          contentType: meta.contentType,
          metadata: {
            cacheControl: meta.cacheControl,
            // Bez tohohle pole nejde objekt přečíst přes download URL — admin
            // SDK ho na rozdíl od klientského `uploadBytes` sám nepřidá.
            metadata: { firebaseStorageDownloadTokens: meta.downloadToken },
          },
        });
      },
    },
  };
}

/**
 * Společné tělo obou triggerů: rozhodni, vyrob, zapiš `thumbnailUrl` zpět.
 *
 * Zápis je `merge: true` a týká se JEN `thumbnailUrl` (+ velikosti) — trigger
 * běží souběžně s uživatelem, který může tentýž dokument zrovna editovat.
 */
async function runThumbnailTrigger(
  kind: ThumbnailKind,
  documentPath: string,
  record: ThumbnailSourceRecord,
  context: Record<string, string>
): Promise<void> {
  const firestore = getFirestore(getLocalApp());
  const defaultBucket = getStorage(getLocalApp()).bucket().name;
  const decision = decideThumbnail(kind, record, defaultBucket);

  if (decision.action === "skip") {
    // `already-present` je normální stav (klient svou práci stihl), ne událost.
    if (decision.reason === "already-present") {
      return;
    }
    logger.warn(`${kind}: miniatura se nevyrobí (${decision.reason})`, { ...context, decision });
    const marker = thumbnailFailureMarker(
      decision.reason,
      String(record.contentType ?? "neznámý typ"),
      new Date().toISOString()
    );
    if (marker) {
      await firestore.doc(documentPath).set(marker, { merge: true }).catch(() => undefined);
    }
    return;
  }

  try {
    const result = await generateThumbnail(await createThumbnailDeps(), decision);
    await firestore.doc(documentPath).set(
      {
        thumbnailUrl: result.thumbnailUrl,
        thumbnailSizeBytes: result.bytes,
        // Úspěch marker po sobě uklidí — jinak by po opakovaném běhu zůstala
        // viset stopa po chybě, která už neplatí.
        thumbnailGeneration: FieldValue.delete(),
      },
      { merge: true }
    );
    logger.info(`${kind}: miniatura vyrobena serverově`, {
      ...context,
      bytes: result.bytes,
      objectPath: decision.plan.target.objectPath,
    });
  } catch (error) {
    logger.error(`${kind}: výroba miniatury selhala`, { ...context, error });
    const marker = thumbnailFailureMarker(
      "error",
      error instanceof Error ? error.message : String(error),
      new Date().toISOString()
    );
    if (marker) {
      await firestore.doc(documentPath).set(marker, { merge: true }).catch(() => undefined);
    }
    // Nevyhazuj dál: bez `retry` by to stejně nikdo neopakoval a marker
    // v datech nese víc informace než červený řádek v logu.
  }
}

export const generatePhotoThumbnail = onDocumentCreated(
  {
    document: "workspaces/{workspaceId}/projects/{projectId}/photos/{photoId}",
    ...THUMBNAIL_RUNTIME,
  },
  async (event) => {
    const data = event.data?.data();
    if (!data) {
      return;
    }
    const { workspaceId, projectId, photoId } = event.params;
    await runThumbnailTrigger(
      "photo",
      `workspaces/${workspaceId}/projects/${projectId}/photos/${photoId}`,
      {
        sourceUrl: data.url,
        sourceObjectPath: data.storagePath,
        thumbnailUrl: data.thumbnailUrl,
        contentType: data.contentType,
      },
      { workspaceId, projectId, photoId }
    );
  }
);

export const generateDocumentThumbnail = onDocumentCreated(
  {
    document:
      "workspaces/{workspaceId}/projects/{projectId}/documentVersions/{versionId}",
    ...THUMBNAIL_RUNTIME,
  },
  async (event) => {
    const data = event.data?.data();
    if (!data) {
      return;
    }
    const { workspaceId, projectId, versionId } = event.params;
    await runThumbnailTrigger(
      "documentVersion",
      `workspaces/${workspaceId}/projects/${projectId}/documentVersions/${versionId}`,
      {
        sourceUrl: data.filePath,
        sourceObjectPath: data.fileId,
        thumbnailUrl: data.thumbnailUrl,
        contentType: data.contentType,
      },
      { workspaceId, projectId, versionId }
    );
  }
);
