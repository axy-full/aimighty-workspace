import { NextResponse, type NextRequest } from "next/server";
import { requireRender, withTenant } from "@/lib/auth";
import { claimStep, getStep, reconcileRunningSteps, stepForBrowser } from "@/lib/atomik";
import { ACCOUNT_STEP_NOTE, isAccountStep } from "@/lib/atomikAccountStep";
import { ARCHIVED_NOTE, threadArchived } from "@/lib/atomikThreads";
import { PEOPLE_ONLY, isPerson } from "@/lib/security/people-only";
import { STEP_GONE, adminStepSheet, stepIsMine } from "@/lib/atomikAccess";
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
  /* Claiming marks a step running, which approves its spend, and hands back its prompt. The step's person claims it (lib/atomikAccess.ts), and an admin claims another
     member's only while it needs an admin's tap (over the per-shot cap; owner, 13 Oct; the 200 cr line it also named was retired on 20 Oct 2026). Anyone else is told it is gone, as an unknown step is, and the step is
     left as it was. Asked after the people-only and sample refusals, which do not depend on the step. */
  const mine = (await stepIsMine(id, got.user)) === true;
  if (!mine && !(await adminStepSheet(id, got.user))) return NextResponse.json({ error: STEP_GONE }, { status: 404 });
  /* What an admin is handed is the step itself, never its chat: no chat id, message id or position (owner, 13 Oct). */
  const shown = (s: Parameters<typeof stepForBrowser>[0]) => {
    const view = stepForBrowser(s);
    if (mine) return view;
    const { chatId: _chat, messageId: _message, position: _position, ...own } = view as Record<string, unknown>;
    void _chat; void _message; void _position;
    return own;
  };

  /* A step planned on the connected account is never claimed: nothing here
     runs on that account any more, so it stays exactly as it was. */
  const pending = await getStep(id);
  if (pending && isAccountStep(pending))
    return NextResponse.json({ error: ACCOUNT_STEP_NOTE, step: shown(pending) }, { status: 409 });
  /* A step in an archived thread waits, unpaid, until its thread is restored (lib/atomikThreads.ts). */
  if (pending && (await threadArchived(pending.chatId)))
    return NextResponse.json({ error: ARCHIVED_NOTE, step: shown(pending) }, { status: 409 });

  /* An admin's claim keeps the chat out of the step's render key (it is `atomik-step:<step>`), so no response carries the chat's id. */
  let step = await claimStep(id, got.user.id, { chatless: !mine });
  /* A step left running by an approval that never reached the renderer is
     settled first; if nothing was sent, it is proposed again and this
     approval may take it. */
  if (!step && pending?.status === "running" && !pending.genId && (await reconcileRunningSteps(pending.chatId)))
    step = await claimStep(id, got.user.id, { chatless: !mine });
  if (step) return NextResponse.json({ step: shown(step) });

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
      step: shown(existing),
    },
    { status: 409 },
  );
});
