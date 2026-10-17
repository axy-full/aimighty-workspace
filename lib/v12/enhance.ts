/**
 * Enhance in Make (docs/redesign: the owner's night queue, item 2; reshaped by the owner's note of 16 Oct 2026, 13:15), as data. Pure: no React, no
 * fetch (tests/unit/v12-enhance.spec.ts).
 *
 * Enhance is the explicit prompt-writer job that already exists (POST /api/prompt/enhance, lib/paidText: quoted, approved at its figure, carried
 * back as `maxCredits`), run by `useEnhancer` (lib/shell/use-enhancer.ts) when a person presses the Enhance button. The enhanced words land in the
 * prompt box and nothing is generated; a later press of Make sends what the box holds, as written, and never waits on the enhancer. This file holds
 * what the new interface adds around it: whether the control is offered, and how a take says whether it was enhanced.
 */

/** Whether the workspace offers Enhance in Make, as its setting stores it (Settings › Advanced, `enhanceDefault`: "on" or "off"); On unless an admin turned it off. */
export const workspaceEnhance = (value: unknown): boolean => String(value ?? "on") !== "off";

/** Where Enhance applies: stills and clips, which are made from words and carry the label. Sound and a spoken line go as written (neither request carries one). */
export function enhanceOffered(type: string): boolean {
  return type === "image" || type === "video";
}

/**
 * Enhance is a Director tool, not an Agent one (the owner, 16 Oct 2026, decision 2b): it is offered where the person has picked what to make (Image or
 * Video, and the engine with it), never in Auto, where Atomik picks the model and settings.
 */
export function enhanceInMode(mode: string): boolean {
  return mode === "image" || mode === "video";
}

/** The button's own label. */
export const ENHANCE_LABEL = "Enhance";
/**
 * Its hover label (decision 2b, replacing the long tooltip of 15:50): "Enhance prompt", then one line with the press's price and "free if it fails". The
 * price is the server's quote for this press, never typed: "1 credit" where the workspace pays in credits, the text model's own dollars where it pays in
 * dollars (the house), and only "Free if it fails" until the quote is in. The writer is never named.
 */
export const ENHANCE_TIP_NAME = "Enhance prompt";
export const ENHANCE_TIP_FREE = "free if it fails";
export function enhanceTipLine(price: { credits: number | null; usd: number | null; dollars: boolean }, fmtUsd: (usd: number) => string): string {
  const figure = price.dollars
    ? (typeof price.usd === "number" && Number.isFinite(price.usd) && price.usd >= 0 ? fmtUsd(price.usd) : null)
    : (typeof price.credits === "number" && Number.isFinite(price.credits) && price.credits >= 0
      ? `${price.credits.toLocaleString("en-US", { maximumFractionDigits: 1 })} ${price.credits === 1 ? "credit" : "credits"}`
      : null);
  return figure ? `${figure} · ${ENHANCE_TIP_FREE}` : `${ENHANCE_TIP_FREE[0].toUpperCase()}${ENHANCE_TIP_FREE.slice(1)}`;
}

/** What a press says while it waits and when it ends. The hint comes at 2 s; it names no engine, so it is right in Agent mode too. */
export const ENHANCE_WORKING = "Enhancing…";
export const ENHANCE_HINT = "Rewriting for the chosen engine: light, camera, detail";
export const ENHANCE_HINT_AFTER_MS = 2_000;
/** The progress line runs toward this: the time the first words may take. */
export const ENHANCE_PROGRESS_MS = 8_000;
/** How long the changed words stay marked once the rewrite is in. */
export const ENHANCE_MARK_MS = 2_400;
export const ENHANCE_UNDO = "Undo enhance";
export const ENHANCE_AGAIN = "Try again";

/** The rewrite as pieces, each marked when it says something the typed words did not (a word the original lacks), for the brief highlight once a rewrite lands. Case and edge punctuation do not count as a change. */
export function changedWords(original: string, enhanced: string): { text: string; changed: boolean }[] {
  const bare = (word: string) => word.toLowerCase().replace(/^[^\p{L}\p{N}@]+|[^\p{L}\p{N}]+$/gu, "");
  const had = new Map<string, number>();
  for (const word of original.split(/\s+/)) { const key = bare(word); if (key) had.set(key, (had.get(key) ?? 0) + 1); }
  return (enhanced.match(/\S+\s*/g) ?? []).map((piece) => {
    const key = bare(piece.trim());
    const left = key ? had.get(key) ?? 0 : 0;
    if (left > 0) { had.set(key, left - 1); return { text: piece, changed: false }; }
    return { text: piece, changed: Boolean(key) };
  });
}

/** What a take records of it (generations.params, from the request's `enhanced`, once the enhancer's own job is proved: lib/enhanceProof.ts): `enhanced: true` with the typed words in `enhancedFrom` (`rawPrompt` keeps its old meaning), or `false`. */
export type TakeEnhance = { label: "Enhanced"; original: string | null } | { label: "Raw" } | null;
export function takeEnhance(params: unknown): TakeEnhance {
  const p = (params ?? {}) as { enhanced?: unknown; enhancedFrom?: unknown };
  if (p.enhanced === true) return { label: "Enhanced", original: typeof p.enhancedFrom === "string" && p.enhancedFrom.trim() ? p.enhancedFrom : null };
  if (p.enhanced === false) return { label: "Raw" };
  return null;
}
