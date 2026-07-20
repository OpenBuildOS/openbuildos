import * as logger from "firebase-functions/logger";

/**
 * Provider-agnostický odesílací bod pro transakční e-maily firemního backendu.
 *
 * Proč abstrakce: self-host firmy mají různou mail infrastrukturu. Kit musí jít
 * nasadit s Resendem (default, nejmíň práce), ale i proti firemnímu SMTP nebo
 * SendGridu bez zásahu do volající funkce. Přidání providera = jedna implementace
 * `MailProvider` + jedna větev v `resolveMailProvider()`; volající kód se nemění.
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
 * Vybere adaptér podle toho, co má firma nakonfigurované.
 *
 * INTEGRAČNÍ BOD pro další providery — přidej větev výše/pod Resend:
 *
 *   SendGrid:  `if (process.env.SENDGRID_API_KEY) return new SendGridProvider(...)`
 *              POST https://api.sendgrid.com/v3/mail/send, Bearer auth.
 *   SMTP:      `if (process.env.SMTP_HOST) return new SmtpProvider(...)`
 *              vyžaduje přidat `nodemailer` do functions/package.json
 *              a secrety SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS.
 *
 * Klíč se čte z Functions secretu (`firebase functions:secrets:set RESEND_API_KEY`),
 * který runtime vystaví jako proměnnou prostředí — nikdy se necommituje do repa.
 */
export function resolveMailProvider(): MailProvider {
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    return new ResendProvider(resendKey);
  }

  throw new MailNotConfiguredError(
    "Není nakonfigurovaný žádný mail provider. Nastav secret RESEND_API_KEY " +
      "(`firebase functions:secrets:set RESEND_API_KEY`) a redeployuj functions."
  );
}

/**
 * Odesílatel. Musí být doména ověřená u providera, jinak provider e-mail odmítne
 * nebo skončí ve spamu. Formát: `OpenBuildOS <pozvanky@firma.cz>`.
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
