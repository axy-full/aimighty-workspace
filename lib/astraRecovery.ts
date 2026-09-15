import type { MeterEvent } from "./meter";
import { billCredits } from "./creditTerms";
import { ASTRA_MODEL } from "./astra";
import { db } from "./db";
import { platformDb } from "./platform";
import { requireTenant } from "./tenant";
import { paidByPlatform } from "./platformSpend";

export const ASTRA_LOCAL_TIMEOUT = "The render never came back from fal.ai. Render again.";

/** Discovery is deliberately narrower than status=failed plus a surviving handle.
 * Only our exact old timeout with its original submission and unknown-cost receipt qualifies. */
export function astraTimeoutCandidateSql(alias: "g" | "generations" = "generations") {
  return `(${alias}.provider='fal' AND ${alias}.model='${ASTRA_MODEL}' AND ${alias}.kind='video'
    AND ${alias}.status='failed' AND ${alias}.deleted=0 AND ${alias}.cost_usd IS NULL
    AND ${alias}.stored_url IS NULL AND ${alias}.source_url IS NULL
    AND ${alias}.error='${ASTRA_LOCAL_TIMEOUT}'
    AND json_type(${alias}.params,'$.falRequestId')='text'
    AND length(json_extract(${alias}.params,'$.falRequestId')) BETWEEN 1 AND 160
    AND json_extract(${alias}.params,'$.falModel')='${ASTRA_MODEL}'
    AND json_type(${alias}.params,'$.paidClaim') IN ('integer','real')
    AND json_extract(${alias}.params,'$.paidClaim')>0
    AND json_extract(${alias}.params,'$.producedOutcome.kind')='video'
    AND json_extract(${alias}.params,'$.producedOutcome.taskId')=json_extract(${alias}.params,'$.falRequestId')
    AND json_extract(${alias}.params,'$.producedOutcome.endpoint')=json_extract(${alias}.params,'$.falModel')
    AND EXISTS (SELECT 1 FROM generation_settlements ar WHERE ar.id=${alias}.id
      AND ar.settled_at IS NOT NULL AND json_extract(ar.event,'$.id')=${alias}.id
      AND json_extract(ar.event,'$.kind')='video' AND json_extract(ar.event,'$.engine')='fal'
      AND json_extract(ar.event,'$.model')='${ASTRA_MODEL}' AND json_extract(ar.event,'$.status')='failed'
      AND json_type(ar.event,'$.engineCostUsd')='null'))`;
}

export type AstraTimeoutReceipt = { event: string; settledAt: number; funding: string; params: string };

/** A read-only funding guard: recovery never resets an old meter or creates a reservation. */
export async function astraTimeoutReceipt(id: string): Promise<AstraTimeoutReceipt | null> {
  const row = (await db().execute({
    sql: `SELECT g.params,json_remove(g.params,'$.astraPollUntil') AS submitted_params,s.event,s.settled_at FROM generations g JOIN generation_settlements s ON s.id=g.id WHERE g.id=? AND ${astraTimeoutCandidateSql("g")}`,
    args: [id],
  })).rows[0];
  if (!row) return null;
  const params = JSON.parse(String(row.params));
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(params.falRequestId)) return null;
  const funding = (await platformDb().execute({
    sql: `SELECT m.workspace_id,m.kind,m.engine,m.model,m.status,m.engine_cost_usd,m.billed_credits,m.paid_by_platform,
      b.credits AS debit,r.state AS recovery_state
      FROM meter_events m JOIN billing_debits b ON b.workspace_id=m.workspace_id AND b.event_id=m.id
      JOIN recovery_intents r ON r.workspace_id=m.workspace_id AND r.id=m.id
      WHERE m.id=? AND m.workspace_id=?`,
    args: [id, requireTenant().id],
  })).rows[0];
  if (!funding || funding.kind !== "video" || funding.engine !== "fal" || funding.model !== ASTRA_MODEL || funding.status !== "failed" || funding.recovery_state !== "accepted") return null;
  const cost = Number(funding.engine_cost_usd), billed = Number(funding.billed_credits);
  if (!(cost > 0) || !Number.isFinite(cost) || !Number.isInteger(billed) || billed < 0 || Number(funding.debit) !== billed) return null;
  if (Boolean(funding.paid_by_platform) !== paidByPlatform("fal")) return null;
  // astraPollUntil is a transient lease, not part of the immutable submitted work.
  return { event: String(row.event), settledAt: Number(row.settled_at), funding: JSON.stringify(funding), params: String(row.submitted_params) };
}
export async function sameAstraTimeoutReceipt(id: string, receipt: AstraTimeoutReceipt): Promise<boolean> {
  return JSON.stringify(await astraTimeoutReceipt(id)) === JSON.stringify(receipt);
}

/** Rates may have changed since the old timeout. Never exceed its accepted debit or cost. */
export function astraRecoveryWithinReservation(receipt: AstraTimeoutReceipt, costUsd: number): boolean {
  const funding = JSON.parse(receipt.funding), params = JSON.parse(receipt.params);
  if (!Number.isFinite(costUsd) || costUsd < 0 || costUsd > Number(funding.engine_cost_usd) + 0.000001) return false;
  if (!Boolean(funding.paid_by_platform)) return true;
  const billed = billCredits(costUsd, ASTRA_MODEL);
  const quoted = typeof params.maxCredits === "number" && Number.isFinite(params.maxCredits) ? params.maxCredits : Infinity;
  return billed <= Number(funding.billed_credits) && billed <= quoted;
}

/** Freeze the recovery debit in the durable outbox; delivery validates it in the billing transaction. */
export function astraRecoveryFunding(receipt: AstraTimeoutReceipt, costUsd: number | null): NonNullable<MeterEvent["recoveryFunding"]> {
  const funding = JSON.parse(receipt.funding), paidByPlatform = Boolean(funding.paid_by_platform);
  return {
    engineCostUsd: Number(funding.engine_cost_usd), billedCredits: Number(funding.billed_credits), paidByPlatform,
    settledCredits: costUsd == null ? Number(funding.billed_credits) : paidByPlatform ? billCredits(costUsd, ASTRA_MODEL) : 0,
  };
}
