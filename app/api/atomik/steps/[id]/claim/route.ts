import { NextResponse, type NextRequest } from "next/server";
import { requireRender, withTenant } from "@/lib/auth";
import { claimStep, getStep, reconcileRunningSteps, stepForBrowser } from "@/lib/atomik";
import { ACCOUNT_STEP_NOTE, isAccountStep } from "@/lib/atomikAccountStep";
import { ARCHIVED_NOTE, threadArchived } from "@/lib/atomikThreads";
import { PEOPLE_ONLY, isPerson } from "@/lib/security/people-only";
import { STEP_GONE, stepIsMine } from "@/lib/atomikAccess";
import { sampleWorkspaceOff } from "@/lib/demo/spend-guard.server";

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
  /* Claiming a step is approving its spend: a person's press, never a token's (owner rule; lib/security/people-only.ts). */
  if (!isPerson({ user: got.user, token: got.token })) return NextResponse.json({ error: PEOPLE_ONLY }, { status: 403 });
  /* The sample workspace spends nothing: no step is taken there. */
  { const off = await sampleWorkspaceOff(); if (off) return off; }
  const { id } = await ctx.params;
  /* Claiming marks a step running, which approves its spend, and hands back its prompt: the step's person's alone (lib/atomikAccess.ts). Anyone else,
     an admin included, is told it is gone, as an unknown step is, and the step is left as it was (owner, 21 Oct 2026: the admin approval rule is retired;
     "every member approves their own spend with their own tap on the quote"). Asked after the people-only and sample refusals, which do not depend on the step. */
  if ((await stepIsMine(id, got.user)) !== true) return NextResponse.json({ error: STEP_GONE }, { status: 404 });

  /* A step planned on the connected account is never claimed: nothing here
     runs on that account any more, so it stays exactly as it was. */
  const pending = await getStep(id);
  if (pending && isAccountStep(pending))
    return NextResponse.json({ error: ACCOUNT_STEP_NOTE, step: stepForBrowser(pending) }, { status: 409 });
  /* A step in an archived thread waits, unpaid, until its thread is restored (lib/atomikThreads.ts). */
  if (pending && (await threadArchived(pending.chatId)))
    return NextResponse.json({ error: ARCHIVED_NOTE, step: stepForBrowser(pending) }, { status: 409 });

  let step = await claimStep(id, got.user.id);
  /* A step left running by an approval that never reached the renderer is
     settled first; if nothing was sent, it is proposed again and this
     approval may take it. */
  if (!step && pending?.status === "running" && !pending.genId && (await reconcileRunningSteps(pending.chatId)))
    step = await claimStep(id, got.user.id);
  if (step) return NextResponse.json({ step: stepForBrowser(step) });

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
      step: stepForBrowser(existing),
    },
    { status: 409 },
  );
});
