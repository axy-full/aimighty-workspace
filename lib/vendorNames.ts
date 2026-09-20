/**
 * Vendor and competitor names never appear in product copy (owner decision,
 * 19 September 2026). Internal ids, env vars, API paths and code identifiers
 * keep them; everything a person reads uses the neutral vocabulary instead.
 *
 * This is the single list the UI guard (tests/unit/noVendorNamesInUi.spec.ts)
 * and the display-name functions share.
 */
export const VENDOR_NAMES = [
  "Seedance", "Seedream", "Dreamina", "ByteDance", "BytePlus", "ModelArk",
  "Higgsfield", "Genjutsu", "ElevenLabs", "OpenAI", "ChatGPT", "GPT",
  "Claude", "Anthropic", "Sonnet", "Opus", "Haiku", "Fable", "Blender",
  "Kling", "Kuaishou", "Veo", "Google", "Gemini", "Runway", "Sora",
  "Midjourney", "Flux", "Luma", "Pika", "Nano Banana", "Soul ID",
  "Soul Character", "Vercel", "Topaz", "Bria", "fal.ai", "fal", "Wan",
] as const;

/** Case-insensitive, whole-word. "GPT" also catches "GPT-6", "GPT Image".
 *  "Eleven" only as the audio product line, never the English number.
 *  "Runway" only capitalised: "months of runway" is ordinary English. */
export const VENDOR_NAME_PATTERN = new RegExp(
  String.raw`(?:\b(?:${VENDOR_NAMES.filter(name => name !== "Runway")
    .map(name => name.replace(/[.]/g, String.raw`\.`).replace(/ /g, String.raw`[\s-]+`))
    .join("|")})\b)|\bEleven\s+(?:v\d|Multilingual|Flash|Turbo|Sound|Music)\b`,
  "i",
);
const RUNWAY = /\bRunway\b/;

export function hasVendorName(text: string): boolean {
  return VENDOR_NAME_PATTERN.test(text) || RUNWAY.test(text);
}

/** The first banned name in a piece of copy, for readable test failures. */
export function vendorNameIn(text: string): string | null {
  return text.match(VENDOR_NAME_PATTERN)?.[0] ?? text.match(RUNWAY)?.[0] ?? null;
}

/** Neutral names for the provider accounts behind the engines, keyed by
 *  both provider id (lib/providers.ts) and key name (lib/vendorKeys.ts). */
export const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  byteplus: "Connected video account",
  ark: "Connected video account",
  google: "Connected image account",
  gemini: "Connected image account",
  fal: "Connected render account",
  elevenlabs: "Connected audio account",
  vercel: "Connected model gateway",
  gateway: "Connected model gateway",
  openai: "Connected language account",
  anthropic: "Connected model gateway",
  higgsfield: "Connected identity account",
  "higgsfield-consumer": "Connected account",
};

export function providerDisplayName(id: string): string {
  return PROVIDER_DISPLAY_NAMES[id] ?? (hasVendorName(id) ? "Connected account" : id);
}

/**
 * Third-party model families, renamed for display. Order matters: longer
 * phrases first. A family keeps its version and tier words, so
 * "Seedance 2.0 Mini" reads "Motion 2.0 Mini" and "Google Veo 3.1 Lite"
 * reads "Vista 3.1 Lite". Vendor prefixes that name only the company are
 * dropped.
 */
const FAMILY_RENAMES: [RegExp, string][] = [
  [/\bSoul[\s-]+ID\b/gi, "Identity"],
  [/\bSoul[\s-]+Character\b/gi, "Identity render"],
  [/\bHiggsfield\s+Soul\b/gi, "Persona"],
  [/\bSoul(?=\s+(?:\d|Cinema|Cast|Location|v\d))/gi, "Persona"],
  [/\bNano\s+Banana\b/gi, "Image"],
  [/\bGPT[-\s]?Image\b/gi, "Forge Image"],
  [/\bChatGPT\b/gi, "your assistant"],
  [/\bGPT-6\s+Astra\b/gi, "Astra"],
  [/\bGPT\b/gi, "Forge"],
  [/\bOpenAI\b/gi, "Forge"],
  [/\bClaude\b/gi, "Sage"],
  [/\bAnthropic\b/gi, "Sage"],
  [/\bGoogle\s+Veo\b/gi, "Vista"],
  [/\bVeo\b/gi, "Vista"],
  [/\bGemini\b/gi, "Prism"],
  [/\bSeedance\b/gi, "Motion"],
  [/\bSeedream\b/gi, "Still"],
  [/\bSeed\s+Audio\b/gi, "Audio"],
  [/\bKling\b/gi, "Kinetic"],
  [/\bFLUX\.(?=\d)/gi, "Frame "],
  [/\bFlux\b/gi, "Frame"],
  [/\bGrok\b/gi, "Spark"],
  [/\bMini[Mm]ax\s+Hailuo\b/g, "Tide"],
  [/\bMiniMax\b/gi, "Tide"],
  [/\bHailuo\b/gi, "Tide"],
  [/\bWan(?=\s+\d)/g, "Flow"],
  [/\bHappy\s+Horse\b/gi, "Canter"],
  [/\bTopaz\b/gi, "Precision Upscale"],
  [/\bRecraft\b/gi, "Vector"],
  [/\bQwen\b/gi, "Lyra"],
  [/\bSonilo\b/gi, "Score"],
  [/\bMirelo\b/gi, "Foley"],
  [/\bInworld\b/gi, "Speech"],
  [/\bHunyuan\s*3D\b/gi, "Form 3D"],
  [/\bHunyuan\b/gi, "Form"],
  [/\bMeshy\b/gi, "Mesh"],
  [/\bTripo\b/gi, "Sculpt"],
  [/\bSAM(?=\s+\d)/g, "Segment"],
  [/\bZ\s+Image\b/g, "Swift Image"],
  [/\bSync\s+Lipsync\b/gi, "Lipsync"],
  [/\bBytedance\b|\bByteDance\b|\bBytePlus\b|\bDreamina\b|\bModelArk\b/g, ""],
  [/\bHiggsfield(?:'s|’s)?\b/gi, ""],
  [/\bGoogle(?:'s|’s)?\b/gi, ""],
  [/\bElevenLabs\b/gi, "Voice"],
  [/\bEleven(?=\s+(?:v\d|Multilingual|Flash|Turbo))/g, "Voice"],
  [/\bBlender\b/g, "3D runtime"],
  [/\bLuma\b/gi, "Reframe"],
  [/\bBria\b/gi, ""],
  [/\bfal\.ai\b/gi, "the render service"],
  [/\bVercel\b/gi, ""],
];

/** Provider-supplied model names and descriptions, made fit to print. */
export function neutralModelText(text: string): string {
  let out = text;
  for (const [pattern, name] of FAMILY_RENAMES) out = out.replace(pattern, name);
  return out.replace(/\s{2,}/g, " ").replace(/^\s*[·:,-]\s*/, "").trim();
}
