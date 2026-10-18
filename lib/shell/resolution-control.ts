import { exact, type PriceValue } from "./price-words";
import { NOT_ON_ENGINE, UPSCALED_4K } from "../resolutions";

/**
 * The Resolution control, apart from how it is drawn (owner, 16 Oct 2026, § D). The options are the server's: POST /api/generate/resolutions
 * (lib/resolutionQuote.ts) returns this engine's own sizes, each priced by the quote engine, the sizes it cannot do (shown greyed, "not on this
 * engine"), and the upscaled 4K apart from any native 4K. Nothing here prices anything: a figure is the server's, or there is none.
 *
 * Until the server has answered (or when it could not), the control still works from the engine's own list as the composer holds it, unpriced.
 * Draft and Final are presets over the same sizes (Draft = 480p, Final = 1080p); the size stays visible and changeable.
 */

/** One option, as the route sends it (lib/resolutionQuote.ts › PricedOption). */
export type ResolutionOptionReply = {
  id: string; label: string; kind: "native" | "upscaled"; available: boolean; reason?: string; untested?: boolean; from?: string; via?: string;
  estimatedCredits?: number; price?: number; unit?: "cr" | "usd";
  steps?: { tool: "render" | "upscale"; resolution: string; estimatedCredits: number; price: number; unit: "cr" | "usd" }[];
  problem?: string;
};
export type ResolutionReply = { model: string; options: ResolutionOptionReply[] };

export const DRAFT_PRESET = "480p";
export const FINAL_PRESET = "1080p";
/** Why a size is held while a draft is on (the draft's own size, as the composer has always said it). */
export const DRAFT_HOLDS = "A draft is 480p; its final is 1080p.";

export type ResolutionChip = {
  /** The size a pick sends (a size from the engine's list), or the upscaled option's id. */
  id: string;
  label: string;
  /** Pressable: the engine makes it and nothing holds the size. */
  enabled: boolean;
  /** The engine cannot do it: drawn greyed, with `reason`, and never pressed. */
  off: boolean;
  reason: string | null;
  pressed: boolean;
  price: PriceValue | null;
  untested: boolean;
};
export type ResolutionView = {
  presets: (ResolutionChip & { name: "Draft" | "Final" })[];
  sizes: ResolutionChip[];
  /** The upscaled 4K: a render at `from`, then an upscale of that take, each priced and approved on its own. */
  upscaled: (ResolutionChip & { from: string; render: PriceValue | null; upscale: PriceValue | null }) | null;
};

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
/** "480p", "4K", "1K": the size as a person reads it. */
export const sizeLabel = (id: string) => (/^\d+p$/i.test(id) ? id.toLowerCase() : same(id, "4k") ? "4K" : id);

/** A figure from the server, in this workspace's unit: credits, with the engine's dollars beside them for a workspace that pays in dollars. */
function priceOf(credits: number | undefined, price: number | undefined, unit: "cr" | "usd" | undefined): PriceValue | null {
  if (typeof credits !== "number" || !Number.isFinite(credits) || credits < 0) return null;
  return exact(credits, unit === "usd" && typeof price === "number" && Number.isFinite(price) ? price : undefined);
}

export type ResolutionInput = {
  /** The engine's own list, as the composer holds it. */
  resolutions: readonly string[];
  /** The size the composer will send. */
  resolution: string;
  /** A draft is on: the size is held at the draft's. */
  draft: boolean;
  /** The upscaled 4K is the pick (the render is at its `from`). */
  upscale: boolean;
  /** Video shows the ladder, the presets and the upscale; a still shows its own sizes. */
  video: boolean;
  /** The server's answer for THIS engine and these settings, or null while it is not here. */
  reply: ResolutionReply | null;
  /** Show no figures (references change the price, and the quote here does not carry them; the button does). */
  unpriced?: boolean;
};

export function resolutionView(input: ResolutionInput): ResolutionView {
  const options: ResolutionOptionReply[] = input.reply?.options.length
    ? input.reply.options
    : input.resolutions.map((id) => ({ id, label: sizeLabel(id), kind: "native" as const, available: true }));
  const upscaledPick = input.upscale && options.some((o) => o.id === UPSCALED_4K && o.available && o.from && same(o.from, input.resolution));
  const priced = (o: ResolutionOptionReply) => (input.unpriced || o.problem ? null : priceOf(o.estimatedCredits, o.price, o.unit));
  const chip = (o: ResolutionOptionReply): ResolutionChip => {
    /* A size the server lists but the composer's own list does not (or the other way about) is not pressed: the composer sends only its own. */
    const listed = o.kind === "upscaled" || input.resolutions.some((r) => same(r, o.id));
    const off = !o.available || !listed;
    const held = input.draft && !(o.kind === "native" && same(o.id, input.resolution));
    return {
      id: o.kind === "native" ? input.resolutions.find((r) => same(r, o.id)) ?? o.id : o.id,
      label: o.label || sizeLabel(o.id),
      enabled: !off && !held,
      off,
      reason: off ? o.reason ?? NOT_ON_ENGINE : held ? DRAFT_HOLDS : o.problem ?? null,
      pressed: !off && (o.kind === "upscaled" ? upscaledPick : !upscaledPick && same(o.id, input.resolution)),
      price: off ? null : priced(o),
      untested: Boolean(o.untested),
    };
  };
  const sizes = options.filter((o) => o.kind === "native").map(chip);
  const up = input.video ? options.find((o) => o.kind === "upscaled") : undefined;
  const upChip = up ? chip(up) : null;
  const steps = up?.steps ?? [];
  const step = (tool: "render" | "upscale") => {
    const s = steps.find((x) => x.tool === tool);
    return s && !input.unpriced ? priceOf(s.estimatedCredits, s.price, s.unit) : null;
  };
  const preset = (name: "Draft" | "Final", size: string) => {
    const at = sizes.find((s) => same(s.id, size));
    const base: ResolutionChip = at ?? { id: size, label: sizeLabel(size), enabled: false, off: true, reason: NOT_ON_ENGINE, pressed: false, price: null, untested: false };
    /* A preset is pressed only while its size is the plain pick (not a draft, not the upscale's render). */
    return { ...base, name, pressed: base.pressed && !input.draft };
  };
  return {
    presets: input.video ? [preset("Draft", DRAFT_PRESET), preset("Final", FINAL_PRESET)] : [],
    sizes,
    upscaled: upChip && up ? { ...upChip, from: up.from ?? "", render: step("render"), upscale: step("upscale") } : null,
  };
}

/** What a press on a chip asks the composer for: the size to send, and whether the upscale follows. */
export function resolutionPick(view: ResolutionView, id: string): { resolution: string; upscale: boolean } | null {
  if (view.upscaled && id === view.upscaled.id) return view.upscaled.enabled && view.upscaled.from ? { resolution: view.upscaled.from, upscale: true } : null;
  const size = [...view.sizes, ...view.presets].find((s) => s.id === id);
  return size && size.enabled ? { resolution: size.id, upscale: false } : null;
}

/** The body the route prices: this engine at these settings. No words are sent (a size's price does not depend on them), and nothing spends. */
export function resolutionQuery(input: { model: string; ratio: string; duration: number; generateAudio?: boolean }): Record<string, unknown> {
  return { model: input.model, ratio: input.ratio, duration: input.duration, ...(input.generateAudio ? { generateAudio: true } : {}) };
}
