import { requireRender, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { prepareGeneration } from "@/lib/generationAdmission";
import { workbenchScopeProblem } from "@/lib/workbench/request-scope";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** The same validation and pricing as admission, stopped before reservation. */
export const POST = withTenant(async function POST(req: Request) {
  const got = await requireRender();
  if (got.response) return got.response;
  const problem = workbenchScopeProblem(
    req,
    requireTenant().id,
    got.user.id,
    !got.token,
  );
  if (problem) return Response.json({ error: problem }, { status: 409 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body))
    return Response.json(
      { error: "Provide a generation request." },
      { status: 400 },
    );
  const result = await prepareGeneration(body, got);
  return Response.json(result.ok ? result.value.quote : result.body, {
    status: result.ok ? 200 : result.status,
    headers: { "Cache-Control": "no-store" },
  });
});
