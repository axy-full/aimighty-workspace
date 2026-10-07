import { crossOriginProblem } from "@/lib/requestOrigin";
import { z } from "zod";
import { withTenant, requireSession } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { workbenchScopeProblem } from "@/lib/workbench/request-scope";
import { readProjectBody } from "@/lib/workbench/request-body";
import { orderedIds } from "@/lib/workbench/team-canvas-model";
import { collabConfigured } from "@/lib/collab";
import { db } from "@/lib/db";
import { storedActorMaskHere } from "@/lib/platformOwnerPrivacy";
import {
  masterLocks, patchTeamCanvas, readTeamCanvas, requireProduction, teamCanvasRevision, teamPatchSchema, teamRoomFor, TeamCanvasError,
} from "@/lib/workbench/team-canvas";
import { latestServerChange } from "@/lib/workbench/canvas-ops-log";
import { boardHistory } from "@/lib/board/history.server";
import { applyCanvasOps } from "@/lib/workbench/canvas-ops";
import { scheduleCanvasPush } from "@/lib/workbench/canvas-push";
import { sampleWorkspaceOff } from "@/lib/demo/spend-guard.server";
import {
  approveRigAgent, approveRigAgentPlan, askRigAgent, declineRigAgent, fixRigAgentShot, MAX_RUN_LIMIT, retryRigAgentStep, raiseRigAgentLimit, renderRigAgentStep, RigAgentError, rigAgentEnabled, rigAgentState,
  newBoardAskTerms, skipRigAgentStep, stopRigAgent, undoRigAgent,
} from "@/lib/workbench/rig-agent";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/** A card as this workspace may read its lock record: the platform owner is "Particl support" outside the house (lib/platformOwnerPrivacy.ts). */
type CardShown = { master?: { lockedBy?: string } & Record<string, unknown> };
function shownLock<N extends CardShown>(shown: (value: string) => string, node: N): N {
  return node.master?.lockedBy ? { ...node, master: { ...node.master, lockedBy: shown(node.master.lockedBy) } } : node;
}

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
 * whether building is switched on, the newest run on this production (its limit, what it has
 * spent inside it, and its renders), and with `projectId` (the viewer's project) and no run in
 * progress, what asking would cost: the suggested limit, the per-job line, and planning's price.
 * `locks`: the elements its cards stand for that are locked, the masters (from the elements table).
 * `agent=1&board=new` (no production): what asking would cost on a new, empty board, for Home's Start
 * before its project exists. Prices only; nothing is reserved or written.
 * `history=1` answers the board's History: the canvas's changes, newest first, with this workspace's names (no prices).
 */
export const GET = withTenant(async (req: Request) => {
  const who = await caller(req, false);
  if (who.response) return who.response;
  const url = new URL(req.url);
  const productionId = url.searchParams.get("productionId") ?? "";
  try {
    if (url.searchParams.get("agent") === "1" && url.searchParams.get("board") === "new")
      return Response.json({ agent: await newBoardAskTerms() }, { headers: NO_STORE });
    if (url.searchParams.get("agent") === "1") {
      const draftId = url.searchParams.get("projectId");
      return Response.json({ agent: await rigAgentState(productionId, who.userId!, draftId && /^[a-zA-Z0-9-]{1,100}$/.test(draftId) ? draftId : null) }, { headers: NO_STORE });
    }
    await requireProduction(productionId);
    /* The board's History (stream 3; lead decision 26): this production's canvas changes and who made them, read only. */
    if (url.searchParams.get("history") === "1") return Response.json({ history: await boardHistory(productionId) }, { headers: NO_STORE });
    /* Anything the live room has not taken yet goes out again, after this answer. */
    scheduleCanvasPush(productionId);
    const server = await latestServerChange(productionId);
    if (url.searchParams.get("head") === "1")
      return Response.json({ head: true, revision: await teamCanvasRevision(productionId), server }, { headers: NO_STORE });
    const saved = await readTeamCanvas(productionId);
    /* Who locked a master, as this workspace may read it: the platform owner is "Particl support" outside the house (lib/platformOwnerPrivacy.ts). */
    const shown = await storedActorMaskHere();
    const nodes = saved ? Object.fromEntries(Object.entries(saved.canvas.nodes).map(([id, n]) => [id, shownLock(shown, n)])) : {};
    return Response.json({
      canvas: saved ? { nodes, assets: saved.canvas.assets, order: orderedIds(saved.canvas), removedIds: Object.keys(saved.canvas.removed), serverMade: saved.canvas.serverMade } : null,
      revision: saved?.revision ?? 0,
      room: collabConfigured() ? teamRoomFor(requireTenant().id, productionId) : null,
      server,
      locks: saved ? [...(await masterLocks(db(), saved.canvas))] : [],
    }, { headers: NO_STORE });
  } catch (error) { return failure(error); }
});

/** One person's edit: nodes written or taken off (kept in the canvas's own record), assets they use, the order. */
export const PATCH = withTenant(async (req: Request) => {
  const who = await caller(req, true);
  if (who.response) return who.response;
  if (crossOriginProblem(req)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
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
    /* Writes that would have changed a locked master did not land; the rest of the edit did. `held` says which,
       with the card (or asset) as the canvas holds it, so the window puts it back. */
    const shown = saved.masterHolds.length ? await storedActorMaskHere() : null;
    const held = saved.masterHolds.map((h) => ({
      ...h,
      ...(h.nodeId && saved.canvas.nodes[h.nodeId] ? { node: shownLock(shown!, saved.canvas.nodes[h.nodeId]) } : {}),
      ...(h.assetId && saved.canvas.assets[h.assetId] ? { asset: saved.canvas.assets[h.assetId] } : {}),
    }));
    return Response.json({ revision: saved.revision, ...(held.length ? { held } : {}) }, { headers: NO_STORE });
  } catch (error) { return failure(error); }
});

const ACTION_ID = /^[A-Za-z0-9_-]{8,100}$/;
const PRODUCTION = z.string().max(100);
const RUN_ID = z.string().regex(/^rar_[a-f0-9]{24}$/);
const tidySchema = z.object({ action: z.literal("tidy"), productionId: PRODUCTION, opId: z.string().regex(ACTION_ID) });
const runAction = <A extends string>(action: A) => z.object({ action: z.literal(action), productionId: PRODUCTION, runId: RUN_ID });
const LIMIT = z.number().positive().max(MAX_RUN_LIMIT);
const SEQ = z.number().int().min(1).max(10_000);
const FINGERPRINT = z.string().regex(/^[a-f0-9]{64}$/);
const actionSchema = z.discriminatedUnion("action", [
  tidySchema,
  /* Ask Atomik to build: the project (draft) it is asked from, a request id (asking twice asks once), the request,
     and the limit the person approves for the run with its mode (Ask, the default, or Auto). */
  z.object({
    action: z.literal("agent.plan"), productionId: PRODUCTION, projectId: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/),
    requestId: z.string().regex(ACTION_ID), goal: z.string().trim().min(3).max(2000), model: z.string().min(1).max(120).optional(),
    limit: LIMIT, mode: z.enum(["ask", "auto"]).optional(),
  }),
  runAction("agent.approve").extend({ fingerprint: FINGERPRINT }),
  runAction("agent.decline"),
  runAction("agent.stop"),
  runAction("agent.undo"),
  /* A render after the build: approve it at the price shown (or Try again), skip it, or raise the run's limit. */
  runAction("agent.render").extend({ seq: SEQ, fingerprint: FINGERPRINT.optional() }),
  runAction("agent.skip").extend({ seq: SEQ }),
  runAction("agent.limit").extend({ limit: LIMIT }),
  /* The plan approved once at the server's quote (its fingerprint), and a fix drawn under that approval. */
  runAction("agent.approvePlan").extend({ fingerprint: FINGERPRINT }),
  runAction("agent.fix").extend({ seq: SEQ }),
  /* A render that failed with nothing billed, again under the same approval at the same price (not a fix). */
  runAction("agent.retry").extend({ seq: SEQ }),
]);

/**
 * A server action on the canvas. None of these requests charges anything itself.
 *
 *  - `tidy` lays the whole board out by sections (lib/workspace/rig-board.ts:
 *    a block of columns per section under its title, rows in canvas order;
 *    locked cards stay where they are) for everyone at once, making any kind's
 *    section title the board lacks. `opId` names the press, so a retry of the
 *    same press changes nothing twice. `moved`: cards it moved; `sections`:
 *    section titles it made. Free.
 *  - `agent.*` is Atomik on the board (lib/workbench/rig-agent.ts): ask for a
 *    board with the limit approved for the run (Atomik proposes the cards and
 *    wires; its planning is metered into that limit), approve the proposal as
 *    shown or set it aside, render a paid step at the price shown, skip one, or
 *    raise the limit (only the person who asked); approve the plan once at the
 *    server's quote, or draw a fix under that approval (only the person who
 *    asked, a signed-in session: tokens are refused); stop a run or undo a build
 *    (anyone on the team). What a run spends is spent by its worker, inside
 *    the approved limit. Each answers Atomik's run card.
 */
/** The board agent's actions that can lead to a paid call (a planning turn, a render, a raised limit). */
const SPENDING_AGENT_ACTIONS = new Set(["agent.plan", "agent.approve", "agent.render", "agent.limit", "agent.approvePlan", "agent.fix", "agent.retry"]);

export const POST = withTenant(async (req: Request) => {
  const who = await caller(req, true);
  if (who.response) return who.response;
  if (crossOriginProblem(req)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
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
    /* The sample workspace spends nothing: Atomik on its boards plans, approves, renders and retries nothing.
       Declining, stopping, skipping and undoing stay free. While an owner or admin has lifted the mark for one run
       (lib/demo/lift.server.ts), their own ask that makes it, and their own presses on that run, pass. */
    if (SPENDING_AGENT_ACTIONS.has(action.action)) {
      const scope = action.action === "agent.plan" ? { ask: { userId, requestId: action.requestId } } : "runId" in action ? { runId: action.runId, userId } : {};
      const off = await sampleWorkspaceOff(scope);
      if (off) return off;
    }
    const { productionId } = action;
    const run =
      action.action === "agent.plan" ? await askRigAgent({ productionId, draftId: action.projectId, userId, requestId: action.requestId, goal: action.goal, model: action.model, limit: action.limit, mode: action.mode })
      : action.action === "agent.approve" ? await approveRigAgent({ productionId, runId: action.runId, fingerprint: action.fingerprint, userId })
      : action.action === "agent.decline" ? await declineRigAgent({ productionId, runId: action.runId, userId })
      : action.action === "agent.stop" ? await stopRigAgent({ productionId, runId: action.runId, userId })
      : action.action === "agent.render" ? await renderRigAgentStep({ productionId, runId: action.runId, seq: action.seq, fingerprint: action.fingerprint ?? null, userId })
      : action.action === "agent.skip" ? await skipRigAgentStep({ productionId, runId: action.runId, seq: action.seq, userId })
      : action.action === "agent.limit" ? await raiseRigAgentLimit({ productionId, runId: action.runId, limit: action.limit, userId })
      : action.action === "agent.approvePlan" ? await approveRigAgentPlan({ productionId, runId: action.runId, fingerprint: action.fingerprint, userId })
      : action.action === "agent.fix" ? await fixRigAgentShot({ productionId, runId: action.runId, seq: action.seq, userId })
      : action.action === "agent.retry" ? await retryRigAgentStep({ productionId, runId: action.runId, seq: action.seq, userId })
      : await undoRigAgent({ productionId, runId: action.runId, userId });
    return Response.json({ agent: { enabled: rigAgentEnabled(), run, ask: null } }, { status: action.action === "agent.plan" ? 202 : 200, headers: NO_STORE });
  } catch (error) { return failure(error); }
});
