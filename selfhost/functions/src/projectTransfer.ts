import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
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

async function collectTree(path: string, output: BackupDocument[]): Promise<void> {
  const reference = getFirestore(app()).doc(path);
  const snapshot = await reference.get();
  if (snapshot.exists) output.push({ path, data: encode(snapshot.data() as DocumentData) });
  for (const child of await reference.listCollections()) {
    for (const childDoc of (await child.get()).docs) await collectTree(childDoc.ref.path, output);
  }
}

type StorageFile = ReturnType<ReturnType<ReturnType<typeof getStorage>["bucket"]>["file"]>;

async function hashFile(file: StorageFile): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => file.createReadStream().on("data", (chunk) => hash.update(chunk)).on("error", reject).on("end", resolve));
  return hash.digest("hex");
}

async function buildManifest(workspaceId: string, projectId: string): Promise<BackupManifest> {
  const documents: BackupDocument[] = [];
  await collectTree(`projects/${projectId}`, documents);
  await collectTree(`workspaces/${workspaceId}/projects/${projectId}`, documents);
  if (!documents.some((item) => item.path === `projects/${projectId}`)) throw new HttpsError("not-found", "Projekt neexistuje.");

  const bucket = getStorage(app()).bucket();
  const prefix = `workspaces/${workspaceId}/projects/${projectId}/`;
  const [objects] = await bucket.getFiles({ prefix });
  const files: BackupFile[] = [];
  for (const object of objects) {
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
    const who = principal(request.auth);
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
    const who = principal(request.auth);
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
  if (path === `projects/${manifest.sourceProjectId}` || path.startsWith(`projects/${manifest.sourceProjectId}/`)) {
    return path.replace(`projects/${manifest.sourceProjectId}`, `projects/${projectId}`);
  }
  return path.replace(`workspaces/${manifest.sourceWorkspaceId}/projects/${manifest.sourceProjectId}`, `workspaces/${workspaceId}/projects/${projectId}`);
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
  const remap = (path: string) => remapPath(path, manifest, workspaceId, projectId);
  const sourceMembers = `/projects/${manifest.sourceProjectId}/members/`;
  const sourceShareLinks = `/projects/${manifest.sourceProjectId}/shareLinks/`;
  const documents = manifest.documents
    .filter((item) => !item.path.includes(sourceMembers) && !item.path.includes(sourceShareLinks))
    .map((item) => ({ path: remap(item.path), data: rewriteStrings(decode(item.data, remap), manifest, workspaceId, projectId, targetBucket) as DocumentData }));
  const root = documents.find((item) => item.path === `projects/${projectId}`);
  if (!root) throw new HttpsError("invalid-argument", "Záloha neobsahuje kořenový projekt.");
  root.data = { ...root.data, workspaceId, memberIds: [who], roles: { [who]: "admin" }, archived: false, restoredAt: new Date().toISOString(), importOperationId };
  const memberPath = `workspaces/${workspaceId}/projects/${projectId}/members/${who}`;
  documents.push({ path: memberPath, data: { role: "admin", displayName: "Nový vlastník", joinedAt: new Date().toISOString() } });

  for (let offset = 0; offset < documents.length; offset += 400) {
    const batch = db.batch();
    for (const item of documents.slice(offset, offset + 400)) batch.set(db.doc(item.path), item.data);
    await batch.commit();
  }
}

async function restoreFiles(directory: unzipper.CentralDirectory, manifest: BackupManifest, workspaceId: string, projectId: string): Promise<void> {
  const bucket = getStorage(app()).bucket();
  const byEntry = new Map(directory.files.map((entry) => [entry.path, entry]));
  for (const item of manifest.files) {
    const entry = byEntry.get(item.entry);
    if (!entry) throw new HttpsError("invalid-argument", `V záloze chybí ${item.entry}.`);
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

export const importProjectBackup = onCall<{ workspaceId?: string; objectPath?: string; projectId?: string }>(
  { region: REGION, timeoutSeconds: 3600, memory: "2GiB" },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Chybí přihlášení.");
    const workspaceId = requireResourceId(request.data.workspaceId?.trim() ?? "", "workspaceId");
    const objectPath = request.data.objectPath?.trim() ?? "";
    const projectId = requireResourceId(request.data.projectId?.trim() || `proj-${Date.now()}`, "projectId");
    const who = principal(request.auth);
    if (!workspaceId || !objectPath.startsWith(`workspaces/${workspaceId}/${IMPORT_PREFIX}/${who}/`)) throw new HttpsError("invalid-argument", "Neplatná cesta importu.");
    await requireWorkspaceAdmin(workspaceId, who);
    const localPath = join("/tmp", `${randomUUID()}.obosbackup`);
    const bucket = getStorage(app()).bucket();
    const importOperationId = randomUUID();
    const targetPrefix = `workspaces/${workspaceId}/projects/${projectId}/`;
    let reserved = false;
    try {
      await bucket.file(objectPath).download({ destination: localPath });
      const directory = await unzipper.Open.file(localPath);
      const manifestEntry = directory.files.find((entry) => entry.path === "manifest.json");
      if (!manifestEntry) throw new HttpsError("invalid-argument", "Soubor není OpenBuildOS záloha.");
      const manifest = JSON.parse((await manifestEntry.buffer()).toString("utf8")) as BackupManifest;
      validateManifest(manifest);
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
      await bucket.file(objectPath).delete({ ignoreNotFound: true });
      logger.info("Project backup restored", { workspaceId, projectId, sourceProjectId: manifest.sourceProjectId, who });
      return { projectId, documentCount: manifest.documents.length, fileCount: manifest.files.length };
    } catch (error) {
      if (reserved) {
        const reservation = await getFirestore(app()).doc(`projects/${projectId}`).get().catch(() => null);
        if (reservation?.data()?.importOperationId === importOperationId) {
          const [partialFiles] = await bucket.getFiles({ prefix: targetPrefix });
          await Promise.all(partialFiles.map((file) => file.delete({ ignoreNotFound: true })));
          await deleteTree(`workspaces/${workspaceId}/projects/${projectId}`);
          await deleteTree(`projects/${projectId}`);
        }
      }
      throw error;
    } finally {
      await bucket.file(objectPath).delete({ ignoreNotFound: true }).catch(() => undefined);
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
    const who = principal(request.auth);
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
