import assert from "node:assert/strict";
import test from "node:test";
import {
  DOCUMENT_THUMBNAIL_WIDTH,
  PHOTO_THUMBNAIL_WIDTH,
  STORAGE_CACHE_CONTROL,
  buildDownloadUrl,
  decideThumbnail,
  documentThumbnailPath,
  generateThumbnail,
  isSupportedImage,
  parseDownloadUrl,
  photoThumbnailPath,
  resolveSourceObject,
  thumbnailFailureMarker,
  type StorageObjectRef,
  type ThumbnailDeps,
} from "./thumbnails";

const BUCKET = "openbuildos.firebasestorage.app";
const PHOTO_PATH = "workspaces/ws_a/projects/p1/photos/ph1/IMG_0042.jpg";
const PHOTO_URL =
  `https://firebasestorage.googleapis.com/v0/b/${BUCKET}`
  + `/o/${encodeURIComponent(PHOTO_PATH)}?alt=media&token=tok-1`;

// ── čtení adresy originálu ───────────────────────────────────────────────────

test("download URL se rozloží na bucket a cestu", () => {
  assert.deepEqual(parseDownloadUrl(PHOTO_URL), { bucket: BUCKET, objectPath: PHOTO_PATH });
});

test("podporuje i přímý tvar storage.googleapis.com", () => {
  assert.deepEqual(parseDownloadUrl(`https://storage.googleapis.com/${BUCKET}/${PHOTO_PATH}`), {
    bucket: BUCKET,
    objectPath: PHOTO_PATH,
  });
});

test("co není adresa objektu, vrací null místo výjimky", () => {
  for (const value of [undefined, null, "", "   ", 42, "nonsense", "https://example.com/x.jpg"]) {
    assert.equal(parseDownloadUrl(value), null, `selhalo pro ${JSON.stringify(value)}`);
  }
});

test("adresa má přednost před uloženou cestou (nese i bucket)", () => {
  const resolved = resolveSourceObject(
    { sourceUrl: PHOTO_URL, sourceObjectPath: "jina/cesta.jpg" },
    "vychozi-bucket"
  );
  assert.deepEqual(resolved, { bucket: BUCKET, objectPath: PHOTO_PATH });
});

test("bez adresy se použije uložená cesta a výchozí bucket", () => {
  assert.deepEqual(resolveSourceObject({ sourceObjectPath: PHOTO_PATH }, "vychozi-bucket"), {
    bucket: "vychozi-bucket",
    objectPath: PHOTO_PATH,
  });
});

// ── podporované formáty ──────────────────────────────────────────────────────

test("deklarovaný typ rozhoduje, i s parametrem charsetu", () => {
  assert.equal(isSupportedImage("image/jpeg", "x.jpg"), true);
  assert.equal(isSupportedImage("image/png; charset=binary", "x.png"), true);
  assert.equal(isSupportedImage("IMAGE/WEBP", "x.webp"), true);
});

test("PDF ani HEIC server nezvládne — sharp je nedekóduje", () => {
  assert.equal(isSupportedImage("application/pdf", "vykres.pdf"), false);
  assert.equal(isSupportedImage("image/heic", "IMG_1.heic"), false);
  // Bez deklarovaného typu rozhoduje přípona — a `.pdf` mezi obrázky není.
  assert.equal(isSupportedImage(undefined, "vykres.pdf"), false);
});

test("bez deklarovaného typu se čte přípona", () => {
  assert.equal(isSupportedImage(undefined, PHOTO_PATH), true);
  assert.equal(isSupportedImage(null, "a/b/c.TIFF"), true);
  assert.equal(isSupportedImage("", "a/b/soubor-bez-pripony"), false);
});

// ── cesty miniatur ───────────────────────────────────────────────────────────

test("miniatura fotky leží vedle originálu s prefixem thumb_ a příponou webp", () => {
  assert.equal(
    photoThumbnailPath(PHOTO_PATH),
    "workspaces/ws_a/projects/p1/photos/ph1/thumb_IMG_0042.webp"
  );
});

test("jméno s tečkami si nechá všechno kromě poslední přípony", () => {
  assert.equal(photoThumbnailPath("a/b/rez.A-A.v2.jpeg"), "a/b/thumb_rez.A-A.v2.webp");
});

test("soubor bez přípony si jméno nechá celé", () => {
  assert.equal(photoThumbnailPath("a/b/snimek"), "a/b/thumb_snimek.webp");
});

test("náhled verze dokumentu jde do podsložky thumbnails/", () => {
  assert.equal(
    documentThumbnailPath("workspaces/ws_a/projects/p1/documents/d1/v1/vykres.pdf"),
    "workspaces/ws_a/projects/p1/documents/d1/v1/thumbnails/preview.webp"
  );
});

test("miniatura NIKDY nepřepíše originál", () => {
  // Kdyby cíl vyšel na zdroj, funkce by si přepsala vlastní vstup — u fotky
  // by z 1600px pracovního snímku zbyla 320px dlaždice a originál by byl pryč.
  for (const path of [PHOTO_PATH, "a/b/c.png", "bez-adresare.jpg"]) {
    assert.notEqual(photoThumbnailPath(path), path);
    assert.notEqual(documentThumbnailPath(path), path);
  }
});

// ── rozhodování ──────────────────────────────────────────────────────────────

test("existující miniatura se nepřegenerovává", () => {
  const decision = decideThumbnail(
    "photo",
    { sourceUrl: PHOTO_URL, thumbnailUrl: "https://example.com/thumb.webp" },
    BUCKET
  );
  assert.deepEqual(decision, { action: "skip", reason: "already-present" });
});

test("prázdný řetězec v thumbnailUrl se NEpočítá jako miniatura", () => {
  const decision = decideThumbnail("photo", { sourceUrl: PHOTO_URL, thumbnailUrl: "  " }, BUCKET);
  assert.equal(decision.action, "generate");
});

test("dokument bez adresy originálu je vada dat, ne nepodporovaný typ", () => {
  assert.deepEqual(decideThumbnail("photo", {}, BUCKET), { action: "skip", reason: "no-source" });
});

test("fotka bez miniatury se naplánuje na 320 px", () => {
  const decision = decideThumbnail("photo", { sourceUrl: PHOTO_URL }, BUCKET);
  assert.equal(decision.action, "generate");
  if (decision.action !== "generate") return;
  assert.equal(decision.plan.width, PHOTO_THUMBNAIL_WIDTH);
  assert.equal(decision.plan.source.objectPath, PHOTO_PATH);
  assert.equal(
    decision.plan.target.objectPath,
    "workspaces/ws_a/projects/p1/photos/ph1/thumb_IMG_0042.webp"
  );
  // Miniatura patří do TÉHOŽ bucketu jako originál.
  assert.equal(decision.plan.target.bucket, BUCKET);
});

test("verze dokumentu se naplánuje na 480 px", () => {
  const decision = decideThumbnail(
    "documentVersion",
    { sourceObjectPath: "workspaces/ws_a/projects/p1/documents/d1/v1/plan.png" },
    BUCKET
  );
  assert.equal(decision.action, "generate");
  if (decision.action !== "generate") return;
  assert.equal(decision.plan.width, DOCUMENT_THUMBNAIL_WIDTH);
  assert.equal(
    decision.plan.target.objectPath,
    "workspaces/ws_a/projects/p1/documents/d1/v1/thumbnails/preview.webp"
  );
});

test("PDF verze se přeskočí s vlastním důvodem, ne jako chyba", () => {
  const decision = decideThumbnail(
    "documentVersion",
    { sourceObjectPath: "a/b/v1/vykres.pdf", contentType: "application/pdf" },
    BUCKET
  );
  assert.deepEqual(decision, { action: "skip", reason: "unsupported-type" });
});

// ── provedení ────────────────────────────────────────────────────────────────

function makeDeps(): ThumbnailDeps & {
  uploads: Array<{ ref: StorageObjectRef; body: Buffer; metadata: Record<string, string> }>;
  downloads: StorageObjectRef[];
} {
  const uploads: Array<{
    ref: StorageObjectRef;
    body: Buffer;
    metadata: Record<string, string>;
  }> = [];
  const downloads: StorageObjectRef[] = [];
  return {
    uploads,
    downloads,
    newToken: () => "token-pevny",
    storage: {
      async download(ref) {
        downloads.push(ref);
        return Buffer.from("puvodni-obrazek-o-mnoha-bajtech");
      },
      async upload(ref, body, metadata) {
        uploads.push({ ref, body, metadata: metadata as unknown as Record<string, string> });
      },
    },
    encoder: {
      async toWebp() {
        return Buffer.from("webp");
      },
    },
  };
}

test("vygenerovaná miniatura se nahraje s cacheControl a vrátí download URL", async () => {
  const deps = makeDeps();
  const decision = decideThumbnail("photo", { sourceUrl: PHOTO_URL }, BUCKET);

  const result = await generateThumbnail(deps, decision);

  assert.equal(result.status, "generated");
  assert.equal(result.bytes, 4);
  assert.equal(deps.uploads.length, 1);
  assert.equal(deps.uploads[0].metadata.contentType, "image/webp");
  // 🔴 Bez téhle hlavičky servíruje Storage `private, max-age=0` a miniatura
  // se přenáší při každém zobrazení mřížky — celý smysl serverové cesty pryč.
  assert.equal(deps.uploads[0].metadata.cacheControl, STORAGE_CACHE_CONTROL);
  assert.equal(
    result.thumbnailUrl,
    buildDownloadUrl(
      { bucket: BUCKET, objectPath: "workspaces/ws_a/projects/p1/photos/ph1/thumb_IMG_0042.webp" },
      "token-pevny"
    )
  );
});

test("cacheControl v functions je shodný s tím v src/lib/storageCache.ts", () => {
  // Duplikát nejde importovat (jiný npm balík), takže aspoň zamčená hodnota.
  assert.equal(STORAGE_CACHE_CONTROL, "private, max-age=31536000, immutable");
  assert.match(STORAGE_CACHE_CONTROL, /^private,/);
});

test("bez download tokenu by miniatura nešla přečíst — token je v adrese", async () => {
  const deps = makeDeps();
  const result = await generateThumbnail(deps, decideThumbnail("photo", { sourceUrl: PHOTO_URL }, BUCKET));
  assert.equal(deps.uploads[0].metadata.downloadToken, "token-pevny");
  assert.match(String(result.thumbnailUrl), /token=token-pevny/);
});

test("přeskočený dokument se ani nestahuje", async () => {
  const deps = makeDeps();
  const result = await generateThumbnail(deps, {
    action: "skip",
    reason: "already-present",
  });
  assert.deepEqual(result, { status: "skipped", reason: "already-present" });
  assert.equal(deps.downloads.length, 0);
  assert.equal(deps.uploads.length, 0);
});

// ── marker ───────────────────────────────────────────────────────────────────

test("selhání nechá v datech stopu, kterou UI ukáže", () => {
  const marker = thumbnailFailureMarker("unsupported-type", "application/pdf", "2026-08-11T10:00:00.000Z");
  assert.deepEqual(marker, {
    thumbnailGeneration: {
      status: "unsupported-type",
      reason: "application/pdf",
      at: "2026-08-11T10:00:00.000Z",
    },
  });
});

test("normální stav (klient miniaturu stihl) marker nedostane", () => {
  assert.equal(thumbnailFailureMarker("already-present", "", "2026-08-11T10:00:00.000Z"), null);
});
