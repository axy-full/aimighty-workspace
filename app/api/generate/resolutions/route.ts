import { requireRender, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { workbenchScopeProblem } from "@/lib/workbench/request-scope";
import { quoteResolutionOptions } from "@/lib/resolutionQuote";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The Resolution control's options for an engine, each priced by the quote engine (lib/resolutionQuote.ts). Free and repeatable: it quotes, reserves and sends nothing,
 * and the press that spends is /api/generate, which refuses a size the engine does not list.
 */
export const POST = withTenant(async function POST(req: Request) {
  const got = await requireRender();
  if (got.response) return got.response;
  const problem = workbenchScopeProblem(req, requireTenant().id, got.user.id, !got.token);
  if (problem) return Response.json({ error: problem }, { status: 409 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "Provide a generation request." }, { status: 400 });
  const out = await quoteResolutionOptions(body as Record<string, unknown>, got);
  return Response.json(out.body, { status: out.status, headers: { "Cache-Control": "no-store" } });
});
