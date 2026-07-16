# OpenBuildOS — `authExchange` (token-exchange federace)

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

## Konfigurace

| Proměnná              | Výchozí       | Význam                                      |
| --------------------- | ------------- | ------------------------------------------- |
| `CENTRAL_PROJECT_ID`  | `openbuildos` | Projekt, jehož tokenům funkce důvěřuje.     |

Region funkce je `europe-west1`.

---

## `pulseReport` — denní agregovaný reporter (OpenBuildOS Pulse, opt-in)

Volitelná scheduled funkce, která **jednou denně** spočítá jen **agregované
počty** z firemního backendu a pošle je **podepsané** centrálnímu endpointu
OpenBuildOS. Slouží k inventárním KPI („kolik projektů/úkolů/souborů celkem"),
které klientská analytika neumí. **Neodesílá** názvy, e-maily, obsah ani
identifikaci uživatelů — jen čísla.

### Vlastnosti
- **Opt-in:** bez `PULSE_REPORT_ENABLED=true` je to no-op.
- **Podepsané:** HMAC-SHA256 instalačním tajemstvím (`PULSE_INSTALL_SECRET`).
- **Fail-open:** jakákoliv chyba se zaloguje a spolkne, backend není dotčen.
- **Idempotentní:** report má klíč `{workspaceId}_{YYYY-MM-DD}`, opakování téhož
  dne přepíše stejný snapshot (žádné duplikáty).

### Konfigurace (Cloud Functions env / Secret Manager)

| Proměnná | Povinná | Význam |
| --- | --- | --- |
| `PULSE_REPORT_ENABLED` | ano | `true` zapne odesílání; cokoliv jiného = vypnuto |
| `PULSE_INGEST_URL` | ano | URL centrálního `pulseIngest` endpointu |
| `PULSE_INSTALL_SECRET` | ano | **Secret Manager!** Stejné tajemství drží centrální registr |
| `PULSE_WORKSPACE_ID` | ne | stabilní pseudonym; default = id firemního projektu |
| `PULSE_KIT_VERSION` | ne | verze self-host kitu do reportu |

> `PULSE_INSTALL_SECRET` **nikdy** necommituj a nedávej do `VITE_*`. Ulož do
> Secret Manageru a naváž na funkci (`--set-secrets`), viz deploy guide.

### Nasazení

```bash
cd selfhost/functions
npm install
firebase deploy --only functions:pulseReport --project <id-firemního-projektu>
```

`onSchedule` si automaticky vytvoří Cloud Scheduler job (vyžaduje Blaze).
Kompletní postup včetně provisioningu tajemství a centrálního registru je v
hlavním repu: `docs/OPENBUILDOS_PULSE_BACKEND.md`.

### Test

```bash
cd selfhost/functions && npm test
```
