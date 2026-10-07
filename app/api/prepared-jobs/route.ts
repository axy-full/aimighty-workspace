import { requireUser, withTenant } from "@/lib/auth";
import { PreparedError, prepareJob, preparedJobs } from "@/lib/security/prepared-jobs";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

/**
 * Prepared jobs (Gaps B, MCP tokens): an outside agent with a `prepare` token files the words and settings of a
 * render; a person approves each by opening it in Make and pressing it at its price, or dismisses it.
 *
 * POST: a `prepare` token only (withTenant lets that scope write here and nowhere else). It prices, holds and sends
 * nothing. GET: a person sees what waits; a token sees only the jobs it prepared itself.
 */
export const GET = withTenant(async () => {
  const got = await requireUser();
  if (got.response) return got.response;
  const jobs = got.token ? await preparedJobs({ tokenId: got.token.id }) : await preparedJobs({ state: "waiting" });
  return Response.json({ jobs }, { headers });
});

export const POST = withTenant(async (req: Request) => {
  const got = await requireUser();
  if (got.response) return got.response;
  const body = await req.json().catch(() => null);
  try {
    const job = await prepareJob(body && typeof body === "object" ? body : {}, got.token);
    return Response.json({ job }, { status: 201, headers });
  } catch (error) {
    if (error instanceof PreparedError) return Response.json({ error: error.message }, { status: error.status, headers });
    throw error;
  }
}, { preparedJobs: true });
