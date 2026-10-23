import type { AdmissionActor } from "./admissionTypes";
import { prepareGeneration } from "./generationAdmission";
import { creditsApply, quotedCredits } from "./credits";
import { estimateCostUsd } from "./vendorPricing";
import { getModel } from "./models";
import { requireTenant } from "./tenant";
import { UPSCALE_MODEL, UPSCALED_4K, resolutionOptions, topNativeResolution, type ResolutionOption } from "./resolutions";

/**
 * The Resolution control's options for one engine, each with the price the quote engine gives it (owner, 16 Oct 2026, § D). Nothing here is a number of ours:
 *  - a NATIVE size is quoted by `prepareGeneration`, the very validation and pricing a quote and a press run, with that size in the request;
 *  - the UPSCALED 4K is two steps, each priced on its own: the render at the engine's top native size (the same quote) and the upscale of the finished take
 *    (Topaz Astra at 4K, from the rate table through `estimateCostUsd` and the margin table). Its total is their sum; each step is approved on its own.
 * An option the engine cannot do carries `reason` and no price. A size that could not be quoted (a request the quote refused) carries `problem` in words.
 * The price is in what this workspace pays in (`unit`): credits, or dollars on its own keys. Free; nothing is reserved, held or sent.
 */
export type PricedStep = { tool: "render" | "upscale"; resolution: string; model: string; estimatedCredits: number; price: number; unit: "cr" | "usd" };
export type PricedOption = ResolutionOption & { estimatedCredits?: number; price?: number; unit?: "cr" | "usd"; steps?: PricedStep[]; problem?: string };

export async function quoteResolutionOptions(input: Record<string, unknown>, actor: AdmissionActor): Promise<{ status: number; body: Record<string, unknown> }> {
  const modelId = String(input.model ?? "");
  let model;
  try { model = getModel(modelId); } catch { return { status: 400, body: { error: `Unknown model: ${modelId}` } }; }
  const inCredits = creditsApply(requireTenant());
  const unit = inCredits ? "cr" : "usd";
  /* The quote asks for a prompt; the price of a size does not depend on it. */
  const base: Record<string, unknown> = { ...input, prompt: typeof input.prompt === "string" && input.prompt.trim() ? input.prompt : "Resolution price check" };
  delete base.maxCredits; delete base.draft; delete base.resolution;

  const quoteAt = async (resolution: string): Promise<{ estimatedCredits: number; price: number } | { problem: string }> => {
    const result = await prepareGeneration({ ...base, resolution }, actor);
    if (!result.ok) return { problem: typeof result.body.error === "string" ? result.body.error : "This could not be priced." };
    return { estimatedCredits: result.value.quote.estimatedCredits, price: result.value.quote.price };
  };

  const options: PricedOption[] = [];
  for (const option of resolutionOptions(model)) {
    if (!option.available) { options.push(option); continue; }
    if (option.kind === "native") {
      const q = await quoteAt(option.id);
      options.push("problem" in q ? { ...option, problem: q.problem } : { ...option, estimatedCredits: q.estimatedCredits, price: q.price, unit });
      continue;
    }
    /* Upscaled 4K: the render at the top native size, then the upscale of that take. */
    const top = topNativeResolution(model)!;
    const render = await quoteAt(top);
    if ("problem" in render) { options.push({ ...option, problem: render.problem }); continue; }
    const duration = model.durations.includes(Number(input.duration)) ? Number(input.duration) : (model.durations[0] ?? 5);
    const estimate = estimateCostUsd(UPSCALE_MODEL, "4k", "adaptive", duration, duration, true, { task: "upscale", fps60: false });
    if (!estimate || !(estimate.net > 0)) { options.push({ ...option, problem: "The upscale could not be priced." }); continue; }
    const upCredits = quotedCredits(estimate.net, UPSCALE_MODEL);
    const upscale: PricedStep = { tool: "upscale", resolution: "4k", model: UPSCALE_MODEL, estimatedCredits: upCredits, price: inCredits ? upCredits : estimate.net, unit };
    const first: PricedStep = { tool: "render", resolution: top, model: model.id, estimatedCredits: render.estimatedCredits, price: render.price, unit };
    options.push({ ...option, estimatedCredits: first.estimatedCredits + upscale.estimatedCredits, price: Math.round((first.price + upscale.price) * 1e6) / 1e6, unit, steps: [first, upscale] });
  }
  return { status: 200, body: { model: model.id, label: model.label, default: model.resolutions[0], upscaled: UPSCALED_4K, options } };
}
