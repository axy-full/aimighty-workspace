import type { Client } from "@libsql/client";
import { db, now } from "../db";

/*
 * The settlement's way back to an Atomik run (plan §6: `rig/render.settled`).
 * Every engine's end is delivered through lib/generationSettlement.ts; when
 * the take was one a run made, its step records how it ended (the charge the
 * ledger settled, or for a failed take what the provider did with it) and the
 * run is woken for its next step. Light on purpose: most takes are not a
 * run's, and this answers them with one indexed read.
 */

const known = new WeakMap<Client, boolean>();

/** Whether this workspace has ever run Atomik on a board (a read never creates the tables). */
async function hasRuns(): Promise<boolean> {
  const client = db();
  if (known.get(client)) return true;
  const exists = (await client.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='rig_agent_steps'")).rows.length > 0;
  if (exists) known.set(client, true);
  return exists;
}

/**
 * A check of a take finished and was stored (lib/workbench/development-server.ts): a run whose check
 * of that take waits for a person to check the clip on the board reads it now (free), and is woken.
 */
export async function rigCheckStored(takeId: string): Promise<void> {
  if (!(await hasRuns())) return;
  const waiting = (await db().execute({
    sql: "SELECT run_id FROM rig_agent_steps WHERE purpose='verify' AND state='paused' AND pause='check' AND verdict IS NULL AND json_extract(request,'$.take')=? LIMIT 8",
    args: [takeId],
  }).catch(() => ({ rows: [] }))).rows;
  if (!waiting.length) return;
  const { rigCheckLanded } = await import("./rig-agent");
  for (const row of waiting) await rigCheckLanded(String(row.run_id), takeId);
}

export async function rigRenderSettled(genId: string): Promise<void> {
  if (!(await hasRuns())) return;
  const { stepOfJob, getRun } = await import("./rig-agent-store");
  const step = await stepOfJob(db(), genId);
  if (!step || step.state !== "rendering") return;
  const { recordTakeEnd } = await import("./rig-agent-runs");
  await recordTakeEnd(step, genId);
  const run = await getRun(db(), step.runId);
  if (!run || run.state !== "running") return;
  await db().execute({ sql: "UPDATE rig_agent_runs SET wake_at=? WHERE id=? AND state='running'", args: [now(), run.id] });
  const { notifyRenderSettled } = await import("./rig-agent");
  await notifyRenderSettled(run, genId);
}
