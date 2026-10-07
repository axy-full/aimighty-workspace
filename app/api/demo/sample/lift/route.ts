import { crossOriginProblem } from "@/lib/requestOrigin";
import { requireSession, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { workbenchScopeProblem } from "@/lib/workbench/request-scope";
import {
  canBuildSample, liftSampleMark, putSampleMarkBack, readSampleMark, sampleLiftRecord, sampleLiftStatus, SampleError,
} from "@/lib/demo/mark.server";

export const dynamic = "force-dynamic";
const noStore = { "Cache-Control": "no-store" };

/**
 * The sample mark's one-run lift (owner, 7 Oct; lib/demo/lift.server.ts). People only: a token, an agent or an MCP
 * caller is refused by the session check, and a guest is never signed in to this workspace.
 *
 * GET, any signed-in member: `{ marked, status }`, whether the mark is lifted now and whether by the viewer (the board's
 *   line). An owner or admin also reads `canLift` and `record`: who lifted it, when, for which run, and when it came back.
 * POST, an owner or admin:
 *   { action: "lift", runId? }  lift it for the caller's next ask of Atomik, or for a run of theirs still going;
 *   { action: "putBack" }       put it back now.
 */
export const GET = withTenant(async function GET() {
  const auth = await requireSession();
  if (auth.response) return auth.response;
  try {
    const [mark, status] = await Promise.all([readSampleMark(), sampleLiftStatus(auth.user.id)]);
    const admin = canBuildSample(auth.user);
    return Response.json({
      marked: !!mark, status,
      ...(admin ? { canLift: !!mark && !status.lifted, record: await sampleLiftRecord(auth.user) } : {}),
    }, { headers: noStore });
  } catch (error) {
    console.error("The sample lift could not be read:", error);
    return Response.json({ error: "The sample mark could not be read. Try again." }, { status: 500, headers: noStore });
  }
});

export const POST = withTenant(async function POST(req: Request) {
  const auth = await requireSession();
  if (auth.response) return auth.response;
  const scopeError = workbenchScopeProblem(req, requireTenant().id, auth.user.id, true);
  if (scopeError) return Response.json({ error: scopeError }, { status: 409, headers: noStore });
  if (crossOriginProblem(req)) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const body = await req.json().catch(() => null) as { action?: unknown; runId?: unknown } | null;
  try {
    if (body?.action === "lift") {
      const lift = await liftSampleMark(auth.user, { runId: body.runId });
      return Response.json({ lifted: { runId: lift.runId, expiresAt: lift.expiresAt } }, { headers: noStore });
    }
    if (body?.action === "putBack") return Response.json({ putBack: await putSampleMarkBack(auth.user) }, { headers: noStore });
    return Response.json({ error: "Choose lift or putBack." }, { status: 400, headers: noStore });
  } catch (error) {
    if (error instanceof SampleError) return Response.json({ error: error.message }, { status: error.status, headers: noStore });
    console.error("The sample lift request failed:", error);
    return Response.json({ error: "The sample mark could not be changed. Try again." }, { status: 500, headers: noStore });
  }
}, { requireRequestScope: true });
