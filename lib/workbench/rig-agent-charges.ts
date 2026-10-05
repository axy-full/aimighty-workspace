import { db } from "../db";
import { reserveGenerationSpend, SpendReservationError } from "../generationRequests";
import { meter } from "../meter";
import { platformDb, platformReady } from "../platform";
import { requireTenant } from "../tenant";
import { closeStepCharge, openStepCharge, type RunRow, type StepRow } from "./rig-agent-store";

/*
 * A run's paid text (plan §5.5): the planning turn, and a step's own turn —
 * the fix writer filling a fix's template. Each is metered into the run's
 * limit the same way: reserved at its ceiling under the run's id before the
 * turn is sent, then settled at what it used (never above what was reserved),
 * or released unbilled when it failed, was stopped before it was sent, or its
 * worker died (then what was reserved is recorded as the platform's cost). A
 * turn whose outcome is uncertain is never sent again on its own.
 *
 * Particl's own words only: what a turn used is never shown; the run card
 * shows credits.
 */

/** The longest one paid text turn of a run may take. Its worker holds the run's lease for at least this long while it runs. */
export const PAID_TEXT_TIMEOUT_MS = 120_000;

/** A step's own paid text (the fix writer's turn): one meter event per step and attempt. */
export const stepChargeEventId = (runId: string, seq: number, attempt: number) => `rigfix_${runId.replace(/^rar_/, "")}_${seq}_${attempt}`;

/** A text charge as the ledger keeps it: its event, and the model it ran on (`engine`: "openai" when sent straight to OpenAI, else "vercel"). */
export type TextCharge = { id: string; engine: string; model: string };

/** The event's outcome is settled (billed, or released unbilled): nothing for a recovery drain to reconcile. */
export async function closeChargeIntent(eventId: string) {
  const [{ billingTransaction }, { resolveRecoveryJobTx }] = await Promise.all([import("../billingLedger"), import("../recovery")]);
  const workspaceId = requireTenant().id;
  await billingTransaction((tx) => resolveRecoveryJobTx(tx, workspaceId, eventId));
}

/**
 * Releases a text charge the ledger still holds as running, unbilled, recording `costUsd` — or,
 * when that is not known (null), what was reserved — as the platform's cost. Answers whether the
 * ledger had the event at all.
 */
export async function releaseTextCharge(eventId: string, who: Pick<RunRow, "productionId" | "owner">, costUsd: number | null): Promise<boolean> {
  await platformReady();
  const row = (await platformDb().execute({ sql: "SELECT kind,engine,model,status,engine_cost_usd FROM meter_events WHERE workspace_id=? AND id=?", args: [requireTenant().id, eventId] })).rows[0];
  if (row && String(row.status) === "running")
    await meter({
      id: eventId, kind: "text", engine: String(row.engine), model: String(row.model), status: "failed", unbilled: true,
      engineCostUsd: costUsd ?? Number(row.engine_cost_usd ?? 0), projectId: who.productionId, createdBy: who.owner,
    }, { critical: true });
  if (row) await closeChargeIntent(eventId);
  return !!row;
}

/**
 * Reserves a step's paid text at its ceiling, inside the run's limit, before the turn is sent. The
 * step records the charge first, so a worker that dies before the ledger answers leaves a record
 * the cron releases. Answers null once reserved, or why nothing was reserved (the limit, the
 * balance, a stop): then nothing was charged and nothing may be sent.
 */
export async function reserveStepCharge(
  run: Pick<RunRow, "id" | "productionId" | "owner" | "capCredits">, step: Pick<StepRow, "id">,
  charge: TextCharge & { ceilingUsd: number }, live: () => Promise<string | null>,
): Promise<string | null> {
  if (run.capCredits == null) return "This run has no approved limit, so nothing in it is paid.";
  if (!Number.isFinite(charge.ceilingUsd) || charge.ceilingUsd < 0) return "This turn has no price, so Atomik does not send it.";
  if (!(await openStepCharge(db(), step.id, charge.id))) return "This step already holds a charge that has not settled.";
  try {
    await reserveGenerationSpend({
      id: charge.id, kind: "text", engine: charge.engine, model: charge.model, status: "running",
      engineCostUsd: charge.ceilingUsd, projectId: run.productionId, createdBy: run.owner,
    }, { run: { id: run.id, limitCredits: run.capCredits, band: 1, live } });
    return null;
  } catch (error) {
    /* Anything but a refusal may have reserved after all: the record stays, and the release finds what the ledger holds. */
    if (!(error instanceof SpendReservationError)) throw error;
    await closeStepCharge(db(), step.id, charge.id, "released");
    return error.message;
  }
}

/**
 * Settles a step's paid text: billed at what the turn used (never above its ceiling), or released
 * unbilled when it failed or its use cannot be priced. A write that fails leaves the charge reserved
 * for the cron to release. Answers whether it settled.
 */
export async function settleStepCharge(
  run: Pick<RunRow, "productionId" | "owner">, step: Pick<StepRow, "id">,
  charge: TextCharge & { ceilingUsd: number }, outcome: { billed: boolean; usedUsd: number | null },
): Promise<boolean> {
  try {
    const cost = Math.min(outcome.usedUsd ?? charge.ceilingUsd, charge.ceilingUsd);
    const event = { id: charge.id, kind: "text" as const, engine: charge.engine, model: charge.model, engineCostUsd: cost, projectId: run.productionId, createdBy: run.owner };
    if (outcome.billed) await meter({ ...event, status: "succeeded" }, { critical: true });
    else await meter({ ...event, status: "failed", unbilled: true }, { critical: true });
    await closeChargeIntent(charge.id);
    await closeStepCharge(db(), step.id, charge.id, outcome.billed ? "settled" : "released");
    return true;
  } catch (error) {
    console.error("rig agent step charge:", (error as Error).message);
    return false;
  }
}

/**
 * Releases a step's charge that is still reserved, unbilled: its turn was stopped before it was sent
 * (`costUsd` 0), or the worker that held it is gone (null: what it used is not known, so what was
 * reserved is recorded as the platform's). Answers whether it released one.
 */
export async function releaseStepCharge(run: Pick<RunRow, "productionId" | "owner">, step: Pick<StepRow, "id" | "chargeId" | "charge">, costUsd: number | null): Promise<boolean> {
  if (step.charge !== "reserved" || !step.chargeId) return false;
  await releaseTextCharge(step.chargeId, run, costUsd);
  return closeStepCharge(db(), step.id, step.chargeId, "released");
}
