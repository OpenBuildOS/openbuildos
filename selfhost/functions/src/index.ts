import { randomUUID } from "node:crypto";
import { initializeApp, getApps, getApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { HttpsError, onCall, onRequest, type Request } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import type { Response } from "express";

// Odesílání pozvánek e-mailem (samostatný modul, viz sendProjectInvite.ts).
export { sendProjectInvite } from "./sendProjectInvite";

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

    const customToken = await getAuth(getLocalApp()).createCustomToken(uid, {
      email,
      name,
      src: "openbuildos",
    });

    logger.info("authExchange OK", { uid, hasEmail: Boolean(email) });
    res.status(200).json({ customToken });
  } catch (error) {
    logger.error("authExchange selhalo", error);
    res.status(401).json({ error: "Ověření centrálního tokenu selhalo." });
  }
});

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

async function canEditProjectContent(workspaceId: string, projectId: string, principal: string): Promise<boolean> {
  const db = getFirestore(getLocalApp());
  const [workspaceSnap, projectSnap] = await Promise.all([
    db.doc(`workspaces/${workspaceId}`).get(),
    db.doc(`projects/${projectId}`).get(),
  ]);

  if (!workspaceSnap.exists || !projectSnap.exists) {
    return false;
  }

  const workspace = workspaceSnap.data() as {
    ownerId?: string;
    adminIds?: string[];
  };
  const project = projectSnap.data() as {
    workspaceId?: string;
    roles?: Record<string, string>;
  };

  if (project.workspaceId !== workspaceId) {
    return false;
  }

  if (workspace.ownerId === principal || workspace.adminIds?.includes(principal)) {
    return true;
  }

  const role = project.roles?.[principal] ?? "";
  return role === "editor" || role === "admin";
}

function parseStorageObjectFromDownloadUrl(fileUrl: string): { bucket: string; objectPath: string } {
  const url = new URL(fileUrl);
  const firebaseApiMatch = url.pathname.match(/^\/v0\/b\/([^/]+)\/o\/(.+)$/);
  if (firebaseApiMatch) {
    return {
      bucket: decodeURIComponent(firebaseApiMatch[1]),
      objectPath: decodeURIComponent(firebaseApiMatch[2]),
    };
  }

  const directMatch = url.pathname.match(/^\/([^/]+)\/(.+)$/);
  if (url.hostname === "storage.googleapis.com" && directMatch) {
    return {
      bucket: decodeURIComponent(directMatch[1]),
      objectPath: decodeURIComponent(directMatch[2]),
    };
  }

  throw new HttpsError(
    "failed-precondition",
    "Sdílený soubor nemá podporovaný Firebase Storage download URL."
  );
}

async function rotateDownloadToken(fileUrl: string): Promise<void> {
  const { bucket, objectPath } = parseStorageObjectFromDownloadUrl(fileUrl);
  const file = getStorage(getLocalApp()).bucket(bucket).file(objectPath);
  const [metadata] = await file.getMetadata();
  await file.setMetadata({
    metadata: {
      ...(metadata.metadata ?? {}),
      firebaseStorageDownloadTokens: randomUUID(),
    },
  });
}

export const revokeShareLinkAndRotateToken = onCall<
  { wid?: string; pid?: string; token?: string }
>({ region: "europe-west1" }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Chybí přihlášení do workspace.");
  }

  const workspaceId = typeof request.data?.wid === "string" ? request.data.wid : "";
  const projectId = typeof request.data?.pid === "string" ? request.data.pid : "";
  const token = typeof request.data?.token === "string" ? request.data.token : "";
  if (!workspaceId || !projectId || !token) {
    throw new HttpsError("invalid-argument", "Chybí wid, pid nebo token.");
  }

  const principal = principalFromAuth(request.auth);
  if (!(await canEditProjectContent(workspaceId, projectId, principal))) {
    throw new HttpsError("permission-denied", "Nemáš oprávnění zneplatnit sdílecí odkaz.");
  }

  const db = getFirestore(getLocalApp());
  const shareRef = db.doc(`workspaces/${workspaceId}/projects/${projectId}/shareLinks/${token}`);
  const shareSnap = await shareRef.get();
  if (!shareSnap.exists) {
    throw new HttpsError("not-found", "Sdílecí odkaz neexistuje.");
  }

  const shareDoc = shareSnap.data() as { fileUrl?: string; revoked?: boolean };
  if (typeof shareDoc.fileUrl !== "string" || shareDoc.fileUrl.length === 0) {
    throw new HttpsError("failed-precondition", "Sdílecí odkaz neobsahuje URL souboru.");
  }

  await rotateDownloadToken(shareDoc.fileUrl);
  await shareRef.update({ revoked: true });

  logger.info("revokeShareLinkAndRotateToken OK", {
    workspaceId,
    projectId,
    token,
    principal,
    wasAlreadyRevoked: Boolean(shareDoc.revoked),
  });

  return { revoked: true, tokenRotated: true };
});
