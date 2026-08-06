# OpenBuildOS — Cloud Functions (`authExchange`, revokace share linků)

Tato Cloud Function zajišťuje **jedno přihlášení napříč samostatnými firemními
Firebase backendy** bez OIDC, Zitadelu nebo Identity Platform.

## Jak to funguje

1. Uživatel se přihlásí do **centrálního** projektu OpenBuildOS (`openbuildos`)
   běžným způsobem (Google / e-mail). Frontend má jeho **centrální ID token**.
2. Frontend pošle ten token sem: `POST { idToken }`.
3. Funkce token **ověří** přes Firebase Admin (`verifyIdToken`). K ověření stačí
   znát jen **veřejné project id** `openbuildos` — Google podepisuje tokeny
   veřejnými klíči, takže **není potřeba žádný secret ani service-account soubor**.
4. Funkce vyrobí **lokální custom token** (`createCustomToken(uid)`) s **uid
   shodným s centrálním uid**. Nasazená funkce má automaticky práva service
   accountu **svého** projektu, takže ani tady **žádný klíč není potřeba**.
5. Frontend zavolá `signInWithCustomToken(...)` a je přihlášen do firemního
   backendu se **stejným uid** jako centrálně.

Důsledek: `request.auth.uid` je stejné ve všech backendech → membership pravidla
podle uid fungují napříč firmami. Přihlášení spadá do free koše „Custom"
(3000 DAU), ne do OIDC stropu.

> Funkce **důvěřuje pouze tokenům z projektu `openbuildos`** (lze přepsat přes
> `CENTRAL_PROJECT_ID`). Tokeny z jiných projektů odmítne.

## Nasazení (self-hoster)

Předpoklady: vlastní Firebase projekt firmy s aktivním plánem **Blaze**
(Cloud Functions vyžadují Blaze). Provoz je **zdarma do free tier**.

**Doporučený postup je setup CLI**, ne ruční deploy — nasadí funkce, IAM role,
pravidla úložiště i CORS ve správném pořadí a zapíše URL ověřovací funkce do
`config/public`, takže si ji aplikace **najde sama**:

```bash
cd selfhost
node scripts/openbuildos-setup.mjs --project <id-firemního-projektu>
```

Detaily a troubleshooting org policy: [`docs/COMPANION_CLI.md`](../docs/COMPANION_CLI.md),
krok za krokem pro netechnické uživatele: [`docs/cloudshell-tutorial.md`](../docs/cloudshell-tutorial.md).

Ručně (jen když víte proč):

```bash
cd selfhost/functions
npm install
cd ..
firebase deploy --only functions --project <id-firemního-projektu>
```

⚠️ **Bez `--force`.** `--force` odklepne i smazání funkcí, které ve vašem klonu
nejsou — ze staršího klonu byste si tím odstranili část vlastního backendu.

Funkce běží jako **gen2**, tedy na Cloud Run; URL má tvar
`https://authexchange-xxxxxxxxxx-ew.a.run.app` (ne `…cloudfunctions.net`).
Ruční deploy ji **nezapíše** do `config/public`, takže ji pak musíte vložit
v aplikaci do pole **„URL ověřovací funkce"** (modal *Připojení firmy*).

## Aktualizace

Funkce jsou **součástí open-source repozitáře** OpenBuildOS.

> 🔴 **Aktualizace NENÍ jen redeploy funkcí.** Od srpna 2026 gatují pravidla
> úložiště na custom claims, které razí `authExchange` + `syncMemberClaims` —
> funkce a `storage.rules` se od sebe nedají oddělit. Aktualizujte proto
> **celým setup CLI** (`node scripts/openbuildos-setup.mjs --project <firma>`),
> které pustí obojí ve správném pořadí. Samotný `openbuildos-storage-setup.mjs`
> se bez nasazených funkcí odmítne spustit — schválně.

## Funkce v balíčku

Deset exportů. **`authExchange` a `syncMemberClaims` jsou povinné** — bez nich
nikdo nedostane claims a pravidla úložiště nepustí ke svým souborům ani
vlastníka firmy.

- `authExchange` — federace centrální session do firemního backendu; zároveň
  razí členství do custom claims (`wsa`/`pw`/`p`).
- `syncMemberClaims` — přerazítkuje claims po změně členství a zneplatní
  refresh tokeny, aby se odebrání přístupu projevilo hned, ne až za hodinu.
- `companyFile` — autorizovaný přístup k interním firemním souborům
  (`companySpaces`), které jsou v pravidlech úložiště zakázané napřímo.
- `revokeShareLinkAndRotateToken` — callable funkce pro skutečnou revokaci
  veřejného share linku: označí Firestore záznam jako `revoked` a zároveň
  zrotuje Firebase Storage download token souboru.
- `sendProjectInvite` — odeslání pozvánky e-mailem (SMTP/Resend).
- **Přenos projektu (#291)** — `exportProjectBackup`, `prepareProjectBackupImport`,
  `importProjectBackup`, `deleteProjectPermanently` (viz níže).
- `promoteApprovedDrawingToPlan` — **Firestore trigger** (jediný v balíčku):
  po schválení jednostránkového výkresu ho povýší do Plánů. Běží na serveru
  schválně — zápis do `plans` vyžaduje editační práva, která schvalovatel
  (TDI, projektant) mít nemusí. Viz `src/planPromotion.ts`.

## Přenos projektu mezi backendy (#291)

Umožňuje předat celý projekt z jedné firemní Firebase instance do druhé
(„založím u sebe → předám klientovi"). Vše běží přes **admin SDK** na obou
stranách (Blaze) → **nevyžaduje žádnou změnu security rules** (rules se obcházejí).

| Funkce | Co dělá |
| --- | --- |
| `exportProjectBackup({workspaceId, projectId})` | serializuje celý projekt (Firestore oba stromy `projects/{pid}` + `workspaces/{wid}/projects/{pid}` rekurzivně, referencovaný výřez firemního adresáře, Storage se sha256) do ZIP → signed URL (TTL 1 h) |
| `prepareProjectBackupImport({workspaceId, fileName})` | v4 signed **write** URL pro nahrání zálohy do cíle (TTL 15 min) |
| `importProjectBackup({workspaceId, objectPath\|sourceUrl, projectId?})` | rezervace ID → restore Storage (kontrola velikost+sha256) → commit Firestore → cleanup; rollback při chybě |
| `deleteProjectPermanently({workspaceId, projectId, confirmation, backupObjectPath})` | hard-delete až po archivaci + ověřené záloze |

**Model identity (Scénář A — plné členství, živé autorství):** federovaný
`principal` je napříč backendy stabilní, takže import **zachová** `memberIds`,
`roles`, mapu `companies` i všechna autorská pole (`createdBy`, klíče `approvals`,
`reviewedBy`, …) a importujícího uživatele **jen přidá** jako `admin`. Doc IDs se
zachovávají 1:1 (ploché joiny jako `documentVersions↔documentId`); cílové
`projectId` je defaultně shodné se zdrojovým (dva oddělené Firestore).

**Bezpečnost / co se NEpřenáší:**
- `shareLinks` (bearer tokeny) a `notificationQueue` (přechodná fronta) se zahazují.
- `verificationTargetUrl`/`verificationShareToken`/`qrOverlay*` a QR-`verified/` PDF
  se strhnou/nepřenášejí — zapékají **zdrojový apiKey**; ověřovací QR dokumentů se
  v cíli **musí přegenerovat** po schválení.
- Autorizace: obě strany vyžadují owner/admin daného workspace (`requireWorkspaceAdmin`),
  jen podepsané `storage.googleapis.com` URL; limity 750 MB / 200 MB soubor / 100k docs / 20k souborů.

**Bezpečnost importu:** `importProjectBackup` bere nedůvěryhodný vstup (záloha od
jiné instance). Cesty dokumentů v manifestu procházejí allowlistem
(`isTransferableDocumentPath`) — povolené jsou jen oba stromy projektu a ploché
`workspaces/{wid}/companies/{id}`; cokoli jiného manifest odmítne (jinak by
vyrobená záloha mohla přepsat cizí projekt / workspace doc / pozvánky). ZIP má
strop na rozbalenou velikost položek (`assertEntryNotBomb`), principal se validuje
před použitím v cestě.

**První nasazení (bbfs):** nasazují se JEN `exportProjectBackup` +
`importProjectBackup` (přesně co wizard volá). `prepareProjectBackupImport`
(upload-staging) a `deleteProjectPermanently` (destruktivní) se zatím NEnasazují —
viz follow-up.

**Známá omezení / follow-up (před nasazením prepare/delete):**
- `prepareProjectBackupImport`: staging cesta `workspaces/{wid}/openbuildos-imports/**`
  je dnes pokrytá generickým `storage.rules` (čitelná/zapisovatelná členy firmy) →
  před nasazením přidat deny (jen funkce + signed URL). Wizard tuto funkci nepoužívá
  (jede přímý přenos přes `sourceUrl`).
- `deleteProjectPermanently`: gate „ověřená záloha" akceptuje i STAROU zálohu
  (kontroluje jen existenci + metadata projektu, ne čerstvost/hashe) → před
  nasazením svázat delete s konkrétní zálohou z téhož flow.
- `verificationTargetUrl` je strženo; případný zbytkový `k=<apiKey>` v jiných polích
  se negeneralizovaně nečistí (Firebase web apiKey je veřejný identifikátor).
- Rollback neúspěšného importu maže projektové stromy, **ne** merge-nuté firmy
  (`companies` s merge+zachovanými IDs → re-import je idempotentní).
- Nefederovaní (dev-uid) členové v cíli nedosednou — degradace na provenance je
  zatím na re-invite, import je neodlišuje.
- Exportované zálohy nemají TTL/lifecycle; `archiver` + `unzipper` jako runtime deps.

## Konfigurace

| Proměnná              | Výchozí       | Význam                                      |
| --------------------- | ------------- | ------------------------------------------- |
| `CENTRAL_PROJECT_ID`  | `openbuildos` | Projekt, jehož tokenům funkce důvěřuje.     |

Region funkce je `europe-west1`.
