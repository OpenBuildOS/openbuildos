# E-mailové pozvánky (`sendProjectInvite`)

Odesílání pozvánek e-mailem je **volitelná** schopnost firemního backendu.
Když ji nenastavíš, aplikace funguje dál — jen zůstane u dnešního
„zkopírovat odkaz" a odkaz pošleš ručně.

## Proč to běží na firemním projektu

Centrální projekt OpenBuildOS běží na Sparku a e-maily posílat nemůže.
Odesílání je proto firemní schopnost:

- pozvánka odchází z **vaší schránky / domény** → lepší doručitelnost
  a příjemce vidí odesílatele, kterého zná,
- centrál nedrží vaše mail tajemství ani nenese náklady,
- je to konzistentní s federačním modelem (data i backend jsou vaše).

## Předpoklady

- Firebase projekt na plánu **Blaze** (Cloud Functions v2).
- Mail schránka nebo účet u providera. **Výchozí a nejjednodušší cesta je
  SMTP přes vaši existující firemní schránku** (Google Workspace, Office365,
  hosting mail) — posílá z reálné adresy, kterou už vlastníte, bez nastavování
  DNS navíc. Alternativa: [Resend](https://resend.com) (chce ověření domény).

## Nastavení — SMTP (doporučeno)

> ### ⚠️ Nejdřív ověř, jestli SMTP tvého poskytovatele tohle povoluje
>
> Spousta poskytovatelů pošty (typicky ti, co dělají hosting domén, ne transakční
> mail) **zakazuje** posílat přes svůj SMTP z webových aplikací a automatizovaných
> systémů — i když se do limitu vejdeš. Příklad: Český hosting v
> [politikách SMTP serverů](https://www.cesky-hosting.cz/napoveda/e-maily/politiky-smtp-serveru/)
> uvádí limit 300 zpráv/hod, ale zároveň že server *není* pro „odesílání zpráv
> z webových aplikací".
>
> Když aplikační odesílání nepovoluje, použij **alias přes Google** (níže) nebo
> transakčního providera (Resend).

1. **Zjisti SMTP údaje schránky a vytvoř „app password"** (ne heslo k účtu).
   - Google Workspace / Gmail: účet → Zabezpečení → dvoufázové ověření →
     Hesla aplikací. Host `smtp.gmail.com`, port `465`.
   - Office365: povol SMTP AUTH pro schránku. Host `smtp.office365.com`, port `587`.
   - Hosting domény (Wedos, Český hosting, Forpsi…): hostname a port najdeš
     v jejich nápovědě — viz varování výše.

2. **Otestuj údaje, než je uložíš jako secrety.** Ušetří to kolo
   „nastav secrety → nasaď → ono to nejde":

   ```bash
   cd selfhost/functions && npm install
   SMTP_HOST=… SMTP_PORT=… SMTP_USER=… SMTP_PASS=… INVITE_MAIL_FROM=… \
     node checks/smtp-test.mjs muj@email.cz
   ```

   Skript ověří připojení i přihlášení, pošle testovací zprávu a typické chyby
   přeloží na příčinu. Bez e-mailu v argumentu jen ověří přihlášení.

3. **Ulož secrety** (nikdy je nedávej do repa):

   ```bash
   firebase functions:secrets:set SMTP_HOST        --project <firma>   # smtp.gmail.com
   firebase functions:secrets:set SMTP_PORT        --project <firma>   # 465 nebo 587
   firebase functions:secrets:set SMTP_USER        --project <firma>   # pozvanky@firma.cz
   firebase functions:secrets:set SMTP_PASS        --project <firma>   # app password
   firebase functions:secrets:set INVITE_MAIL_FROM --project <firma>   # OpenBuildOS <pozvanky@firma.cz>
   ```

   `SMTP_USER` je účet, kterým se **přihlašuješ**; `INVITE_MAIL_FROM` je adresa
   v hlavičce **Od**. Většinou stejné — ale nemusí, viz alias níže.

4. **Nasaď funkce:**

   ```bash
   firebase deploy --only functions --project <firma> --account <vlastník firmy>
   ```

5. **Vlastní doména appky?** Když si appku hostuješ na jiné adrese než výchozí,
   přidej ji do `APP_ORIGINS` (čárkou oddělené), jinak funkce odkaz odmítne
   (env proměnná functions `APP_ORIGINS`).

### Odesílání přes alias (Google účet + adresa z jiné domény)

Časté u firem, které mají doménu i schránku u hostingu, ale používají ji
z Gmailu. Pak se **přihlašuješ Google účtem**, ale posíláš „jako" firemní adresa:

1. V Gmailu musí být adresa přidaná v *Nastavení → Účty → Odesílat pomocí* a
   **ověřená** (klik na potvrzovací odkaz). Bez ověření Google adresu v hlavičce
   Od přepíše zpět na přihlášený účet.
2. Na Google účtu zapni **dvoufázové ověření** a vytvoř **app password**
   (bez 2FA se app password nedá vygenerovat).
3. Secrety nastav takto — všimni si, že se `SMTP_USER` a `INVITE_MAIL_FROM`
   **liší**:

   ```
   SMTP_HOST        = smtp.gmail.com
   SMTP_PORT        = 465
   SMTP_USER        = <primární adresa Google účtu>     # NE alias!
   SMTP_PASS        = <app password>
   INVITE_MAIL_FROM = Firma <adresa@firma.cz>           # ověřený alias
   ```

⚠️ **Pozor na typ Google účtu.** Tohle funguje jen když má účet **skutečnou
Gmail schránku**. Google účet *založený na* firemní adrese (přihlašuješ se jí,
ale Gmail schránku k ní nemáš) přes `smtp.gmail.com` posílat neumí — přihlášení
skončí chybou. Ověříš to skriptem z kroku 2 dřív, než cokoli nasadíš.

**Doručitelnost:** e-mail poletí z Google IP, ale v hlavičce Od bude tvoje
doména. Aby ho příjemci nebrali jako podvrh, měla by mít doména **SPF záznam**,
který Google povoluje (`v=spf1 include:_spf.google.com ~all` — pokud posíláš
i odjinud, uveď i to). Bez SPF část příjemců e-mail označí nebo zahodí.

## Nastavení — Resend (alternativa)

Když chceš posílat přes Resend místo SMTP:

1. Ověř doménu u Resendu a vytvoř API klíč.
2. V `functions/src/sendProjectInvite.ts` přidej `RESEND_API_KEY` zpět do
   `defineSecret` i do pole `secrets: []` (viz komentář u deklarace secretů).
3. Nastav secrety `RESEND_API_KEY` + `INVITE_MAIL_FROM` (odesílatel z ověřené
   domény) a nasaď. SMTP secrety nenastavuj — bez `SMTP_HOST` se použije Resend.

## Co funkce kontroluje

Funkce **nevěří klientovi** nic kromě identity. Než odešle e-mail, ověří že:

1. volající je přihlášený do firemního backendu (přes `authExchange`),
2. je **správcem projektu** — zrcadlí `canManageProject()` z `firestore.rules`,
3. pozvánka `workspaces/{wid}/invites/{token}` **skutečně existuje**, patří
   danému projektu, je schválená, nepoužitá a neexpirovaná,
4. `inviteUrl` míří na **známý origin** appky a obsahuje daný token.

Body 3 a 4 jsou zásadní: bez nich by šla funkce zneužít jako **otevřená relay** —
kdokoli s právem volat by rozesílal libovolný obsah a libovolné odkazy
podepsané DKIM vaší domény. To je přesně ten typ díry, kvůli kterému se
nedoporučuje pouštět klienta přímo do kolekce `mail/` (extension
„Trigger Email from Firestore"), kde se autorizace nemá kam pověsit.

## Další provider (např. SendGrid)

Adaptéry jsou izolované v `functions/src/mailProvider.ts` (dnes **SMTP** a
**Resend**). Přidání dalšího = implementace rozhraní `MailProvider` + jedna
větev v `resolveMailProvider()`; volající funkce se nemění. V souboru je
konkrétní poznámka pro **SendGrid** (HTTPS API).

## Když mail nakonfigurovaný není

Funkce vrátí `failed-precondition` a frontend spadne zpět na „zkopírovat odkaz".
Není to chyba — je to podporovaný režim.
