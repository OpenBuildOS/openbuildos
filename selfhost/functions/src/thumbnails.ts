/**
 * Serverové miniatury — fotka i verze dokumentu dostanou náhled i tehdy, když
 * ho prohlížeč nevyrobil.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴 PROČ TO MUSÍ DĚLAT SERVER
 * ══════════════════════════════════════════════════════════════════════════
 * Do 11. 8. 2026 vznikala miniatura VÝHRADNĚ v prohlížeči při nahrávání
 * (`src/services/photos.ts`, 320 px). Selhání bylo nefatální — jen
 * `console.warn` — a mřížka pak tiše ukázala ORIGINÁL. To je stonásobek dat
 * při každém zobrazení; `docs/MONETIZATION_UNIT_ECONOMICS.md` kap. 7 tu regresi
 * vyčísluje na egress ×16 ≈ 700 USD/měs, tedy 30 % modelované tržby.
 *
 * PR #573 fallback zrušil, takže se místo originálu ukáže „Bez náhledu".
 * Vidět to je — ale nikdo to nespraví: uživatel na stavbě nemá jak miniaturu
 * dogenerovat a fotka tak zůstane bez náhledu NAVŽDY. Klientské generování
 * navíc závisí na verzi prohlížeče, velikosti souboru a volné paměti telefonu,
 * což je v terénu ta nejhorší možná závislost.
 *
 * Klientská cesta ZŮSTÁVÁ jako rychlá (náhled je vidět hned a funguje offline);
 * tenhle modul je záruka, že chybějící miniatura je dočasný stav, ne trvalý.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⭐ PROČ VLASTNÍ FUNKCE, A NE ROZŠÍŘENÍ `storage-resize-images`
 * ══════════════════════════════════════════════════════════════════════════
 * Rozšíření je hotové a udržované a kdyby stačilo vyrobit soubor, vyhrálo by.
 * Jenže appka náhled nečte ze Storage — čte ho z Firestore pole
 * (`photos/{id}.thumbnailUrl`, `documentVersions/{id}.thumbnailUrl`).
 * Rozšíření je transformace Storage → Storage; o naší kolekci nic neví a
 * `thumbnailUrl` nikomu nezapíše. Musela by tedy vzniknout DRUHÁ vlastní
 * funkce, která po něm doplní Firestore — tedy dva pohyblivé díly a jedna
 * závislost navíc místo jednoho modulu.
 *
 * K tomu tři menší důvody:
 *  1. Rozšíření si nese vlastní konfiguraci a vlastní funkci MIMO `functions/src`.
 *     Self-hoster by ho musel instalovat a nastavit sám a jeho backend by se
 *     lišil od našeho — `docs/REPO_BOUNDARIES.md` je celé o tom, že se ta dvě
 *     prostředí rozejít nesmí. Tenhle modul je naopak SDÍLENÝ soubor: obě
 *     nasazení dostanou bajtově týž kód.
 *  2. `cacheControl` by nastavovalo rozšíření podle SVÉ konfigurace, ne podle
 *     `src/lib/storageCache.ts`. Rozejít se s tou hlavičkou znamená vrátit
 *     `private, max-age=0`, tedy přesně to, co #573 opravoval.
 *  3. Rozšíření se instaluje per-projekt; my potřebujeme totéž chování
 *     v centrálním i ve firemních backendech.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⭐ PROČ FIRESTORE TRIGGER, A NE `onObjectFinalized`
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ Pozn.: precedens na `onObjectFinalized` v repu NENÍ.
 * `promoteApprovedDrawingToPlan` je `onDocumentUpdated`, tedy Firestore trigger
 * — Storage trigger by tu byl první svého druhu.
 *
 * A hlavně by byl horší:
 *
 *  1. **Smyčka.** Funkce nad Storage, která do TÉHOŽ bucketu zapisuje, spustí
 *     sama sebe; ubránit se jde jen filtrem podle cesty, a ten je jen tak
 *     dobrý, jak dobře ho příští úprava dodrží. Trigger nad VZNIKEM dokumentu
 *     se zacyklit NEMŮŽE ani omylem: zápis `thumbnailUrl` je update, a ten
 *     `onDocumentCreated` nespouští. Smyčka je tu vyloučená konstrukcí, ne
 *     ostražitostí.
 *  2. **Mapování zpět na dokument.** Ze Storage cesty by se muselo hádat, do
 *     které kolekce a kterého dokumentu adresa patří — parsováním řetězce.
 *     Firestore trigger dostane `workspaceId`, `projectId` i id v `event.params`.
 *  3. **Objekt bez záznamu.** Do bucketu se nahrává PŘED zápisem dokumentu.
 *     Storage trigger by tedy běžel na soubor, ke kterému ještě žádný záznam
 *     neexistuje, a musel by na něj čekat. Tady je pořadí dané: když dokument
 *     vznikl, objekt už tam je.
 *
 * ⚠️ Zápis `thumbnailUrl` na verzi dokumentu probudí `promoteApprovedDrawingToPlan`
 * (`onDocumentUpdated` nad toutéž kolekcí). Ten se ale řídí ZMĚNOU `status`, a ta
 * se tu nemění, takže hned odpadne — stejně jako u vlastního zápisu markeru.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴 `cacheControl` NASTAVUJE I TAHLE FUNKCE
 * ══════════════════════════════════════════════════════════════════════════
 * Bez explicitní hlavičky servíruje Storage `private, max-age=0` (změřeno na
 * stagingu). Nová cesta, kterou objekty do bucketu vstupují, je tedy nová
 * příležitost tu hlavičku ztratit. `STORAGE_CACHE_CONTROL` níž musí zůstat
 * shodná s `src/lib/storageCache.ts` — hlídá to `scripts/ci/egress-guard.mjs`,
 * který od 11. 8. 2026 kontroluje i `functions/src`.
 */

import { randomUUID } from "node:crypto";

/**
 * ⚠️ Musí být ZNAK PO ZNAKU shodné s `STORAGE_CACHE_CONTROL`
 * v `src/lib/storageCache.ts`. Duplikace je vědomá: `functions/` je samostatný
 * npm balík s vlastním tsconfigem a ze `src/` importovat nemůže (a nesmí —
 * companion repo `src/` vůbec nemá). Shodu hlídá `check:egress`.
 *
 * `private`, ne `public`: download URL nese token, tedy je to capability URL,
 * a `shareLinkRotation` ho umí zneplatnit. Sdílená cache nebo CDN by kopii po
 * rotaci nevyhodila a odebrání přístupu by přestalo platit.
 */
export const STORAGE_CACHE_CONTROL = "private, max-age=31536000, immutable";

/** Šířka miniatury. Musí sedět s klientem (`src/services/photos.ts`). */
export const PHOTO_THUMBNAIL_WIDTH = 320;
/** Náhled dokumentu je větší — nese čárovou grafiku a text. */
export const DOCUMENT_THUMBNAIL_WIDTH = 480;

export const PHOTO_THUMBNAIL_QUALITY = 65;
export const DOCUMENT_THUMBNAIL_QUALITY = 72;

/**
 * Formáty, které umí `sharp` v runtime Cloud Functions dekódovat.
 *
 * ⚠️ `application/pdf` v seznamu ZÁMĚRNĚ NENÍ. `sharp` (libvips bez PDFia)
 * PDF nerasterizuje; rasterizace by znamenala přibalit pdfjs s nativním
 * canvasem, nebo ghostscript. Náhledy PDF proto zatím dělá jen klient
 * (`src/modules/documents/services/documentThumbnail.ts`) — viz „Co tenhle
 * modul NEUMÍ" v `docs/SERVER_THUMBNAILS.md`.
 *
 * ⚠️ `image/heic` také ne: prebuilt `sharp` nemá libheif (licence).
 *
 * 🔴 OPRAVA PŘEDPOKLADU (14. 8. 2026): tady stálo „fotky z iPhonu chodí přes
 * `<input type=file>` jako JPEG, takže je to okrajové". Platí to jen pro
 * `accept="image/*"` (modul Fotky, „Vyfotit"). Příloha úkolu „Ze zařízení" má
 * accept SMÍŠENÝ (`src/lib/fileAccept.ts`) a přes něj HEIC projde v původním
 * formátu. Okrajové to tedy není.
 *
 * Nezachraňuje to server, ale KLIENT: `compressImage` (`src/services/photos.ts`)
 * fotku překóduje na JPEG všude, kde ji prohlížeč umí dekódovat (Safari na iOS
 * HEIC umí, tedy právě na zařízeních, která ho vyrábějí). Sem pak dorazí JPEG.
 * Kde konverze neprojde, skončí to VIDITELNÝM markerem, ne tichým ničím.
 *
 * ⚠️ Právě proto se `contentType` čte z DOKUMENTU a ne z přípony: po konverzi
 * se jméno nemění (`IMG_1234.HEIC` nese JPEG). Viz `isSupportedImage`.
 */
const SUPPORTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/tiff",
  "image/avif",
]);

const IMAGE_EXTENSIONS = /\.(jpe?g|png|webp|gif|tiff?|avif)$/i;

// ── typy ─────────────────────────────────────────────────────────────────────

export interface StorageObjectRef {
  bucket: string;
  objectPath: string;
}

export type ThumbnailKind = "photo" | "documentVersion";

/**
 * Proč se pro dokument miniatura NEVYRÁBÍ. Každý důvod je jiný druh události:
 * `already-present` je normální (klient stihl svou práci), `unsupported-type`
 * je očekávané omezení, `no-source` je vada dat.
 */
export type ThumbnailSkipReason = "already-present" | "unsupported-type" | "no-source";

export interface ThumbnailPlan {
  kind: ThumbnailKind;
  source: StorageObjectRef;
  target: StorageObjectRef;
  width: number;
  quality: number;
}

export type ThumbnailDecision =
  | { action: "generate"; plan: ThumbnailPlan }
  | { action: "skip"; reason: ThumbnailSkipReason };

/** Co z dokumentu potřebujeme — schválně jen tahle čtyři pole. */
export interface ThumbnailSourceRecord {
  /** Download URL originálu (`photos.url`, `documentVersions.filePath`). */
  sourceUrl?: unknown;
  /** Cesta objektu ve Storage (`photos.storagePath`, `documentVersions.fileId`). */
  sourceObjectPath?: unknown;
  /** Už existující miniatura — pak se nedělá nic. */
  thumbnailUrl?: unknown;
  /** Deklarovaný typ obsahu, když ho dokument nese. */
  contentType?: unknown;
}

// ── čisté rozhodování (tohle je testovatelná část) ───────────────────────────

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Bucket + cesta z Firebase download URL. Stejné tvary jako
 * `shareLinkRotation.parseStorageObjectFromDownloadUrl`, ale bez vyhazování —
 * tady je „nedá se to přečíst" normální vstup, ne chyba.
 */
export function parseDownloadUrl(value: unknown): StorageObjectRef | null {
  const raw = asNonEmptyString(value);
  if (!raw) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  const firebaseApi = url.pathname.match(/^\/v0\/b\/([^/]+)\/o\/(.+)$/);
  if (firebaseApi) {
    return {
      bucket: decodeURIComponent(firebaseApi[1]),
      objectPath: decodeURIComponent(firebaseApi[2]),
    };
  }

  if (url.hostname === "storage.googleapis.com") {
    const direct = url.pathname.match(/^\/([^/]+)\/(.+)$/);
    if (direct) {
      return {
        bucket: decodeURIComponent(direct[1]),
        objectPath: decodeURIComponent(direct[2]),
      };
    }
  }

  return null;
}

/**
 * Kde originál leží. Download URL má přednost před uloženou cestou: nese i
 * bucket, takže je přesnější než „cesta + výchozí bucket".
 */
export function resolveSourceObject(
  record: ThumbnailSourceRecord,
  defaultBucket: string
): StorageObjectRef | null {
  const fromUrl = parseDownloadUrl(record.sourceUrl);
  if (fromUrl) {
    return fromUrl;
  }
  const objectPath = asNonEmptyString(record.sourceObjectPath);
  if (objectPath && defaultBucket) {
    return { bucket: defaultBucket, objectPath };
  }
  return null;
}

/**
 * Umí `sharp` tenhle soubor otevřít? Typ má přednost, přípona je záloha.
 *
 * ⚠️ To pořadí není libovůle. Přípona popisuje, co uživatel VYBRAL; `contentType`
 * popisuje, co v bucketu SKUTEČNĚ leží. Rozcházejí se pokaždé, když klient
 * fotku překóduje (HEIC → JPEG beze změny jména), a tehdy je pravdivý typ.
 * Fotky nahrané před 14. 8. 2026 pole `contentType` nemají (`src/types/index.ts`),
 * takže jim zůstává přípona — proto je záloha, ne mrtvá větev.
 */
export function isSupportedImage(contentType: unknown, objectPath: string): boolean {
  const declared = asNonEmptyString(contentType);
  if (declared) {
    return SUPPORTED_IMAGE_TYPES.has(declared.split(";")[0].trim().toLowerCase());
  }
  return IMAGE_EXTENSIONS.test(objectPath);
}

/**
 * Cesta miniatury fotky — vedle originálu, s prefixem `thumb_`.
 *
 * Prefix drží konvenci klienta. Na zacyklení tu nespoléhá nic (viz hlavička),
 * ale kdyby někdy přibyl Storage trigger, je podle čeho filtrovat.
 */
export function photoThumbnailPath(sourceObjectPath: string): string {
  const cut = sourceObjectPath.lastIndexOf("/");
  const directory = cut >= 0 ? sourceObjectPath.slice(0, cut + 1) : "";
  const fileName = cut >= 0 ? sourceObjectPath.slice(cut + 1) : sourceObjectPath;
  const stem = fileName.replace(/\.[^./]+$/, "") || fileName;
  return `${directory}thumb_${stem}.webp`;
}

/**
 * Cesta náhledu verze dokumentu — podsložka `thumbnails/`, přesně jak ji píše
 * `DocumentBatchUploadModal`. Odvozuje se z cesty NAHRANÉHO SOUBORU, tedy
 * `…/{versionId}/{jméno}` → `…/{versionId}/thumbnails/preview.webp`.
 */
export function documentThumbnailPath(sourceObjectPath: string): string {
  const cut = sourceObjectPath.lastIndexOf("/");
  const directory = cut >= 0 ? sourceObjectPath.slice(0, cut + 1) : "";
  return `${directory}thumbnails/preview.webp`;
}

/**
 * Má se pro tenhle dokument miniatura vyrábět, a jaká?
 *
 * `already-present` je nejčastější odpověď a je to DOBŘE: znamená, že klient
 * svou práci stihl a server nemá co dohánět. Serverová cesta je záchranná síť,
 * ne hlavní silnice.
 */
export function decideThumbnail(
  kind: ThumbnailKind,
  record: ThumbnailSourceRecord,
  defaultBucket: string
): ThumbnailDecision {
  if (asNonEmptyString(record.thumbnailUrl)) {
    return { action: "skip", reason: "already-present" };
  }

  const source = resolveSourceObject(record, defaultBucket);
  if (!source) {
    return { action: "skip", reason: "no-source" };
  }

  if (!isSupportedImage(record.contentType, source.objectPath)) {
    return { action: "skip", reason: "unsupported-type" };
  }

  const isPhoto = kind === "photo";
  return {
    action: "generate",
    plan: {
      kind,
      source,
      target: {
        bucket: source.bucket,
        objectPath: isPhoto
          ? photoThumbnailPath(source.objectPath)
          : documentThumbnailPath(source.objectPath),
      },
      width: isPhoto ? PHOTO_THUMBNAIL_WIDTH : DOCUMENT_THUMBNAIL_WIDTH,
      quality: isPhoto ? PHOTO_THUMBNAIL_QUALITY : DOCUMENT_THUMBNAIL_QUALITY,
    },
  };
}

/** Download URL v tom tvaru, jaký vrací klientské `getDownloadURL`. */
export function buildDownloadUrl({ bucket, objectPath }: StorageObjectRef, token: string): string {
  return (
    `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucket)}`
    + `/o/${encodeURIComponent(objectPath)}?alt=media&token=${encodeURIComponent(token)}`
  );
}

// ── provedení ────────────────────────────────────────────────────────────────

/**
 * Co modul potřebuje z okolí. Rozhraní (a ne přímé `getStorage()`) proto, aby
 * se rozhodování i zápis daly otestovat bez emulátoru — stejně jako
 * `trashSweep` a `shareLinkRotation`.
 */
export interface ThumbnailStorage {
  download(ref: StorageObjectRef): Promise<Buffer>;
  upload(
    ref: StorageObjectRef,
    body: Buffer,
    metadata: { contentType: string; cacheControl: string; downloadToken: string }
  ): Promise<void>;
}

export interface ThumbnailEncoder {
  /** Zmenší na `width` a zakóduje do WebP. Vrací hotové bajty. */
  toWebp(input: Buffer, width: number, quality: number): Promise<Buffer>;
}

export interface ThumbnailDeps {
  storage: ThumbnailStorage;
  encoder: ThumbnailEncoder;
  /** Injektovatelné kvůli deterministickým testům. */
  newToken?: () => string;
}

export interface ThumbnailResult {
  status: "generated" | "skipped";
  reason?: ThumbnailSkipReason;
  thumbnailUrl?: string;
  bytes?: number;
}

/**
 * Vyrobí miniaturu a vrátí adresu, na kterou se má nastavit `thumbnailUrl`.
 *
 * Zápis do Firestore tu ZÁMĚRNĚ není — dělá ho volající (`index.ts`), aby
 * modul nemusel znát cestu ke kolekci a šel testovat bez Firestore.
 */
export async function generateThumbnail(
  deps: ThumbnailDeps,
  decision: ThumbnailDecision
): Promise<ThumbnailResult> {
  if (decision.action === "skip") {
    return { status: "skipped", reason: decision.reason };
  }

  const { plan } = decision;
  const original = await deps.storage.download(plan.source);
  const thumbnail = await deps.encoder.toWebp(original, plan.width, plan.quality);

  // Bez download tokenu by objekt nešel přečíst přes download URL — admin SDK
  // ho (na rozdíl od klientského `uploadBytes`) sám nepřidá. Rotaci tokenu
  // („Zneplatnit odkaz") to nijak nebrání: pracuje s metadaty objektu.
  const downloadToken = (deps.newToken ?? randomUUID)();
  await deps.storage.upload(plan.target, thumbnail, {
    contentType: "image/webp",
    cacheControl: STORAGE_CACHE_CONTROL,
    downloadToken,
  });

  return {
    status: "generated",
    thumbnailUrl: buildDownloadUrl(plan.target, downloadToken),
    bytes: thumbnail.length,
  };
}

/**
 * Marker na dokument, když se miniatura nevyrobila.
 *
 * ⭐ Stejný princip jako `planPromotion.status = "failed"`: trigger běží mimo
 * záložku uživatele, takže jediné místo, kde po sobě může nechat stopu, jsou
 * DATA. Bez markeru by „fotka nemá náhled" a „fotce se náhled nepodařilo
 * vyrobit a víme proč" vypadaly v UI úplně stejně.
 *
 * `already-present` marker nedostane — to není událost, to je normální stav.
 */
export function thumbnailFailureMarker(
  reason: ThumbnailSkipReason | "error",
  detail: string,
  at: string
): { thumbnailGeneration: { status: string; reason: string; at: string } } | null {
  if (reason === "already-present") {
    return null;
  }
  return { thumbnailGeneration: { status: reason, reason: detail, at } };
}
