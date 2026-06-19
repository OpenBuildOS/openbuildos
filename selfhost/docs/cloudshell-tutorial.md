# Nasazení OpenBuildOS backendu pro vaši firmu

Vítejte. Tento průvodce vás krok za krokem provede nasazením vlastního
**OpenBuildOS backendu** do vašeho Firebase projektu. Veškerá data vaší firmy
tak zůstanou ve vaší vlastní cloudové infrastruktuře.

- **Co to udělá:** nasadí ověřovací funkci a bezpečnostní pravidla pro databázi
  a úložiště do vašeho Firebase projektu.
- **Jak dlouho to trvá:** zhruba 5 minut.
- **Kolik to stojí:** v běžném provozu se vejdete do **bezplatného tieru** Google
  Cloud. Platí se jen za skutečné využití nad rámec free limitů.

---

## Krok 1 — Předpoklady ve Firebase konzoli

Než spustíte instalaci, připravte si ve [Firebase konzoli](https://console.firebase.google.com/)
následující (stačí jednou):

1. **Vytvořte projekt** (nebo použijte existující). Poznamenejte si jeho
   **Project ID** — budete ho potřebovat níže.
2. **Firestore Database** → *Create database* → vyberte lokaci **`eur3`**
   (Evropa).
3. **Authentication** → *Get started*. Žádného poskytovatele přihlášení
   zapínat nemusíte — stačí Authentication aktivovat.
4. **Upgrade na plán Blaze** (*Pay as you go*). Bez něj nelze nasadit
   funkce. Pro malý provoz zůstáváte v rámci bezplatných limitů.

---

## Krok 2 — Spusťte instalaci

Cloud Shell vás otevře rovnou ve složce `selfhost`, takže nikam nemusíte
přepínat. V terminálu (otevře se vpravo nebo dole) spusťte:

```bash
firebase login --no-localhost
node scripts/openbuildos-setup.mjs
```

Skript se na **Project ID** vašeho Firebase projektu (z kroku 1) sám zeptá.

Volitelně ho můžete předat rovnou — `PROJECT_ID` nahraďte svým skutečným ID
(`gcloud projects list` vám ID vypíše):

```bash
node scripts/openbuildos-setup.mjs --project PROJECT_ID
```

Skript je možné spustit i opakovaně — když něco selže, jen ho pusťte znovu.

---

## Krok 3 — Propojte backend s aplikací OpenBuildOS

Až instalace doběhne, vypíše na konec **URL ověřovací funkce**. Vypadá zhruba
takto:

```
https://authexchange-xxxxxxxxxx-ew.a.run.app
```

1. Tuto URL **zkopírujte**.
2. Otevřete aplikaci **OpenBuildOS** → **Připojení firmy** → pole
   **„URL ověřovací funkce"** a URL sem vložte.
3. **Přihlaste se přes svůj OpenBuildOS účet.**

Hotovo — vaše firma má teď vlastní backend a všichni se k němu přihlašují
jediným OpenBuildOS účtem.
