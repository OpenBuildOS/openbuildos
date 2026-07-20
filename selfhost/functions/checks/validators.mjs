import { validateInviteUrl, normalizeEmail } from "../lib/sendProjectInvite.js";
import { resolveMailProvider, MailNotConfiguredError } from "../lib/mailProvider.js";

const TOKEN = "abc-123-token";
let pass = 0, fail = 0;

function expectOk(label, fn) {
  try { fn(); console.log(`  ok   ${label}`); pass++; }
  catch (e) { console.log(`  FAIL ${label} → nečekaně odmítnuto: ${e.message}`); fail++; }
}
function expectReject(label, fn) {
  try { fn(); console.log(`  FAIL ${label} → PROŠLO, mělo být odmítnuto!`); fail++; }
  catch { console.log(`  ok   ${label} (odmítnuto)`); pass++; }
}
function expectEq(label, actual, expected) {
  if (actual === expected) { console.log(`  ok   ${label}`); pass++; }
  else { console.log(`  FAIL ${label} → čekal '${expected}', dostal '${actual}'`); fail++; }
}

// Izolace mezi případy — mail config žije v process.env.
const MAIL_KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "RESEND_API_KEY", "INVITE_MAIL_FROM"];
function clearMailEnv() {
  for (const k of MAIL_KEYS) delete process.env[k];
}

console.log("\n== inviteUrl: legitimní odkazy ==");
expectOk("krátký odkaz (#400, bez k)", () =>
  validateInviteUrl(`https://openbuildos.web.app/invite/bbfs-openbuildos/${TOKEN}?n=BBFS`, TOKEN));
expectOk("legacy odkaz s apiKey", () =>
  validateInviteUrl(`https://openbuildos-app.web.app/invite/bbfs/${TOKEN}?k=AIza&n=BBFS`, TOKEN));
expectOk("app.openbuildos.org", () =>
  validateInviteUrl(`https://app.openbuildos.org/invite/bbfs/${TOKEN}`, TOKEN));

console.log("\n== inviteUrl: útoky (musí být odmítnuto) ==");
expectReject("phishing na cizí doméně", () =>
  validateInviteUrl(`https://evil.example.com/invite/x/${TOKEN}`, TOKEN));
expectReject("lookalike doména", () =>
  validateInviteUrl(`https://openbuildos.web.app.evil.com/invite/${TOKEN}`, TOKEN));
expectReject("http místo https", () =>
  validateInviteUrl(`http://openbuildos.web.app/invite/x/${TOKEN}`, TOKEN));
expectReject("odkaz na jiný token", () =>
  validateInviteUrl("https://openbuildos.web.app/invite/x/JINY-TOKEN", TOKEN));
expectReject("javascript: schéma", () =>
  validateInviteUrl(`javascript:alert('${TOKEN}')`, TOKEN));
expectReject("subdoména povolené domény", () =>
  validateInviteUrl(`https://x.openbuildos.org/invite/${TOKEN}`, TOKEN));
expectReject("prázdný vstup", () => validateInviteUrl("", TOKEN));
expectReject("není string", () => validateInviteUrl(42, TOKEN));

console.log("\n== APP_ORIGINS rozšíření ==");
process.env.APP_ORIGINS = "https://stavby.bbfs.cz";
expectOk("vlastní doména po rozšíření", () =>
  validateInviteUrl(`https://stavby.bbfs.cz/invite/bbfs/${TOKEN}`, TOKEN));
delete process.env.APP_ORIGINS;
expectReject("stejná doména bez rozšíření", () =>
  validateInviteUrl(`https://stavby.bbfs.cz/invite/bbfs/${TOKEN}`, TOKEN));

console.log("\n== email ==");
expectOk("normalizace na lowercase", () => {
  const r = normalizeEmail("  Jan.Novak@BBFS.cz  ");
  if (r !== "jan.novak@bbfs.cz") throw new Error(`dostal '${r}'`);
});
expectReject("CRLF injektáž hlaviček", () =>
  normalizeEmail("a@b.cz\r\nBcc: victim@x.cz"));
expectReject("bez zavináče", () => normalizeEmail("neplatny"));
expectReject("bez domény", () => normalizeEmail("a@b"));

console.log("\n== výběr mail providera ==");
clearMailEnv();
expectReject("bez konfigurace → MailNotConfiguredError", () => resolveMailProvider());

clearMailEnv();
process.env.SMTP_HOST = "smtp.gmail.com";
process.env.SMTP_USER = "pozvanky@firma.cz";
process.env.SMTP_PASS = "app-pass";
expectEq("SMTP nakonfigurováno → provider 'smtp'", resolveMailProvider().name, "smtp");

clearMailEnv();
process.env.SMTP_HOST = "smtp.gmail.com"; // bez USER/PASS
expectReject("SMTP_HOST bez USER/PASS → chyba", () => resolveMailProvider());

clearMailEnv();
process.env.SMTP_HOST = "smtp.gmail.com";
process.env.SMTP_USER = "u@firma.cz";
process.env.SMTP_PASS = "p";
process.env.SMTP_PORT = "nesmysl";
expectReject("nečíselný SMTP_PORT → chyba", () => resolveMailProvider());

clearMailEnv();
process.env.RESEND_API_KEY = "re_123";
expectEq("jen Resend klíč → provider 'resend'", resolveMailProvider().name, "resend");

clearMailEnv();
process.env.SMTP_HOST = "smtp.gmail.com";
process.env.SMTP_USER = "u@firma.cz";
process.env.SMTP_PASS = "p";
process.env.RESEND_API_KEY = "re_123";
expectEq("SMTP má přednost před Resendem", resolveMailProvider().name, "smtp");
clearMailEnv();

console.log(`\n=== ${pass} prošlo, ${fail} selhalo ===`);
process.exit(fail ? 1 : 0);
