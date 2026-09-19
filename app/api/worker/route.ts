import { NextResponse, after } from "next/server";
import { z } from "zod";
import { WORKER_EVENT_NAMES, type WorkerEvent } from "@/lib/dispatch";
import { runWorkerHandler, workerJobId } from "@/lib/worker-handlers";
import { acquireSlot, releaseSlot, chainDispatch } from "@/lib/worker-slots";
import { recordDispatch } from "@/lib/dispatch-log";
import { recoveryFence, reserveRecoveryContinuation, withRecoveryJob } from "@/lib/recovery";

/**
 * Native dispatch: the app's own worker.
 *
 * A request path that has work to hand off POSTs one event here and gets a
 * 202 back before the work starts; the work then runs in THIS function's
 * `after()` lifetime, up to maxDuration, on Vercel, with no third party in
 * between. The caller is the app itself (or an operator with the cron
 * secret), never a browser — which is why the bearer is CRON_SECRET and
 * why there is no session, tenant or CSRF handling here. The event names
 * identifiers only; everything else is read from tenant storage inside the
 * handler.
 *
 * Concurrency is a platform-wide slot table (4 total, 2 per workspace —
 * Inngest's numbers). A refused slot is still a 202, with accepted:false:
 * the job stays queued, and the slot chain or the ten-minute cron picks it
 * up. It is deliberately NOT a signal to run inline.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ID = /^[A-Za-z0-9_-]{1,120}$/;
const eventSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/),
    name: z.enum(WORKER_EVENT_NAMES),
    data: z.record(z.string().regex(ID), z.string().regex(ID)),
  })
  .strict();

const noStore = { "Cache-Control": "no-store" };

export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  const authorized = secret
    ? req.headers.get("authorization") === `Bearer ${secret}`
    : process.env.NODE_ENV !== "production";
  if (!authorized)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: noStore });

  let event: WorkerEvent;
  try {
    const parsed = eventSchema.parse(await req.json());
    event = { id: parsed.id, name: parsed.name, data: parsed.data };
  } catch {
    return NextResponse.json({ error: "Invalid worker event" }, { status: 400, headers: noStore });
  }
  const jobId = workerJobId(event);
  const workspaceId = event.data.workspaceId ?? "";
  if (!jobId)
    return NextResponse.json({ error: "Invalid worker event" }, { status: 400, headers: noStore });

  // A closed or draining fence starts no new work; the cron drains what was accepted.
  const fence = await recoveryFence().status();
  if (fence.state !== "open")
    return NextResponse.json({ maintenance: true }, { status: 503, headers: noStore });

  const slot = await acquireSlot({ kind: event.name, workspaceId, jobId });
  if (!slot) {
    await recordDispatch({ eventId: event.id, name: event.name, phase: "run", outcome: "busy", workspaceId }).catch(() => {});
    return NextResponse.json({ accepted: false, reason: "busy" }, { status: 202, headers: noStore });
  }

  let continuation: () => Promise<void>;
  try {
    continuation = await reserveRecoveryContinuation("worker", () =>
      runWorkerEvent(event, slot.id),
    );
  } catch {
    await releaseSlot(slot.id).catch(() => {});
    return NextResponse.json({ maintenance: true }, { status: 503, headers: noStore });
  }
  after(continuation);
  return NextResponse.json({ accepted: true }, { status: 202, headers: noStore });
}

/** One event, one attempt, one slot; a fixed-shape log line and a dispatch_log row, never a payload. */
async function runWorkerEvent(event: WorkerEvent, slotId: string): Promise<void> {
  const startedAt = Date.now();
  const jobId = workerJobId(event);
  const workspaceId = event.data.workspaceId ?? "";
  let ok = false;
  try {
    await withRecoveryJob(workspaceId, jobId, () => runWorkerHandler(event));
    ok = true;
  } catch {
    ok = false;
  } finally {
    const durationMs = Date.now() - startedAt;
    console[ok ? "info" : "error"](
      JSON.stringify({
        level: ok ? "info" : "error",
        event: "worker.finished",
        name: event.name,
        ok,
        durationMs,
      }),
    );
    await recordDispatch({
      eventId: event.id,
      name: event.name,
      phase: "run",
      outcome: ok ? "finished-ok" : "finished-error",
      durationMs,
      workspaceId,
    }).catch(() => {});
    await releaseSlot(slotId).catch(() => {});
  }
  await chainDispatch({ kind: event.name, workspaceId });
}
