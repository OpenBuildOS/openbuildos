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

```bash
cd functions
npm install
firebase deploy --only functions --project <id-firemního-projektu>
```

Po nasazení získáte URL funkce, např.:

```
https://europe-west1-<id-firemního-projektu>.cloudfunctions.net/authExchange
```

Tuto URL vložte v aplikaci do pole **„URL ověřovací funkce (token-exchange
endpoint)"** při připojování workspace (modal *Připojit workspace*).

> **Pozn.:** Tohle je RUČNÍ postup. Companion CLI níže navíc zapíše URL do
> `config/public`, takže si ji aplikace **najde sama** (auto-discovery) a ruční
> vložení pak není potřeba.

> **Tip — companion CLI:** Místo ručního postupu lze použít skript, který nasadí
> pravidla i funkci (s retry pro čerstvý Blaze projekt) a nastaví potřebné IAM
> role (veřejný `run.invoker` + `serviceAccountTokenCreator`):
> `npm run setup:company -- --project <id-firemního-projektu>`
> Detaily a troubleshooting org policy: [`docs/COMPANION_CLI.md`](../docs/COMPANION_CLI.md).

## Aktualizace

Funkce je **součástí open-source repozitáře** OpenBuildOS. Při aktualizaci stačí
znovu spustit `firebase deploy --only functions --project <firma>` — nasadí se
nové verze funkcí.

## Funkce v balíčku

- `authExchange` — federace centrální session do firemního backendu.
- `revokeShareLinkAndRotateToken` — callable funkce pro skutečnou revokaci
  veřejného share linku: označí Firestore záznam jako `revoked` a zároveň
  zrotuje Firebase Storage download token souboru.
- `sendProjectInvite` — odeslání pozvánky e-mailem (SMTP/Resend).
- **Přenos projektu (#291)** — `exportProjectBackup`, `prepareProjectBackupImport`,
  `importProjectBackup`, `deleteProjectPermanently` (viz níže).

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

**Známá omezení (první cut):**
- Rollback neúspěšného importu maže projektové stromy, **ne** merge-nuté firmy
  (`companies` s merge+zachovanými IDs → re-import je idempotentní).
- Nefederovaní (dev-uid) členové v cíli nedosednou — degradace na provenance je
  zatím na re-invite, import je neodlišuje.
- Přidává runtime deps `archiver` + `unzipper`.

## Konfigurace

| Proměnná              | Výchozí       | Význam                                      |
| --------------------- | ------------- | ------------------------------------------- |
| `CENTRAL_PROJECT_ID`  | `openbuildos` | Projekt, jehož tokenům funkce důvěřuje.     |

Region funkce je `europe-west1`.
