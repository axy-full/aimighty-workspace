import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { getRun, latestRun } from "@/lib/runs";

/**
 * One run, as the run view shows it (brief 3, surface 1a).
 *
 * The id may be a production's instead, which answers with the run it is on.
 * That is what the Rig entry in the nav opens to: a producer looking at a
 * production wants the run it is on, not a list to pick from.
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withTenant(async function GET(req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { id } = await params;

  const run = new URL(req.url).searchParams.get("of") === "project"
    ? await latestRun(id)
    : await getRun(id);
  /* A production with no run is an answer, not a failure. Answering 404 with
     a data-shaped body made the client treat it as an error and show "this
     didn't load" to somebody whose production simply has not been run yet. */
  return NextResponse.json({ run: run ?? null });
});
