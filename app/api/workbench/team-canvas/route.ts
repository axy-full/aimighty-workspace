import { withTenant, requireSession } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { workbenchScopeProblem } from "@/lib/workbench/request-scope";
import { readProjectBody } from "@/lib/workbench/request-body";
import { orderedIds } from "@/lib/workbench/team-canvas-model";
import { collabConfigured } from "@/lib/collab";
import {
  patchTeamCanvas, readTeamCanvas, requireProduction, teamPatchSchema, teamRoomFor, TeamCanvasError,
} from "@/lib/workbench/team-canvas";

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

/** The production's shared Rig canvas, and the live room to edit it in when Liveblocks is set up. */
export const GET = withTenant(async (req: Request) => {
  const who = await caller(req, false);
  if (who.response) return who.response;
  const productionId = new URL(req.url).searchParams.get("productionId") ?? "";
  try {
    await requireProduction(productionId);
    const saved = await readTeamCanvas(productionId);
    return Response.json({
      canvas: saved ? { nodes: saved.canvas.nodes, assets: saved.canvas.assets, order: orderedIds(saved.canvas), removedIds: Object.keys(saved.canvas.removed) } : null,
      revision: saved?.revision ?? 0,
      room: collabConfigured() ? teamRoomFor(requireTenant().id, productionId) : null,
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
    return Response.json({ revision: saved.revision }, { headers: NO_STORE });
  } catch (error) { return failure(error); }
});
