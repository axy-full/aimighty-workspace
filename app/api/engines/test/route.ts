import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { enhancePrompt, activeWriter } from "@/lib/enhance";
import { invalidateSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * One real, tiny refine, so an admin can hear the chosen writer answer from
 * the Settings screen — right after topping up gateway credits, say —
 * rather than discovering on a paid render that it could not. Costs about
 * a tenth of a cent on Sonnet; nothing is stored.
 */
export async function POST() {
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
    return NextResponse.json({ ok: false, writer, ms: Date.now() - t0, error: (e as Error).message });
  }
}
