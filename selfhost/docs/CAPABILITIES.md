# Kapacity a moduly — co váš Firebase projekt potřebuje pro jednotlivé funkce

OpenBuildOS je modulární: každý **workspace** (firemní Firebase projekt) má na
dokumentu `workspaces/{projectId}` pole `modules`, které říká, co je zapnuté.
Zapínání a vypínání modulů dělá **workspace admin v appce**:
**Nastavení → Moduly**. Setup CLI (`openbuildos-setup`) při onboardingu
**zapne maximum automaticky** — všechno, na co projekt má kapacity
(volbou `--minimal` naopak zapne jen jádro).

Tenhle dokument říká, **který modul co vyžaduje**, kolik to stojí a jaké ruční
kroky v konzoli jsou potřeba.

## Přehled (matice kapacit)

| Modul | Vyžaduje | Plán | Ruční krok v konzoli |
| --- | --- | --- | --- |
| Úkoly, Plány, Fotky, Deník, Dokumenty | Firestore | Spark (zdarma) | — |
| Fotky/Dokumenty — **soubory** | Storage | Spark¹ | zapnout Storage (EU/eur3) |
| Firemní prostory (`companySpaces`) | Blaze, Storage, Functions | Blaze | upgrade na Blaze + deploy functions |
| Hlasové úkoly (`voiceTaskCapture`) — Gemini | AI Logic, App Check | Spark | zapnout Firebase AI Logic + registrovat App Check |
| Hlasové úkoly — self-host | Blaze, Functions | Blaze | deploy `aiParse` + endpoint Ollama |

¹ Storage bucket `*.firebasestorage.app` vyžaduje **jednorázové zapnutí
v konzoli** (Build → Storage → Get started). Po zapnutí je zdarma v rámci
Spark limitů.

---

## Jádrové moduly — Úkoly, Plány, Fotky, Deník, Dokumenty

- **Prerekvizity:** jen **Firestore** (zapíná se při onboardingu, viz
  [cloudshell-tutorial.md](./cloudshell-tutorial.md), krok 1).
- **Jak zapnout:** nijak — jádro je **vždy zapnuté**, setup CLI ho zapíše
  automaticky a v appce ho nelze vypnout.
- **Cena/plán:** **Spark, zdarma** (platí Spark limity Firestore).

Metadata fotek a dokumentů fungují i bez Storage; **soubory** (upload/stažení
originálů, výkresy) potřebují zapnuté Storage — viz další sekce.

## Soubory ve Fotkách a Dokumentech (Storage)

- **Prerekvizity:** zapnutý **Firebase Storage** (bucket
  `<projectId>.firebasestorage.app`).
- **Jak zapnout:**
  1. [Firebase konzole](https://console.firebase.google.com/) → váš projekt →
     **Build → Storage → Get started** → lokace **EU (`eur3`)**.
     ⚠️ Lokaci nejde později změnit.
  2. Spusť krok Úložiště (nasadí `storage.rules` + CORS) — buď znovu celý
     `openbuildos-setup` (krok 9 to udělá sám), nebo samostatně:
     ```bash
     node scripts/openbuildos-storage-setup.mjs --project <projectId>
     ```
- **Cena/plán:** **Spark, zdarma** po zapnutí (v rámci Spark limitů Storage);
  nad limity pay-as-you-go na Blaze.

## Firemní prostory (`companySpaces`)

Interní dokumenty firmy, sdílení mezi projekty, federační funkce navíc.

- **Prerekvizity:** plán **Blaze** + zapnutý **Storage** + nasazené
  **Cloud Functions** (deploy dělá `openbuildos-setup`, krok 4).
- **Jak zapnout:**
  1. **Upgrade na Blaze**: konzole → ozubené kolo → *Usage and billing* →
     *Modify plan* (`https://console.firebase.google.com/project/<projectId>/usage/details`).
  2. Zapni **Storage** (viz výše).
  3. Spusť `openbuildos-setup` — nasadí functions a při splněných kapacitách
     modul **zapne automaticky** (pokud jsi nedal `--minimal`).
  4. Případně doladíš v appce: **Nastavení → Moduly**.
- **Cena/plán:** **Blaze** (pay-as-you-go). Malý provoz se typicky vejde do
  free tieru — platí se jen skutečné využití nad limity.

## Hlasové úkoly (`voiceTaskCapture`)

Diktování úkolů hlasem s AI parsováním (capture-first, potvrzovací fronta).
Setup CLI tenhle modul **nikdy nezapíná automaticky** — vyžaduje ruční kroky
v konzoli a **výslovný souhlas admina** (odesílání hlasových přepisů AI
poskytovateli) přímo v appce.

### Varianta A — Gemini (doporučená, funguje na Sparku)

- **Prerekvizity:** **Firebase AI Logic** + registrovaný **App Check**.
- **Jak zapnout:**
  1. Konzole → **AI Logic** (`https://console.firebase.google.com/project/<projectId>/ailogic`)
     → *Get started* → vyber **Gemini Developer API** (zdarma na Sparku).
  2. Konzole → **App Check** (`https://console.firebase.google.com/project/<projectId>/appcheck`)
     → registruj webovou aplikaci (reCAPTCHA v3 / Enterprise). Bez App Check
     by AI endpoint mohl zneužít kdokoliv s configem.
  3. V appce: **Nastavení → Moduly → Hlasové úkoly** → zapni a potvrď souhlas
     (provider `gemini`, `consentGiven: true`).
- **Cena/plán:** **Spark, zdarma** v rámci free tieru Gemini API; orientačně
  **~0,004 Kč na úkol** (Gemini Flash) — tj. i stovky úkolů měsíčně za
  jednotky korun.

### Varianta B — self-host (bez odesílání dat Googlu)

- **Prerekvizity:** plán **Blaze** + nasazená funkce **`aiParse`** + vlastní
  **Ollama endpoint** (lokální LLM server, na který funkce volá).
- **Jak zapnout:** upgrade na Blaze, deploy funkce `aiParse` z tohoto repa
  (až bude součástí `functions/`), nastavení URL Ollama endpointu a pak
  v appce **Nastavení → Moduly → Hlasové úkoly** (provider self-host).
- **Cena/plán:** **Blaze** (samotné volání funkce je levné; hlavní náklad je
  provoz vlastního Ollama serveru).

---

## Jak s tím pracuje setup CLI

- `openbuildos-setup` po nasazení federace **zdetekuje kapacity** projektu
  (Blaze, existence Storage bucketu; AI Logic a App Check přes API
  detekovat nejdou → hlásí se jako „neznámé") a zapíše
  `workspaces/{projectId}.modules`.
- **Co je neznámé nebo chybí, se nezapíná** — skript to místo toho vypíše
  v závěrečném **checklistu** (varování) s přesným ručním krokem a URL.
- Zápis je **nedestruktivní**: existující `modules` (volby admina z appky)
  se nepřepisují, doplňují se jen chybějící moduly.
- `--enable-all` (výchozí) zapne vše, na co jsou kapacity; `--minimal` zapne
  jen jádro.

Podrobnosti o CLI: [COMPANION_CLI.md](./COMPANION_CLI.md).
