/**
 * Ověří SMTP údaje DŘÍV, než je uložíš jako secrety a nasadíš funkci.
 *
 * Proč: `sendProjectInvite` selže až za běhu a chybu uvidíš jen v logu funkce.
 * Tohle ti dá odpověď na vteřiny a rovnou přeloží typické SMTP chyby.
 *
 * Použití (z adresáře selfhost/functions):
 *
 *   npm install                       # jednou, kvůli nodemailer
 *   SMTP_HOST=smtp.gmail.com \
 *   SMTP_PORT=465 \
 *   SMTP_USER=jmeno@gmail.com \
 *   SMTP_PASS='xxxx xxxx xxxx xxxx' \
 *   INVITE_MAIL_FROM='OpenBuildOS <Info@firma.cz>' \
 *   node checks/smtp-test.mjs prijemce@example.com
 *
 * Bez argumentu jen ověří připojení a přihlášení (nic neodešle).
 * S e-mailem v argumentu pošle skutečnou testovací zprávu.
 *
 * POZOR: heslo dávej do příkazu v uvozovkách a ideálně s mezerou na začátku
 * řádku (většina shellů takový příkaz neuloží do historie).
 */

import { createTransport } from "nodemailer";

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, INVITE_MAIL_FROM } = process.env;
const recipient = process.argv[2];

const missing = ["SMTP_HOST", "SMTP_USER", "SMTP_PASS"].filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`✗ Chybí proměnné: ${missing.join(", ")}`);
  console.error("  Viz komentář na začátku tohoto souboru.");
  process.exit(2);
}

const port = Number(SMTP_PORT || "587");
const from = INVITE_MAIL_FROM || SMTP_USER;

console.log("Nastavení, které se testuje:");
console.log(`  host      ${SMTP_HOST}:${port}  (${port === 465 ? "implicit TLS" : "STARTTLS"})`);
console.log(`  přihlášení ${SMTP_USER}`);
console.log(`  odesílatel ${from}`);
if (from !== SMTP_USER && !String(from).includes(String(SMTP_USER))) {
  console.log("  ⚠ Odesílatel se liší od přihlášení → server ho musí mít jako");
  console.log("    ověřený alias, jinak zprávu odmítne nebo přepíše hlavičku Od.");
}
console.log();

const transport = createTransport({
  host: SMTP_HOST,
  port,
  secure: port === 465,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
});

/** Přeloží typické SMTP chyby na srozumitelnou příčinu a další krok. */
function explain(error) {
  const code = error?.code ?? "";
  const response = String(error?.response ?? error?.message ?? "");

  if (code === "EAUTH" || /5\.7\.\d|authentication|username and password/i.test(response)) {
    return [
      "Přihlášení odmítnuto.",
      "  • Používáš app password (ne heslo k účtu)? U Googlu je nutné mít zapnuté 2FA.",
      "  • U Gmailu patří do SMTP_USER PRIMÁRNÍ adresa účtu, ne alias.",
      "  • Účet bez Gmail schránky (Google účet založený na cizí adrese) přes",
      "    smtp.gmail.com posílat NEUMÍ — pak zvol jinou cestu (viz docs).",
    ].join("\n");
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || /ENOTFOUND|getaddrinfo/i.test(response)) {
    return [
      `Hostname '${SMTP_HOST}' se nepodařilo přeložit — nejspíš překlep.`,
      "  • Gmail: smtp.gmail.com | Office365: smtp.office365.com",
      "  • Hosting: hodnotu najdeš v nápovědě poskytovatele (často smtp.<hosting>.cz).",
    ].join("\n");
  }
  if (code === "ETIMEDOUT" || code === "ESOCKET" || code === "ECONNECTION") {
    return [
      "Nepodařilo se navázat spojení.",
      "  • Sedí port? (465 = SSL, 587 = STARTTLS — na špatném portu spojení visí)",
      "  • Neblokuje odchozí SMTP tvoje síť/firewall?",
    ].join("\n");
  }
  if (/5\.7\.1|not allowed|relay|sender/i.test(response)) {
    return [
      "Server odmítl odesílatele (relay/sender).",
      "  • Adresa v INVITE_MAIL_FROM musí být na serveru povolená (ověřený alias).",
      "  • Někteří poskytovatelé zakazují odesílání z aplikací úplně — zkontroluj",
      "    jejich podmínky (viz varování v docs/INVITE_EMAIL.md).",
    ].join("\n");
  }
  return `Neznámá chyba.\n  ${response || error}`;
}

try {
  await transport.verify();
  console.log("✓ Připojení i přihlášení OK.");
} catch (error) {
  console.error("✗ Připojení/přihlášení selhalo.\n");
  console.error(explain(error));
  process.exit(1);
}

if (!recipient) {
  console.log("\nHotovo (jen ověření). Chceš-li poslat testovací zprávu:");
  console.log("  node checks/smtp-test.mjs prijemce@example.com");
  process.exit(0);
}

try {
  const info = await transport.sendMail({
    from,
    to: recipient,
    subject: "OpenBuildOS — test odesílání",
    text: "Tohle je testovací zpráva z checks/smtp-test.mjs. Když ti dorazila, SMTP funguje.",
  });
  console.log(`✓ Zpráva odeslána (id ${info.messageId}).`);
  console.log("\nZkontroluj u příjemce:");
  console.log("  • DORAZILA? Když ne, mrkni do spamu.");
  console.log(`  • Je v poli Od skutečně '${from}'?`);
  console.log("    Když tam je jiná adresa, server hlavičku přepsal → alias není ověřený.");
  console.log("  • Nemá zpráva varování typu „odesláno přes…\"? To řeší SPF záznam domény.");
} catch (error) {
  console.error("✗ Odeslání selhalo.\n");
  console.error(explain(error));
  process.exit(1);
}
