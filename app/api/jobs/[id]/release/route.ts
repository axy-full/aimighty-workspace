import { NextResponse, after } from "next/server";
import { getGeneration } from "@/lib/jobs";
import { requireUser, withTenant } from "@/lib/auth";
import { heldNeedsFor, releaseHeldJobs, releaseRefusal } from "@/lib/held";
import { creditState } from "@/lib/credits";
import { standing, workspaceLimits } from "@/lib/limits";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
type Ctx = { params: Promise<{ id: string }> };

/* Released once already (a second press, one whose reply was lost, or credits arriving), and not discarded: said so, and nothing more is charged. */
function notHeld(gen: { status: string; params: Record<string, unknown> }, id: string) {
  if (gen.status !== "cancelled" && typeof gen.params.releasedAt === "number") return NextResponse.json({ released: true, id, already: true });
  return NextResponse.json({ error: "This take is not held." }, { status: 409 });
}

/**
 * Release one held take, if the balance now covers it. Its author or an
 * admin may. The jobs tray sends the credits it showed (`{ credits }`), which
 * idea 4's route (#413) charges exactly or refuses with the new figure; this
 * route does not read it yet.
 */
export const POST = withTenant(async function POST(_req: Request, { params }: Ctx) {
  const got = await requireUser();
  if (got.response) return got.response;
  const { id } = await params;
  const gen = await getGeneration(id);
  if (!gen) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (got.user.role !== "admin" && gen.createdBy !== got.user.id) {
    return NextResponse.json({ error: "Only the person who made this take, or an admin, can release it." }, { status: 403 });
  }
  if (gen.status !== "held") return notHeld(gen, id);
  const out = await releaseHeldJobs({ only: id, defer: (fn) => after(fn) });
  if (!out.released.length) {
    const held = (gen.params as { held?: { why?: unknown; needs?: unknown } }).held;
    const [credits, latest, limits, st, figures] = await Promise.all([creditState(), getGeneration(id), workspaceLimits(), standing(), heldNeedsFor([id])]);
    /* A press that raced another (or the automatic release) lost the row, not the take. */
    if (latest && latest.status !== "held") return notHeld(latest, id);
    /* The figure the release was just measured against — what it costs now, which may have moved from the one approved when it was held. */
    const needs = figures.get(id) ?? Number(held?.needs ?? 0);
    /* A cap that refused it is written on the take by this release (moving its updated_at); an older
       refusal left on the take is not why this one started nothing. */
    const reason = latest?.status === "held" && latest.error && latest.updatedAt > gen.updatedAt ? latest.error : null;
    /* A take held for a slot waits on no balance. */
    const balance = held?.why === "slots" || !credits ? null : credits.balance;
    const refusal = releaseRefusal({ needs, balance, reason, slotsFull: st.running >= limits.concurrency });
    /* The figure it was measured against rides along (as idea 4's route sends it), so the next press approves that one. */
    return NextResponse.json({ error: refusal.error, credits: needs }, { status: refusal.status });
  }
  return NextResponse.json({ released: true, id });
});
