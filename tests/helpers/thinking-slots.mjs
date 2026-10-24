/**
 * Thinking slots for tests and CI (owner, 23 Oct 2026, option A). The app maps no slot to a model: each slot's model is the deployment's env
 * (ATOMIK_THINKING_{HIGH,MEDIUM,LOW}_MODEL, lib/atomikModelPolicy.ts). Tests and the CI servers set those three here, to distinct ids picked
 * from the verified Claude catalogue by the checked-in catalogue's prices, never by name (pickThinkingSlots). These are test fixtures, not
 * a recommendation for the deployment's slots.
 *
 * `node tests/helpers/thinking-slots.mjs` prints the three as KEY=value lines; with --github-env it masks them and appends them to
 * $GITHUB_ENV. tests/helpers/thinkingSlots.ts sets them for a unit spec.
 */
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

/* The repository root: every caller (Playwright, CI's steps, the rehearsal) runs from it. No import.meta, so Playwright can load this. */
const ROOT = process.cwd();
const RATES = ["input", "output", "input_cache_read", "input_cache_write"];
export const SLOT_SETTINGS = ["high", "medium", "low"];
export const slotModelEnv = (setting) => `ATOMIK_THINKING_${setting.toUpperCase()}_MODEL`;

const ratesOf = (pricing) => {
  const rates = {};
  for (const key of RATES) {
    const value = Number(pricing?.[key]);
    if (pricing?.[key] == null || !Number.isFinite(value) || value <= 0) return null;
    rates[key] = value;
  }
  return rates;
};
const total = (rates) => RATES.reduce((sum, key) => sum + rates[key], 0);
/** Whether `below` is no dearer than `above` on every rate. */
const noDearer = (above, below) => RATES.every((key) => below[key] <= above[key]);
const offersHigh = (entry) => (entry.reasoningOptions ?? []).some((option) => option.type === "effort" && option.values?.includes("high"));

/**
 * Three distinct slot ids from `entries` (catalogue entries) limited to `allowed`, by price, or null when the catalogue cannot give three.
 * Every ordered triple is tried (High dearer than Medium dearer than Low by the rates summed, each no dearer on any rate than the slot
 * above it); the one kept has the dearest High, then the cheapest Low, then the Medium nearest the middle (the cheaper on a tie).
 */
export function pickThinkingSlots(entries, allowed) {
  const ok = new Set(allowed), seen = new Set();
  const priced = entries
    .filter((entry) => ok.has(entry.id) && offersHigh(entry) && !seen.has(entry.id) && seen.add(entry.id))
    .map((entry) => ({ id: entry.id, rates: ratesOf(entry.pricing) }))
    .filter((entry) => entry.rates)
    /* Dearest first; equal totals keep a fixed order so every run picks the same three. */
    .sort((a, b) => total(b.rates) - total(a.rates) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const below = (above, entry) => total(entry.rates) < total(above.rates) && noDearer(above.rates, entry.rates);
  let best = null;
  for (let i = 0; i < priced.length; i++) for (let k = priced.length - 1; k > i; k--) for (let j = i + 1; j < k; j++) {
    if (!below(priced[i], priced[j]) || !below(priced[j], priced[k])) continue;
    /* Smaller is better, compared in order: the dearest High, the cheapest Low, the Medium nearest the middle, the cheaper Medium. */
    const rank = [i, -k, Math.abs(j - (i + k) / 2), -j];
    const first = best ? rank.findIndex((value, n) => value !== best.rank[n]) : -1;
    if (!best || (first >= 0 && rank[first] < best.rank[first])) best = { rank, slots: { high: priced[i].id, medium: priced[j].id, low: priced[k].id } };
  }
  return best ? best.slots : null;
}

/** A list in a source file: from its declaration to the first `endMarker` after it. */
const slice = (text, start, endMarker) => {
  const from = text.indexOf(start);
  if (from < 0) return "";
  const to = text.indexOf(endMarker, from);
  return text.slice(from, to < 0 ? undefined : to);
};

/** The catalogue's Claude ids a slot may name, read from the sources (the verified list, with a direct door). */
export function slotCandidates(root = ROOT) {
  const policy = readFileSync(path.join(root, "lib/atomikModelPolicy.ts"), "utf8");
  const verified = slice(policy, "export const VERIFIED_TEXT_MODEL_IDS", "] as const");
  const route = readFileSync(path.join(root, "lib/textRoute.ts"), "utf8");
  const direct = slice(route, "export const DIRECT_MODEL_IDS", "\n};");
  const ids = (text) => [...text.matchAll(/"(anthropic\/[a-z0-9.-]+)"/g)].map((match) => match[1]);
  const doors = new Set(ids(direct));
  return ids(verified).filter((id) => doors.has(id));
}

/** Why no slots were set, when the catalogue gives no three: Atomik's specs say so, and nothing else is stopped. */
export const NO_SLOTS = "The checked-in catalogue has no three verified Claude models, priced on all four rates, that can set the Thinking slots (tests/helpers/thinking-slots.mjs).";

/** The three slot env variables, as tests and the CI servers set them; empty (never a throw) when the catalogue cannot give three. */
export function thinkingSlotEnv(root = ROOT) {
  try {
    const catalog = JSON.parse(readFileSync(path.join(root, "lib/modelCatalog.json"), "utf8"));
    const slots = pickThinkingSlots(catalog.models ?? [], slotCandidates(root));
    return slots ? Object.fromEntries(SLOT_SETTINGS.map((setting) => [slotModelEnv(setting), slots[setting]])) : {};
  } catch {
    return {};
  }
}

/* `node tests/helpers/thinking-slots.mjs` prints KEY=value lines. With --github-env (CI), each value is masked in the job's log
   (::add-mask::) and the lines are appended to $GITHUB_ENV, so no later step's log shows them. */
if (process.argv[1] && path.basename(process.argv[1]) === "thinking-slots.mjs") {
  const env = thinkingSlotEnv();
  if (!Object.keys(env).length) console.error(`::warning::${NO_SLOTS}`);
  if (process.argv.includes("--github-env")) {
    for (const value of Object.values(env)) console.log(`::add-mask::${value}`);
    if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, Object.entries(env).map(([key, value]) => `${key}=${value}\n`).join(""));
  } else for (const [key, value] of Object.entries(env)) console.log(`${key}=${value}`);
}
