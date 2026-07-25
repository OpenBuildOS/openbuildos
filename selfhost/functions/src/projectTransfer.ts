import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { get as httpsGet } from "node:https";
import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import archiver from "archiver";
import { getApp, getApps, initializeApp } from "firebase-admin/app";
import {
  DocumentReference,
  GeoPoint,
  Timestamp,
  getFirestore,
  type DocumentData,
} from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import unzipper from "unzipper";

const REGION = "europe-west1";
const BACKUP_VERSION = 1;
const BACKUP_PREFIX = "openbuildos-backups";
const IMPORT_PREFIX = "openbuildos-imports";
const MAX_BACKUP_BYTES = 750 * 1024 * 1024;
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const MAX_DOCUMENTS = 100_000;
const MAX_FILES = 20_000;
// Strop na ROZBALENOU velikost položek v ZIPu (obrana proti zip-bombě před
// `buffer()` do paměti). manifest.json nese serializovaný Firestore → velkorysý.
const MAX_MANIFEST_BYTES = 256 * 1024 * 1024;

function assertEntryNotBomb(entry: { uncompressedSize?: number; path?: string }, cap: number): void {
  if (typeof entry.uncompressedSize === "number" && entry.uncompressedSize > cap) {
    throw new HttpsError("resource-exhausted", `Položka zálohy ${entry.path ?? ""} je po rozbalení příliš velká.`);
  }
}

type Encoded = null | boolean | number | string | Encoded[] | { [key: string]: Encoded };

interface BackupDocument {
  path: string;
  data: Encoded;
}

interface BackupFile {
  entry: string;
  sourcePath: string;
  size: number;
  sha256: string;
  contentType?: string;
  downloadToken?: string;
}

interface BackupManifest {
  format: "openbuildos-project-backup";
  version: number;
  createdAt: string;
  sourceWorkspaceId: string;
  sourceProjectId: string;
  sourceBucket: string;
  documents: BackupDocument[];
  files: BackupFile[];
}

function requireResourceId(value: string, label: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new HttpsError("invalid-argument", `${label} má neplatný formát.`);
  }
  return value;
}

/**
 * Principal (OIDC subject) se používá jako segment ve Storage cestách. Subjekty
 * jsou neprůhledné — odmítni `/`, `..`, `\` a prázdno, ať nemůže uniknout mimo
 * svůj adresář (bez omezení znakové sady jako u requireResourceId).
 */
function assertSafePrincipalSegment(who: string): string {
  if (!who || who.includes("/") || who.includes("\\") || who.includes("..")) {
    throw new HttpsError("invalid-argument", "Neplatný identifikátor uživatele.");
  }
  return who;
}

/**
 * Povolený rozsah cest dokumentů v záloze (v ZDROJOVÝCH souřadnicích). Import je
 * nedůvěryhodný vstup (záloha od jiné instance) — bez tohoto allowlistu by
 * vyrobená záloha mohla zapsat kamkoli (sourozenecký projekt, workspace doc,
 * pozvánky = převzetí workspace). Povoleno: oba stromy projektu + PLOCHÉ
 * `workspaces/{sw}/companies/{id}` (firemní adresář). Nic jiného.
 */
export function isTransferableDocumentPath(path: string, sourceWorkspaceId: string, sourceProjectId: string): boolean {
  if (typeof path !== "string" || path.length === 0) return false;
  // Odmítni traversal jen jako celý SEGMENT (`.`/`..`), ne jako substring —
  // legitimní doc ID smí obsahovat `..` (např. `plan..v2`).
  if (path.split("/").some((segment) => segment === "." || segment === "..")) return false;
  const topRoot = `projects/${sourceProjectId}`;
  if (path === topRoot || path.startsWith(`${topRoot}/`)) return true;
  const wsProject = `workspaces/${sourceWorkspaceId}/projects/${sourceProjectId}`;
  if (path === wsProject || path.startsWith(`${wsProject}/`)) return true;
  const companiesPrefix = `workspaces/${sourceWorkspaceId}/companies/`;
  if (path.startsWith(companiesPrefix)) {
    const rest = path.slice(companiesPrefix.length);
    return rest.length > 0 && !rest.includes("/");
  }
  return false;
}

export function validateManifest(manifest: BackupManifest): void {
  if (
    manifest.format !== "openbuildos-project-backup" ||
    manifest.version !== BACKUP_VERSION ||
    !manifest.sourceWorkspaceId ||
    !manifest.sourceProjectId ||
    !manifest.sourceBucket ||
    !Array.isArray(manifest.documents) ||
    !Array.isArray(manifest.files)
  ) {
    throw new HttpsError("invalid-argument", "Neplatný manifest OpenBuildOS zálohy.");
  }
  requireResourceId(manifest.sourceWorkspaceId, "sourceWorkspaceId");
  requireResourceId(manifest.sourceProjectId, "sourceProjectId");
  if (manifest.documents.length > MAX_DOCUMENTS || manifest.files.length > MAX_FILES) {
    throw new HttpsError("resource-exhausted", "Záloha překračuje podporovaný počet záznamů nebo souborů.");
  }
  for (const document of manifest.documents) {
    if (!isTransferableDocumentPath(document?.path, manifest.sourceWorkspaceId, manifest.sourceProjectId)) {
      throw new HttpsError("invalid-argument", `Záloha obsahuje nepovolenou cestu dokumentu: ${String(document?.path)}.`);
    }
  }
  const prefix = `workspaces/${manifest.sourceWorkspaceId}/projects/${manifest.sourceProjectId}/`;
  let total = 0;
  for (const file of manifest.files) {
    const relative = file.sourcePath.startsWith(prefix) ? file.sourcePath.slice(prefix.length) : "";
    if (
      !relative ||
      relative.split("/").includes("..") ||
      file.entry !== `storage/${relative}` ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > MAX_FILE_BYTES ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    ) {
      throw new HttpsError("invalid-argument", `Neplatná položka souboru ${file.entry || file.sourcePath}.`);
    }
    total += file.size;
  }
  if (total > MAX_BACKUP_BYTES) {
    throw new HttpsError("resource-exhausted", "Projekt je větší než současný limit zálohy 750 MB.");
  }
}

export function validateBackupSourceUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpsError("invalid-argument", "Zdrojová URL zálohy není platná.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "storage.googleapis.com" ||
    !url.searchParams.has("X-Goog-Signature")
  ) {
    throw new HttpsError("invalid-argument", "Povolená je pouze podepsaná Google Storage URL zálohy.");
  }
  return url;
}

async function downloadBackupUrl(value: string, destination: string): Promise<void> {
  const url = validateBackupSourceUrl(value);
  await new Promise<void>((resolve, reject) => {
    const request = httpsGet(url, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new HttpsError("unavailable", `Stažení zdrojové zálohy selhalo (${response.statusCode ?? 0}).`));
        return;
      }
      const declaredSize = Number(response.headers["content-length"] ?? 0);
      if (declaredSize > MAX_BACKUP_BYTES) {
        response.resume();
        reject(new HttpsError("resource-exhausted", "Zdrojová záloha překračuje limit 750 MB."));
        return;
      }
      let received = 0;
      const output = createWriteStream(destination);
      response.on("data", (chunk: Buffer) => {
        received += chunk.byteLength;
        if (received > MAX_BACKUP_BYTES) request.destroy(new Error("Backup size limit exceeded"));
      });
      response.on("error", reject);
      output.on("error", reject);
      output.on("finish", resolve);
      response.pipe(output);
    });
    request.on("error", reject);
  });
}

function app() {
  return getApps().some((candidate) => candidate.name === "[DEFAULT]") ? getApp() : initializeApp();
}

function principal(auth: { uid: string; token: Record<string, unknown> }): string {
  const firebase = auth.token.firebase as { identities?: Record<string, unknown> } | undefined;
  const identities = firebase?.identities?.["oidc.openbuildos"];
  return Array.isArray(identities) && typeof identities[0] === "string" ? identities[0] : auth.uid;
}

async function requireWorkspaceAdmin(workspaceId: string, who: string): Promise<void> {
  const snapshot = await getFirestore(app()).doc(`workspaces/${workspaceId}`).get();
  const data = snapshot.data() as { ownerId?: string; adminIds?: string[] } | undefined;
  if (!snapshot.exists || (data?.ownerId !== who && !data?.adminIds?.includes(who))) {
    throw new HttpsError("permission-denied", "Operaci smí provést pouze vlastník nebo správce workspace.");
  }
}

async function requireProjectInWorkspace(workspaceId: string, projectId: string): Promise<DocumentData> {
  const snapshot = await getFirestore(app()).doc(`projects/${projectId}`).get();
  const data = snapshot.data();
  if (!snapshot.exists || data?.workspaceId !== workspaceId) {
    throw new HttpsError("not-found", "Projekt neexistuje v tomto workspace.");
  }
  return data;
}

function encode(value: unknown): Encoded {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }
  if (value instanceof Timestamp) return { __type: "timestamp", seconds: value.seconds, nanoseconds: value.nanoseconds };
  if (value instanceof GeoPoint) return { __type: "geopoint", latitude: value.latitude, longitude: value.longitude };
  if (value instanceof DocumentReference) return { __type: "reference", path: value.path };
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { __type: "bytes", base64: Buffer.from(value).toString("base64") };
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
  }
  throw new HttpsError("failed-precondition", `Záloha obsahuje nepodporovanou hodnotu typu ${typeof value}.`);
}

function decode(value: Encoded, remapReference: (path: string) => string): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => decode(item, remapReference));
  if (value.__type === "timestamp") return new Timestamp(Number(value.seconds), Number(value.nanoseconds));
  if (value.__type === "geopoint") return new GeoPoint(Number(value.latitude), Number(value.longitude));
  if (value.__type === "reference") return getFirestore(app()).doc(remapReference(String(value.path)));
  if (value.__type === "bytes") return Buffer.from(String(value.base64), "base64");
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item, remapReference)]));
}

// Pole, která smějí platit jen ve ZDROJOVÉM projektu a do cíle nepatří:
// ověřovací URL zapéká zdrojový apiKey (`k=`) a QR overlay artefakty se v cíli
// musí přegenerovat (viz S2-phase2-codex-audit.md). Strhneme je při importu.
const STRIP_ON_IMPORT = new Set([
  "verificationTargetUrl",
  "verificationShareToken",
  "qrOverlayStatus",
  "qrOverlayAt",
  "qrOverlayError",
  "qrOverlayFilePath",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Timestamp) &&
    !(value instanceof GeoPoint) &&
    !(value instanceof DocumentReference) &&
    !Buffer.isBuffer(value) &&
    !(value instanceof Uint8Array)
  );
}

/**
 * Doladí dekódovaná data pro cílový backend: (1) přepíše skalární pole
 * `workspaceId`/`projectId` (která nejsou součástí cesty, takže je rewriteStrings
 * mine) ze zdrojové na cílovou identitu, (2) strhne pole vázaná na zdrojový
 * backend (STRIP_ON_IMPORT). Neškodí u typů Timestamp/GeoPoint/Reference/Bytes.
 */
export function sanitizeImportedData(
  value: unknown,
  sourceWorkspaceId: string,
  targetWorkspaceId: string,
  sourceProjectId: string,
  targetProjectId: string,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) =>
      sanitizeImportedData(item, sourceWorkspaceId, targetWorkspaceId, sourceProjectId, targetProjectId),
    );
  }
  if (!isPlainObject(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (STRIP_ON_IMPORT.has(key)) continue;
    if (key === "workspaceId" && item === sourceWorkspaceId) {
      result[key] = targetWorkspaceId;
    } else if (key === "projectId" && item === sourceProjectId) {
      result[key] = targetProjectId;
    } else {
      result[key] = sanitizeImportedData(item, sourceWorkspaceId, targetWorkspaceId, sourceProjectId, targetProjectId);
    }
  }
  return result;
}

/**
 * Posbírá ID firem referencovaná projektem (ownerCompanyId / companyId napříč
 * dokumenty + hodnoty mapy `projects/{pid}.companies` = principal→companyId), aby
 * se přenesl JEN relevantní výřez firemního adresáře, ne celý workspace.
 */
export function collectReferencedCompanyIds(documents: BackupDocument[]): Set<string> {
  const ids = new Set<string>();
  const walk = (value: Encoded): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if ((key === "ownerCompanyId" || key === "companyId") && typeof item === "string" && item) {
        ids.add(item);
      } else if (key === "companies" && item && typeof item === "object" && !Array.isArray(item)) {
        for (const companyId of Object.values(item)) {
          if (typeof companyId === "string" && companyId) ids.add(companyId);
        }
      } else {
        walk(item as Encoded);
      }
    }
  };
  for (const doc of documents) walk(doc.data);
  return ids;
}

async function collectTree(path: string, output: BackupDocument[]): Promise<void> {
  const reference = getFirestore(app()).doc(path);
  const snapshot = await reference.get();
  if (snapshot.exists) output.push({ path, data: encode(snapshot.data() as DocumentData) });
  for (const child of await reference.listCollections()) {
    // listDocuments() vrací i „phantom" parent dokumenty (existují jen jako
    // rodič subkolekce, .get() je nevrací) — jinak by jejich podstrom tiše zmizel.
    for (const childRef of await child.listDocuments()) await collectTree(childRef.path, output);
  }
}

type StorageFile = ReturnType<ReturnType<ReturnType<typeof getStorage>["bucket"]>["file"]>;

async function hashFile(file: StorageFile): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => file.createReadStream().on("data", (chunk) => hash.update(chunk)).on("error", reject).on("end", resolve));
  return hash.digest("hex");
}

async function buildManifest(workspaceId: string, projectId: string): Promise<BackupManifest> {
  const collected: BackupDocument[] = [];
  await collectTree(`projects/${projectId}`, collected);
  await collectTree(`workspaces/${workspaceId}/projects/${projectId}`, collected);
  if (!collected.some((item) => item.path === `projects/${projectId}`)) throw new HttpsError("not-found", "Projekt neexistuje.");

  // Vyloučit přechodnou frontu notifikací — regeneruje se z událostí, kopie by
  // přeposlala staré notifikace / mířila na neexistující příjemce.
  const documents = collected.filter((item) => !item.path.includes("/notificationQueue/"));

  // Přenést JEN referencovaný výřez firemního adresáře (jinak ownerCompanyId
  // v cíli osiří). Zachovává doc IDs, import zapisuje s merge.
  const db = getFirestore(app());
  for (const companyId of collectReferencedCompanyIds(documents)) {
    const companyPath = `workspaces/${workspaceId}/companies/${companyId}`;
    const snapshot = await db.doc(companyPath).get();
    if (snapshot.exists) documents.push({ path: companyPath, data: encode(snapshot.data() as DocumentData) });
  }

  const bucket = getStorage(app()).bucket();
  const prefix = `workspaces/${workspaceId}/projects/${projectId}/`;
  const [objects] = await bucket.getFiles({ prefix });
  const files: BackupFile[] = [];
  for (const object of objects) {
    // QR-`verified/` PDF má do natištěného QR zapečený zdrojový apiKey →
    // nepřenášet (v cíli se přegeneruje po schválení). Miniatury jsou neškodné.
    if (object.name.includes("/verified/")) continue;
    const [metadata] = await object.getMetadata();
    files.push({
      entry: `storage/${object.name.slice(prefix.length)}`,
      sourcePath: object.name,
      size: Number(metadata.size ?? 0),
      sha256: await hashFile(object),
      ...(metadata.contentType ? { contentType: metadata.contentType } : {}),
      ...(metadata.metadata?.firebaseStorageDownloadTokens
        ? { downloadToken: String(metadata.metadata.firebaseStorageDownloadTokens).split(",")[0] }
        : {}),
    });
  }
  const manifest: BackupManifest = { format: "openbuildos-project-backup", version: BACKUP_VERSION, createdAt: new Date().toISOString(), sourceWorkspaceId: workspaceId, sourceProjectId: projectId, sourceBucket: bucket.name, documents, files };
  validateManifest(manifest);
  return manifest;
}

async function createArchive(manifest: BackupManifest, destination: string): Promise<void> {
  const output = createWriteStream(destination);
  const archive = archiver("zip", { zlib: { level: 6 } });
  const done = new Promise<void>((resolve, reject) => {
    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);
  });
  archive.pipe(output);
  archive.append(JSON.stringify(manifest), { name: "manifest.json" });
  const bucket = getStorage(app()).bucket();
  for (const item of manifest.files) archive.append(bucket.file(item.sourcePath).createReadStream(), { name: item.entry });
  await archive.finalize();
  await done;
}

export const exportProjectBackup = onCall<{ workspaceId?: string; projectId?: string }>(
  { region: REGION, timeoutSeconds: 3600, memory: "2GiB" },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Chybí přihlášení.");
    const workspaceId = requireResourceId(request.data.workspaceId?.trim() ?? "", "workspaceId");
    const projectId = requireResourceId(request.data.projectId?.trim() ?? "", "projectId");
    if (!workspaceId || !projectId) throw new HttpsError("invalid-argument", "Chybí workspaceId nebo projectId.");
    const who = assertSafePrincipalSegment(principal(request.auth));
    await requireWorkspaceAdmin(workspaceId, who);
    await requireProjectInWorkspace(workspaceId, projectId);
    const manifest = await buildManifest(workspaceId, projectId);
    const localPath = join("/tmp", `${projectId}-${randomUUID()}.obosbackup`);
    try {
      await createArchive(manifest, localPath);
      const objectPath = `${BACKUP_PREFIX}/${who}/${basename(localPath)}`;
      const bucket = getStorage(app()).bucket();
      await bucket.upload(localPath, { destination: objectPath, metadata: { contentType: "application/zip", metadata: { projectId, workspaceId } } });
      const [url] = await bucket.file(objectPath).getSignedUrl({ action: "read", expires: Date.now() + 60 * 60 * 1000 });
      logger.info("Project backup created", { workspaceId, projectId, documents: manifest.documents.length, files: manifest.files.length, who });
      return { url, objectPath, expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), documentCount: manifest.documents.length, fileCount: manifest.files.length };
    } finally {
      await rm(localPath, { force: true });
    }
  }
);

export const prepareProjectBackupImport = onCall<{ workspaceId?: string; fileName?: string }>(
  { region: REGION },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Chybí přihlášení.");
    const workspaceId = requireResourceId(request.data.workspaceId?.trim() ?? "", "workspaceId");
    const who = assertSafePrincipalSegment(principal(request.auth));
    await requireWorkspaceAdmin(workspaceId, who);
    const safeName = (request.data.fileName || "project.obosbackup").replace(/[^a-zA-Z0-9._-]/g, "-");
    const objectPath = `workspaces/${workspaceId}/${IMPORT_PREFIX}/${who}/${randomUUID()}-${safeName}`;
    const expiresAt = Date.now() + 15 * 60 * 1000;
    const [uploadUrl] = await getStorage(app()).bucket().file(objectPath).getSignedUrl({
      version: "v4",
      action: "write",
      expires: expiresAt,
      contentType: "application/zip",
    });
    return { objectPath, uploadUrl, expiresAt: new Date(expiresAt).toISOString() };
  }
);

export function remapPath(path: string, manifest: BackupManifest, workspaceId: string, projectId: string): string {
  const sw = manifest.sourceWorkspaceId;
  const sp = manifest.sourceProjectId;
  // Top-level `projects/{pid}` strom (metadata + task_audit).
  const topRoot = `projects/${sp}`;
  if (path === topRoot || path.startsWith(`${topRoot}/`)) {
    return `projects/${projectId}${path.slice(topRoot.length)}`;
  }
  // Obsah pod `workspaces/{wid}/projects/{pid}/…`.
  const wsProject = `workspaces/${sw}/projects/${sp}`;
  if (path === wsProject || path.startsWith(`${wsProject}/`)) {
    return `workspaces/${workspaceId}/projects/${projectId}${path.slice(wsProject.length)}`;
  }
  // Workspace-level sourozenci — POUZE firemní adresář `workspaces/{wid}/companies/…`.
  const companiesRoot = `workspaces/${sw}/companies/`;
  if (path.startsWith(companiesRoot)) {
    return `workspaces/${workspaceId}/companies/${path.slice(companiesRoot.length)}`;
  }
  // Cokoli mimo povolený rozsah = poškozený/nepřátelský manifest (obrana do
  // hloubky; validateManifest to už odmítl dřív).
  throw new HttpsError("invalid-argument", `Nepovolená cesta v záloze: ${path}.`);
}

export function rewriteStrings(value: unknown, manifest: BackupManifest, workspaceId: string, projectId: string, targetBucket: string): unknown {
  if (typeof value === "string") {
    const oldPrefix = `workspaces/${manifest.sourceWorkspaceId}/projects/${manifest.sourceProjectId}`;
    const newPrefix = `workspaces/${workspaceId}/projects/${projectId}`;
    return value
      .split(oldPrefix).join(newPrefix)
      .split(encodeURIComponent(oldPrefix)).join(encodeURIComponent(newPrefix))
      .split(manifest.sourceBucket).join(targetBucket);
  }
  if (Array.isArray(value)) return value.map((item) => rewriteStrings(item, manifest, workspaceId, projectId, targetBucket));
  if (value && typeof value === "object" && !(value instanceof Timestamp) && !(value instanceof GeoPoint) && !(value instanceof DocumentReference) && !Buffer.isBuffer(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteStrings(item, manifest, workspaceId, projectId, targetBucket)]));
  }
  return value;
}

async function commitDocuments(manifest: BackupManifest, workspaceId: string, projectId: string, who: string, importOperationId: string): Promise<void> {
  const db = getFirestore(app());
  const targetBucket = getStorage(app()).bucket().name;
  const sw = manifest.sourceWorkspaceId;
  const sp = manifest.sourceProjectId;
  const remap = (path: string) => remapPath(path, manifest, workspaceId, projectId);
  // shareLinks = bearer tokeny (nekopírovat); notificationQueue = přechodná fronta.
  const drop = (path: string) => path.includes("/shareLinks/") || path.includes("/notificationQueue/");
  const transform = (data: Encoded): DocumentData =>
    sanitizeImportedData(
      rewriteStrings(decode(data, remap), manifest, workspaceId, projectId, targetBucket),
      sw,
      workspaceId,
      sp,
      projectId,
    ) as DocumentData;

  const byPath = new Map<string, DocumentData>();
  for (const item of manifest.documents) {
    if (drop(item.path)) continue;
    byPath.set(remap(item.path), transform(item.data));
  }

  const rootPath = `projects/${projectId}`;
  const root = byPath.get(rootPath);
  if (!root) throw new HttpsError("invalid-argument", "Záloha neobsahuje kořenový projekt.");
  // Scénář A: zachovat plné členství + role + companies mapu ze zdroje, importéra
  // jen PŘIDAT jako vlastníka (union), ne přepsat. Federované principaly jsou
  // napříč backendy stabilní (viz S2-phase1b-identity-scenarios.md).
  const sourceMemberIds = Array.isArray(root.memberIds)
    ? (root.memberIds as unknown[]).filter((id): id is string => typeof id === "string")
    : [];
  const sourceRoles = isPlainObject(root.roles) ? (root.roles as Record<string, unknown>) : {};
  byPath.set(rootPath, {
    ...root,
    workspaceId,
    memberIds: Array.from(new Set([...sourceMemberIds, who])),
    roles: { ...sourceRoles, [who]: "admin" },
    archived: false,
    restoredAt: new Date().toISOString(),
    importOperationId,
  });

  // Importér musí být admin i v projektové members/ subkolekci — přepíše roli
  // u případného zděděného záznamu se stejným principálem.
  const memberPath = `workspaces/${workspaceId}/projects/${projectId}/members/${who}`;
  const existingMember = isPlainObject(byPath.get(memberPath)) ? (byPath.get(memberPath) as Record<string, unknown>) : {};
  byPath.set(memberPath, {
    displayName: "Nový vlastník",
    joinedAt: new Date().toISOString(),
    ...existingMember,
    role: "admin",
  });

  const entries = Array.from(byPath.entries());
  for (let offset = 0; offset < entries.length; offset += 400) {
    const batch = db.batch();
    for (const [path, data] of entries.slice(offset, offset + 400)) {
      // Firemní adresář zapisovat s merge (nepřepsat existující firmu v cíli se
      // stejným ID); zbytek je čistý přenos se zachovanými doc IDs.
      if (/^workspaces\/[^/]+\/companies\/[^/]+$/.test(path)) batch.set(db.doc(path), data, { merge: true });
      else batch.set(db.doc(path), data);
    }
    await batch.commit();
  }
}

async function restoreFiles(directory: unzipper.CentralDirectory, manifest: BackupManifest, workspaceId: string, projectId: string): Promise<void> {
  const bucket = getStorage(app()).bucket();
  const byEntry = new Map(directory.files.map((entry) => [entry.path, entry]));
  for (const item of manifest.files) {
    const entry = byEntry.get(item.entry);
    if (!entry) throw new HttpsError("invalid-argument", `V záloze chybí ${item.entry}.`);
    assertEntryNotBomb(entry, MAX_FILE_BYTES);
    const content = await entry.buffer();
    if (content.byteLength !== item.size || createHash("sha256").update(content).digest("hex") !== item.sha256) throw new HttpsError("data-loss", `Velikost nebo kontrolní součet nesedí pro ${item.entry}.`);
    const relative = item.sourcePath.split(`/projects/${manifest.sourceProjectId}/`)[1];
    if (!relative) throw new HttpsError("invalid-argument", `Neplatná cesta souboru ${item.sourcePath}.`);
    await bucket.file(`workspaces/${workspaceId}/projects/${projectId}/${relative}`).save(content, {
      contentType: item.contentType,
      metadata: { metadata: { firebaseStorageDownloadTokens: item.downloadToken || randomUUID() } },
    });
  }
}

export const importProjectBackup = onCall<{ workspaceId?: string; objectPath?: string; sourceUrl?: string; projectId?: string }>(
  { region: REGION, timeoutSeconds: 3600, memory: "2GiB" },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Chybí přihlášení.");
    const workspaceId = requireResourceId(request.data.workspaceId?.trim() ?? "", "workspaceId");
    const objectPath = request.data.objectPath?.trim() ?? "";
    const sourceUrl = request.data.sourceUrl?.trim() ?? "";
    const who = assertSafePrincipalSegment(principal(request.auth));
    const validObjectPath = objectPath.startsWith(`workspaces/${workspaceId}/${IMPORT_PREFIX}/${who}/`);
    if (validObjectPath === Boolean(sourceUrl)) {
      throw new HttpsError("invalid-argument", "Zadejte právě jeden zdroj importu.");
    }
    if (sourceUrl) validateBackupSourceUrl(sourceUrl);
    await requireWorkspaceAdmin(workspaceId, who);
    const localPath = join("/tmp", `${randomUUID()}.obosbackup`);
    const bucket = getStorage(app()).bucket();
    const importOperationId = randomUUID();
    // Cílové projectId defaultně = zdrojové (dva oddělené Firestore, kolize
    // nehrozí) — zachová konzistenci skalárních `projectId` polí napříč entitami.
    // Určí se až po načtení manifestu.
    let projectId = "";
    let reserved = false;
    try {
      if (sourceUrl) await downloadBackupUrl(sourceUrl, localPath);
      else await bucket.file(objectPath).download({ destination: localPath });
      const directory = await unzipper.Open.file(localPath);
      const manifestEntry = directory.files.find((entry) => entry.path === "manifest.json");
      if (!manifestEntry) throw new HttpsError("invalid-argument", "Soubor není OpenBuildOS záloha.");
      assertEntryNotBomb(manifestEntry, MAX_MANIFEST_BYTES);
      const manifest = JSON.parse((await manifestEntry.buffer()).toString("utf8")) as BackupManifest;
      validateManifest(manifest);
      projectId = requireResourceId(request.data.projectId?.trim() || manifest.sourceProjectId, "projectId");
      try {
        await getFirestore(app()).doc(`projects/${projectId}`).create({
          workspaceId,
          memberIds: [who],
          roles: { [who]: "admin" },
          name: "Probíhá obnova projektu",
          archived: true,
          importOperationId,
          createdAt: new Date().toISOString(),
        });
        reserved = true;
      } catch (error) {
        const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
        if (code === "6" || code === "already-exists") throw new HttpsError("already-exists", "Cílové ID projektu už existuje.");
        throw error;
      }
      await restoreFiles(directory, manifest, workspaceId, projectId);
      await commitDocuments(manifest, workspaceId, projectId, who, importOperationId);
      if (objectPath) await bucket.file(objectPath).delete({ ignoreNotFound: true });
      logger.info("Project backup restored", { workspaceId, projectId, sourceProjectId: manifest.sourceProjectId, who });
      return { projectId, documentCount: manifest.documents.length, fileCount: manifest.files.length };
    } catch (error) {
      if (reserved) {
        const reservation = await getFirestore(app()).doc(`projects/${projectId}`).get().catch(() => null);
        if (reservation?.data()?.importOperationId === importOperationId) {
          const [partialFiles] = await bucket.getFiles({ prefix: `workspaces/${workspaceId}/projects/${projectId}/` });
          await Promise.all(partialFiles.map((file) => file.delete({ ignoreNotFound: true })));
          await deleteTree(`workspaces/${workspaceId}/projects/${projectId}`);
          await deleteTree(`projects/${projectId}`);
        }
      }
      throw error;
    } finally {
      if (objectPath) await bucket.file(objectPath).delete({ ignoreNotFound: true }).catch(() => undefined);
      await rm(localPath, { force: true });
    }
  }
);

async function deleteTree(path: string): Promise<number> {
  const db = getFirestore(app());
  const reference = db.doc(path);
  let count = 0;
  for (const child of await reference.listCollections()) {
    for (const childDoc of (await child.get()).docs) count += await deleteTree(childDoc.ref.path);
  }
  if ((await reference.get()).exists) {
    await reference.delete();
    count += 1;
  }
  return count;
}

export const deleteProjectPermanently = onCall<{ workspaceId?: string; projectId?: string; confirmation?: string; backupObjectPath?: string }>(
  { region: REGION, timeoutSeconds: 3600, memory: "1GiB" },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Chybí přihlášení.");
    const workspaceId = requireResourceId(request.data.workspaceId?.trim() ?? "", "workspaceId");
    const projectId = requireResourceId(request.data.projectId?.trim() ?? "", "projectId");
    const who = assertSafePrincipalSegment(principal(request.auth));
    if (!workspaceId || !projectId || request.data.confirmation !== projectId) throw new HttpsError("invalid-argument", "Potvrzení neodpovídá ID projektu.");
    await requireWorkspaceAdmin(workspaceId, who);
    const projectData = await requireProjectInWorkspace(workspaceId, projectId);
    if (projectData.archived !== true) {
      throw new HttpsError("failed-precondition", "Před trvalým smazáním musí být projekt archivovaný.");
    }
    const bucket = getStorage(app()).bucket();
    const backupObjectPath = request.data.backupObjectPath?.trim() ?? "";
    if (!backupObjectPath.startsWith(`${BACKUP_PREFIX}/${who}/`)) throw new HttpsError("failed-precondition", "Před smazáním je povinná ověřená záloha projektu.");
    const backup = bucket.file(backupObjectPath);
    const [exists] = await backup.exists();
    if (!exists) throw new HttpsError("failed-precondition", "Požadovaná záloha neexistuje.");
    const [backupMetadata] = await backup.getMetadata();
    if (backupMetadata.metadata?.projectId !== projectId || backupMetadata.metadata?.workspaceId !== workspaceId) {
      throw new HttpsError("failed-precondition", "Záloha nepatří mazanému projektu.");
    }
    const [files] = await bucket.getFiles({ prefix: `workspaces/${workspaceId}/projects/${projectId}/` });
    await Promise.all(files.map((file) => file.delete({ ignoreNotFound: true })));
    const nestedDeleted = await deleteTree(`workspaces/${workspaceId}/projects/${projectId}`);
    const rootDeleted = await deleteTree(`projects/${projectId}`);
    logger.warn("Project permanently deleted", { workspaceId, projectId, who, files: files.length, documents: nestedDeleted + rootDeleted });
    return { deleted: true, fileCount: files.length, documentCount: nestedDeleted + rootDeleted };
  }
);
