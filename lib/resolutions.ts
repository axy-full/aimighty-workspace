import type { ModelDef } from "./models";
import { ASTRA_MODEL } from "./astra";

/**
 * Resolution is a visible choice, and the server holds the list (owner, 16 Oct 2026, § D).
 *
 * ONE LIST PER ENGINE, in code: `ModelDef.resolutions` in lib/models.ts. This file reads it and adds nothing to it. A request that names a resolution the
 * engine does not list is REFUSED, at the quote and at the press alike (both run lib/generationAdmission.ts), with the reason in words; it is never quietly
 * turned into the engine's first size. A request that names none gets the engine's default (its first size).
 *
 * NATIVE and UPSCALED 4K are separate options. Native 4K is a size the engine itself lists. Upscaled 4K is the engine's top native size plus an upscale step,
 * two jobs, each priced by the quote engine (lib/resolutionQuote.ts) and each approved as its own: the render, and then the upscale of the finished take
 * (Topaz Astra, `UPSCALE_MODEL`). It is offered only where the engine has no native 4K that has been tested, on a model that makes video from words.
 *
 * Pure and client-safe: no prices here (those are the server's).
 */
export const RESOLUTION_LADDER = ["480p", "720p", "1080p", "4k"] as const;
/** The words an option the engine cannot do carries. */
export const NOT_ON_ENGINE = "not on this engine";
export const UPSCALED_4K = "4k-upscaled";
/** The upscale step's engine: priced through the same quote engine as any render. */
export const UPSCALE_MODEL = ASTRA_MODEL;

type Listed = Pick<ModelDef, "id" | "label" | "kind" | "resolutions" | "untestedResolutions" | "supportsTasks">;

export type ResolutionOption = {
  /** What a request names: a size from the engine's list, or `UPSCALED_4K` (a plan, not a size to send). */
  id: string;
  /** What a person reads. */
  label: string;
  kind: "native" | "upscaled";
  /** False when the engine cannot do it: the option is shown greyed out, with `reason`. */
  available: boolean;
  reason?: string;
  /** A size the vendor lists that has never been rendered here. */
  untested?: boolean;
  /** An upscaled option: the size the render is made at, and the engine that upscales it. */
  from?: string;
  via?: string;
};

const lower = (v: string) => v.trim().toLowerCase();
const show = (id: string) => (/^\d+p$/i.test(id) ? id.toLowerCase() : id === "4k" || id === "4K" ? "4K" : id);
const words = (ids: readonly string[]) => ids.map(show).join(", ");

/** The engine's own list, as the vendor spells each size. */
export const listedResolutions = (model: Listed): readonly string[] => model.resolutions;

/** The size the engine's own default is (its first), and what a request that names none gets. */
export const defaultResolution = (model: Listed): string => model.resolutions[0];

/** The largest size on the ladder the engine has rendered here (an untested size is offered, never the headline). */
export function topNativeResolution(model: Listed): string | null {
  const untested = new Set((model.untestedResolutions ?? []).map(lower));
  const have = model.resolutions.filter((r) => !untested.has(lower(r)) && (RESOLUTION_LADDER as readonly string[]).includes(lower(r)));
  if (!have.length) return null;
  return have.reduce((a, b) => ((RESOLUTION_LADDER as readonly string[]).indexOf(lower(b)) > (RESOLUTION_LADDER as readonly string[]).indexOf(lower(a)) ? b : a));
}

/** Does this engine make 4K by an upscale step: a video engine that makes video from words, with no tested native 4K? */
export function upscalesToFourK(model: Listed): boolean {
  if (model.kind !== "video" || !model.supportsTasks?.includes("generate") || model.id === UPSCALE_MODEL) return false;
  const top = topNativeResolution(model);
  return top != null && lower(top) !== "4k";
}

/**
 * The verdict on a requested size: the engine's own spelling of it, or the refusal in words. Omitted (null, undefined, empty) is the engine's default. A size is
 * judged against THIS engine's list, case aside; anything else is refused with what the engine does make.
 */
export function pickResolution(model: Listed, requested: unknown): { resolution: string } | { error: string; resolutions: readonly string[] } {
  if (requested == null || requested === "") return { resolution: defaultResolution(model) };
  const list = listedResolutions(model);
  const found = typeof requested === "string" ? list.find((r) => lower(r) === lower(requested)) : undefined;
  if (found) return { resolution: found };
  const asked = typeof requested === "string" && requested.length <= 24 ? requested : "that size";
  if (typeof requested === "string" && lower(requested) === UPSCALED_4K)
    return { error: `4K upscaled is a ${show(topNativeResolution(model) ?? defaultResolution(model))} render and then an upscale, two steps each priced and approved on its own: render it at ${show(topNativeResolution(model) ?? defaultResolution(model))}.`, resolutions: list };
  const natively = typeof requested === "string" && lower(requested) === "4k" && upscalesToFourK(model);
  return {
    error: `${model.label} does not make ${show(asked)}${natively ? " natively" : ""}. It makes ${words(list)}.${natively ? ` For 4K, make it at ${show(topNativeResolution(model)!)} and upscale it.` : ""}`,
    resolutions: list,
  };
}

/**
 * The options the Resolution control shows for an engine: its own sizes, the sizes on the ladder it cannot do (greyed out, "not on this engine"), and the
 * upscaled 4K where it applies. Prices are not here: the quote engine adds them (lib/resolutionQuote.ts).
 */
export function resolutionOptions(model: Listed): ResolutionOption[] {
  const untested = new Set((model.untestedResolutions ?? []).map(lower));
  const options: ResolutionOption[] = model.resolutions.map((id) => ({ id, label: show(id), kind: "native", available: true, ...(untested.has(lower(id)) ? { untested: true } : {}) }));
  if (model.kind !== "video" || model.id === UPSCALE_MODEL) return options;
  const have = new Set(model.resolutions.map(lower));
  for (const id of RESOLUTION_LADDER) if (!have.has(id)) options.push({ id, label: show(id), kind: "native", available: false, reason: NOT_ON_ENGINE });
  const order = (id: string) => ((RESOLUTION_LADDER as readonly string[]).indexOf(lower(id)) + 1 || 99);
  options.sort((a, b) => order(a.id) - order(b.id));
  const top = topNativeResolution(model);
  options.push(upscalesToFourK(model)
    ? { id: UPSCALED_4K, label: "4K upscaled", kind: "upscaled", available: true, from: top!, via: UPSCALE_MODEL }
    : { id: UPSCALED_4K, label: "4K upscaled", kind: "upscaled", available: false, reason: NOT_ON_ENGINE });
  return options;
}
