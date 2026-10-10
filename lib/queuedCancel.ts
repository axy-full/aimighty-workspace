/**
 * Cancel a take that is still waiting in its engine's own queue: BytePlus ModelArk (Seedance) and fal (Kling, Topaz).
 * The owner's rule: a cancel bills nothing ONLY while the provider still has the job queued. So, in order:
 *
 *  1. Our row must be `queued` (not `running`, which the polls only write once the provider says it started) and carry the
 *     provider's receipt (an Ark task id, a fal request id).
 *  2. The provider is asked how the job stands. Anything but queued is refused in its true words, and billing stays as today.
 *  3. The provider is asked to cancel (lib/ark.ts cancelTask, lib/fal.ts falCancel; behind the engine adapters' `cancel`).
 *     A refusal or a lost answer keeps the hold and says so.
 *  4. The take is then settled by the same path every poll uses (lib/jobs.ts syncGeneration): when the provider reports the
 *     task cancelled, or fal no longer has the request, the row ends `cancelled` and the existing ledger event releases the
 *     reservation at no charge (lib/generationSettlement.ts). Until then it answers `requested`, never `cancelled`.
 *
 * Idempotent: a take already cancelled answers `cancelled` without asking the provider again, and one whose cancel was asked
 * is only settled. The author or an admin of this workspace, as the connected-account cancel (lib/genjutsuVideo.ts). No price,
 * margin or ledger rule is written here: the release is the existing one. A successful take costs what it always did.
 */
import { withAcceptedJobCredentials } from "./acceptedJobCredentials";
import { db, now, ready } from "./db";
import { engineFor } from "./engines";
import type { RenderHandle } from "./engines/types";
import { getGeneration, syncGeneration } from "./jobs";
import { withRecoveryJob } from "./recovery";
import { currentTenant, requireTenant } from "./tenant";

export type QueuedCancel = { status: "cancelled" | "requested" | "running" | "succeeded" | "failed" };
export class QueuedCancelError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = "QueuedCancelError"; }
}

export type QueuedRow = { id: string; status: string; provider: string; kind: string; model: string; createdBy: string | null; arkTaskId: string | null; params: Record<string, unknown> };
export type ProviderSeen = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/** What the orchestration needs from the outside: every one is a real, tenant-scoped call in production, a fake in the mocked tests. */
export type QueuedCancelDeps = {
  exclusive<T>(id: string, run: () => Promise<T>): Promise<T>;
  load(id: string): Promise<QueuedRow | null>;
  actor(): { id: string; role: string } | null;
  poll(row: QueuedRow, handle: RenderHandle): Promise<ProviderSeen>;
  cancel(row: QueuedRow, handle: RenderHandle): Promise<void>;
  markAsked(id: string): Promise<void>;
  /** The take's own sync (lib/jobs.ts syncGeneration): where a terminal provider answer becomes a row status and a ledger release. */
  settle(id: string): Promise<{ status: string }>;
};

/** The take's receipt at the provider, or null for a take this cancel does not serve. */
export function handleOf(row: Pick<QueuedRow, "provider" | "kind" | "model" | "arkTaskId" | "params">): RenderHandle | null {
  if (row.kind !== "video") return null;
  if (row.provider === "byteplus" && row.arkTaskId) return { provider: "byteplus", ref: row.arkTaskId, model: row.model };
  const id = row.params.falRequestId, endpoint = row.params.falModel;
  if (row.provider === "fal" && typeof id === "string" && id && typeof endpoint === "string" && endpoint) return { provider: "fal", ref: id, model: row.model, endpoint };
  return null;
}
/** Whether a take is one of the engines this cancel serves (its provider and kind), whatever its state. */
export const servedHere = (row: Pick<QueuedRow, "provider" | "kind">) => row.kind === "video" && (row.provider === "byteplus" || row.provider === "fal");

export const NOT_HERE = "Only a video waiting in its engine's queue can be cancelled here.";
export const NO_RECEIPT = "The engine has not acknowledged this take yet. Check it again in a moment before cancelling.";
export const UNSURE = "Cancellation could not be confirmed. The take is still tracked and its credits stay held; check it before trying again.";

export async function cancelQueuedVideo(id: string, d: QueuedCancelDeps = realDeps): Promise<QueuedCancel> {
  return d.exclusive(id, async () => {
    const row = await d.load(id);
    if (!row) throw new QueuedCancelError(404, "Not found.");
    const who = d.actor();
    if (!who || (who.role !== "admin" && row.createdBy !== who.id))
      throw new QueuedCancelError(403, "Only this take’s creator or a workspace administrator can cancel it.");
    if (!servedHere(row)) throw new QueuedCancelError(404, NOT_HERE);
    /* Ended already: said as it is, and asked of no one again. */
    if (row.status === "cancelled" || row.status === "succeeded" || row.status === "failed") return { status: row.status };
    /* Our row says it started (the polls write `running` from the provider's own word): the provider's queue no longer holds it. */
    if (row.status === "running") return { status: "running" };
    if (row.status !== "queued") throw new QueuedCancelError(409, NOT_HERE);
    const handle = handleOf(row);
    if (!handle) throw new QueuedCancelError(409, NO_RECEIPT);

    /* A cancel already asked: settle only (the provider's answer decides), never ask twice. */
    if (typeof row.params.cancelRequestedAt === "number") return afterAsk(await d.settle(id));

    let seen: ProviderSeen;
    try { seen = await d.poll(row, handle); }
    catch { throw new QueuedCancelError(503, UNSURE); }
    if (seen !== "queued") {
      if (seen !== "running") await d.settle(id);
      return { status: seen === "cancelled" ? "cancelled" : seen };
    }
    try { await d.cancel(row, handle); }
    catch {
      /* A refusal can mean it started a moment ago: ask once more before saying anything. */
      const again = await d.poll(row, handle).catch(() => null);
      if (again && again !== "queued") {
        if (again !== "running") await d.settle(id);
        return { status: again };
      }
      throw new QueuedCancelError(503, UNSURE);
    }
    await d.markAsked(id);
    return afterAsk(await d.settle(id));
  });
}

const afterAsk = (settled: { status: string }): QueuedCancel => ({ status: settled.status === "cancelled" ? "cancelled" : settled.status === "succeeded" ? "succeeded" : settled.status === "failed" ? "failed" : "requested" });

const realDeps: QueuedCancelDeps = {
  exclusive: (id, run) => withRecoveryJob(requireTenant().id, id, run),
  async load(id) {
    await ready();
    const r = (await db().execute({ sql: "SELECT id,status,provider,kind,model,created_by,ark_task_id,params FROM generations WHERE id=? AND deleted=0", args: [id] })).rows[0];
    if (!r) return null;
    let params: Record<string, unknown> = {};
    try { params = JSON.parse(String(r.params ?? "{}")) as Record<string, unknown>; } catch { params = {}; }
    return { id: String(r.id), status: String(r.status), provider: String(r.provider ?? ""), kind: String(r.kind), model: String(r.model), createdBy: r.created_by == null ? null : String(r.created_by), arkTaskId: r.ark_task_id == null ? null : String(r.ark_task_id), params };
  },
  actor: () => { const user = currentTenant()?.user; return user ? { id: user.id, role: user.role } : null; },
  async poll(row, handle) {
    const vendor = row.provider === "fal" ? "fal" : "ark";
    const seen = await withAcceptedJobCredentials(row.id, vendor, () => engineFor(row.provider).poll!(handle));
    return seen.status;
  },
  async cancel(row, handle) {
    const vendor = row.provider === "fal" ? "fal" : "ark";
    await withAcceptedJobCredentials(row.id, vendor, () => engineFor(row.provider).cancel!(handle));
  },
  async markAsked(id) {
    await db().execute({ sql: "UPDATE generations SET params=json_set(params,'$.cancelRequestedAt',?), updated_at=? WHERE id=? AND deleted=0 AND status='queued'", args: [now(), now(), id] });
  },
  async settle(id) {
    const gen = await getGeneration(id);
    if (!gen) return { status: "failed" };
    const next = await syncGeneration(gen, { strict: false });
    return { status: (await getGeneration(id))?.status ?? next.status };
  },
};
