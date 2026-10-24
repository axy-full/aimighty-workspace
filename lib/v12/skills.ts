/**
 * The "/" skills list in the new interface's bar (docs/redesign/inventory.md § 10.4; prototype C04), as data. Pure: no
 * React, no fetch (tests/unit/v12-skills.spec.ts).
 *
 * A row is a saved Atomik skill (lib/atomikSkills.ts: "/recipe") or a built-in that exists today as a Campaign format
 * (lib/v12/campaign.ts: a creative brief of today's catalogue that Make runs). The prototype's other built-ins (Captions,
 * Thumbnails, Narrated video, Narrator, Cast sheet, Brand assets, Ad versions, Edit) belong to stages that do not exist yet
 * (Social, Variants) and are not listed; each reads "quoted" through `builtInSkill` (lib/v12/unpriced.ts) once its stage is built.
 *
 * Picking a row only writes "/slug " into the bar. Nothing here prices or spends: a row's price is drawn by the screen from the
 * quote layer (a format's engine quote, or a saved skill's free preview), and a run goes through the paths that exist today.
 */
import { CAMPAIGN_FORMATS, type CampaignFormat } from "./campaign";
import type { SkillRunPreview, SkillView } from "@/lib/atomikSkillsText";
import { FREE, upTo } from "@/lib/shell/price-words";
import { QUOTE_FAULT, type Quote } from "./quote";
import type { UnpricedId } from "./unpriced";

export type SkillRow =
  | { kind: "built-in"; key: string; slug: string; name: string; line: string; format: CampaignFormat }
  | { kind: "saved"; key: string; slug: string; name: string; line: string; skill: SkillView };

/** "Product voice-over" → "product-voice-over": lower case, words joined by one hyphen. */
export const slugFor = (title: string): string => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * The built-ins that exist as Campaign formats, in the Formats stage's own order.
 *
 * Each item below is the same thing as its Formats card: the same price (the engines route at Make's settings, `formatQuote`),
 * and the same flow (the Campaign board's Formats stage, where Pick and Make are; Make shows the price on its button and a
 * person presses it). Owner's condition: no second path, no other price source, no other approval.
 *
 * Registry gaps (rule 11): none of these is a tool in the registry yet (A1 is not built). Each is a button-and-bar item on
 * today's paths until its tool exists; the names below are the ones to give them.
 *   // registry-gap: campaign_format_product_video_ad  (Make brief motion-orbit, video, /api/generate)
 *   // registry-gap: campaign_format_talking_review    (Make brief ugc-presenter, video, /api/generate; consent tick)
 *   // registry-gap: campaign_format_unboxing          (Make brief ugc-silent, video, /api/generate)
 *   // registry-gap: campaign_format_try_on            (Make brief editorial-model, stills, /api/generate; "quoted")
 *   // registry-gap: campaign_format_tutorial          (Make brief ugc-faceless, video, /api/generate)
 *   // registry-gap: campaign_format_product_voice_over (no brief or engine yet; "quoted", not pickable)
 *   // registry-gap: campaign_format_website_walk_through (no brief or engine yet; "quoted", not pickable)
 *   // registry-gap: campaign_format_photoshoot        (Make brief studio-seamless, stills, /api/generate; "quoted")
 */
export const BUILT_IN_ROWS: readonly SkillRow[] = CAMPAIGN_FORMATS.map((format): SkillRow => ({
  kind: "built-in", key: `built-in:${format.id}`, slug: slugFor(format.title), name: format.title, line: format.person ? `${format.line}` : format.line, format,
}));

// registry-gap: atomik_skill_run: a saved skill is run by POST /api/atomik/skills/[id]/run, the same route the Atomik composer's "/"
// and the Skills page use; its price here is that route's free preview ({dryRun:true}), the figure its run form shows, and its steps
// are approved one at a time at their own checkpoints.
/** Saved skills first (a person's own words for a thing win), then the built-ins whose command no saved skill has taken. */
export function skillRows(saved: readonly SkillView[]): SkillRow[] {
  const mine: SkillRow[] = saved.map((skill) => ({ kind: "saved", key: `saved:${skill.id}`, slug: skill.slug, name: skill.name, line: skill.description, skill }));
  const taken = new Set(mine.map((row) => row.slug));
  return [...mine, ...BUILT_IN_ROWS.filter((row) => !taken.has(row.slug))];
}

/** True while a command is being typed (`/`, `/unb`, `/unboxing`): the list is open. Once a space follows, the command is made. */
export const typingSlash = (text: string): boolean => /^\/[a-z0-9-]*$/i.test(text);

/** The rows a typed command matches, best first: the command itself, then the start of one, then anywhere in a command or a name. */
export function matchRows(text: string, rows: readonly SkillRow[], max = 12): SkillRow[] {
  const q = text.slice(1).toLowerCase();
  const exact = rows.filter((r) => r.slug === q);
  const starts = rows.filter((r) => r.slug !== q && r.slug.startsWith(q));
  const inside = rows.filter((r) => !r.slug.startsWith(q) && (r.slug.includes(q) || r.name.toLowerCase().includes(q)));
  return [...exact, ...starts, ...inside].slice(0, max);
}

/** The row a made command names (`/unboxing`, alone or with words after it), and those words. */
export function commandOf(text: string, rows: readonly SkillRow[]): { row: SkillRow; rest: string } | null {
  const m = /^\/([a-z][a-z0-9-]{1,39})(?:\s+([\s\S]*))?$/i.exec(text.trim());
  const row = m ? rows.find((r) => r.slug === m[1].toLowerCase()) ?? null : null;
  return row ? { row, rest: (m?.[2] ?? "").trim() } : null;
}

/** What a saved skill's free preview says as a price, or why it has none yet. Estimates, so a figure is "up to N cr". */
export function previewQuote(preview: SkillRunPreview): Quote | { reason: UnpricedId } {
  /* Why there is no total, said as the cause: an engine to choose, else a step with no list rate (or no steps). */
  if (preview.problems.length) return { reason: "skillPriceEngine" };
  if (!preview.steps.length) return { reason: "skillPriceStep" };
  if (preview.steps.some((s) => s.estCredits === null && s.estUsd === null)) return { reason: "skillPriceStep" };
  const credits = preview.steps.reduce((sum, s) => sum + (s.estCredits ?? 0), 0);
  const usd = preview.steps.reduce((sum, s) => sum + (s.estUsd ?? 0), 0);
  if (preview.steps.every((s) => s.estUsd !== null && s.estCredits === null)) return { state: "ready", price: { unit: "usd", usd, upTo: true } };
  if (credits <= 0) return { state: "ready", price: { unit: "cr", value: FREE } };
  const value = upTo(credits);
  return value ? { state: "ready", price: { unit: "cr", value } } : { state: "error", message: QUOTE_FAULT };
}

/** A refusal from the preview that means "the words are not filled in yet" (a parameter with no default), not a fault. */
export const needsWords = (message: string): boolean => /^Fill in /.test(message);

/**
 * A short-lived read kept per workspace scope: the same scope within `ttlMs` shares one read; another scope never reuses it, so
 * a workspace switch cannot see the last workspace's answer, even inside the window.
 */
export function scopedFresh<T>(ttlMs: number) {
  let last: { scope: string; at: number; value: T } | null = null;
  return (scope: string, now: number, make: () => T): T => {
    if (last && last.scope === scope && now - last.at <= ttlMs) return last.value;
    last = { scope, at: now, value: make() };
    return last.value;
  };
}
