import { z } from "zod";
import { db } from "@/lib/db";
import { workbenchTransaction } from "./records";
import { canvasAssetSchema, canvasNodeSchema } from "./studio-schema";
import { PROJECT_LIMITS } from "./project-limits";
import { applyTeamPatch, emptyTeamCanvas, guardMasters } from "./team-canvas-model";
import { canvasClock, masterLocks, readCanvasRow, requireProduction, teamCanvasReady, TeamCanvasError, writeCanvasRow } from "./team-canvas";
import { canvasOpsReady, findCanvasOp, insertCanvasOp } from "./canvas-ops-log";
import { planCanvasOps, withoutHeld, type CanvasOp, type OpOutcome } from "./canvas-ops-model";
import { drainCanvasPushes, liveRooms, type RoomClient } from "./canvas-push";

/*
 * applyCanvasOps: the one way the server changes a production's team canvas
 * (plan §5.2, structure 3-A): make, move, wire and unwire, set, tidy, and take
 * off softly (remove: the card is kept whole in the canvas's record of cards
 * taken off; an Atomik run's undo). Operations are intents, planned against the
 * canvas as it is inside the same write transaction a person's edit takes
 * (lib/workbench/team-canvas.ts), folded in by the same merge on the server's
 * clock, recorded with who asked (a person's user id, or `agent:<runId>`), and
 * then pushed into the live room so every open window has them at once. With
 * no live room, open windows see the change on their next 5-second check
 * (components/workspace/rig/use-team-canvas.ts).
 *
 * Idempotent by op id: the same id applied twice changes the canvas once and
 * answers the same both times. Free: nothing here is priced or paid.
 */

const OP_ID = /^[A-Za-z0-9_:.-]{1,160}$/;

export const canvasOpSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create"), node: canvasNodeSchema, assets: z.array(canvasAssetSchema).max(20).optional() }),
  z.object({ kind: z.literal("move"), nodeId: z.string().max(100), x: z.number().finite(), y: z.number().finite() }),
  z.object({ kind: z.literal("wire"), from: z.string().max(100), to: z.string().max(100) }),
  z.object({ kind: z.literal("unwire"), from: z.string().max(100), to: z.string().max(100) }),
  z.object({ kind: z.literal("set"), nodeId: z.string().max(100), fields: z.record(z.string().max(40), z.unknown()) }),
  z.object({ kind: z.literal("tidy"), nodeIds: z.array(z.string().max(100)).max(PROJECT_LIMITS.nodes).optional() }),
  z.object({ kind: z.literal("remove"), nodeIds: z.array(z.string().max(100)).min(1).max(PROJECT_LIMITS.nodes) }),
]);

export type CanvasOpsRequest = {
  /** Names this change: applying the same id again changes nothing and answers the same. */
  opId: string;
  ops: CanvasOp[];
  /** Who asked: a person's user id, or `agent:<runId>` for an Atomik run. */
  author: string;
  runId?: string | null;
  /** What it is, for the record and for how the team sees it ("tidy"). */
  what?: string;
};

export type CanvasOpsResult = {
  revision: number;
  outcomes: OpOutcome[];
  /** Cards changed or made. */
  changed: number;
  /** True when this op id had been applied already: the answer is the first one. */
  replay: boolean;
  /** "sent": the live room has it; "waiting": in the outbox, pushed again until it lands; "off": no live room to push to. */
  live: "sent" | "waiting" | "off";
};

export async function applyCanvasOps(productionId: string, request: CanvasOpsRequest, options: { room?: RoomClient | null } = {}): Promise<CanvasOpsResult> {
  if (!OP_ID.test(request.opId)) throw new TeamCanvasError("Name this canvas change with an op id.", 400);
  if (!request.author || request.author.length > 200) throw new TeamCanvasError("Say who is making this canvas change.", 400);
  const parsed = z.array(canvasOpSchema).min(1).max(500).safeParse(request.ops);
  if (!parsed.success) throw new TeamCanvasError("Check the canvas change before applying it.", 400);
  const ops = parsed.data as CanvasOp[];
  await requireProduction(productionId);
  await teamCanvasReady();
  await canvasOpsReady();
  const rooms = options.room === undefined ? liveRooms() : options.room;

  const applied = await workbenchTransaction(async (tx) => {
    const seen = await findCanvasOp(tx, productionId, request.opId);
    if (seen) return { revision: seen.revision, outcomes: seen.outcomes, changed: seen.changed, replay: true };
    const saved = await readCanvasRow(tx, productionId);
    const current = saved?.canvas ?? emptyTeamCanvas();
    const plan = planCanvasOps(current, ops, request.author);
    /* Every card as it would be saved must still be a valid card. */
    if (plan.patch.upsertNodes.some((node) => !canvasNodeSchema.safeParse(node).success))
      throw new TeamCanvasError("A card this change makes would not be valid.", 400);
    let revision = saved?.revision ?? 0;
    /* A locked master never changes through a canvas operation either, Atomik's included: the elements table decides
       (team-canvas-model guardMasters), and a write it holds is left out of what is recorded and pushed to the room. */
    const stamped = { ...plan.patch, at: canvasClock(current), author: request.author };
    const guarded = guardMasters(current, stamped, { locks: await masterLocks(tx, current, stamped) });
    const changes = withoutHeld(plan.changes, guarded.held);
    if (changes.length) {
      const next = applyTeamPatch(current, guarded.patch, "trusted");
      for (const change of changes) if (change.made && next.nodes[change.id]) next.serverMade[change.id] = request.author;
      revision = await writeCanvasRow(tx, productionId, next, revision, request.author);
    }
    await tx.execute(insertCanvasOp({
      productionId, opId: request.opId, what: request.what ?? "ops", author: request.author, runId: request.runId,
      ops, outcomes: plan.outcomes, changes, assets: guarded.patch.upsertAssets, focus: plan.focus, revision,
      push: changes.length && rooms ? "pending" : "none",
    }));
    return { revision, outcomes: plan.outcomes, changed: changes.length, replay: false };
  });

  if (!rooms) return { ...applied, live: "off" };
  /* The op counts as done once the room has it; if the room cannot take it now, it waits in the outbox. */
  if (applied.changed) await drainCanvasPushes(productionId, { room: rooms });
  const row = await findCanvasOp(db(), productionId, request.opId);
  return { ...applied, live: row?.push === "pending" ? "waiting" : row?.push === "done" ? "sent" : "off" };
}
