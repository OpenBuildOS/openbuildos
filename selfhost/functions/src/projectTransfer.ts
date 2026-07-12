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
  return { format: "openbuildos-project-backup", version: BACKUP_VERSION, createdAt: new Date().toISOString(), sourceWorkspaceId: workspaceId, sourceProjectId: projectId, sourceBucket: bucket.name, documents, files };
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
    const workspaceId = request.data.workspaceId?.trim() ?? "";
    const projectId = request.data.projectId?.trim() ?? "";
    if (!workspaceId || !projectId) throw new HttpsError("invalid-argument", "Chybí workspaceId nebo projectId.");
    const who = principal(request.auth);
    await requireWorkspaceAdmin(workspaceId, who);
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

async function commitDocuments(manifest: BackupManifest, workspaceId: string, projectId: string, who: string): Promise<void> {
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
  root.data = { ...root.data, workspaceId, memberIds: [who], roles: { [who]: "admin" }, archived: false, restoredAt: new Date().toISOString() };
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
    if (createHash("sha256").update(content).digest("hex") !== item.sha256) throw new HttpsError("data-loss", `Kontrolní součet nesedí pro ${item.entry}.`);
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
    const workspaceId = request.data.workspaceId?.trim() ?? "";
    const objectPath = request.data.objectPath?.trim() ?? "";
    const projectId = request.data.projectId?.trim() || `proj-${Date.now()}`;
    const who = principal(request.auth);
    if (!workspaceId || !objectPath.startsWith(`workspaces/${workspaceId}/${IMPORT_PREFIX}/${who}/`)) throw new HttpsError("invalid-argument", "Neplatná cesta importu.");
    await requireWorkspaceAdmin(workspaceId, who);
    const localPath = join("/tmp", `${randomUUID()}.obosbackup`);
    const bucket = getStorage(app()).bucket();
    try {
      await bucket.file(objectPath).download({ destination: localPath });
      const directory = await unzipper.Open.file(localPath);
      const manifestEntry = directory.files.find((entry) => entry.path === "manifest.json");
      if (!manifestEntry) throw new HttpsError("invalid-argument", "Soubor není OpenBuildOS záloha.");
      const manifest = JSON.parse((await manifestEntry.buffer()).toString("utf8")) as BackupManifest;
      if (manifest.format !== "openbuildos-project-backup" || manifest.version !== BACKUP_VERSION) throw new HttpsError("invalid-argument", "Nepodporovaná verze zálohy.");
      if ((await getFirestore(app()).doc(`projects/${projectId}`).get()).exists) throw new HttpsError("already-exists", "Cílové ID projektu už existuje.");
      await restoreFiles(directory, manifest, workspaceId, projectId);
      await commitDocuments(manifest, workspaceId, projectId, who);
      await bucket.file(objectPath).delete({ ignoreNotFound: true });
      logger.info("Project backup restored", { workspaceId, projectId, sourceProjectId: manifest.sourceProjectId, who });
      return { projectId, documentCount: manifest.documents.length, fileCount: manifest.files.length };
    } finally {
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
    const workspaceId = request.data.workspaceId?.trim() ?? "";
    const projectId = request.data.projectId?.trim() ?? "";
    const who = principal(request.auth);
    if (!workspaceId || !projectId || request.data.confirmation !== projectId) throw new HttpsError("invalid-argument", "Potvrzení neodpovídá ID projektu.");
    await requireWorkspaceAdmin(workspaceId, who);
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
