/**
 * The Enhance toggle in Make (docs/redesign: the owner's night queue, item 2), as data. Pure: no React, no fetch
 * (tests/unit/v12-enhance.spec.ts).
 *
 * Enhance is the explicit prompt-writer job that already exists (POST /api/prompt/enhance, lib/paidText: quoted, approved
 * at its figure, carried back as `maxCredits`), run by `useEnhancer` (lib/shell/use-enhancer.ts) in its Auto mode: with Auto
 * on, the one press on Make enhances the words and then sends the take, and the button's figure is the take plus the
 * enhancement, so a person approves both at once. This file holds what the new interface adds around it: whether the toggle is
 * offered, what a person last chose (per person, default On), and how a take says whether it was enhanced.
 */

/** Where a person's choice is kept: this device's browser, per workspace and per signed-in account (there is no server-side preference store for a person). */
export const ENHANCE_KEY = "particl:v12-enhance";
export const enhanceKey = (workspaceId: string | null | undefined, userId: string | null | undefined): string => `${ENHANCE_KEY}:${workspaceId ?? ""}:${userId ?? ""}`;

/** What this person chose, else the workspace's default (Settings › Advanced), which is On unless an admin turned it off. Nothing is chosen at sign-up. */
export function readEnhance(storage: Pick<Storage, "getItem"> | null, workspaceId: string | null | undefined, userId: string | null | undefined, workspaceDefault = true): boolean {
  try {
    const chosen = storage?.getItem(enhanceKey(workspaceId, userId));
    return chosen === "1" ? true : chosen === "0" ? false : workspaceDefault;
  } catch { return workspaceDefault; }
}
export function writeEnhance(storage: Pick<Storage, "setItem"> | null, workspaceId: string | null | undefined, userId: string | null | undefined, on: boolean): void {
  try { storage?.setItem(enhanceKey(workspaceId, userId), on ? "1" : "0"); } catch { /* the workspace's default applies again next time */ }
}

/** The workspace's default as its setting stores it (`enhanceDefault`: "on" or "off"). */
export const workspaceEnhance = (value: unknown): boolean => String(value ?? "on") !== "off";

/** Where Enhance applies: stills and clips, which are made from words and carry the label. Sound and a spoken line go as written (neither request carries one). */
export function enhanceOffered(type: string): boolean {
  return type === "image" || type === "video";
}

/** The label and the owner's exact tooltip (11 Oct): the name, then the line after the dash. */
export const ENHANCE_LABEL = "Enhance";
export const ENHANCE_TIP_NAME = "Enhance";
export const ENHANCE_TIP_LINE = "On: Particl rewrites your prompt for the chosen engine (light, camera, detail) before it runs. Its small cost is included in the price shown. Off: your prompt is sent exactly as you typed it.";

/** Said under the bar when Enhance is On but the enhancer cannot be priced: the take goes as written, and is labelled Raw. */
export const ENHANCE_ASWRITTEN = "Enhance can't be priced right now, so your words are sent as written.";

/** What a take records of it (generations.params, from the request's `enhanced`, once the enhancer's own job is proved: lib/enhanceProof.ts): `enhanced: true` with the typed words in `enhancedFrom` (`rawPrompt` keeps its old meaning), or `false`. */
export type TakeEnhance = { label: "Enhanced"; original: string | null } | { label: "Raw" } | null;
export function takeEnhance(params: unknown): TakeEnhance {
  const p = (params ?? {}) as { enhanced?: unknown; enhancedFrom?: unknown };
  if (p.enhanced === true) return { label: "Enhanced", original: typeof p.enhancedFrom === "string" && p.enhancedFrom.trim() ? p.enhancedFrom : null };
  if (p.enhanced === false) return { label: "Raw" };
  return null;
}
