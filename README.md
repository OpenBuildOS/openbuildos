# OpenBuildOS — Self-Host Deploy Kit

> **EN summary:** This is the public self-host deploy kit for OpenBuildOS. It lets
> a construction company deploy its own OpenBuildOS backend (auth federation
> function + Firestore/Storage security rules) into its own Firebase project, so
> all company data stays in its own cloud. The frontend app is hosted centrally
> by the operator and will be added to this repo later as `app/`.
> The fastest way to deploy is the **Open in Cloud Shell** button below.

---

OpenBuildOS je jednoduchý stavební software, který v jednom nástroji spojuje
sdílení dokumentů, terénní práci a evidenci projektu — bez složitosti velkých
systémů. Cílem je extrémní jednoduchost pro malé stavební firmy.

## Co je tohle repo

Tohle je **self-host deploy kit** OpenBuildOS. Umožní firmě nasadit **vlastní
backend** (federační funkci `authExchange` + bezpečnostní pravidla pro Firestore
a Storage) do **vlastního Firebase projektu**. Data firmy tak zůstávají v její
vlastní cloudové infrastruktuře.

Frontendovou aplikaci hostuje operátor centrálně; do tohoto repa se přidá později
jako `app/`.

## Quickstart přes Cloud Shell (doporučeno)

Nejrychlejší cesta k nasazení — kliknutím se otevře Google Cloud Shell
s připraveným průvodcem:

[![Open in Cloud Shell](https://gstatic.com/cloudssh/images/open-btn.svg)](https://shell.cloud.google.com/cloudshell/open?cloudshell_git_repo=https://github.com/OpenBuildOS/openbuildos.git&cloudshell_git_branch=main&cloudshell_workspace=selfhost&cloudshell_tutorial=docs/cloudshell-tutorial.md)

Průvodce vás provede předpoklady ve Firebase konzoli a samotným nasazením. Viz
[`selfhost/docs/cloudshell-tutorial.md`](selfhost/docs/cloudshell-tutorial.md).

## Alternativa — lokální spuštění

Pokud máte lokálně nainstalované `node`, `firebase-tools` a `gcloud`:

```bash
cd selfhost
npm run setup:company -- --project PROJECT_ID
```

`PROJECT_ID` nahraďte Project ID svého Firebase projektu (`gcloud projects list`
vám ID vypíše).

Podrobnosti k companion CLI najdete v
[`selfhost/docs/COMPANION_CLI.md`](selfhost/docs/COMPANION_CLI.md).

## Licence

Tento projekt je licencován pod **GNU AGPL-3.0** (viz [`LICENSE`](LICENSE)) —
ochranná open-source licence: kdokoliv provozuje (i upravený) kód jako síťovou
službu, musí zpřístupnit zdrojový kód svých úprav. Volba licence se může ještě
upřesnit (drží ji autor projektu).
