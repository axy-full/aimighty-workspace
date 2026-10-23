import { languageReachable } from '@/lib/language-provider';
import { NO_MODEL_NAME, THINKING_UNAVAILABLE } from "@/lib/atomikModelPolicy";
import { NextResponse } from "next/server";
import { requireRender, withTenant } from "@/lib/auth";

import { resolveModel } from "@/lib/atomik";
import { thinkingRun } from "@/lib/atomikThinking";

import { runPaidText, quotePaidText, atomikQuoteResponse, requestMaxCredits, paidTextQuoteScopeFailure, paidTextFailure } from "@/lib/paidText";
import { withGenerationRequest, ANSWER_AFTER_MS } from "@/lib/generationRequests";
import { textRunCost } from "@/lib/textRunCost";
import { sampleWorkspaceOff } from "@/lib/demo/spend-guard.server";
import { tokenSpendRefusal } from "@/lib/tokenSpend";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

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
  NO_MODEL_NAME,
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
  /* The body, read now: the run may finish after its reply (answerAfterMs). */
  const body = await req.clone().json().catch(() => ({}));
  const quoteOnly = body?.quoteOnly === true;
  if (quoteOnly) { const scopeFailure = paidTextQuoteScopeFailure(req); if (scopeFailure) return scopeFailure; }
  /* The sample workspace spends nothing: answered before the request is claimed. A quote still answers. */
  if (!quoteOnly) { const off = await sampleWorkspaceOff(); if (off) return off; }
  /* A token or an MCP client spends only with a ceiling and the quote it was approved at, as `maxCredits` (lib/tokenSpend.ts): refused before the request is claimed. */
  if (!quoteOnly) { const refused = tokenSpendRefusal({ maxCredits: body?.maxCredits }, got.token); if (refused) return refused; }
  const run = async () => {
  try {
  const brief = String(body.brief ?? "").trim().slice(0, 2000);
  const toneIn = String(body.tone ?? "").trim().slice(0, 300);
  if (!brief) return NextResponse.json({ error: "Write a few words first." }, { status: 400 });
  if (!languageReachable()) {
    return NextResponse.json({ error: "The prompt writer isn't connected for this workspace. Ask the platform to connect it." }, { status: 503 });
  }

  /* Atomik's thinking for a Writing turn, at the workspace's setting (lib/atomikThinking.ts): a model or effort in the body is not a choice, and is ignored. */
  const model = await resolveModel("auto", "writing");
  const thinking = await thinkingRun("writing", model), effort = thinking.effort;
  const user = [`NOTE: ${brief}`, toneIn ? `TONE WORDS: ${toneIn}` : ""].filter(Boolean).join("\n");
  const input = { model, effort, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }], maxTokens: 600, kind: "idea", mock: "idea" as const, createdBy: got.user.id,
    /* Its model call's span (lib/modelTrace.ts): ids and settings only. */ trace: { site: "atomik.ideas" as const, step: "idea", model, effort: effort ?? "auto" } };
  if (quoteOnly) return atomikQuoteResponse(await quotePaidText(input));
  /* A run of Atomik's thinking (or the Treatment writer) needs the ceiling its person approved on the quote, whatever the caller sent: refused before the run, nothing billed. */
  const result = await runPaidText({ ...input, maxCredits: requestMaxCredits(body.maxCredits, thinking.ours), ceilingRequired: thinking.ours });
  const text = result.text;
  const out = extract(text);
  if (!out) return NextResponse.json({ error: "Atomik answered, but not with a logline. Try once more." }, { status: 502 });

  /* Credits as billed for a workspace on credits; dollars only for one on its own keys. */
  /* The model and effort stay on the server (Amendment (iii) §E: never disclosed). */
  return NextResponse.json({ ...out, ...(await textRunCost(result)) });
  } catch (error) { return paidTextFailure(error); }
  };
  /* Atomik's thinking connected before the request is claimed: an empty slot is refused with nothing written, nothing billed. */
  if (!quoteOnly) { const off = await resolveModel("auto", "writing").then(() => null, (error: unknown) => error); if (off instanceof Error && off.message === THINKING_UNAVAILABLE) return paidTextFailure(off); }
  return quoteOnly ? run() : withGenerationRequest(req, got.user.id, run, { answerAfterMs: ANSWER_AFTER_MS });
});
