# E-mailové pozvánky (`sendProjectInvite`)

Odesílání pozvánek e-mailem je **volitelná** schopnost firemního backendu.
Když ji nenastavíš, aplikace funguje dál — jen zůstane u dnešního
„zkopírovat odkaz" a odkaz pošleš ručně.

## Proč to běží na firemním projektu

Centrální projekt OpenBuildOS běží na Sparku a e-maily posílat nemůže.
Odesílání je proto firemní schopnost:

- pozvánka odchází z **vaší domény** (vaše SPF/DKIM) → lepší doručitelnost
  a příjemce vidí odesílatele, kterého zná,
- centrál nedrží vaše mail tajemství ani nenese náklady,
- je to konzistentní s federačním modelem (data i backend jsou vaše).

## Předpoklady

- Firebase projekt na plánu **Blaze** (Cloud Functions v2).
- Účet u mail providera. Výchozí a nejjednodušší je **[Resend](https://resend.com)**;
  stačí ověřit doménu a vygenerovat API klíč.

## Nastavení

1. **Ověř doménu** u providera a vytvoř API klíč.

2. **Ulož secrety** (nikdy je nedávej do repa):

   ```bash
   firebase functions:secrets:set RESEND_API_KEY --project <firma>
   firebase functions:secrets:set INVITE_MAIL_FROM --project <firma>
   ```

   `INVITE_MAIL_FROM` je odesílatel ve tvaru `OpenBuildOS <pozvanky@firma.cz>`.
   Doména **musí** být ta ověřená v kroku 1, jinak provider e-mail odmítne.

3. **Nasaď funkce:**

   ```bash
   firebase deploy --only functions --project <firma> --account <vlastník firmy>
   ```

4. **Vlastní doména appky?** Když si appku hostuješ na jiné adrese než výchozí,
   přidej ji do `APP_ORIGINS` (čárkou oddělené), jinak funkce odkaz odmítne:

   ```bash
   firebase functions:config:set   # nebo env proměnná APP_ORIGINS v runtime configu
   ```

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

## Jiný provider než Resend

Adaptér je izolovaný v `functions/src/mailProvider.ts`. Přidání providera =
implementace rozhraní `MailProvider` + jedna větev v `resolveMailProvider()`;
volající funkce se nemění. V souboru jsou konkrétní poznámky pro **SendGrid**
(HTTPS API) i **SMTP** (vyžaduje přidat `nodemailer` do `package.json`).

## Když mail nakonfigurovaný není

Funkce vrátí `failed-precondition` a frontend spadne zpět na „zkopírovat odkaz".
Není to chyba — je to podporovaný režim.
