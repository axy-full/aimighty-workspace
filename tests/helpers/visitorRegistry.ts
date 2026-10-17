import { AUDIO_LABELS, MODELS, thinkingModelDisplayName } from "../models";
import { PROVIDER_DISPLAY_NAMES } from "../vendorNames";
import { DIRECT_MODEL_IDS, UNMAPPED_DIRECT_MODEL_IDS } from "../textRoute";
import modelCatalogJson from "../modelCatalog.json";

/**
 * Every engine, vendor and model name Particl's own registries hold (lib/models.ts, lib/vendorNames.ts, lib/textRoute.ts,
 * the text catalogue snapshot), as whole phrases and distinctive single words.
 *
 * NOT used by the visitor bar's screen, on purpose: a screen that held Particl's names would tell a visitor which names
 * are Particl's. The screen holds one typed industry list (lib/visitor/screen.ts `INDUSTRY_NAMES`), and
 * tests/unit/visitorBar.spec.ts uses this list to prove that every name here is inside it. Nothing in the route imports
 * this file.
 */

/** Single words in the registries that are ordinary English, so a whole-word match on them alone would hold back
 *  ordinary answers. Each still counts inside the longer registry name it belongs to ("Nano Banana", "Cinema Studio"). */
const ORDINARY = new Set([
  "gateway", "cinema", "studio", "soul", "nano", "image", "images", "video", "videos", "pro", "mini", "flash", "lite", "turbo",
  "motion", "identity", "product", "marketing", "ray", "imagine", "object", "swap", "transfer", "render", "still", "voice",
  "music", "sound", "effects", "standard", "fast", "preview", "expand", "cutout", "upscale", "reasoning", "thinking",
]);

const words = (text: string) => text.replace(/\([^)]*\)/g, " ").replace(/[-_/·:]+/g, " ").trim().split(/\s+/).filter(Boolean);

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
