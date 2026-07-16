import { getApps, getApp, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import * as logger from "firebase-functions/logger";
import { buildPulseEnvelope, type PulseCounts, type PulsePayload } from "./pulseSignature";

/**
 * Instalační tajemství ze Secret Manageru. Deklarace + navázání přes
 * `secrets: [...]` níže zajistí, že firebase-functions vloží hodnotu do
 * `process.env.PULSE_INSTALL_SECRET` až za běhu. Nastavení:
 *   firebase functions:secrets:set PULSE_INSTALL_SECRET --project <firma>
 */
const PULSE_INSTALL_SECRET = defineSecret("PULSE_INSTALL_SECRET");

/**
 * OpenBuildOS Pulse — firemní denní agregovaný reporter (`pulseReport`).
 *
 * Běží na FIREMNÍM (self-host) Firebase projektu. Jednou denně spočítá jen
 * AGREGOVANÉ počty a pošle je podepsané centrálnímu ingest endpointu. Nikdy
 * neodesílá názvy, e-maily, obsah ani žádnou identifikaci uživatelů — jen čísla.
 *
 * Vše je OPT-IN a fail-open:
 *  - Bez `PULSE_REPORT_ENABLED=true` + `PULSE_INGEST_URL` + `PULSE_INSTALL_SECRET`
 *    funkce nic neudělá (no-op).
 *  - Jakákoliv chyba se zaloguje a spolkne; firemní backend ani aplikace tím
 *    nejsou dotčené.
 *
 * Tajemství `PULSE_INSTALL_SECRET` patří do Secret Manageru, NIKDY do Gitu ani
 * do klientského buildu. Stejné tajemství drží centrální registr
 * `pulseWorkspaces/{workspaceId}` — viz deploy guide.
 *
 * Vyžaduje Blaze (Cloud Functions + Cloud Scheduler).
 */

const SCHEMA_VERSION = 1;

export type ReporterConfig =
  | { enabled: false; reason: string }
  | {
      enabled: true;
      ingestUrl: string;
      secret: string;
      workspaceId: string;
      kitVersion: string;
    };

/** Čistě z env vytáhne konfiguraci a rozhodne, jestli se má report poslat. */
export function resolveReporterConfig(env: NodeJS.ProcessEnv): ReporterConfig {
  if (env.PULSE_REPORT_ENABLED !== "true") {
    return { enabled: false, reason: "PULSE_REPORT_ENABLED není true" };
  }
  const ingestUrl = env.PULSE_INGEST_URL?.trim();
  const secret = env.PULSE_INSTALL_SECRET?.trim();
  if (!ingestUrl) {
    return { enabled: false, reason: "chybí PULSE_INGEST_URL" };
  }
  if (!secret) {
    return { enabled: false, reason: "chybí PULSE_INSTALL_SECRET" };
  }
  const workspaceId =
    env.PULSE_WORKSPACE_ID?.trim()
    || env.GCLOUD_PROJECT?.trim()
    || env.GCP_PROJECT?.trim()
    || "";
  if (!workspaceId) {
    return { enabled: false, reason: "nepodařilo se zjistit workspaceId" };
  }
  return {
    enabled: true,
    ingestUrl,
    secret,
    workspaceId,
    kitVersion: env.PULSE_KIT_VERSION?.trim() || "unknown",
  };
}

/** UTC den ve formátu YYYY-MM-DD (idempotence klíč reportu). */
export function pulseReportDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function db(): Firestore {
  const app = getApps().some((a) => a.name === "[DEFAULT]") ? getApp() : initializeApp();
  return getFirestore(app);
}

async function safeCount(run: () => Promise<number>): Promise<number | undefined> {
  try {
    return await run();
  } catch (error) {
    logger.warn("pulseReport: dílčí počet selhal (vynechán)", error);
    return undefined;
  }
}

/**
 * Spočítá agregované počty. Deep kolekce přes collection-group `.count()`
 * (Blaze), workspace-scoped počty iterací přes malý seznam workspaces. Každý
 * počet je best-effort — při chybě se vynechá (coverage), report se pošle dál.
 */
export async function collectCounts(firestore: Firestore): Promise<PulseCounts> {
  const counts: PulseCounts = {};

  const workspaceMembers = await safeCount(async () => {
    const workspaces = await firestore.collection("workspaces").get();
    let members = 0;
    let projects = 0;
    for (const ws of workspaces.docs) {
      const [m, p] = await Promise.all([
        ws.ref.collection("members").count().get(),
        ws.ref.collection("projects").count().get(),
      ]);
      members += m.data().count;
      projects += p.data().count;
    }
    counts.projectsTotal = projects;
    return members;
  });
  if (workspaceMembers !== undefined) {
    counts.membersTotal = workspaceMembers;
  }

  const groups: Array<[keyof PulseCounts, string]> = [
    ["tasksTotal", "tasks"],
    ["photosTotal", "photos"],
    ["plansTotal", "plans"],
    ["documentsTotal", "documents"],
    ["filesTotal", "files"],
  ];
  for (const [key, group] of groups) {
    const value = await safeCount(async () =>
      (await firestore.collectionGroup(group).count().get()).data().count
    );
    if (value !== undefined) {
      counts[key] = value;
    }
  }

  return counts;
}

export const pulseReport = onSchedule(
  {
    schedule: "every day 03:17",
    timeZone: "Europe/Prague",
    region: "europe-west1",
    secrets: [PULSE_INSTALL_SECRET],
  },
  async () => {
    const config = resolveReporterConfig(process.env);
    if (!config.enabled) {
      logger.info("pulseReport přeskočen (opt-in vypnutý)", { reason: config.reason });
      return;
    }

    try {
      const payload: PulsePayload = {
        workspaceId: config.workspaceId,
        date: pulseReportDate(new Date()),
        schemaVersion: SCHEMA_VERSION,
        kitVersion: config.kitVersion,
        counts: await collectCounts(db()),
      };
      const envelope = buildPulseEnvelope(config.secret, payload, Date.now());

      const response = await fetch(config.ingestUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(envelope),
      });
      if (!response.ok) {
        logger.warn("pulseReport: ingest odmítl report", { status: response.status });
        return;
      }
      logger.info("pulseReport odeslán", { date: payload.date });
    } catch (error) {
      // Fail-open: report je best-effort, nikdy nesmí shodit backend.
      logger.error("pulseReport selhal (spolknuto)", error);
    }
  }
);
