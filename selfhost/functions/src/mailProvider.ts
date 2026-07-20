import { createTransport } from "nodemailer";
import * as logger from "firebase-functions/logger";

/**
 * Provider-agnostický odesílací bod pro transakční e-maily firemního backendu.
 *
 * Proč abstrakce: self-host firmy mají různou mail infrastrukturu. Kit musí jít
 * nasadit proti firemnímu SMTP (default — posílá z reálné firemní schránky, bez
 * DNS setupu) i proti Resendu, bez zásahu do volající funkce. Přidání providera
 * = jedna implementace `MailProvider` + jedna větev v `resolveMailProvider()`;
 * volající kód se nemění.
 */

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface MailProvider {
  /** Jméno do logů (nikdy neobsahuje tajemství). */
  readonly name: string;
  send(message: MailMessage, from: string): Promise<void>;
}

/** Chyba konfigurace mailu — volající ji mapuje na `failed-precondition`. */
export class MailNotConfiguredError extends Error {}

/**
 * SMTP (nodemailer) — DEFAULT adaptér.
 *
 * Posílá přes firmou provozovaný mailserver (Google Workspace, Office365,
 * hosting mail). Výhoda pro self-host: pozvánka odchází z REÁLNÉ firemní
 * schránky, kterou firma už vlastní, bez nastavování DNS/DKIM navíc (doména
 * má mail už rozběhnutý). Autentizace přes app password (ne heslo k účtu).
 *
 * Konfigurace přes Functions secrety:
 *   SMTP_HOST  (např. smtp.gmail.com / smtp.office365.com)
 *   SMTP_PORT  (465 = implicit TLS, 587 = STARTTLS)
 *   SMTP_USER  (celá e-mailová adresa schránky)
 *   SMTP_PASS  (app password)
 */
class SmtpProvider implements MailProvider {
  readonly name = "smtp";

  constructor(
    private readonly config: {
      host: string;
      port: number;
      user: string;
      pass: string;
    }
  ) {}

  async send(message: MailMessage, from: string): Promise<void> {
    const transport = createTransport({
      host: this.config.host,
      port: this.config.port,
      // 465 = spojení šifrované od začátku; 587 (a jiné) = STARTTLS upgrade.
      secure: this.config.port === 465,
      auth: { user: this.config.user, pass: this.config.pass },
    });
    // nodemailer chyby nesou SMTP odpověď serveru, ne přihlašovací údaje.
    await transport.sendMail({
      from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
  }
}

/**
 * Resend (https://resend.com) — DEFAULT adaptér.
 *
 * Zvolen pro self-host: čisté HTTPS API (žádná SMTP závislost v balíčku),
 * DKIM/SPF se nastavuje per doménu ve webovém UI, takže pozvánka odchází
 * z domény FIRMY — konzistentní s federačním modelem (odesílatel není centrál).
 */
class ResendProvider implements MailProvider {
  readonly name = "resend";

  constructor(private readonly apiKey: string) {}

  async send(message: MailMessage, from: string): Promise<void> {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
    });

    if (!response.ok) {
      // Tělo odpovědi Resendu neobsahuje API klíč, ale ať se do logu nedostane
      // nic nečekaného, ořízneme ho.
      const detail = (await response.text().catch(() => "")).slice(0, 500);
      throw new Error(`Resend odmítl e-mail (HTTP ${response.status}): ${detail}`);
    }
  }
}

/**
 * Vybere adaptér podle toho, co má firma nakonfigurované. SMTP má přednost —
 * když jsou nastavené SMTP secrety, posílá se přes firemní schránku; jinak se
 * zkusí Resend. Nastavené hodnoty se čtou z Functions secretů
 * (`firebase functions:secrets:set ...`), runtime je vystaví jako env proměnné.
 *
 * INTEGRAČNÍ BOD pro dalšího providera (např. SendGrid):
 *   `if (process.env.SENDGRID_API_KEY) return new SendGridProvider(...)`
 *   POST https://api.sendgrid.com/v3/mail/send, Bearer auth.
 */
export function resolveMailProvider(): MailProvider {
  // SMTP (default) — firemní schránka. Stačí, když je nastavený aspoň host.
  const smtpHost = process.env.SMTP_HOST;
  if (smtpHost) {
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    if (!user || !pass) {
      throw new MailNotConfiguredError(
        "SMTP_HOST je nastavený, ale chybí SMTP_USER nebo SMTP_PASS. " +
          "Nastav oba secrety (SMTP_USER = adresa schránky, SMTP_PASS = app password) a redeployuj."
      );
    }
    // Default 587 (STARTTLS) je nejběžnější; 465 = implicit TLS.
    const port = Number(process.env.SMTP_PORT || "587");
    if (!Number.isInteger(port) || port <= 0) {
      throw new MailNotConfiguredError(`SMTP_PORT '${process.env.SMTP_PORT}' není platné číslo portu.`);
    }
    return new SmtpProvider({ host: smtpHost, port, user, pass });
  }

  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    return new ResendProvider(resendKey);
  }

  throw new MailNotConfiguredError(
    "Není nakonfigurovaný žádný mail provider. Nastav SMTP secrety " +
      "(SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS) nebo RESEND_API_KEY a redeployuj functions."
  );
}

/**
 * Odesílatel. U SMTP se typicky MUSÍ shodovat s přihlášenou schránkou
 * (SMTP_USER), jinak server zápis odmítne; u Resendu musí být z ověřené domény.
 * Formát: `OpenBuildOS <pozvanky@firma.cz>` nebo prostá adresa `pozvanky@firma.cz`.
 */
export function resolveMailFrom(): string {
  const from = process.env.INVITE_MAIL_FROM;
  if (!from) {
    throw new MailNotConfiguredError(
      "Chybí INVITE_MAIL_FROM (odesílatel, např. `OpenBuildOS <pozvanky@firma.cz>`). " +
        "Nastav ho jako secret nebo env proměnnou functions a redeployuj."
    );
  }
  return from;
}

export function logMailSent(provider: MailProvider, context: Record<string, unknown>): void {
  // POZOR: nikdy nelogovat `to` v plném znění ani obsah e-mailu (PII).
  logger.info("Pozvánka odeslána", { provider: provider.name, ...context });
}
