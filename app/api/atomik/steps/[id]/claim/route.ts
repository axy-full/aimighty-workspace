import { NextResponse, type NextRequest } from "next/server";
import { requireRender, withTenant } from "@/lib/auth";
import { claimStep, getStep } from "@/lib/atomik";
import { connectedMeta } from "@/lib/higgsfield-consumer/planner-proposals";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Take a proposed step, once, before spending on it.
 *
 * This exists so that "is this step already being paid for?" is answered by
 * the database rather than by the browser. The client used to decide that
 * from React state, and every way of getting it wrong ended the same way —
 * a second charge for one approval.
 *
 * requireRender, not requireUser: what follows this call costs money, so a
 * read-only token must be refused here rather than at the vendor.
 */
export const POST = withTenant(async function POST(_req: NextRequest, ctx: Ctx) {
  const got = await requireRender();
  if (got.response) return got.response;
  const { id } = await ctx.params;

  /* A connected-account step is approved at its exact connected price through
     its own route, which quotes, claims and submits in one place. */
  const pending = await getStep(id);
  if (pending && connectedMeta(pending.params))
    return NextResponse.json({ error: "Approve this step at its connected-credit price.", step: pending }, { status: 409 });

  const step = await claimStep(id);
  if (step) return NextResponse.json({ step });

  /* Nothing was claimed. Say which of the two reasons it was, because
     "already running" and "gone" want different things from the person. */
  const existing = await getStep(id);
  if (!existing) {
    return NextResponse.json({ error: "That step is gone." }, { status: 404 });
  }
  return NextResponse.json(
    {
      error: existing.status === "rejected"
        ? "That one was already turned down."
        : "That one is already running — it was approved a moment ago.",
      step: existing,
    },
    { status: 409 },
  );
});
