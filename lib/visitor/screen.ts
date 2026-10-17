import { AUDIO_LABELS, MODELS, thinkingModelDisplayName } from "../models";
import { PROVIDER_DISPLAY_NAMES, VENDOR_NAME_PATTERN, connectedFamilyNameIn } from "../vendorNames";
import { DIRECT_MODEL_IDS, UNMAPPED_DIRECT_MODEL_IDS } from "../textRoute";
import modelCatalogJson from "../modelCatalog.json";
import { HELD_ANSWER, HELD_PRICE_ANSWER, INSTRUCTIONS_MARKER, VISITOR_INSTRUCTIONS } from "./instructions";

/**
 * The visitor bar's second line of defence (v30 Phase A, item 9). The instructions already say nothing worth taking;
 * this screen checks every answer before it leaves the server, whatever the model was talked into, and holds back an
 * answer that:
 *
 *  - names an engine, a vendor or a model: every name is read from the server's own registries (lib/models.ts, the
 *    vendor-name rules in lib/vendorNames.ts, the text routes in lib/textRoute.ts, the text catalogue snapshot), never
 *    typed here, so a name added to a registry is screened from the day it is added;
 *  - carries a price: a figure next to credits, a currency, cents, a month, or a percentage off;
 *  - repeats the instructions: any run of six words from them, or their marker;
 *  - hides any of that: reversed, in rot13, spaced out letter by letter, or as a long encoded run (base64, hex).
 *
 * A held answer is replaced whole by a fixed one (no half-redacted sentence with a version number left behind).
 * Pure: no I/O, no logging.
 */

export type ScreenReason = "name" | "price" | "instructions" | "encoded";
export type Screened = { answer: string; held: ScreenReason | null };

/** Single words in the registries that are ordinary English, so a whole-word match on them alone would hold back
 *  ordinary answers. Each still counts inside the longer registry name it belongs to ("Nano Banana", "Cinema Studio"). */
const ORDINARY = new Set([
  "gateway", "cinema", "studio", "soul", "nano", "image", "images", "video", "videos", "pro", "mini", "flash", "lite", "turbo",
  "motion", "identity", "product", "marketing", "ray", "imagine", "object", "swap", "transfer", "render", "still", "voice",
  "music", "sound", "effects", "standard", "fast", "preview", "expand", "cutout", "upscale", "reasoning", "thinking",
]);

const words = (text: string) => text.replace(/\([^)]*\)/g, " ").replace(/[-_/·:]+/g, " ").trim().split(/\s+/).filter(Boolean);
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type CatalogEntry = { id: string; name?: string; owner?: string };
function catalogEntries(): CatalogEntry[] {
  const json = modelCatalogJson as { models?: CatalogEntry[]; providerPriced?: CatalogEntry[] };
  return [...(json.models ?? []), ...(json.providerPriced ?? [])];
}

/** Every engine, vendor and model name the server knows, as whole phrases and distinctive single words. */
export function registryNames(): string[] {
  const out = new Set<string>();
  const phrase = (text: string | null | undefined) => {
    const clean = (text ?? "").replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
    if (clean.length >= 2 && /[a-z]/i.test(clean)) out.add(clean);
  };
  const word = (text: string | null | undefined) => {
    const clean = (text ?? "").trim();
    if (clean.length >= 3 && /^[a-z][a-z0-9.]*$/i.test(clean) && !ORDINARY.has(clean.toLowerCase())) out.add(clean);
  };
  /* A multi-word name: the whole of it, its first word when that word is a brand, and its tail when the tail carries a
     version ("Haiku 5.5"), so a name cut short still counts. */
  const name = (text: string | null | undefined) => {
    const parts = words(text ?? "");
    if (!parts.length) return;
    phrase(parts.join(" "));
    word(parts[0]);
    const tail = parts.slice(1);
    if (tail.length >= 2 && /^[a-z]{3,}$/i.test(tail[0]) && !ORDINARY.has(tail[0].toLowerCase()) && tail.some((part) => /\d/.test(part))) phrase(tail.join(" "));
  };
  for (const model of MODELS) {
    /* Our own engines' names, their families and the services behind them. A neutral label (a Make mode such as
       motion transfer) is a product word, not an engine's name: it is screened only when it carries a brand. */
    phrase(model.id);
    word(model.provider);
    name(model.family);
  }
  for (const model of MODELS) if (words(model.label).some((part) => [...out].some((known) => known.toLowerCase() === part.toLowerCase()))) name(model.label);
  for (const label of Object.values(AUDIO_LABELS)) phrase(label.label);
  for (const id of Object.keys(PROVIDER_DISPLAY_NAMES)) { phrase(id); word(id); }
  for (const [app, provider] of Object.entries(DIRECT_MODEL_IDS)) {
    phrase(app); phrase(provider); word(app.split("/")[0]);
    name(thinkingModelDisplayName(app));
  }
  for (const app of UNMAPPED_DIRECT_MODEL_IDS) { phrase(app); name(thinkingModelDisplayName(app)); }
  for (const entry of catalogEntries()) {
    phrase(entry.id); word(entry.id.split("/")[0]); word(entry.owner);
    name(entry.name); name(thinkingModelDisplayName(entry.id));
  }
  /* A one-word line name that is also a word ("Image") stays out; everything else is matched as a whole word. */
  return [...out].filter((n) => !(n.split(" ").length === 1 && ORDINARY.has(n.toLowerCase()))).sort((a, b) => b.length - a.length);
}

let cached: { pattern: RegExp; letters: string[] } | null = null;
function names() {
  if (cached) return cached;
  const list = registryNames();
  const pattern = new RegExp(`(?<![A-Za-z0-9])(?:${list.map((n) => escape(n).replace(/\\?[ ]/g, "[\\s\\-_]+")).join("|")})(?![A-Za-z0-9])`, "i");
  /* For text spaced out or punctuated letter by letter: the longer single names, letters only. */
  const letters = [...new Set(list.filter((n) => !n.includes(" ")).map((n) => n.toLowerCase().replace(/[^a-z]/g, "")).filter((n) => n.length >= 6))];
  cached = { pattern, letters };
  return cached;
}

function namesIn(text: string): boolean {
  return names().pattern.test(text) || VENDOR_NAME_PATTERN.test(text) || connectedFamilyNameIn(text) !== null;
}

const NUMBER_WORDS = "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|half";
const PRICE_PATTERNS: readonly RegExp[] = [
  /\d(?:[\d,.]|\s(?=\d))*\s*(?:cr|credits?|cents?|dollars?|bucks|usd|eur|euros?|gbp|pounds?|inr|rupees?|rs)\b/i,
  /(?:us\$|\$|€|£|₹|¥|\busd|\beur|\binr|\brs\.?)\s*\d/i,
  new RegExp(`\\b(?:${NUMBER_WORDS})(?:[\\s-]+(?:${NUMBER_WORDS}|and))*[\\s-]+(?:cr|credits?|cents?|dollars?|bucks|euros?|pounds?|rupees?)\\b`, "i"),
  /\bcredits?\b[^.!?\n]{0,24}?\d/i,
  /\d[\d,.]*\s*(?:\/\s*mo(?:nth)?\b|per\s+(?:month|year|second|minute|clip|shot|take|image|still|video)\b|a\s+(?:month|year)\b|monthly\b)/i,
  /\d+(?:\.\d+)?\s*%\s*(?:off|bonus|discount|margin|markup|more|less|cheaper)\b/i,
];
const priceIn = (text: string) => PRICE_PATTERNS.some((pattern) => pattern.test(text));

const normal = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
const SHINGLE = 6;
let instructionShingles: Set<string> | null = null;
function shingles(list: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE <= list.length; i++) out.add(list.slice(i, i + SHINGLE).join(" "));
  return out;
}
function repeatsInstructions(text: string): boolean {
  if (INSTRUCTIONS_MARKER.test(text)) return true;
  instructionShingles ??= shingles(normal(VISITOR_INSTRUCTIONS));
  for (const shingle of shingles(normal(text))) if (instructionShingles.has(shingle)) return true;
  return false;
}

const rot13 = (text: string) => text.replace(/[a-z]/gi, (c) => String.fromCharCode((c <= "Z" ? 65 : 97) + ((c.toLowerCase().charCodeAt(0) - 97 + 13) % 26)));
const reversed = (text: string) => [...text].reverse().join("");
/** A run no plain answer has: 24 or more characters of an encoding's alphabet with no space. */
const ENCODED_RUN = /[A-Za-z0-9+/_=-]{24,}|(?:[0-9a-f]{2}[\s:]?){16,}/i;
function decodedRuns(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/[A-Za-z0-9+/_-]{12,}={0,2}/g)) {
    try {
      const decoded = Buffer.from(match[0].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
      if (/^[\x20-\x7e\s]+$/.test(decoded)) out.push(decoded);
    } catch { /* not base64 */ }
  }
  return out;
}

/** Why an answer must be held back, or null when it may be shown. */
export function screenReason(text: string): ScreenReason | null {
  const variants = [text, reversed(text), rot13(text), reversed(rot13(text)), ...decodedRuns(text)];
  if (variants.some(repeatsInstructions)) return "instructions";
  if (variants.some(namesIn)) return "name";
  const spaced = text.toLowerCase().replace(/[^a-z]/g, "");
  if (names().letters.some((n) => spaced.includes(n) || reversed(spaced).includes(n))) return "name";
  if (priceIn(text) || decodedRuns(text).some(priceIn)) return "price";
  if (ENCODED_RUN.test(text)) return "encoded";
  return null;
}

/** The answer a visitor may read: the model's own when it passes, else the fixed one for the reason. */
export function screenVisitorAnswer(text: string): Screened {
  const held = screenReason(text);
  if (!held) return { answer: text, held: null };
  return { answer: held === "price" ? HELD_PRICE_ANSWER : HELD_ANSWER, held };
}
