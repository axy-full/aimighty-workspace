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
import { importBoardBatch } from "@/lib/workbench/board-import";

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
  if (error instanceof TeamCanvasError) return Response.json({ error: error.message }, { status: error.status, headers: NO_STORE });
  throw error;
}

/**
 * The production's shared Rig canvas, and the live room to edit it in when Liveblocks is set up.
 * `server`: the newest change the server made to it (a Tidy, Atomik's work), so a window with no
 * live room folds the canvas in when it moves. `head=1` answers only the revision and `server`:
 * the light check those windows make every few seconds.
 */
export const GET = withTenant(async (req: Request) => {
  const who = await caller(req, false);
  if (who.response) return who.response;
  const url = new URL(req.url);
  const productionId = url.searchParams.get("productionId") ?? "";
  try {
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
const tidySchema = z.object({ action: z.literal("tidy"), productionId: z.string().max(100), opId: z.string().regex(ACTION_ID) });
const importSchema = z.object({ action: z.literal("import"), productionId: z.string().max(100), boardId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) });
const actionSchema = z.discriminatedUnion("action", [tidySchema, importSchema]);

/**
 * A server action on the canvas. Free: nothing is priced or charged.
 *
 *  - `tidy`: lays the whole board out (columns by input depth, rows in canvas
 *    order; locked cards stay where they are) for everyone at once. `opId`
 *    names the press, so a retry of the same press changes nothing twice.
 *  - `import`: brings an old Rig board of this production (boards.project_id)
 *    across onto its team canvas, one bounded batch per call; call again until
 *    `done`. Idempotent and resumable: each batch is planned from the canvas as
 *    it is, and a card already brought (or taken off since) is never made
 *    again. The old board itself is only read (lib/workbench/board-import.ts).
 */
export const POST = withTenant(async (req: Request) => {
  const who = await caller(req, true);
  if (who.response) return who.response;
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const parsed = actionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Check the canvas action before sending it." }, { status: 400, headers: NO_STORE });
  if (parsed.data.action === "import") {
    const { productionId, boardId } = parsed.data;
    try {
      return Response.json(await importBoardBatch(productionId, boardId, who.userId!), { headers: NO_STORE });
    } catch (error) { return failure(error); }
  }
  const { productionId, opId } = parsed.data;
  try {
    await requireProduction(productionId);
    const result = await applyCanvasOps(productionId, { opId: `tidy:${who.userId}:${opId}`, ops: [{ kind: "tidy" }], author: who.userId!, what: "tidy" });
    const moved = result.outcomes.flatMap((o) => o.nodeIds).length;
    return Response.json({ revision: result.revision, moved, live: result.live, credits: 0 }, { headers: NO_STORE });
  } catch (error) { return failure(error); }
});
