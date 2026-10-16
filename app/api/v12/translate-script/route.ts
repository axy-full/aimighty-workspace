import { NextResponse } from "next/server";
import { requireSession, requireUser, withTenant } from "@/lib/auth";
import { creditsApply, quotedCredits } from "@/lib/credits";
import { engineMock } from "@/lib/mock";
import { requireTenant } from "@/lib/tenant";
import { HINDI, SOURCE_LANGUAGE, translateProblem } from "@/lib/v12/translate-script";
import { sampleHindi } from "@/lib/v12/translate-script.mock";

export const dynamic = "force-dynamic";

/**
 * The Hindi script's STAND-IN (lib/v12/translate-script.ts), until Sarvam's translate tool lands (#777, POST /api/sarvam).
 *
 * It answers only under ENGINE_MOCK=1; everywhere else it is "no such tool", so it can never bill. Nothing leaves the process and nothing is
 * written. It is priced through the same path as any text call (`quotedCredits`, so the rate card's margin and the workspace's unit apply)
 * from a made-up engine cost that exists only here. A quote may be asked by anyone signed in; a run is a person's press and is refused for
 * a token, and for any figure below the quote.
 */
const MOCK_USD_PER_10K_CHARS = 0.2;
const chars = (text: string) => [...text].length;

const handle = withTenant(async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const run = body.mode === "run";
  /* A quote reserves nothing: anyone signed in may ask. A run is a person's press. */
  const got = run ? await requireSession() : await requireUser();
  if (got.response) return got.response;
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (body.source !== SOURCE_LANGUAGE || body.target !== HINDI) return NextResponse.json({ error: "Only English to Hindi is offered here." }, { status: 400 });
  const problem = translateProblem(text);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  const usd = Math.round((chars(text) / 10_000) * MOCK_USD_PER_10K_CHARS * 1e6) / 1e6;
  const estimatedCredits = quotedCredits(usd, "text");
  const inCredits = creditsApply(requireTenant());
  if (!run) return NextResponse.json({ estimatedCredits, price: inCredits ? estimatedCredits : usd, unit: inCredits ? "cr" : "usd", chars: chars(text) });
  /* Approved in the unit the quote was shown in: credits, or (the house) dollars. */
  const price = inCredits ? estimatedCredits : usd;
  if (typeof body.approved !== "number" || !Number.isFinite(body.approved) || body.approved < price)
    return NextResponse.json({ error: "Approve the price first: the estimate is above the approved credit amount." }, { status: 409 });
  return NextResponse.json({ ok: true, tool: "translate", estimatedCredits, text: sampleHindi(text), source: SOURCE_LANGUAGE, target: HINDI });
});

/** No such tool unless the engine is mocked: answered before the workspace, the session or the body is looked at. */
export function POST(req: Request, ctx: Parameters<typeof handle>[1]) {
  if (!engineMock()) return NextResponse.json({ error: "There is no such tool here." }, { status: 404 });
  return handle(req, ctx);
}
