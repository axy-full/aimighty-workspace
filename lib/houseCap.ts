import { after } from "next/server";
import { currentTenant } from "./tenant";
import { platformDb, platformReady } from "./platform";
import { cycleBounds } from "./cycle";
import { allowanceUsdOf } from "./cinemaHold";
import { HOUSE_WORKSPACE_ID, isHouseWorkspace } from "./houseWorkspace";
import { mailConfigured, sendMail } from "./mail";
import { platformAuditStatement } from "./platformAudit";
import { HOUSE_CAP_DEFAULT_USD, HOUSE_CAP_REACHED, HOUSE_CAP_WARN_PCT, houseCapState, houseCapUsdText, houseCapWarning, type HouseCapView } from "./houseCapText";

/**
 * The house workspace's monthly cap on the engines (lib/houseCapText.ts for the words and the decision).
 *
 * No migration: the figure is the `allowance_usd` the workspaces table has always had, which only the platform owner's
 * desk writes (app/api/admin/workspaces/[id]). Unset, the house is held to HOUSE_CAP_DEFAULT_USD, never to nothing.
 *
 * What counts is every job the house's engines ran or are running this month, at what the engines charge: a running job at
 * its hold (lib/cinemaHold.ts allowanceUsdOf), a settled one at what it settled at, plus any overrun the engine charged past
 * the estimate. The house's jobs are metered with `paid_by_platform = 0`, so the customer allowance (lib/platformSpend.ts)
 * never sees them; this reads the meter's rows for the house directly.
 */

export { HOUSE_CAP_DEFAULT_USD, HOUSE_CAP_REACHED, HOUSE_CAP_WARN_PCT } from "./houseCapText";

/** The cap a stored `allowance_usd` means for the house: its own figure (0 is a wall), else the default. */
export function houseCapOfStored(stored: unknown): { usd: number; source: "own" | "default" } {
  if (stored == null) return { usd: HOUSE_CAP_DEFAULT_USD, source: "default" };
  const n = Number(stored);
  return Number.isFinite(n) && n >= 0 ? { usd: n, source: "own" } : { usd: 0, source: "own" };
}

/** What one meter row counts for against the cap. */
export function houseSpendOfRow(row: { readonly [column: string]: unknown }): number {
  const overrun = Number(row.overrun_usd ?? 0);
  return allowanceUsdOf(row) + (Number.isFinite(overrun) && overrun > 0 ? overrun : 0);
}

/** The house's spend this month: the sum of its meter rows since the 1st (UTC). `except`: a job being reserved again. */
export async function houseSpendSince(sinceMs: number, except?: string): Promise<number> {
  await platformReady();
  const rs = await platformDb().execute({
    sql: "SELECT id,status,engine_cost_usd,hold_band,overrun_usd FROM meter_events WHERE workspace_id=? AND created_at>=?",
    args: [HOUSE_WORKSPACE_ID, sinceMs],
  });
  return rs.rows.reduce((sum, row) => (except && String(row.id) === except ? sum : sum + houseSpendOfRow(row)), 0);
}

export const houseMonthStart = (at = Date.now()): number => cycleBounds(1, at).start;

/** The cap and the month so far for the house workspace, or null for any other. */
export async function houseCapView(): Promise<HouseCapView | null> {
  const ws = currentTenant()?.workspace;
  if (!ws || !isHouseWorkspace(ws)) return null;
  const cap = houseCapOfStored(ws.allowanceUsd);
  return houseCapState(cap.usd, await houseSpendSince(houseMonthStart()), cap.source);
}

/** The platform's own read for the desk (no tenant): the house's cap and month. */
export async function houseCapViewFor(stored: unknown, at = Date.now()): Promise<HouseCapView> {
  const cap = houseCapOfStored(stored);
  return houseCapState(cap.usd, await houseSpendSince(houseMonthStart(at)), cap.source);
}

/**
 * The gate: whether the house may start a job estimated at `estUsd` (a take that holds its ceiling counts at `band` times it).
 * Anything but the house passes. At the cap, a job is refused with 429 and the sentence for the person; a job that would pass it
 * is refused the same way. It also tells the platform owner, once a month, that the warning line has been reached.
 */
export async function houseCapCheck(estUsd = 0, band = 1): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const view = await houseCapView();
  if (!view) return { ok: true };
  const needs = Math.max(0, estUsd) * (Number.isInteger(band) && band > 1 ? band : 1);
  if (view.spentUsd >= view.capUsd - 1e-9 || view.spentUsd + needs > view.capUsd + 1e-9) return { ok: false, status: 429, error: HOUSE_CAP_REACHED };
  return { ok: true };
}

/**
 * A house job was just reserved, bringing the month to `spentUsd` of `capUsd`. At the warning line the platform owner is told, once
 * a month: one platform history line (the marker, written only when none exists for this month, so two jobs crossing together
 * write one) and, when mail is set up, one email to the deployment's owner address. A failed email never fails the job.
 */
export async function noteHouseSpend(spentUsd: number, capUsd: number, at = Date.now()): Promise<boolean> {
  const view = houseCapState(capUsd, spentUsd);
  if (!view.warn) return false;
  await platformReady();
  const audit = platformAuditStatement({ actorId: "system", action: "housecap.warned", targetType: "workspace", targetId: HOUSE_WORKSPACE_ID, workspaceId: HOUSE_WORKSPACE_ID, details: { capUsd, atPct: view.pct } }, false, houseMonthStart(at));
  const wrote = await platformDb().execute(audit);
  if (!wrote.rowsAffected) return false;
  const owner = (process.env.SUPER_ADMIN_EMAIL ?? "").trim().toLowerCase();
  if (!mailConfigured() || !owner) return true;
  const body = `${houseCapWarning(view)}. The house workspace's engine spend has reached ${HOUSE_CAP_WARN_PCT}% of its ${houseCapUsdText(capUsd)} monthly cap. At 100% its jobs stop until the month turns or you raise the cap on the platform desk.`;
  await sendMail({ to: owner, subject: `Particl: ${houseCapWarning(view)}`, text: body, html: `<p>${body}</p>` }).catch(() => {});
  return true;
}

/* The notes still on their way (a test, or anything that must see the warning written, waits for them with houseNotesSettled). */
const notesUnderway = new Set<Promise<unknown>>();

/**
 * noteHouseSpend, sent off and never awaited: a reservation calls this once its turn is let go (lib/generationRequests.ts), so a mail
 * server that is slow or down holds up no reservation, the house's or any other workspace's. Inside a request it runs in Next's
 * `after`; outside one (a script, a test, background work) it simply runs on its own. A failure is logged, never thrown: the job is
 * already reserved and stays so.
 */
export function noteHouseSpendLater(spentUsd: number, capUsd: number): void {
  const run = async (): Promise<void> => {
    const note = noteHouseSpend(spentUsd, capUsd).catch((error) => {
      console.error(JSON.stringify({ level: "error", event: "house_cap.warn_failed", message: error instanceof Error ? error.message : "unknown" }));
      return false;
    });
    notesUnderway.add(note);
    try { await note; } finally { notesUnderway.delete(note); }
  };
  try { after(run); } catch { void run(); }
}

/** Resolves once every house note sent off so far has finished (written its line, sent or given up on its mail). */
export async function houseNotesSettled(): Promise<void> {
  while (notesUnderway.size) await Promise.allSettled([...notesUnderway]);
}
