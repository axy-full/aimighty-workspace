import { NextResponse, after } from "next/server";
import { getGeneration } from "@/lib/jobs";
import { requireUser, withTenant } from "@/lib/auth";
import { heldNeeds, releaseHeldJobs, releaseRefusal, type HeldInfo } from "@/lib/held";
import { creditState } from "@/lib/credits";
import { standing, workspaceLimits } from "@/lib/limits";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
type Ctx = { params: Promise<{ id: string }> };

/** Release one held take, if the balance now covers it. Its author or an admin may. */
export const POST = withTenant(async function POST(_req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { id } = await params;
  const gen = await getGeneration(id);
  if (!gen) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (gen.status !== "held") return NextResponse.json({ error: "This take is not held." }, { status: 409 });
  if (got.user.role !== "admin" && gen.createdBy !== got.user.id) {
    return NextResponse.json({ error: "Only the person who made this take, or an admin, can release it." }, { status: 403 });
  }
  const out = await releaseHeldJobs({ only: id, defer: (fn) => after(fn) });
  if (!out.released.length) {
    /* The figure the release was just measured against (the jobs tray's "Held · needs N cr"), not the one written when it was held. */
    const needs = heldNeeds((gen.params as { held?: Partial<HeldInfo> }).held, gen.kind, gen.model);
    const [credits, latest, limits, st] = await Promise.all([creditState(), getGeneration(id), workspaceLimits(), standing()]);
    /* A cap that refused it is written on the take by the release itself. */
    const reason = latest?.status === "held" && latest.error ? latest.error : null;
    const refusal = releaseRefusal({ needs, balance: credits ? credits.balance : null, reason, slotsFull: st.running >= limits.concurrency });
    return NextResponse.json({ error: refusal.error }, { status: refusal.status });
  }
  return NextResponse.json({ released: true, id });
});
