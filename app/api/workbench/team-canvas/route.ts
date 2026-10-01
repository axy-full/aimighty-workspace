import { z } from "zod";
import { withTenant, requireSession } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { workbenchScopeProblem } from "@/lib/workbench/request-scope";
import { readProjectBody } from "@/lib/workbench/request-body";
import { orderedIds } from "@/lib/workbench/team-canvas-model";
import { collabConfigured } from "@/lib/collab";
import {
  patchTeamCanvas, readTeamCanvas, requireProduction, teamCanvasRevision, teamPatchSchema, teamRoomFor, TeamCanvasError,
} from "@/lib/workbench/team-canvas";
import { latestServerChange } from "@/lib/workbench/canvas-ops-log";
import { applyCanvasOps } from "@/lib/workbench/canvas-ops";
import { scheduleCanvasPush } from "@/lib/workbench/canvas-push";
import {
  approveRigAgent, askRigAgent, declineRigAgent, RigAgentError, rigAgentEnabled, rigAgentState, stopRigAgent, undoRigAgent,
} from "@/lib/workbench/rig-agent";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

async function caller(req: Request, write: boolean) {
  const auth = await requireSession();
  if (auth.response) return { response: auth.response };
  const scopeError = workbenchScopeProblem(req, requireTenant().id, auth.user.id, write);
  if (scopeError) return { response: Response.json({ error: scopeError }, { status: 409, headers: NO_STORE }) };
  return { userId: auth.user.id };
}

function failure(error: unknown) {
  if (error instanceof TeamCanvasError || error instanceof RigAgentError) return Response.json({ error: error.message }, { status: error.status, headers: NO_STORE });
  throw error;
}

/**
 * The production's shared Rig canvas, and the live room to edit it in when Liveblocks is set up.
 * `server`: the newest change the server made to it (a Tidy, Atomik's work), so a window with no
 * live room folds the canvas in when it moves. `head=1` answers only the revision and `server`:
 * the light check those windows make every few seconds. `agent=1` answers Atomik's run card:
 * whether building is switched on, and the newest run on this production.
 */
export const GET = withTenant(async (req: Request) => {
  const who = await caller(req, false);
  if (who.response) return who.response;
  const url = new URL(req.url);
  const productionId = url.searchParams.get("productionId") ?? "";
  try {
    if (url.searchParams.get("agent") === "1")
      return Response.json({ agent: await rigAgentState(productionId, who.userId!) }, { headers: NO_STORE });
    await requireProduction(productionId);
    /* Anything the live room has not taken yet goes out again, after this answer. */
    scheduleCanvasPush(productionId);
    const server = await latestServerChange(productionId);
    if (url.searchParams.get("head") === "1")
      return Response.json({ head: true, revision: await teamCanvasRevision(productionId), server }, { headers: NO_STORE });
    const saved = await readTeamCanvas(productionId);
    return Response.json({
      canvas: saved ? { nodes: saved.canvas.nodes, assets: saved.canvas.assets, order: orderedIds(saved.canvas), removedIds: Object.keys(saved.canvas.removed), serverMade: saved.canvas.serverMade } : null,
      revision: saved?.revision ?? 0,
      room: collabConfigured() ? teamRoomFor(requireTenant().id, productionId) : null,
      server,
    }, { headers: NO_STORE });
  } catch (error) { return failure(error); }
});

/** One person's edit: nodes written or taken off (kept in the canvas's own record), assets they use, the order. */
export const PATCH = withTenant(async (req: Request) => {
  const who = await caller(req, true);
  if (who.response) return who.response;
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const body = await readProjectBody(req);
  if (!body.ok) return Response.json({ error: body.error }, { status: body.status, headers: NO_STORE });
  const parsed = teamPatchSchema.safeParse(body.value);
  if (!parsed.success) return Response.json({ error: "Check the canvas edit before saving." }, { status: 400, headers: NO_STORE });
  const { productionId, ...patch } = parsed.data;
  try {
    await requireProduction(productionId);
    const saved = await patchTeamCanvas(productionId, patch, who.userId!);
    /* A card the server made that this edit only implied taking off stays: the live room is told to keep it. */
    if (saved.held.length) scheduleCanvasPush(productionId);
    return Response.json({ revision: saved.revision }, { headers: NO_STORE });
  } catch (error) { return failure(error); }
});

const ACTION_ID = /^[A-Za-z0-9_-]{8,100}$/;
const PRODUCTION = z.string().max(100);
const RUN_ID = z.string().regex(/^rar_[a-f0-9]{24}$/);
const tidySchema = z.object({ action: z.literal("tidy"), productionId: PRODUCTION, opId: z.string().regex(ACTION_ID) });
const runAction = <A extends string>(action: A) => z.object({ action: z.literal(action), productionId: PRODUCTION, runId: RUN_ID });
const actionSchema = z.discriminatedUnion("action", [
  tidySchema,
  /* Ask Atomik to build: the project (draft) it is asked from, a request id (asking twice asks once), the request. */
  z.object({
    action: z.literal("agent.plan"), productionId: PRODUCTION, projectId: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/),
    requestId: z.string().regex(ACTION_ID), goal: z.string().trim().min(3).max(2000), model: z.string().min(1).max(120).optional(),
  }),
  runAction("agent.approve").extend({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }),
  runAction("agent.decline"),
  runAction("agent.stop"),
  runAction("agent.undo"),
]);

/**
 * A server action on the canvas. Free: nothing here is priced or charged.
 *
 *  - `tidy` lays the whole board out by sections (lib/workspace/rig-board.ts:
 *    a block of columns per section under its title, rows in canvas order;
 *    locked cards stay where they are) for everyone at once, making any kind's
 *    section title the board lacks. `opId` names the press, so a retry of the
 *    same press changes nothing twice. `moved`: cards it moved; `sections`:
 *    section titles it made.
 *  - `agent.*` is Atomik building the board (lib/workbench/rig-agent.ts): ask
 *    for a board (Atomik proposes the cards and wires), approve the proposal
 *    as shown or set it aside (only the person who asked), stop a build or
 *    undo one (anyone on the team). Each answers Atomik's run card.
 */
export const POST = withTenant(async (req: Request) => {
  const who = await caller(req, true);
  if (who.response) return who.response;
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const parsed = actionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Check the canvas action before sending it." }, { status: 400, headers: NO_STORE });
  const action = parsed.data;
  const userId = who.userId!;
  try {
    if (action.action === "tidy") {
      await requireProduction(action.productionId);
      const result = await applyCanvasOps(action.productionId, { opId: `tidy:${userId}:${action.opId}`, ops: [{ kind: "tidy" }], author: userId, what: "tidy" });
      const count = (kind: string) => result.outcomes.filter((o) => o.kind === kind).flatMap((o) => o.nodeIds).length;
      return Response.json({ revision: result.revision, moved: count("tidy"), sections: count("create"), live: result.live, credits: 0 }, { headers: NO_STORE });
    }
    const { productionId } = action;
    const run =
      action.action === "agent.plan" ? await askRigAgent({ productionId, draftId: action.projectId, userId, requestId: action.requestId, goal: action.goal, model: action.model })
      : action.action === "agent.approve" ? await approveRigAgent({ productionId, runId: action.runId, fingerprint: action.fingerprint, userId })
      : action.action === "agent.decline" ? await declineRigAgent({ productionId, runId: action.runId, userId })
      : action.action === "agent.stop" ? await stopRigAgent({ productionId, runId: action.runId, userId })
      : await undoRigAgent({ productionId, runId: action.runId, userId });
    return Response.json({ agent: { enabled: rigAgentEnabled(), run }, credits: 0 }, { status: action.action === "agent.plan" ? 202 : 200, headers: NO_STORE });
  } catch (error) { return failure(error); }
});
