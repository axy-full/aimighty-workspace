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

/** Where a person's choice is kept: this browser, per signed-in account (as the board toolbar's first-visit labels are). */
export const ENHANCE_KEY = "particl:v12-enhance";
export const enhanceKey = (userId: string | null | undefined): string => `${ENHANCE_KEY}:${userId ?? ""}`;

/** What this person chose, else the workspace's default (Settings › Advanced), which is On unless an admin turned it off. Nothing is chosen at sign-up. */
export function readEnhance(storage: Pick<Storage, "getItem"> | null, userId: string | null | undefined, workspaceDefault = true): boolean {
  try {
    const chosen = storage?.getItem(enhanceKey(userId));
    return chosen === "1" ? true : chosen === "0" ? false : workspaceDefault;
  } catch { return workspaceDefault; }
}
export function writeEnhance(storage: Pick<Storage, "setItem"> | null, userId: string | null | undefined, on: boolean): void {
  try { storage?.setItem(enhanceKey(userId), on ? "1" : "0"); } catch { /* the workspace's default applies again next time */ }
}

/** The workspace's default as its setting stores it (`enhanceDefault`: "on" or "off"). */
export const workspaceEnhance = (value: unknown): boolean => String(value ?? "on") !== "off";

/** Where Enhance applies: what is made from words (stills, clips, and the sound that is described: effects and music). A spoken line is read as written. */
export function enhanceOffered(type: string, audioTask: string | null | undefined): boolean {
  if (type === "image" || type === "video") return true;
  return type === "audio" && (audioTask === "sound" || audioTask === "music");
}

/** The label and the owner's exact tooltip (11 Oct): the name, then the line after the dash. */
export const ENHANCE_LABEL = "Enhance";
export const ENHANCE_TIP_NAME = "Enhance";
export const ENHANCE_TIP_LINE = "On: Particl rewrites your prompt for the chosen engine (light, camera, detail) before it runs. Its small cost is included in the price shown. Off: your prompt is sent exactly as you typed it.";

/** Said under the bar when Enhance is On but the enhancer cannot be priced: the take goes as written, and is labelled Raw. */
export const ENHANCE_ASWRITTEN = "Enhance can't be priced right now, so your words are sent as written.";

/** What a take records of it (generations.params, from the request's `enhanced`): `enhanced: true` with the words it was made from, or `false`. */
export type TakeEnhance = { label: "Enhanced"; original: string | null } | { label: "Raw" } | null;
export function takeEnhance(params: unknown): TakeEnhance {
  const p = (params ?? {}) as { enhanced?: unknown; rawPrompt?: unknown };
  if (p.enhanced === true) return { label: "Enhanced", original: typeof p.rawPrompt === "string" && p.rawPrompt.trim() ? p.rawPrompt : null };
  if (p.enhanced === false) return { label: "Raw" };
  return null;
}
