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
 * ⚠️ ROTACE MÁ VEDLEJŠÍ ÚČINEK a ten se musí uklidit TADY. Download token je
 * vlastnost OBJEKTU, ne odkazu — přeražením proto zemře i adresa, kterou má
 * aplikace uloženou u samotné položky — `photos/{id}.url`,
 * `documentVersions/{id}.filePath`, `plans/{id}.versions[].fileUrl`
 * i `tasks/{id}.relations.attachments[].url` —, protože je to tatáž adresa.
 * Do 8. 8. 2026 to znamenalo, že kdo zneplatnil odkaz na fotku, tomu se ta
 * fotka přestala v aplikaci načítat (Storage vrací na starou adresu 403).
 * Rotace proto po sobě uložené adresy PŘEPÍŠE novou (viz
 * {@link ShareLinkRotationStore.refreshStoredDownloadUrls}) a teprve pak
 * označí odkaz za zneplatněný.
 *
 * ⭐ PROČ SE TO UKLÍZÍ NA SERVERU, a ne až v klientovi při 403. Na jeden objekt
 * ukazuje víc záznamů najednou (povýšená revize výkresu má v `plans` TÝŽ
 * `fileUrl` jako `documentVersions.filePath` — viz `src/services/planFileReferences.ts`)
 * a uloženou adresu čtou i cesty, které nic nekreslí: offline prefetch, export
 * anotované fotky, generování reportu. Oprava „až se to někomu nenačte" by
 * platila jen pro to jedno zařízení a jen pro to jedno místo v UI, kdežto
 * v datech by adresa zůstala mrtvá. Uklidit to jde jen tam, kde se ví, který
 * objekt se právě přerazil — tedy tady.
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

/** Co se má po rotaci přepsat, ať uložená adresa nezůstane mrtvá. */
export interface RefreshStoredDownloadUrlsInput {
  workspaceId: string;
  projectId: string;
  /** Objekt, kterému se právě přerazil token. */
  target: StorageObjectRef;
  /** Adresa, kterou odkaz rozdával — tatáž, jakou má uloženou položka. */
  staleUrl: string;
  /** Nová download URL téhož objektu. */
  freshUrl: string;
  /** Token právě zneplatňovaného odkazu — ten se NEobnovuje. */
  revokedToken: string;
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
  /** Přerazí `firebaseStorageDownloadTokens` a vrátí NOVÝ token. */
  rotateDownloadToken(target: StorageObjectRef): Promise<string>;
  /**
   * Přepíše uložené adresy, které ukazují na přeražený objekt, na `freshUrl`.
   * Vrací počet přepsaných dokumentů (jen pro log a výsledek).
   */
  refreshStoredDownloadUrls(input: RefreshStoredDownloadUrlsInput): Promise<number>;
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
  /** Kolik uložených adres se po rotaci přepsalo na novou (0 = žádná na ten objekt neukazovala). */
  refreshedUrls: number;
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
      "Sdílený soubor je uložený jinde, než odkud ho umíme zneplatnit."
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
    "Sdílený soubor je uložený jinde, než odkud ho umíme zneplatnit."
  );
}

/** Jako {@link parseStorageObjectFromDownloadUrl}, ale cizí adresa je `null`, ne výjimka. */
export function tryParseStorageObjectFromDownloadUrl(value: unknown): StorageObjectRef | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  try {
    return parseStorageObjectFromDownloadUrl(value);
  } catch {
    return null;
  }
}

/**
 * Ukazuje uložená hodnota na TENTÝŽ objekt ve Storage? Porovnává bucket + cestu,
 * NE celou adresu — token v query se po každé rotaci liší, a právě proto se
 * uložená adresa hledá takhle (jinak by druhá rotace za sebou už nic nenašla).
 */
export function pointsAtStorageObject(value: unknown, target: StorageObjectRef): boolean {
  const parsed = tryParseStorageObjectFromDownloadUrl(value);
  return parsed !== null && parsed.bucket === target.bucket && parsed.objectPath === target.objectPath;
}

/** Složí download URL přesně v tom tvaru, jaký vrací klientské `getDownloadURL`. */
export function buildDownloadUrl({ bucket, objectPath }: StorageObjectRef, token: string): string {
  return (
    `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucket)}` +
    `/o/${encodeURIComponent(objectPath)}?alt=media&token=${encodeURIComponent(token)}`
  );
}

/**
 * Kolekce stavby, ve kterých visí uložené download URL.
 *
 * `urlFields[0]` je pole, které si sdílecí odkaz zkopíroval do `fileUrl` — podle
 * něj se dá záznam dohledat rovností (jednopolový index má Firestore sám).
 * `objectPathField` je druhá cesta k témuž záznamu: cesta k objektu ve Storage.
 * Hledá se OBĚMA, protože ani jedna sama nestačí — fotky nahrané před zavedením
 * `storagePath` pole nemají, a naopak po druhé rotaci už uložená adresa není
 * shodná s tou, kterou nese sdílecí odkaz.
 */
export interface StoredUrlCollection {
  collection: string;
  urlFields: readonly string[];
  objectPathField: string;
}

export const STORED_URL_COLLECTIONS: readonly StoredUrlCollection[] = [
  { collection: "photos", urlFields: ["url", "thumbnailUrl"], objectPathField: "storagePath" },
  {
    collection: "documentVersions",
    urlFields: ["filePath", "thumbnailUrl"],
    objectPathField: "fileId",
  },
];

/**
 * Která pole dokumentu ukazují na přeražený objekt a čím je přepsat. `null` =
 * dokument se nemá čeho chytit (volající ho pak vůbec nezapisuje).
 */
export function refreshedUrlFields(
  data: Record<string, unknown>,
  fields: readonly string[],
  target: StorageObjectRef,
  freshUrl: string
): Record<string, string> | null {
  const patch: Record<string, string> = {};
  for (const field of fields) {
    const current = data[field];
    if (current !== freshUrl && pointsAtStorageObject(current, target)) {
      patch[field] = freshUrl;
    }
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Verze výkresů (`plans.versions`) i přílohy úkolu (`tasks.relations.attachments`)
 * leží v POLI uvnitř dokumentu — na hodnotu v poli se nedá dotázat ani ji nejde
 * přepsat po jednom, takže se přepisuje celé pole. `null` = beze změny.
 */
export function refreshedUrlsInArray(
  items: unknown,
  fields: readonly string[],
  target: StorageObjectRef,
  freshUrl: string
): unknown[] | null {
  if (!Array.isArray(items)) {
    return null;
  }
  let changed = false;
  const next = items.map((item) => {
    if (!item || typeof item !== "object") {
      return item;
    }
    const record = item as Record<string, unknown>;
    const patch = refreshedUrlFields(record, fields, target, freshUrl);
    if (!patch) {
      return item;
    }
    changed = true;
    return { ...record, ...patch };
  });
  return changed ? next : null;
}

/**
 * Zneplatní sdílecí odkaz: přerazí download token objektu, přepíše uložené
 * adresy, které na ten objekt ukazovaly, a až POTOM označí záznam jako
 * `revoked`.
 *
 * Pořadí je záměrné. Rotace je ta část, na které záleží; kdyby se dřív zapsalo
 * `revoked = true` a rotace pak selhala, appka by tvrdila „zneplatněno" a přímá
 * adresa by žila dál. V opačném pořadí je horší případ ten, že se rotace povede
 * a zápis ne — odkaz je pak fakticky mrtvý a jen v datech visí jako živý, což
 * druhé zavolání spraví (obojí je idempotentní).
 *
 * Ze stejného důvodu se selhání obnovy adres NEPOLYKÁ: kdyby se spolklo,
 * „Zneplatnit odkaz" by tiše prošlo a fotka by se v appce přestala načítat —
 * přesně ta chyba, kvůli které tenhle krok vznikl. Chyba jde k volajícímu, ať
 * to může zopakovat (rotace i obnova jsou idempotentní, druhý pokus najde
 * záznamy podle cesty k objektu i s už přepsanou adresou).
 */
export async function revokeShareLinkAndRotate(
  store: ShareLinkRotationStore,
  input: RevokeShareLinkInput
): Promise<RevokeShareLinkResult> {
  const { workspaceId, projectId, token, principal } = input;
  if (!workspaceId || !projectId || !token) {
    throw new ShareLinkRotationError(
      "invalid-argument",
      "Není určená firma, stavba nebo odkaz, který se má zneplatnit."
    );
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
      "U tohohle sdílecího odkazu není zaznamenané, na který soubor míří."
    );
  }

  const target = parseStorageObjectFromDownloadUrl(shareLink.fileUrl);
  const freshToken = await store.rotateDownloadToken(target);
  const refreshedUrls = await store.refreshStoredDownloadUrls({
    workspaceId,
    projectId,
    target,
    staleUrl: shareLink.fileUrl,
    freshUrl: buildDownloadUrl(target, freshToken),
    revokedToken: token,
  });
  await store.markShareLinkRevoked(workspaceId, projectId, token);

  return {
    revoked: true,
    tokenRotated: true,
    wasAlreadyRevoked: shareLink.revoked === true,
    refreshedUrls,
  };
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
      const freshToken = randomUUID();
      // Merge, ne přepis: v `metadata` bývají i vlastní klíče (contentType řeší
      // Storage sám, ale custom metadata bychom smazali).
      await file.setMetadata({
        metadata: {
          ...(metadata.metadata ?? {}),
          firebaseStorageDownloadTokens: freshToken,
        },
      });
      return freshToken;
    },
    refreshStoredDownloadUrls: async ({
      workspaceId,
      projectId,
      target,
      staleUrl,
      freshUrl,
      revokedToken,
    }) => {
      const base = `workspaces/${workspaceId}/projects/${projectId}`;
      const batch = firestore.batch();
      let refreshed = 0;
      let hitPhoto = false;

      for (const holder of STORED_URL_COLLECTIONS) {
        const collectionRef = firestore.collection(`${base}/${holder.collection}`);
        const [byObjectPath, byStaleUrl] = await Promise.all([
          collectionRef.where(holder.objectPathField, "==", target.objectPath).get(),
          collectionRef.where(holder.urlFields[0], "==", staleUrl).get(),
        ]);
        const seen = new Set<string>();
        for (const snap of [...byObjectPath.docs, ...byStaleUrl.docs]) {
          if (seen.has(snap.id)) {
            continue;
          }
          seen.add(snap.id);
          const patch = refreshedUrlFields(
            (snap.data() ?? {}) as Record<string, unknown>,
            holder.urlFields,
            target,
            freshUrl
          );
          if (patch) {
            batch.update(snap.ref, patch);
            refreshed += 1;
            hitPhoto = hitPhoto || holder.collection === "photos";
          }
        }
      }

      // Plány se čtou celé: verze visí v poli uvnitř dokumentu a na hodnotu
      // uvnitř pole map se ve Firestoru dotázat nejde. Stavba jich má jednotky
      // až desítky a zneplatnění odkazu je vzácný úkon, takže je to levnější
      // než držet kvůli tomu druhý index.
      const plans = await firestore.collection(`${base}/plans`).get();
      for (const snap of plans.docs) {
        const versions = refreshedUrlsInArray(
          ((snap.data() ?? {}) as { versions?: unknown }).versions,
          ["fileUrl", "thumbnailUrl"],
          target,
          freshUrl
        );
        if (versions) {
          batch.update(snap.ref, { versions });
          refreshed += 1;
        }
      }

      // Přílohy úkolů jsou KOPIE adresy knihovní fotky (`buildGalleryAttachment`
      // v `src/services/taskAttachments.ts`), takže rotace zabije i je. Úkolů
      // bývají stovky, proto se čtou jen když jde o fotku — u sdíleného
      // dokumentu (nejčastější případ) by ten průchod byl zbytečný. Kromě
      // nalezeného záznamu bere i tvar cesty, ať se příloha spraví i tehdy,
      // když sama fotka v knihovně už není.
      if (hitPhoto || target.objectPath.includes("/photos/")) {
        const tasks = await firestore.collection(`${base}/tasks`).get();
        for (const snap of tasks.docs) {
          const data = (snap.data() ?? {}) as { relations?: { attachments?: unknown } };
          const attachments = refreshedUrlsInArray(
            data.relations?.attachments,
            ["url", "thumbnailUrl"],
            target,
            freshUrl
          );
          if (attachments) {
            batch.update(snap.ref, { "relations.attachments": attachments });
            refreshed += 1;
          }
        }
      }

      // 🔴 FIREMNÍ PROSTORY (`companySpaces/{cid}`). Interní registr firmy leží
      // POD stavbou, ale mimo `${base}/documentVersions` — do 22. 8. 2026ho
      // tenhle průchod míjel. Následek nebyl jen „neuklizený odkaz": rotace
      // tokenu je vlastnost OBJEKTU, takže zneplatnění sdíleného dokumentu
      // tiše rozbilo tentýž soubor v interním registru a firma viděla mrtvou
      // dlaždici bez vysvětlení.
      //
      // Firem na stavbě jsou jednotky, zneplatnění je vzácný úkon — cena je
      // pár dotazů navíc jen tehdy, když někdo opravdu rotuje.
      const companySpaces = await firestore.collection(`${base}/companySpaces`).listDocuments();
      for (const space of companySpaces) {
        const versions = await space
          .collection("documentVersions")
          .where("fileId", "==", target.objectPath)
          .get();
        const byUrl = await space
          .collection("documentVersions")
          .where("filePath", "==", staleUrl)
          .get();
        const seenVersions = new Set<string>();
        for (const snap of [...versions.docs, ...byUrl.docs]) {
          if (seenVersions.has(snap.id)) {
            continue;
          }
          seenVersions.add(snap.id);
          const patch = refreshedUrlFields(
            (snap.data() ?? {}) as Record<string, unknown>,
            ["filePath", "thumbnailUrl"],
            target,
            freshUrl
          );
          if (patch) {
            batch.update(snap.ref, patch);
            refreshed += 1;
          }
        }

        // Firemní plány drží verze v poli, stejně jako ty oficiální — dotázat
        // se na hodnotu uvnitř pole map nejde, takže se čtou celé.
        const companyPlans = await space.collection("plans").get();
        for (const snap of companyPlans.docs) {
          const planVersions = refreshedUrlsInArray(
            ((snap.data() ?? {}) as { versions?: unknown }).versions,
            ["fileUrl", "thumbnailUrl"],
            target,
            freshUrl
          );
          if (planVersions) {
            batch.update(snap.ref, { versions: planVersions });
            refreshed += 1;
          }
        }
      }

      // 🔴 LOGO FIRMY (`workspaces/{wid}.logo.url`). Taky capability URL
      // s tokenem, jen o patro výš než celý tenhle průchod — takže dokud tu
      // nebylo, nešlo logo zneplatnit vůbec (rotace tokenu by ho jen tiše
      // rozbila v reportech všech staveb).
      //
      // ⚠️ Logo NENÍ v `STORED_URL_COLLECTIONS`: ta je seznam KOLEKCÍ pod
      // stavbou, tohle je jedno pole jednoho dokumentu firmy. Čte se jen když
      // cesta objektu vede do `branding/`, ať běžné zneplatnění fotky
      // nevytěžuje dokument firmy.
      if (target.objectPath.includes("/branding/")) {
        const workspaceRef = firestore.doc(`workspaces/${workspaceId}`);
        const workspaceSnap = await workspaceRef.get();
        const logo = ((workspaceSnap.data() ?? {}) as { logo?: Record<string, unknown> }).logo;
        if (logo) {
          const patch = refreshedUrlFields(logo, ["url"], target, freshUrl);
          if (patch) {
            batch.update(workspaceRef, { "logo.url": patch.url });
            refreshed += 1;
          }
        }
      }

      // Ostatní ŽIVÉ odkazy na týž soubor. Token je vlastnost objektu, takže je
      // rotace zabila taky — a odkaz, který nikdo nezneplatnil, nesmí přestat
      // fungovat jen proto, že někdo zneplatnil jiný.
      const siblings = await firestore
        .collection(`${base}/shareLinks`)
        .where("fileUrl", "==", staleUrl)
        .get();
      for (const snap of siblings.docs) {
        const data = (snap.data() ?? {}) as ShareLinkRecord;
        if (snap.id === revokedToken || data.revoked === true) {
          continue;
        }
        batch.update(snap.ref, { fileUrl: freshUrl });
        refreshed += 1;
      }

      if (refreshed > 0) {
        await batch.commit();
      }
      return refreshed;
    },
  };
}
