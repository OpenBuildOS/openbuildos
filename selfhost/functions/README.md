# OpenBuildOS — Cloud Functions

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

> **Tip — companion CLI:** Místo ručního postupu lze použít skript, který nasadí
> pravidla i funkci (s retry pro čerstvý Blaze projekt) a nastaví potřebné IAM
> role (veřejný `run.invoker` + `serviceAccountTokenCreator`):
> `npm run setup:company -- --project <id-firemního-projektu>`
> Detaily a troubleshooting org policy: [`docs/COMPANION_CLI.md`](../docs/COMPANION_CLI.md).

## Aktualizace

Funkce je **součástí open-source repozitáře** OpenBuildOS. Při aktualizaci stačí
znovu spustit `firebase deploy --only functions --project <firma>` — nasadí se
nová verze.

## Životní cyklus projektu

Balíček nasazuje také callable funkce:

- `exportProjectBackup` vytvoří přenositelný `.obosbackup` ZIP s verzovaným manifestem,
  Firestore daty, Storage objekty a SHA-256 kontrolními součty. Odkaz platí jednu hodinu.
- `importProjectBackup` obnoví balíček nahraný pod
  `workspaces/{wid}/openbuildos-imports/{principal}/`, přemapuje workspace/project ID a nastaví
  volajícího jako nového vlastníka projektu. Staré členství a share linky se neaktivují.
- `deleteProjectPermanently` kaskádově odstraní Firestore i Storage až po typed confirmation a
  ověření, že existuje záloha stejného projektu.

Všechny tři operace smí spustit pouze vlastník nebo správce workspace. Funkce mají limit 2 GiB
paměti a timeout 60 minut; extrémně velké projekty budou v další verzi potřebovat Cloud Run job.

## Konfigurace

| Proměnná              | Výchozí       | Význam                                      |
| --------------------- | ------------- | ------------------------------------------- |
| `CENTRAL_PROJECT_ID`  | `openbuildos` | Projekt, jehož tokenům funkce důvěřuje.     |

Region funkce je `europe-west1`.
