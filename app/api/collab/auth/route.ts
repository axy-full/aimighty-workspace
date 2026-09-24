import { Liveblocks } from "@liveblocks/node";
import { withTenant, requireSession } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { workbenchScopeProblem } from "@/lib/workbench/request-scope";
import { collabColor, collabConfigured } from "@/lib/collab";
import { productionOfRoom, requireProduction, TeamCanvasError } from "@/lib/workbench/team-canvas";

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
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const body = await req.json().catch(() => null) as { room?: unknown } | null;
  const room = typeof body?.room === "string" ? body.room : "";
  const productionId = productionOfRoom(room, tenant.id);
  if (!productionId) return Response.json({ error: "forbidden", reason: "Not a room in this workspace." }, { status: 403, headers: NO_STORE });
  try { await requireProduction(productionId); }
  catch (error) {
    if (error instanceof TeamCanvasError) return Response.json({ error: "forbidden", reason: error.message }, { status: 403, headers: NO_STORE });
    throw error;
  }
  const liveblocks = new Liveblocks({ secret: process.env.LIVEBLOCKS_SECRET_KEY! });
  const session = liveblocks.prepareSession(`${tenant.id}:${auth.user.id}`, {
    userInfo: { name: auth.user.name, color: collabColor(auth.user.id) },
  });
  session.allow(room, ["*:write"]);
  const { status, body: token } = await session.authorize();
  return new Response(token, { status, headers: { ...NO_STORE, "Content-Type": "application/json" } });
});
