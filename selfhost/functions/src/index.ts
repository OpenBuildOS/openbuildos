import { initializeApp, getApps, getApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
export { deleteProjectPermanently, exportProjectBackup, importProjectBackup } from "./projectTransfer";

/**
 * Token-exchange Cloud Function `authExchange` pro OpenBuildOS federaci.
 *
 * Princip (BEZ OIDC/Identity Platform):
 *  1. Frontend má ID token z CENTRÁLNÍHO projektu (openbuildos).
 *  2. Pošle ho sem (POST { idToken }).
 *  3. Funkce ověří token přes admin app inicializovanou JEN s projectId
 *     centrálního projektu — k ověření stačí veřejné project id, Google
 *     podepisuje tokeny veřejnými klíči (žádný secret/service-account soubor).
 *  4. Z dekódovaného tokenu vyrobí LOKÁLNÍ custom token (createCustomToken)
 *     s uid = centrální uid. Deployovaná funkce má automaticky práva service
 *     accountu SVÉHO projektu, takže createCustomToken funguje bez klíče.
 *  5. Frontend zavolá signInWithCustomToken → přihlášen do firemního backendu
 *     se STEJNÝM uid jako centrálně → membership rules podle uid sedí napříč.
 *
 * Self-host: nasaďte do svého Firebase projektu (`firebase deploy --only
 * functions --project <firma>`). Vyžaduje plán Blaze, je zdarma do free tier.
 * Funkce důvěřuje POUZE tokenům z projektu openbuildos (CENTRAL_PROJECT_ID).
 */

const CENTRAL_PROJECT_ID = process.env.CENTRAL_PROJECT_ID || "openbuildos";

/** Povolené originy (frontend OpenBuildOS). */
const ALLOWED_ORIGINS = new Set<string>([
  "https://openbuildos.web.app",
  "https://openbuildos-app.web.app",
  "https://openbuildos.org",
  "http://localhost:5173",
]);

/**
 * Admin app pro OVĚŘENÍ centrálního tokenu — inicializovaná JEN s projectId
 * centrálního projektu. Žádné credentials nejsou potřeba: verifyIdToken stahuje
 * veřejné podpisové klíče Googlu a kontroluje, že token patří CENTRAL_PROJECT_ID.
 */
const CENTRAL_APP_NAME = "central-verify";

function getCentralApp() {
  const existing = getApps().find((app) => app.name === CENTRAL_APP_NAME);
  if (existing) {
    return existing;
  }
  return initializeApp({ projectId: CENTRAL_PROJECT_ID }, CENTRAL_APP_NAME);
}

/**
 * Default admin app = LOKÁLNÍ projekt (firemní backend), automatické credentials
 * z prostředí Cloud Functions. Používá se na createCustomToken (podpis service
 * accountem lokálního projektu).
 */
function getLocalApp() {
  return getApps().some((app) => app.name === "[DEFAULT]") ? getApp() : initializeApp();
}

function resolveCorsOrigin(origin: string | undefined): string {
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    return origin;
  }
  // Bezpečný default — nepovolíme libovolný origin s credentials.
  return "https://openbuildos.web.app";
}

export const authExchange = onRequest({ region: "europe-west1" }, async (req, res) => {
  const origin = req.headers.origin as string | undefined;
  res.set("Access-Control-Allow-Origin", resolveCorsOrigin(origin));
  res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Access-Control-Max-Age", "3600");

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const idToken: unknown = req.body?.idToken;
  if (typeof idToken !== "string" || idToken.length === 0) {
    res.status(401).json({ error: "Chybí idToken." });
    return;
  }

  try {
    const decoded = await getAuth(getCentralApp()).verifyIdToken(idToken);
    const uid = decoded.uid;
    const email = decoded.email ?? null;
    const name = (decoded.name as string | undefined) ?? null;

    const customToken = await getAuth(getLocalApp()).createCustomToken(uid, {
      email,
      name,
      src: "openbuildos",
    });

    logger.info("authExchange OK", { uid, hasEmail: Boolean(email) });
    res.status(200).json({ customToken });
  } catch (error) {
    logger.error("authExchange selhalo", error);
    res.status(401).json({ error: "Ověření centrálního tokenu selhalo." });
  }
});
