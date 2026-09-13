import { NextResponse } from "next/server";
import { requireRender, withTenant } from "@/lib/auth";
import { startTraining, trainCostUsd } from "@/lib/identities";
import { allowanceCheck } from "@/lib/allowance";
import { checkLimits } from "@/lib/limits";
import { engineOff } from "@/lib/platform";
import { getProvider } from "@/lib/providers";
import { enginePausedSentence, enginePausedFrom } from "@/lib/platformLayer";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
type Ctx = { params: Promise<{ id: string }> };

/* Board 12h, the kill switch: training runs on fal, and fal paused from the
   platform's desk is a 503 before the zip, the submit, the row or the meter.
     curl -b "$COOKIE" -X POST http://localhost:4550/api/identities/<id>/train -d '{"consent":true}'
     503 { error: "fal.ai is paused by the platform, <reason>. Pick another engine or try again later." } */
const pausedLine = enginePausedSentence;

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
 * loop at $3.60 of the platform's fal money a press, with no rate limit in
 * front of it. Both sibling identity routes already checked; ground rule 1
 * is "other people's money", and this was the one door with no lock.
 */
export const POST = withTenant(async function POST(req: Request, { params }: Ctx) {
  const got = await requireRender();
  if (got.response) return got.response;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  if (body.consent !== true) return NextResponse.json({ error: "Confirm you have the right to train on this person's face." }, { status: 400 });
  {
    const paused = await engineOff("fal");
    if (paused.off) return NextResponse.json({ error: pausedLine(getProvider("fal").label, paused.reason) }, { status: 503 });
  }

  /* The same three walls the render path uses, in the same order, priced at
     what this actually costs rather than at zero.
     Not parked as `held` the way a refused take is: a training run has no
     queue to wait in and no take to release, so it refuses outright and says
     what it would cost. */
  const usd = trainCostUsd();
  const wall = await allowanceCheck("fal", usd, "identity-training");
  if (!wall.ok) {
    return NextResponse.json({ error: wall.error }, { status: wall.status });
  }
  const lim = await checkLimits();
  if (!lim.allow) {
    return NextResponse.json({ error: lim.error }, { status: lim.why === "rate" ? 429 : 409 });
  }

  try {
    const identity = await startTraining(id, { by: got.user.id });
    return NextResponse.json({ identity: { ...identity, loraUrl: undefined, configUrl: undefined, trained: false } }, { status: 202 });
  } catch (e) {
    /* The gate above reads the ten-second layer cache; startTraining reads
       the switch again where the money starts. Its refusal is the same 503
       with the sentence, never a 400 with the ENGINE_PAUSED: prefix. */
    const paused = enginePausedFrom(e);
    return NextResponse.json({ error: paused ?? (e as Error).message }, { status: paused ? 503 : 400 });
  }
});
