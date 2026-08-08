import { randomUUID } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import type { Storage } from "firebase-admin/storage";

/**
 * Zneplatnění sdílecího odkazu, které opravdu zneplatňuje — rotací
 * `firebaseStorageDownloadTokens` v metadatech objektu ve Storage.
 *
 * ⭐ PROČ TO NESTAČÍ VE FIRESTORU. Sdílecí odkaz vede na `/share/{wid}/{token}`,
 * ale ta stránka jen přečte záznam a přesměruje na PŘÍMOU download URL souboru
 * (`…?alt=media&token=…`). Kdo si tu přímou adresu jednou zkopíroval, tomu
 * `revoked = true` ve Firestoru nevezme nic — objekt dál servíruje Storage podle
 * tokenu v URL, mimo Firestore rules. Zneplatnit odkaz jde tedy JEN tak, že se
 * ten token přerazí.
 *
 * ⭐ SDÍLENÝ SOUBOR. Musí být IDENTICKÝ v obou repech (viz docs/REPO_BOUNDARIES.md):
 *   hlavní repo `functions/src/shareLinkRotation.ts`
 *   companion   `selfhost/functions/src/shareLinkRotation.ts`
 * Sdílecí odkazy žijí v tom Firebase projektu, který drží data workspace — u
 * self-hostu firemní projekt (companion), u hostovaného a stagingového workspace
 * centrální projekt (hlavní repo). Do 8. 8. 2026 tahle funkce existovala JEN
 * v companionu: hostovaný zákazník klikl „Zneplatnit odkaz", klient spadl na
 * `updateDoc({ revoked: true })` a přímá adresa souboru zůstala živá. Slib
 * o zneplatnění tak platil jen pro půlku zákazníků — a to je přesně ta třída
 * chyby, kterou sdílené soubory mají zabránit.
 *
 * ⚠️ ROTACE MÁ VEDLEJŠÍ ÚČINEK, který je potřeba znát: download token je
 * vlastnost OBJEKTU, ne odkazu. Přeražením tedy zneplatní i URL uloženou
 * u položky v aplikaci (`photos/{id}.url`, `documentVersions/{id}.fileUrl`, …),
 * protože se vydává tatáž adresa. Do doby, než se uložená adresa obnoví
 * (`getDownloadURL`), se položka v appce nenačte. Je to úmyslný kompromis:
 * druhá možnost je, že zneplatnění odkazu nezneplatní nic. Dořešení
 * (obnovit uloženou adresu po rotaci) je vedeno samostatně.
 */

/** Kód chyby v termínech `HttpsError` — volající ho jen přebalí. */
export type ShareLinkRotationErrorCode =
  | "invalid-argument"
  | "permission-denied"
  | "not-found"
  | "failed-precondition";

export class ShareLinkRotationError extends Error {
  readonly code: ShareLinkRotationErrorCode;

  constructor(code: ShareLinkRotationErrorCode, message: string) {
    super(message);
    this.name = "ShareLinkRotationError";
    this.code = code;
  }
}

/** Objekt ve Storage vytažený z download URL. */
export interface StorageObjectRef {
  bucket: string;
  objectPath: string;
}

/** Firmy: jen pole, která rozhodnutí o oprávnění potřebuje. */
export interface WorkspaceRecord {
  ownerId?: string;
  adminIds?: string[];
}

/** Stavby: jen pole, která rozhodnutí o oprávnění potřebuje. */
export interface ProjectRecord {
  workspaceId?: string;
  roles?: Record<string, string>;
}

/** Záznam sdílecího odkazu: jen pole, která rotace čte. */
export interface ShareLinkRecord {
  fileUrl?: string;
  revoked?: boolean;
}

/** Vstupy, které si funkce sama neumí obstarat (Firestore + Storage). */
export interface ShareLinkRotationStore {
  loadWorkspace(workspaceId: string): Promise<WorkspaceRecord | null>;
  loadProject(projectId: string): Promise<ProjectRecord | null>;
  loadShareLink(
    workspaceId: string,
    projectId: string,
    token: string
  ): Promise<ShareLinkRecord | null>;
  markShareLinkRevoked(workspaceId: string, projectId: string, token: string): Promise<void>;
  rotateDownloadToken(target: StorageObjectRef): Promise<void>;
}

export interface RevokeShareLinkInput {
  workspaceId: string;
  projectId: string;
  token: string;
  /** Federovaný subjekt volajícího (fallback uid) — `principalFromAuth`. */
  principal: string;
}

export interface RevokeShareLinkResult {
  revoked: true;
  tokenRotated: true;
  /** Odkaz už byl ve Firestoru označený jako zneplatněný (rotace přesto proběhla). */
  wasAlreadyRevoked: boolean;
}

/**
 * Role, které v `firestore.rules` nesou oprávnění `edit` (tam `rolePermissions()`).
 *
 * ⚠️ `company_lead` je ZRUŠENÁ role — nově ji nejde přiřadit, ale komu se do dat
 * dostala, tomu pravidla `edit` dál dávají. Kdyby ten výčet byl užší než
 * pravidla, backend by odmítl úkon, který klient povolil (a naopak — širší výčet
 * by byl díra). Držet shodné s `rolePermissions()` ve `firestore.rules`
 * a s `src/lib/permissions/projectPermissions.ts`.
 */
const PROJECT_ROLES_WITH_EDIT = new Set(["admin", "editor", "company_lead"]);

/**
 * Smí volající měnit CIZÍ obsah na téhle stavbě? Zrcadlí `canEdit(wid, pid)`
 * z `firestore.rules` (rules na `shareLinks` mají `allow create, update, delete:
 * if canEdit(wid, pid)`) — funkce nesmí pustit dál nikoho, koho by pravidla
 * odmítla.
 */
export function canEditProjectContent(
  workspace: WorkspaceRecord | null,
  project: ProjectRecord | null,
  workspaceId: string,
  principal: string
): boolean {
  if (!workspace || !project || !principal) {
    return false;
  }
  // Stavba musí patřit TÉ firmě, jejíž vlastnictví se kontroluje — jinak by
  // admin firmy A rozhodoval o stavbě firmy B.
  if (project.workspaceId !== workspaceId) {
    return false;
  }
  if (workspace.ownerId === principal || (workspace.adminIds ?? []).includes(principal)) {
    return true;
  }
  return PROJECT_ROLES_WITH_EDIT.has(project.roles?.[principal] ?? "");
}

/**
 * Vytáhne bucket + cestu k objektu z Firebase download URL. Podporované tvary:
 *  - `https://firebasestorage.googleapis.com/v0/b/{bucket}/o/{urlEncodedPath}?…`
 *  - `https://storage.googleapis.com/{bucket}/{path}`
 */
export function parseStorageObjectFromDownloadUrl(fileUrl: string): StorageObjectRef {
  let url: URL;
  try {
    url = new URL(fileUrl);
  } catch {
    throw new ShareLinkRotationError(
      "failed-precondition",
      "Sdílený soubor nemá podporovaný Firebase Storage download URL."
    );
  }

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

  throw new ShareLinkRotationError(
    "failed-precondition",
    "Sdílený soubor nemá podporovaný Firebase Storage download URL."
  );
}

/**
 * Zneplatní sdílecí odkaz: přerazí download token objektu a až POTOM označí
 * záznam jako `revoked`.
 *
 * Pořadí je záměrné. Rotace je ta část, na které záleží; kdyby se dřív zapsalo
 * `revoked = true` a rotace pak selhala, appka by tvrdila „zneplatněno" a přímá
 * adresa by žila dál. V opačném pořadí je horší případ ten, že se rotace povede
 * a zápis ne — odkaz je pak fakticky mrtvý a jen v datech visí jako živý, což
 * druhé zavolání spraví (obojí je idempotentní).
 */
export async function revokeShareLinkAndRotate(
  store: ShareLinkRotationStore,
  input: RevokeShareLinkInput
): Promise<RevokeShareLinkResult> {
  const { workspaceId, projectId, token, principal } = input;
  if (!workspaceId || !projectId || !token) {
    throw new ShareLinkRotationError("invalid-argument", "Chybí wid, pid nebo token.");
  }

  const [workspace, project] = await Promise.all([
    store.loadWorkspace(workspaceId),
    store.loadProject(projectId),
  ]);
  if (!canEditProjectContent(workspace, project, workspaceId, principal)) {
    throw new ShareLinkRotationError(
      "permission-denied",
      "Nemáš oprávnění zneplatnit sdílecí odkaz."
    );
  }

  const shareLink = await store.loadShareLink(workspaceId, projectId, token);
  if (!shareLink) {
    throw new ShareLinkRotationError("not-found", "Sdílecí odkaz neexistuje.");
  }
  if (typeof shareLink.fileUrl !== "string" || shareLink.fileUrl.length === 0) {
    throw new ShareLinkRotationError(
      "failed-precondition",
      "Sdílecí odkaz neobsahuje URL souboru."
    );
  }

  await store.rotateDownloadToken(parseStorageObjectFromDownloadUrl(shareLink.fileUrl));
  await store.markShareLinkRevoked(workspaceId, projectId, token);

  return { revoked: true, tokenRotated: true, wasAlreadyRevoked: shareLink.revoked === true };
}

/** Napojení na skutečný Firestore + Storage. Testy si podstrčí vlastní store. */
export function createFirestoreShareLinkStore(
  firestore: Firestore,
  storage: Storage
): ShareLinkRotationStore {
  const readDoc = async <T>(path: string): Promise<T | null> => {
    const snap = await firestore.doc(path).get();
    return snap.exists ? ((snap.data() ?? {}) as T) : null;
  };

  return {
    loadWorkspace: (workspaceId) => readDoc<WorkspaceRecord>(`workspaces/${workspaceId}`),
    // ⚠️ Stavba leží v KOŘENOVÉ kolekci `projects/{pid}`, ne pod workspace —
    // stejně jako to čte `projectPath()` ve firestore.rules.
    loadProject: (projectId) => readDoc<ProjectRecord>(`projects/${projectId}`),
    loadShareLink: (workspaceId, projectId, token) =>
      readDoc<ShareLinkRecord>(
        `workspaces/${workspaceId}/projects/${projectId}/shareLinks/${token}`
      ),
    markShareLinkRevoked: async (workspaceId, projectId, token) => {
      await firestore
        .doc(`workspaces/${workspaceId}/projects/${projectId}/shareLinks/${token}`)
        .update({ revoked: true });
    },
    rotateDownloadToken: async ({ bucket, objectPath }) => {
      const file = storage.bucket(bucket).file(objectPath);
      const [metadata] = await file.getMetadata();
      // Merge, ne přepis: v `metadata` bývají i vlastní klíče (contentType řeší
      // Storage sám, ale custom metadata bychom smazali).
      await file.setMetadata({
        metadata: {
          ...(metadata.metadata ?? {}),
          firebaseStorageDownloadTokens: randomUUID(),
        },
      });
    },
  };
}
