import { languageReachable } from "@/lib/language-provider";
import { NextResponse } from "next/server";
import { requireRender, withTenant } from "@/lib/auth";
import { catalog } from "@/lib/catalog";
import { CLAIM_DEFERRED_HEADER, completeDeferredRequest, withGenerationRequest, type GenerationRequest } from "@/lib/generationRequests";
import { displayModelName } from "@/lib/models";
import { isVerifiedTextModel } from "@/lib/atomikModelPolicy";
import { ENHANCE_DEADLINE_MS, ENHANCE_MIN_PROVIDER_MS, type PaidTextResult, paidTextFailure, paidTextQuoteResponse, paidTextQuoteScopeFailure, quotePaidText, requestMaxCredits, runPaidText } from "@/lib/paidText";
import { getPlatformLayer } from "@/lib/platform";
import { textModelFor } from "@/lib/platformLayer";
import { getSetting } from "@/lib/settings";
import {
  DEFAULT_ENHANCER, ENHANCE_MAX_PROMPT, ENHANCE_MAX_TOKENS, ENHANCER_LABEL, enhancerMessages, isEnhanceMode, isEnhancerProvider,
  isRawPrompt, parseEnhanced, pickEnhancerModel, type EnhancerProvider,
} from "@/lib/shell/enhancer";
import { sampleWorkspaceOff } from "@/lib/demo/spend-guard.server";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

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
  /* The writer gets 8 s (ENHANCE_DEADLINE_MS; the browser waits 10), counted from the request's start: the catalogue read and the claim come out of it. */
  const deadline = Date.now() + ENHANCE_DEADLINE_MS;
  const got = await requireRender();
  if (got.response) return got.response;
  const quoteOnly = (await req.clone().json().catch(() => ({}))).quoteOnly === true;
  if (quoteOnly) { const scopeFailure = paidTextQuoteScopeFailure(req); if (scopeFailure) return scopeFailure; }
  /* The sample workspace spends nothing: answered before the request is claimed. A quote still answers. */
  if (!quoteOnly) { const off = await sampleWorkspaceOff(); if (off) return off; }
  const run = async (claim?: GenerationRequest) => {
    try {
      const body = await req.json().catch(() => ({}));
      const prompt = String(body.prompt ?? "").trim();
      if (!prompt) return NextResponse.json({ error: "Write a few words first.", nothingBilled: true }, { status: 400 });
      if (prompt.length > ENHANCE_MAX_PROMPT) return NextResponse.json({ error: "That prompt is too long to enhance. Shorten it.", nothingBilled: true }, { status: 400 });
      if (isRawPrompt(prompt)) return NextResponse.json({ error: "A raw: prompt is sent as written. Remove raw: to enhance it.", nothingBilled: true }, { status: 400 });
      if (!isEnhanceMode(body.mode)) return NextResponse.json({ error: "Choose what you are generating first.", nothingBilled: true }, { status: 400 });
      if (body.provider !== undefined && !isEnhancerProvider(body.provider)) return NextResponse.json({ error: "Choose a supported prompt enhancer.", nothingBilled: true }, { status: 400 });
      if (!languageReachable())
        return NextResponse.json({ error: "The prompt writer isn't connected for this workspace. Ask the platform to connect it.", nothingBilled: true }, { status: 503 });

      const saved = await getSetting("promptEnhancer");
      const provider: EnhancerProvider = isEnhancerProvider(body.provider) ? body.provider : isEnhancerProvider(saved) ? saved : DEFAULT_ENHANCER;
      const models = (await catalog()).filter((m) => m.type === "language" && isVerifiedTextModel(m.id));
      const available = models.map((m) => m.id);
      const routed = provider === "higgsfield" ? textModelFor((await getPlatformLayer().catch(() => null))?.models ?? null, "enhance") : null;
      const writer = pickEnhancerModel(provider, available, routed);
      if (!writer) return NextResponse.json({ error: `${ENHANCER_LABEL[provider]} isn't available to write prompts right now. Choose another enhancer in Workspace › General.`, nothingBilled: true }, { status: 503 });

      const engine = typeof body.model === "string" && body.model ? displayModelName(body.model.slice(0, 120)) : null;
      const messages = enhancerMessages(prompt, { mode: body.mode, anchored: body.anchored === true, editing: body.editing === true, engine });
      /* `quick`: the lightest reasoning the writer offers, with a small fixed room to think (lib/paidText.ts quickEffort); quoted and run the same way. */
      const input = { model: writer, messages, maxTokens: ENHANCE_MAX_TOKENS, kind: "enhance", mock: "prompt" as const, createdBy: got.user.id, quick: true };
      /* The catalogue read above is the one priced from: a second read could wait on the gateway again. */
      const model = models.find((m) => m.id === writer);
      if (quoteOnly) return paidTextQuoteResponse(await quotePaidText(input, model));
      /* The price the person saw is required: there is no unquoted enhancement.
         The answer is judged before the job settles: a rewrite that dropped a
         citation, or that is not a prompt, is refused and the workspace is not charged.
         The provider gets what is left of the 8 s deadline; with under 3 s left the
         press is refused before anything is reserved (503, nothing charged). Whatever
         goes wrong (no answer by the deadline, a cancelled press, an error status, an
         unreadable or unusable reply) the job settles as failed at zero, "Nothing billed",
         with a billing-unknown outcome on its ledger line (`freeOnFailure`, lib/paidText.ts).
         A streamed press (`stream: true`) holds the settlement: the words go out one by one
         and the workspace is charged when the last is delivered; a stream cut off midway is
         abandoned, free. */
      const stream = body.stream === true && claim !== undefined;
      const result = await runPaidText({ ...input, maxCredits: requestMaxCredits(body.maxCredits, true), deadline, minProviderMs: ENHANCE_MIN_PROVIDER_MS, freeOnFailure: true, signal: req.signal, holdSettlement: stream }, { model, accept: (text) => parseEnhanced(text, prompt) });
      const parsed = parseEnhanced(result.text, prompt);
      if (!parsed.ok) {
        await result.abandon?.("The answer was not a prompt.");
        return NextResponse.json({ error: parsed.reason, nothingBilled: true }, { status: 502 });
      }
      if (stream && result.finish && result.abandon) return streamAnswer({ result, prompt: parsed.prompt, provider, writer, claim: claim! });
      return NextResponse.json({ prompt: parsed.prompt, provider, writer }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) { return paidTextFailure(error); }
  };
  return quoteOnly ? run() : withGenerationRequest(req, got.user.id, run);
});

/**
 * The answer, word by word (the owner, 16 Oct 2026): one JSON line per word, `{"t":"word "}`, paced to finish inside about a second, then the settlement,
 * then `{"done":true,"prompt","provider","writer"}`. The workspace is charged only when the last word is out. A reader that goes away midway (Cancel, a dropped
 * connection) cancels the stream, which abandons the answer: failed at zero, never charged, and the key replays that. The claim is ended here, not from the
 * body (lib/generationRequests.ts CLAIM_DEFERRED_HEADER).
 */
function streamAnswer(o: { result: PaidTextResult; prompt: string; provider: EnhancerProvider; writer: string; claim: GenerationRequest }): Response {
  const words = o.prompt.match(/\S+\s*/g) ?? [o.prompt];
  const gap = Math.max(6, Math.min(40, Math.floor(1_200 / words.length)));
  const encoder = new TextEncoder();
  const line = (value: unknown) => encoder.encode(`${JSON.stringify(value)}\n`);
  let over = false;
  const end = async (status: number, body: unknown) => { over = true; await completeDeferredRequest(o.claim, status, JSON.stringify(body)).catch(() => {}); };
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const word of words) {
          if (over) return;
          controller.enqueue(line({ t: word }));
          await new Promise((resolve) => setTimeout(resolve, gap));
        }
        if (over) return;
        await o.result.finish!();
        const answer = { prompt: o.prompt, provider: o.provider, writer: o.writer };
        await end(200, answer);
        controller.enqueue(line({ done: true, ...answer }));
        controller.close();
      } catch (error) {
        if (over) return;
        const message = error instanceof Error ? error.message : "The answer couldn't be delivered.";
        await end(502, { error: message, nothingBilled: true });
        try { controller.enqueue(line({ error: message, nothingBilled: true })); controller.close(); } catch { /* the reader is gone */ }
      }
    },
    async cancel() {
      if (over) return;
      over = true;
      await o.result.abandon!("The stream was cut off before the last word.").catch(() => {});
      await completeDeferredRequest(o.claim, 499, JSON.stringify({ error: "Cancelled. Nothing billed.", nothingBilled: true })).catch(() => {});
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no", [CLAIM_DEFERRED_HEADER]: "1" } });
}
