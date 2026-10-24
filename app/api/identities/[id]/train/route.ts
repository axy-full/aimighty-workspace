import { NextResponse } from "next/server";
import { requireRender, withTenant } from "@/lib/auth";
import { startTraining, trainCostUsd, identityForBrowser, getIdentity } from "@/lib/identities";
import { consentForTraining, projectKeysFor } from "@/lib/security/consent";
import { ConsentError } from "@/lib/security/consent-words";
import { allowanceCheck } from "@/lib/allowance";
import { checkLimits } from "@/lib/limits";
import { billCredits } from "@/lib/creditTerms";
import { creditsApply } from "@/lib/credits";
import { currentTenant } from "@/lib/tenant";
import { trainApprovalProblem } from "@/lib/identityTraining";
import { PEOPLE_ONLY, isPerson } from "@/lib/security/people-only";

import { withGenerationRequest, SpendReservationError } from "@/lib/generationRequests";
import { sampleWorkspaceOff } from "@/lib/demo/spend-guard.server";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
type Ctx = { params: Promise<{ id: string }> };

/**
 * Hand the photos to the trainer. Returns as soon as the job is queued.
 *
 * requireRender, not requireUser: this is the most expensive single button
 * in the app — a fal.ai LoRA run, fifteen hundred steps, several dollars a
 * press — and requireUser accepts a bearer of ANY scope. A token minted as
 * read-only, which is the credential handed to ChatGPT Actions and MCP
 * clients precisely because /connect promises it cannot bill, could call
 * this in a loop. The paid route beside it (../render) already guards this
 * way; this one was the outlier, and it costs more per call.
 *
 * AND IT WAS STILL THE OUTLIER ON MONEY. That paragraph reasoned carefully
 * about WHO may press the button and never asked whether the workspace can
 * PAY for it: `allowanceCheck` was called from seven routes and this was not
 * one of them, `checkLimits` from three and not this one either. `meter()`
 * only records — it has never refused anything. So a member of any workspace,
 * holding zero credits and past the monthly allowance, could press this in a
 * loop, spending the platform's fal money on every press, with no rate limit in
 * front of it. Both sibling identity routes already checked; ground rule 1
 * is "other people's money", and this was the one door with no lock.
 */
export const POST = withTenant(async function POST(req: Request, { params }: Ctx) {
  const got = await requireRender();
  if (got.response) return got.response;
  /* Training is a person's priced press, as it has always been here: a token or an agent is refused before anything is
     read. So `consent: true` below, recorded as the tick (consent_by, consent_at), is only ever a person's. */
  if (!isPerson({ user: got.user, token: got.token })) return NextResponse.json({ error: PEOPLE_ONLY }, { status: 403 });
  /* The sample workspace spends nothing: answered before the request is claimed. */
  { const off = await sampleWorkspaceOff(); if (off) return off; }
  /* A tick, not a gate (owner, 23 Oct 2026): a training that cites a live tick for this identity's production and cast
     member carries that tick's own who and when; one that cites none, or a withdrawn or ended one, trains all the same.
     Only a malformed citation (another production's or cast member's tick, none named) is refused, in words, before
     anything is claimed or sent (review of #558, M1). This route never links the tick (identity_consents.identity_id
     is the Soul identity the Cast card follows; an older-trainer id there would hide it). */
  const peek = await req.clone().json().catch(() => ({})) as { consentId?: unknown; subjectKey?: unknown };
  const known = await getIdentity((await params).id);
  if (!known) return NextResponse.json({ error: "Not found" }, { status: 404 });
  let tick: Awaited<ReturnType<typeof consentForTraining>>;
  try {
    tick = await consentForTraining(peek.consentId, await projectKeysFor(known.projectId, got.user.id), peek.subjectKey);
  } catch (error) {
    if (error instanceof ConsentError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
  return withGenerationRequest(req, got.user.id, async () => {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  /* Who ticked and when are only ever the ticking person's: the presser's own tick (`consent: true`) at the press, else
     the cited tick's own recorded_by and recorded_at, else no tick at all. Never required. */
  const ticker = body.consent === true ? { by: got.user.id } : tick ? { by: tick.tickedById, at: tick.recordedAt } : undefined;

  /* The same three walls the render path uses, in the same order, priced at
     what this actually costs rather than at zero.
     Not parked as `held` the way a refused take is: a training run has no
     queue to wait in and no take to release, so it refuses outright and says
     what it would cost. */
  const usd = trainCostUsd();
  /* The price the sheet showed comes back as the approval (`maxCredits`, or
     `maxUsd` for a workspace on its own keys); a run that now costs more is
     refused rather than charged. */
  /* A dollar approval is read only from a workspace that pays fal itself: on the platform's keys a
     refusal that turned on it would tell, one guess at a time, what the vendor charges. */
  const approval = trainApprovalProblem(creditsApply(currentTenant()?.workspace) ? { maxCredits: body.maxCredits } : body,
    { credits: billCredits(usd, "identity-training"), usd });
  if (approval) return NextResponse.json({ error: approval }, { status: 409 });
  const wall = await allowanceCheck("fal", usd, "identity-training");
  if (!wall.ok) {
    return NextResponse.json({ error: wall.error }, { status: wall.status });
  }
  const lim = await checkLimits();
  if (!lim.allow) {
    return NextResponse.json({ error: lim.error }, { status: lim.why === "rate" ? 429 : 409 });
  }

  try {
    const identity = await startTraining(id, ticker);
    return NextResponse.json({ identity: identity && { ...identityForBrowser(identity), trained: false } }, { status: 202 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: e instanceof SpendReservationError ? e.status : 400 });
  }
  });
});
