import { requireSession, requireUser, withTenant } from "@/lib/auth";
import { requireTenant } from "@/lib/tenant";
import { workbenchScopeProblem } from "@/lib/workbench/request-scope";
import { readSampleBoard } from "@/lib/demo/board.server";
import { hideSampleMark, markSampleProduction, SampleError } from "@/lib/demo/mark.server";
import { openSampleDraft } from "@/lib/demo/open.server";
import { sampleWorkspaceRefusal } from "@/lib/demo/spend-guard.server";

export const dynamic = "force-dynamic";
const noStore = { "Cache-Control": "no-store" };

/**
 * The sample production (lead decision 38). GET: this workspace's sample as the board reads it (credits from the
 * ledger's record, the owner's cast wording and cut), or `{ board: null }`. Read-only, any member. `sampleWorkspace:
 * true` is added when this workspace is the sample workspace (it holds a mark, readable or not), where the server
 * refuses every paid job (lib/demo/spend-guard.server.ts): the screens then offer no paid control.
 *
 * POST, people only (a token is refused), the workspace's own rows only, and no take or ledger row is ever written:
 *   { action: "mark", draftId | projectId }  the workspace's owner or an admin marks their finished production as the sample;
 *   { action: "undo" }                       the same people undo it (the row is archived and hidden, never deleted);
 *   { action: "open" }                       any member opens their own copy of the sample as a draft.
 */
export const GET = withTenant(async function GET() {
  const got = await requireUser();
  if (got.response) return got.response;
  const [board, line] = await Promise.all([readSampleBoard(), sampleWorkspaceRefusal().catch(() => "unknown")]);
  /* A workspace that cannot be checked is treated as the sample workspace: the server refuses its paid jobs too. */
  return Response.json({ board, ...(line ? { sampleWorkspace: true } : {}) }, { headers: noStore });
});

export const POST = withTenant(async function POST(req: Request) {
  const auth = await requireSession();
  if (auth.response) return auth.response;
  const scopeError = workbenchScopeProblem(req, requireTenant().id, auth.user.id, true);
  if (scopeError) return Response.json({ error: scopeError }, { status: 409, headers: noStore });
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin) return Response.json({ error: "Invalid request origin" }, { status: 403 });
  const body = await req.json().catch(() => null) as { action?: unknown; draftId?: unknown; projectId?: unknown } | null;
  try {
    if (body?.action === "mark") {
      const mark = await markSampleProduction({ draftId: body.draftId, projectId: body.projectId }, auth.user);
      return Response.json({ sample: { projectId: mark.projectId, name: mark.name, markedAt: mark.markedAt } }, { headers: noStore });
    }
    if (body?.action === "undo") return Response.json({ undone: await hideSampleMark(auth.user) }, { headers: noStore });
    if (body?.action === "open") {
      const opened = await openSampleDraft(auth.user.id);
      return Response.json(opened, { headers: noStore });
    }
    return Response.json({ error: "Choose mark, undo or open." }, { status: 400, headers: noStore });
  } catch (error) {
    if (error instanceof SampleError) return Response.json({ error: error.message }, { status: error.status, headers: noStore });
    console.error("The sample production request failed:", error);
    return Response.json({ error: "The sample production could not be reached. Try again." }, { status: 500, headers: noStore });
  }
}, { requireRequestScope: true });
