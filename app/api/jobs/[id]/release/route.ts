import { NextResponse } from "next/server";
import { getGeneration } from "@/lib/jobs";
import { requireUser, withTenant } from "@/lib/auth";
import { releaseHeldJobs } from "@/lib/held";
import { mayRelease } from "@/lib/workspace/release";
import { PEOPLE_ONLY, isPerson } from "@/lib/security/people-only";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
type Ctx = { params: Promise<{ id: string }> };

/** Released once already (a second press, a press whose reply was lost, or credits arriving), not discarded. */
const releasedBefore = (gen: { status: string; params: Record<string, unknown> }) =>
  gen.status !== "held" && gen.status !== "cancelled" && typeof gen.params.releasedAt === "number";

/**
 * Release one held take, if the balance now covers it. Its author or an
 * admin may. `credits` is the exact price the person was shown: the release
 * charges that figure at admission, or starts nothing and says why. Pressing
 * again after a release — or after a reply that never arrived — answers that
 * it is released and charges nothing more.
 */
export const POST = withTenant(async function POST(req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  /* Releasing a held take approves its spend: people only, never an API or MCP token of any scope (owner rule). */
  if (!isPerson({ user: got.user, token: got.token })) return NextResponse.json({ error: PEOPLE_ONLY }, { status: 403 });
  const { id } = await params;
  const body = await req.json().catch(() => null) as { credits?: unknown } | null;
  const approved = Number(body?.credits ?? Number.NaN);
  if (!Number.isSafeInteger(approved) || approved < 0)
    return NextResponse.json({ error: "Release needs the price you approve, in whole credits." }, { status: 400 });
  const gen = await getGeneration(id);
  if (!gen) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!mayRelease(got.user, gen.createdBy)) {
    return NextResponse.json({ error: "Only the person who made this take, or an admin, can release it." }, { status: 403 });
  }
  if (gen.status !== "held") {
    if (releasedBefore(gen)) return NextResponse.json({ released: true, id, already: true });
    return NextResponse.json({ error: "This take is not held." }, { status: 409 });
  }
  /* The default `defer` keeps the paid submission behind a recovery continuation (lib/held.ts continueAfterResponse). */
  const out = await releaseHeldJobs({ only: id, approved });
  if (out.released.length) return NextResponse.json({ released: true, id });
  /* A press that raced another (or the automatic release) lost the row, not the take. */
  const now = await getGeneration(id);
  if (now && now.status !== "held") {
    if (releasedBefore(now)) return NextResponse.json({ released: true, id, already: true });
    return NextResponse.json({ error: "This take is not held." }, { status: 409 });
  }
  const refused = out.refused;
  if (!refused) return NextResponse.json({ error: "This take could not be started just now. Nothing was charged." }, { status: 409 });
  return NextResponse.json({ error: refused.error, credits: refused.needs }, { status: refused.status });
});
