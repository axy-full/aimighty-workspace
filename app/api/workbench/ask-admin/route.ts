import { z } from "zod";
import { requireSession, withTenant } from "@/lib/auth";
import { AskAdminError, askAdmin, type AskAbout } from "@/lib/control-room/ask-admin";
import { requireTenant } from "@/lib/tenant";
import { workbenchScopeProblem } from "@/lib/workbench/request-scope";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

const ID = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const ASK = z.discriminatedUnion("about", [
  z.object({ about: z.literal("step"), productionId: ID, runId: ID, seq: z.number().int().min(0).max(10_000) }),
  z.object({ about: z.literal("rules") }),
]);

/**
 * "Ask an admin": a person who is not an admin asks the owner and admins to look at a step over the per-shot cap,
 * or at the spending rules (lib/control-room/ask-admin.ts). A signed-in person only: an API or MCP token is refused
 * here (requireSession), and Atomik never asks. It tells; it spends, approves and changes nothing.
 */
export const POST = withTenant(async (req: Request) => {
  const auth = await requireSession();
  if (auth.response) return auth.response;
  const scope = workbenchScopeProblem(req, requireTenant().id, auth.user.id, true);
  if (scope) return Response.json({ error: scope }, { status: 409, headers: NO_STORE });
  const parsed = ASK.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Say what an admin should look at." }, { status: 400, headers: NO_STORE });
  try {
    const user = auth.user;
    const result = await askAdmin({ id: user.id, name: user.name, admin: user.role === "admin" }, parsed.data as AskAbout);
    return Response.json(result, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof AskAdminError) return Response.json({ error: error.message }, { status: error.status, headers: NO_STORE });
    throw error;
  }
}, { requireRequestScope: true });
