import { requireUser, withTenant } from "@/lib/auth";
import { sampleWorkspaceOff } from "@/lib/demo/spend-guard.server";
import { RigAgentError } from "@/lib/workbench/rig-agent";
import { preparePlanStep, type PlanStepInput } from "@/lib/workbench/plan-step-tool";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * `plan_step` (lib/workbench/plan-step-tool.ts): prepares and prices Agent mode's quick plan for a board's step, for a signed-in person or a token acting as them. Free:
 * nothing is reserved, sent or approved here. A prepare token may call it (it writes only a plan for a person to approve); a read-only token may not. The person approves
 * the plan once in Particl, in a signed-in session.
 */
export const POST = withTenant(async function POST(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "Send the board and the step as JSON." }, { status: 400 });
  /* An approval is never taken from a caller here, whoever it is. */
  if ("maxCredits" in body || "fingerprint" in body || "approve" in body) return Response.json({ error: "A plan is prepared here, never approved: only a person approves it, in Particl." }, { status: 400 });
  /* The sample workspace makes no plan, as the board's own `agent.planStep` is refused there (app/api/workbench/team-canvas): nothing is written on a sample board. */
  const off = await sampleWorkspaceOff();
  if (off) return off;
  try {
    return Response.json({ plan: await preparePlanStep(got.user.id, body as PlanStepInput) }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof RigAgentError) return Response.json({ error: error.message }, { status: error.status, headers: { "Cache-Control": "no-store" } });
    throw error;
  }
}, { preparedJobs: true });
