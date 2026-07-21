# Companion CLI — `openbuildos-setup`

Node skript, který za firmu zautomatizuje **asistovaný self-host onboarding**
federačního backendu OpenBuildOS. Nahrazuje ruční postup z
[`SELF_HOST_ONBOARDING_LOG.md`](./SELF_HOST_ONBOARDING_LOG.md).

## Co dělá

Do firemního Firebase projektu (na plánu Blaze) nasadí:

1. **Firestore pravidla** (`firestore.rules`) — s retry/backoffem.
2. **Token-exchange funkci `authExchange`** (`functions/`) — `--force` deploy
   (1. pokus čerstvého Blaze projektu typicky selže na *build service account*,
   retry to vyřeší; `--force` zároveň nastaví **artifact cleanup policy**).

A nastaví **dvě IAM role**, bez kterých federace nefunguje:

| Role | Kde | Proč |
| --- | --- | --- |
| `roles/run.invoker` pro `allUsers` | Cloud Run služba `authexchange` | Gen2 funkce = Cloud Run; bez veřejného invokeru vrací **403** a browser federaci nezavolá. |
| `roles/iam.serviceAccountTokenCreator` | runtime SA funkce **sám na sebe** | Bez něj `createCustomToken` → `signBlob denied` → **401**. |

Nakonec vypíše **funkce URL** (`https://authexchange-…-ew.a.run.app`) a návod,
kam ji v appce vložit.

Skript je **idempotentní** — lze ho spustit opakovaně.

## Kapacity a moduly (kroky 8–10)

Po federaci skript navíc:

1. **Zdetekuje kapacity projektu** (best-effort): Blaze (úspěšný deploy
   functions = jistota), existenci Storage bucketu (REST dotaz na
   `<projectId>.firebasestorage.app`); AI Logic a App Check přes API
   detekovat nejdou → „neznámé“.
2. **Spustí krok Úložiště** — zavolá sdílený `openbuildos-storage-setup.mjs`
   (storage.rules + CORS) jako child process, jen když Storage existuje nebo
   to potvrdíš. Selhání je jen varování, ne pád.
3. **Zapíše `workspaces/{projectId}.modules`** — mapu modulů, kterou čte appka
   (**Nastavení → Moduly**). Jádro (Úkoly, Plány, Fotky, Deník, Dokumenty) je
   vždy zapnuté; **Firemní prostory** se zapnou jen při Blaze + Functions +
   Storage; **Hlasové úkoly** nikdy automaticky (vyžadují AI Logic + App Check
   + souhlas admina v appce). Existující `modules` se **nepřepisuje** — jen se
   doplní chybějící moduly.

| Volba | Význam |
| --- | --- |
| `--enable-all` | Zapne všechny moduly, na které projekt má kapacity (**výchozí**). |
| `--minimal` | Zapne jen jádrové moduly; volitelné nechá vypnuté. |

Co zapnout nešlo, skončí v závěrečném **checklistu varování** s přesným ručním
krokem. Kompletní matice „modul → prerekvizity → jak zapnout → cena“:
**[CAPABILITIES.md](./CAPABILITIES.md)**.

## Předpoklady (zajistí člověk předem)

- **Node** + **firebase-tools** (volá se `npx firebase`) + **gcloud SDK**
  (na PATH nebo v `~/google-cloud-sdk/bin/gcloud`).
- `gcloud auth login` jako **vlastník firemního projektu**.
  > Pozn.: loopback login flow potřebuje interaktivní terminál — z agent/IDE
  > backgroundu nemusí fungovat. Spusť `gcloud auth login` ručně v Terminálu.
- Firemní **Firebase projekt na plánu Blaze**, se zapnutým **Firestore** a
  **Authentication** (vytvoření projektu + Blaze + karta = ruční kroky v konzoli,
  Google je přes API bez billingu nepustí).

## Použití

```bash
node scripts/openbuildos-setup.mjs --project <companyProjectId> \
  [--region europe-west1] [--firebase-account <email>] [--yes]

# nebo přes npm:
npm run setup:company -- --project <companyProjectId>
```

Bez `--project` se skript zeptá interaktivně. Bez `--yes` si vyžádá potvrzení
před zásahem do projektu.

| Volba | Význam |
| --- | --- |
| `--project <id>` | ID firemního Firebase projektu (povinné; jinak dotaz). |
| `--region <r>` | Region funkce. Default `europe-west1`. |
| `--firebase-account <mail>` | Předá se firebase-tools jako `--account`. |
| `--yes` | Přeskočí potvrzovací dotazy. |
| `--enable-all` | Zapne všechny moduly s dostupnými kapacitami (výchozí). |
| `--minimal` | Zapne jen jádrové moduly (viz [CAPABILITIES.md](./CAPABILITIES.md)). |
| `--help` | Vypíše nápovědu a skončí. |

## Robustnost

- Každý krok v `try/catch` s čitelnou českou hláškou; helper `run(cmd,args,{retries})`
  dělá **exponenciální backoff** (deploy rules 2×, deploy funkce 2× s delším
  základem).
- Skript **nikdy nevypisuje tajemství** (nečte tokeny ani service-account klíče).
- Na konci **shrnutí**: projekt, region, URL, seznam varování.

## Troubleshooting — org policy (Domain Restricted Sharing)

Pokud má firemní Google Workspace zapnutou org policy
`constraints/iam.allowedPolicyMemberDomains` (**Domain Restricted Sharing**),
přidání `allUsers` na Cloud Run **selže**. Skript to **detekuje** a místo pádu
vypíše varování s možnostmi:

1. Admin organizace **upraví org policy** (povolí `allUsers` / public sharing),
   pak skript spustit znovu (idempotentní).
2. Nebo zvolit **jiný přístup** k funkci (API Gateway / Firebase Hosting rewrite).

Bez veřejného invokeru vrací Cloud Run `403` a federace z browseru neproběhne.

## Co zůstává na člověku

- Přihlášení do Firebase/Google konzole, vytvoření projektu, **Blaze + karta**.
- Zapnutí **Firestore** a **Authentication** v konzoli.
- `gcloud auth login` (interaktivně v Terminálu).
- **Vložení funkce URL do připojení firmy v appce** (skript ji jen vypíše;
  auto-registrace zpět do appky zatím není součástí).
- Případná úprava org policy (viz výše).
