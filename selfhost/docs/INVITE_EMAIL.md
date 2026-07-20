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

1. **Vytvoř „app password"** pro schránku, ze které chceš posílat.
   - Google Workspace / Gmail: účet → Zabezpečení → Hesla aplikací.
     Host `smtp.gmail.com`, port `465`.
   - Office365: povol SMTP AUTH pro schránku. Host `smtp.office365.com`, port `587`.

2. **Ulož secrety** (nikdy je nedávej do repa):

   ```bash
   firebase functions:secrets:set SMTP_HOST        --project <firma>   # smtp.gmail.com
   firebase functions:secrets:set SMTP_PORT        --project <firma>   # 465 nebo 587
   firebase functions:secrets:set SMTP_USER        --project <firma>   # pozvanky@firma.cz
   firebase functions:secrets:set SMTP_PASS        --project <firma>   # app password
   firebase functions:secrets:set INVITE_MAIL_FROM --project <firma>   # OpenBuildOS <pozvanky@firma.cz>
   ```

   `INVITE_MAIL_FROM` je odesílatel; u SMTP se typicky **musí shodovat**
   se `SMTP_USER` (jinak server zápis odmítne).

3. **Nasaď funkce:**

   ```bash
   firebase deploy --only functions --project <firma> --account <vlastník firmy>
   ```

4. **Vlastní doména appky?** Když si appku hostuješ na jiné adrese než výchozí,
   přidej ji do `APP_ORIGINS` (čárkou oddělené), jinak funkce odkaz odmítne
   (env proměnná functions `APP_ORIGINS`).

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
