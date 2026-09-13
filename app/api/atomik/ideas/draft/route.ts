import { NextResponse } from "next/server";
import { requireRender, withTenant } from "@/lib/auth";

import { gatewayReachable } from "@/lib/gateway";
import { resolveModel } from "@/lib/atomik";

import { runPaidText, paidTextFailure } from "@/lib/paidText";
import { withGenerationRequest } from "@/lib/generationRequests";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * A model writes the idea up.
 *
 * What someone types into the New idea card is usually a note to themselves
 * — "car ad, dawn, one long take, no dialogue". This turns that into the
 * card's two fields, a logline and a tone list, with the reasoning model
 * they picked, through Vercel AI Gateway. Their own words are handed back
 * to the client untouched so one click restores them.
 *
 * Paid — text costs money whether or not the idea is ever saved — so it
 * needs the render right, and what it cost is written to its own ledger
 * row rather than lost in the gap before the idea exists.
 */
const SYSTEM = [
  "You write ideas for films, commercials, music videos and series for a production studio.",
  "You are given a rough note and, sometimes, a few tone words. Write the LOGLINE: one or two sentences,",
  "at most 60 words — who, what happens, and what it should feel like. Concrete, filmable, no hype,",
  "no title, no camera jargon. Then list 3 to 6 TONE tags: short phrases a director would say",
  "(a mood, a lighting or grade note, a pace, a length like 30s). Keep any tone words you were given.",
  "Never invent brand names or people that were not in the note.",
  'Return ONLY a JSON object: {"logline": string, "tone": string[]} — no prose, no code fence.',
].join(" ");

function extract(text: string): { logline: string; tone: string[] } | null {
  const body = text.replace(/```(?:json)?/gi, "").trim();
  const start = body.indexOf("{"), end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const j = JSON.parse(body.slice(start, end + 1)) as { logline?: unknown; tone?: unknown };
    const logline = typeof j.logline === "string" ? j.logline.trim().slice(0, 600) : "";
    if (!logline) return null;
    const tone = Array.isArray(j.tone)
      ? j.tone.map((t) => String(t).trim().slice(0, 30)).filter(Boolean).slice(0, 8)
      : [];
    return { logline, tone };
  } catch {
    return null;
  }
}

export const POST = withTenant(async function POST(req: Request) {
  const got = await requireRender();
  if (got.response) return got.response;
  return withGenerationRequest(req, got.user.id, async () => {
  try {
  const body = await req.json().catch(() => ({}));
  const brief = String(body.brief ?? "").trim().slice(0, 2000);
  const toneIn = String(body.tone ?? "").trim().slice(0, 300);
  if (!brief) return NextResponse.json({ error: "Write a few words first." }, { status: 400 });
  if (!gatewayReachable()) {
    return NextResponse.json({ error: "The prompt writer isn't connected for this workspace. Ask the platform to connect it." }, { status: 503 });
  }

  const model = await resolveModel(typeof body.model === "string" ? body.model.slice(0, 120) : "auto", "idea");
  const user = [`NOTE: ${brief}`, toneIn ? `TONE WORDS: ${toneIn}` : ""].filter(Boolean).join("\n");
  const result = await runPaidText({ model, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }], maxTokens: 600, kind: "idea", mock: "idea", createdBy: got.user.id });
  const text = result.text;
  const costUsd = result.costUsd;
  const out = extract(text);
  if (!out) return NextResponse.json({ error: `${model} answered, but not with a logline. Try once more, or another model.` }, { status: 502 });

  return NextResponse.json({ ...out, model, costUsd });
  } catch (error) { return paidTextFailure(error); }
  });
});
