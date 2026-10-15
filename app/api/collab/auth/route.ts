import { crossOriginProblem } from "@/lib/requestOrigin";
import { Liveblocks } from "@liveblocks/node";
import { withTenant, requireSession } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { workbenchScopeProblem } from "@/lib/workbench/request-scope";
import { collabColor, collabConfigured, roomUserId } from "@/lib/collab";
import { requireProduction, roomParts, TeamCanvasError } from "@/lib/workbench/team-canvas";
import { roomGeneration } from "@/lib/workbench/room-rotation";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Signs a person into one production's live room. The token names that room
 * alone, and only for a production of the workspace they are signed into;
 * the secret never leaves the server.
 */
export const POST = withTenant(async (req: Request) => {
  if (!collabConfigured()) return Response.json({ error: "Live editing is not set up." }, { status: 503, headers: NO_STORE });
  const auth = await requireSession();
  if (auth.response) return auth.response;
  const tenant = requireTenant();
  const scopeError = workbenchScopeProblem(req, tenant.id, auth.user.id, true);
  if (scopeError) return Response.json({ error: scopeError }, { status: 409, headers: NO_STORE });
  if (crossOriginProblem(req)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const body = await req.json().catch(() => null) as { room?: unknown } | null;
  const room = typeof body?.room === "string" ? body.room : "";
  const parts = roomParts(room, tenant.id);
  if (!parts) return Response.json({ error: "forbidden", reason: "Not a room in this workspace." }, { status: 403, headers: NO_STORE });
  const productionId = parts.productionId;
  /* A room that was closed (the people who may write the board changed for the worse, lib/workbench/room-rotation.ts) gets no token: the current one does. */
  if (parts.generation !== (await roomGeneration(productionId))) return Response.json({ error: "forbidden", reason: "That room has been closed." }, { status: 403, headers: NO_STORE });
  /* A live room is the owner's and the editors': the admin rule does not open it (an admin looks and edits through the saved board, audited; live rooms for admins wait for their screens), so no room token outlives an admin's role. */
  try { await requireProduction(productionId, undefined, "write", { admin: false }); }
  catch (error) {
    if (error instanceof TeamCanvasError) return Response.json({ error: "forbidden", reason: error.message }, { status: 403, headers: NO_STORE });
    throw error;
  }
  const liveblocks = new Liveblocks({ secret: process.env.LIVEBLOCKS_SECRET_KEY! });
  const session = liveblocks.prepareSession(`${tenant.id}:${await roomUserId(tenant, auth.user.id)}`, {
    userInfo: { name: auth.user.name, color: collabColor(auth.user.id) },
  });
  session.allow(room, ["*:write"]);
  const { status, body: token } = await session.authorize();
  return new Response(token, { status, headers: { ...NO_STORE, "Content-Type": "application/json" } });
});
