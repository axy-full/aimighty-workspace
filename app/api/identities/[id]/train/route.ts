import { NextResponse } from "next/server";
import { requireRender } from "@/lib/auth";
import { startTraining } from "@/lib/identities";

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
 */
export async function POST(_req: Request, { params }: Ctx) {
  const got = await requireRender();
  if (got.response) return got.response;
  const { id } = await params;
  try {
    const identity = await startTraining(id);
    return NextResponse.json({ identity: { ...identity, loraUrl: undefined, configUrl: undefined, trained: false } }, { status: 202 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
