import { NextResponse } from "next/server";
import { requireRender, withTenant } from "@/lib/auth";
import { catalog } from "@/lib/catalog";
import { gatewayReachable } from "@/lib/gateway";
import { withGenerationRequest } from "@/lib/generationRequests";
import { displayModelName } from "@/lib/models";
import { isVerifiedTextModel } from "@/lib/atomikModelPolicy";
import { paidTextFailure, paidTextQuoteResponse, paidTextQuoteScopeFailure, quotePaidText, requestMaxCredits, runPaidText } from "@/lib/paidText";
import { getPlatformLayer } from "@/lib/platform";
import { textModelFor } from "@/lib/platformLayer";
import { getSetting } from "@/lib/settings";
import {
  DEFAULT_ENHANCER, ENHANCE_MAX_PROMPT, ENHANCE_MAX_TOKENS, ENHANCER_LABEL, enhancerMessages, isEnhanceMode, isEnhancerProvider,
  isRawPrompt, parseEnhanced, pickEnhancerModel, type EnhancerProvider,
} from "@/lib/shell/enhancer";
import { vendorKey } from "@/lib/vendorKeys";
import { sampleWorkspaceOff } from "@/lib/demo/spend-guard.server";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
/** The whole request answers within this (no request stays silent past 100 s; docs/long-flows.md › C4). */
const ENHANCE_BUDGET_MS = 90_000;

/**
 * POST /api/prompt/enhance { prompt, provider?, model?, mode, anchored?, editing? }
 *
 * One rough idea in, one concrete prompt out (design/particl-graphite/README.md
 * › Prompt enhancer). The provider is the request's, else the workspace's
 * (Workspace › General), else Higgsfield. A `raw:` prompt is never rewritten.
 *
 * Paid, so it is the same envelope as every other text job (lib/paidText):
 * `quoteOnly` returns the live price, the run carries that price back as
 * `maxCredits`, and a price that moved refuses instead of charging more. A
 * failed or unusable answer is not the caller's cost to discover here — the
 * meter settles what the provider reports, and nothing is reserved on a quote.
 */
export const POST = withTenant(async function POST(req: Request) {
  const deadline = Date.now() + ENHANCE_BUDGET_MS;
  const got = await requireRender();
  if (got.response) return got.response;
  const quoteOnly = (await req.clone().json().catch(() => ({}))).quoteOnly === true;
  if (quoteOnly) { const scopeFailure = paidTextQuoteScopeFailure(req); if (scopeFailure) return scopeFailure; }
  /* The sample workspace spends nothing: answered before the request is claimed. A quote still answers. */
  if (!quoteOnly) { const off = await sampleWorkspaceOff(); if (off) return off; }
  const run = async () => {
    try {
      const body = await req.json().catch(() => ({}));
      const prompt = String(body.prompt ?? "").trim();
      if (!prompt) return NextResponse.json({ error: "Write a few words first." }, { status: 400 });
      if (prompt.length > ENHANCE_MAX_PROMPT) return NextResponse.json({ error: "That prompt is too long to enhance. Shorten it." }, { status: 400 });
      if (isRawPrompt(prompt)) return NextResponse.json({ error: "A raw: prompt is sent as written. Remove raw: to enhance it." }, { status: 400 });
      if (!isEnhanceMode(body.mode)) return NextResponse.json({ error: "Choose what you are generating first." }, { status: 400 });
      if (body.provider !== undefined && !isEnhancerProvider(body.provider)) return NextResponse.json({ error: "Choose a supported prompt enhancer." }, { status: 400 });
      if (!gatewayReachable() && !vendorKey("openai"))
        return NextResponse.json({ error: "The prompt writer isn't connected for this workspace. Ask the platform to connect it." }, { status: 503 });

      const saved = await getSetting("promptEnhancer");
      const provider: EnhancerProvider = isEnhancerProvider(body.provider) ? body.provider : isEnhancerProvider(saved) ? saved : DEFAULT_ENHANCER;
      const models = (await catalog()).filter((m) => m.type === "language" && isVerifiedTextModel(m.id));
      const available = models.map((m) => m.id);
      const routed = provider === "higgsfield" ? textModelFor((await getPlatformLayer().catch(() => null))?.models ?? null, "idea") : null;
      const writer = pickEnhancerModel(provider, available, routed);
      if (!writer) return NextResponse.json({ error: `${ENHANCER_LABEL[provider]} isn't available to write prompts right now. Choose another enhancer in Workspace › General.` }, { status: 503 });

      const engine = typeof body.model === "string" && body.model ? displayModelName(body.model.slice(0, 120)) : null;
      const messages = enhancerMessages(prompt, { mode: body.mode, anchored: body.anchored === true, editing: body.editing === true, engine });
      const input = { model: writer, messages, maxTokens: ENHANCE_MAX_TOKENS, kind: "enhance", mock: "prompt" as const, createdBy: got.user.id };
      /* The catalogue read above is the one priced from: a second read could wait on the gateway again. */
      const model = models.find((m) => m.id === writer);
      if (quoteOnly) return paidTextQuoteResponse(await quotePaidText(input, model));
      /* The price the person saw is required: there is no unquoted enhancement.
         The answer is judged before the job settles: a rewrite that dropped a
         citation, or that is not a prompt, is refused and the workspace is not charged.
         The provider gets what is left of the 90 s budget; with under 20 s left the
         press is refused before anything is reserved (503, nothing charged). A provider
         that stalls past the budget settles the job as uncertain and the 1 cr estimate
         is billed (lib/paidText.ts); no later step reconciles it. */
      const result = await runPaidText({ ...input, maxCredits: requestMaxCredits(body.maxCredits, true), deadline }, { model, accept: (text) => parseEnhanced(text, prompt) });
      const parsed = parseEnhanced(result.text, prompt);
      if (!parsed.ok) return NextResponse.json({ error: parsed.reason }, { status: 502 });
      return NextResponse.json({ prompt: parsed.prompt, provider, writer }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) { return paidTextFailure(error); }
  };
  return quoteOnly ? run() : withGenerationRequest(req, got.user.id, run);
});
