import { NextResponse } from "next/server";
import { requireAdmin, withTenant } from "@/lib/auth";
import { enhancePrompt, activeWriter } from "@/lib/enhance";
import { invalidateSettings } from "@/lib/settings";
import { enginePausedFrom } from "@/lib/platformLayer";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * One real, tiny refine, so an admin can hear the chosen writer answer from
 * the Settings screen — right after topping up gateway credits, say —
 * rather than discovering on a paid render that it could not. Costs about
 * a tenth of a cent on Sonnet; nothing is stored.
 */
export const POST = withTenant(async function POST() {
  const got = await requireAdmin();
  if (got.response) return got.response;
  invalidateSettings();
  const writer = await activeWriter();
  if (writer.writer === "none") {
    return NextResponse.json({
      ok: true, writer, ms: 0,
      sample: "Pro: prompts reach the engine exactly as written. There is no writer to test.",
    });
  }
  const t0 = Date.now();
  try {
    const r = await enhancePrompt({
      prompt: "a woman walks into a bar",
      citations: [],
      model: "dreamina-seedance-2-5-260628",
      durationS: 5,
      task: "generate",
      provider: writer.provider === "none" ? undefined : writer.provider,
    });
    return NextResponse.json({
      ok: true, writer, model: r.model, ms: Date.now() - t0,
      inTokens: r.inTokens, outTokens: r.outTokens, move: r.move ?? null,
      sample: r.text.slice(0, 240),
    });
  } catch (e) {
    /* A writer the platform has paused (SOW v2 §9) is a 503 with the
       sentence, not a failed test with the ENGINE_PAUSED: prefix in it. */
    const paused = enginePausedFrom(e);
    if (paused) return NextResponse.json({ ok: false, writer, ms: Date.now() - t0, error: paused }, { status: 503 });
    return NextResponse.json({ ok: false, writer, ms: Date.now() - t0, error: (e as Error).message });
  }
});
