import { audioSeconds, activeModel, chosenKey, composerSettings, composerVoices, workspaceModels, type EngineRow } from "@/lib/workspace/composer";
import { nodeAudioBody, speechVoiceFor, type NodeAudioSetup } from "@/lib/workbench/generation-audio";
import type { CtxPrice } from "./context-menu";
import { recipePrompt, recreateBlock, recreatePreset, type RecipeSource } from "./recipe";

/**
 * What "Recreate" costs, for the right-click menu (design/particl-graphite/README.md § 4, § 5: every control that spends shows its
 * price). Recreate itself sends nothing: it hands the take's recipe to Make, which prices it on its own button. So the figure here
 * is Make's own: the recipe is applied to the engine list exactly as the composer applies it (lib/workspace/composer.ts), and the
 * same server quote the composer's price line reads is asked for it (GET /api/workbench/engines for stills and video, POST
 * /api/audio with `quoteOnly` for sound). Nothing is reserved or charged by asking. When the server has no price for it, the
 * answer says so and the menu item stays disabled with that reason; a figure is never guessed.
 */
export type RecreatePrice =
  | { state: "reading" }
  | { state: "ready"; credits: number; approximate: boolean }
  | { state: "unavailable"; reason: string };

/** How a request is read: the caller's own scoped fetch. Rejects with an Error whose message is the server's reason. */
export type QuoteReader = (url: string, init?: { method: "POST"; body: unknown }) => Promise<unknown>;

const NO_PRICE = "No price is available for this take right now. Try again.";
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const credits = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
const reasonOf = (error: unknown) => {
  const text = error instanceof Error ? error.message.trim() : "";
  /* A server answer worded for people (the quote route's own) is kept; anything else is a read failure. */
  return text && text.length <= 160 && !/^(failed to fetch|request failed|unable to read|load failed)/i.test(text) ? text : NO_PRICE;
};

/** The price of recreating `source`, or why there is none. */
export async function quoteRecreate(source: RecipeSource, read: QuoteReader, project?: { aspect?: string }): Promise<RecreatePrice> {
  const blocked = recreateBlock(source);
  if (blocked) return { state: "unavailable", reason: blocked };
  const preset = recreatePreset(source, { name: "" });
  const type = preset.type;
  if (!type) return { state: "unavailable", reason: NO_PRICE };
  try {
    if (type === "audio") {
      const audio = (await read("/api/audio")) as NodeAudioSetup;
      const models = workspaceModels([], audio);
      const model = activeModel({ type, chosen: preset.model ? { [chosenKey(type)]: preset.model } : {} }, models);
      if (!model?.audioTask) return { state: "unavailable", reason: "Sound is not available here right now." };
      const text = recipePrompt(source).trim();
      if (!text) return { state: "unavailable", reason: "This take has no words to recreate from." };
      const seconds = audioSeconds(model.audioTask, preset.sound?.seconds ?? 10);
      const voice = model.audioTask === "speech" ? speechVoiceFor(composerVoices(audio, model.id), preset.sound?.voiceId) : null;
      const body = nodeAudioBody({ task: model.audioTask, text, seconds, instrumental: preset.sound?.instrumental ?? true, voiceId: voice?.id ?? "", modelId: model.id });
      const answer = await read("/api/audio", { method: "POST", body: { ...body, quoteOnly: true } });
      const n = record(answer) ? credits(answer.estimatedCredits) : null;
      return n == null ? { state: "unavailable", reason: "Sound cannot be priced with these settings." } : { state: "ready", credits: n, approximate: false };
    }
    const list = (await read("/api/workbench/engines")) as { models?: EngineRow[] };
    const models = workspaceModels(Array.isArray(list?.models) ? list.models : [], null);
    const model = activeModel({ type, chosen: preset.model ? { [chosenKey(type)]: preset.model } : {} }, models);
    if (!model) return { state: "unavailable", reason: "No engine is offered for this take right now." };
    const settings = composerSettings(model, project?.aspect, preset.picks ?? {});
    const query = new URLSearchParams({ model: model.id, resolution: settings.resolution, ratio: settings.ratio, duration: String(settings.duration), ...(settings.generateAudio ? { audio: "1" } : {}) });
    /* The references the recipe names, as the composer's own quote names them. */
    for (const ref of preset.references ?? []) query.append(ref.origin === "generation" ? "genId" : "uploadId", ref.id);
    query.set("imageRefs", "0");
    query.set("unresolvedVideoRefs", "0");
    const answer = await read(`/api/workbench/engines?${query}`);
    const n = record(answer) ? credits(answer.credits) : null;
    return n == null ? { state: "unavailable", reason: "This engine cannot be priced with these settings." } : { state: "ready", credits: n, approximate: record(answer) && answer.approximate === true };
  } catch (error) {
    return { state: "unavailable", reason: reasonOf(error) };
  }
}

/** "43 cr", or "about 43 cr" where the engine settles on what it delivers (the composer's own wording). */
export function priceWords(price: Extract<RecreatePrice, { state: "ready" }>): string {
  return `${price.approximate ? "about " : ""}${price.credits.toLocaleString("en-US")} cr`;
}

/** The menu's form of a price: its words after the label, and the dollars on hover at the workspace's credit rate. */
export function ctxPrice(price: RecreatePrice, creditUsd: number | undefined): CtxPrice {
  if (price.state === "reading") return { state: "reading" };
  if (price.state === "unavailable") return { state: "unavailable", reason: price.reason };
  const hover = typeof creditUsd === "number" && creditUsd > 0 ? `${price.approximate ? "About " : ""}US$${(price.credits * creditUsd).toFixed(2)}` : undefined;
  return { state: "ready", text: priceWords(price), ...(hover ? { hover } : {}) };
}
