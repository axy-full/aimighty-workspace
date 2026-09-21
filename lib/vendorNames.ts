/**
 * The product's naming rule, in one place.
 *
 * RETIRED FOR THE SUITES SURFACE — owner decision, 21 September 2026: "follow
 * the design and retire the rule". design/particl-suites/README.md names the
 * connected account (Higgsfield), its product lines (Marketing Studio,
 * Genjutsu, Supercomputer) and every provider, and lib/shell, components/
 * graphite and app/suites print them as designed. What follows still
 * describes the LEGACY screens (/workspace, /workbench), which keep their
 * neutral copy until the switch-over removes them; nothing new should be
 * built on it.
 *
 * Owner decision, 20 September 2026 — this REVERSES part of #231 for MODEL
 * names only. Three rules, keyed by which surface a name appears on:
 *
 * 1. A DIRECTLY INTEGRATED MODEL SHOWS ITS REAL NAME everywhere a person
 *    reads it: Seedance 2.5, Kling 3.0 Pro, Nano Banana 2, Topaz Astra 2,
 *    Eleven v3, GPT-6 Astra, Claude Fable 5.1, Gemini 3.1 Pro. Those names
 *    live in lib/models.ts and reach the UI only through
 *    `displayModelName()`.
 * 2. A MODEL SERVED THROUGH THE CONNECTED ACCOUNT KEEPS A NEUTRAL NAME. The
 *    catalogue read from the connected account (lib/higgsfield-consumer/*,
 *    Atomik Generate, Subatomik, the marketing templates) is renamed at parse
 *    time by `neutralModelText` below. So the SAME FAMILY can read
 *    "Seedance 2.5" on our direct surface and "Motion 2.5" on the connected
 *    surface, and "Nano Banana 2" against "Image 2". That is intended: what
 *    we integrate ourselves we name; what the connected account serves we do
 *    not advertise for it.
 * 3. NEVER NAMED ANYWHERE, on either surface: the names in `VENDOR_NAMES`
 *    below — the connected account itself and its brands, and the provider
 *    companies that are not part of any model's real name. The connected
 *    account stays "the connected account" and its credits "connected
 *    credits".
 *
 * Internal ids, env vars, API paths, DB values, code identifiers, logs, LLM
 * prompts, docs and comments keep every name.
 *
 * This is the single list the UI guard (tests/unit/noVendorNamesInUi.spec.ts)
 * shares with the display-name functions.
 */
export const VENDOR_NAMES = [
  // The connected account, its own product lines and its brand words.
  "Higgsfield", "Supercomputer", "Genjutsu", "Soul ID", "Soul Character",
  // Provider and platform companies that are not part of a model's real name.
  "BytePlus", "ByteDance", "ModelArk", "Dreamina", "fal.ai", "fal", "Vercel",
] as const;

/** Case-insensitive, whole-word: "fal" does not match "falling", and
 *  "Soul ID" also catches "Soul-ID". Model names are NOT in this list — a
 *  direct model's real name is required copy (rule 1 above), and the
 *  connected catalogue's families are handled by `neutralModelText`. */
export const VENDOR_NAME_PATTERN = new RegExp(
  String.raw`\b(?:${VENDOR_NAMES
    .map(name => name.replace(/[.]/g, String.raw`\.`).replace(/ /g, String.raw`[\s-]+`))
    .join("|")})\b`,
  "i",
);

export function hasVendorName(text: string): boolean {
  return VENDOR_NAME_PATTERN.test(text);
}

/** The first banned name in a piece of copy, for readable test failures. */
export function vendorNameIn(text: string): string | null {
  return text.match(VENDOR_NAME_PATTERN)?.[0] ?? null;
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
 * CONNECTED SURFACE ONLY. Third-party model families as the CONNECTED
 * ACCOUNT's catalogue names them, renamed for display (rule 2 above). Our own
 * directly integrated engines never come through here — their real names are
 * in lib/models.ts and are printed as they are. Order matters: longer
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

/**
 * Provider-supplied model names and descriptions from the CONNECTED account,
 * made fit to print. Never call this on one of our own model labels: a direct
 * model's real name is the required copy.
 */
export function neutralModelText(text: string): string {
  let out = text;
  for (const [pattern, name] of FAMILY_RENAMES) out = out.replace(pattern, name);
  return out.replace(/\s{2,}/g, " ").replace(/^\s*[·:,-]\s*/, "").trim();
}

/**
 * Has a piece of CONNECTED-catalogue text kept a family name that rule 2 says
 * it should not advertise? The guard uses this on the connected catalogue only
 * — on our direct surface the same names are correct copy.
 */
export function connectedFamilyNameIn(text: string): string | null {
  for (const [pattern] of FAMILY_RENAMES) {
    const match = text.match(new RegExp(pattern.source, pattern.flags.replace("g", "")));
    if (match?.[0]?.trim()) return match[0].trim();
  }
  return null;
}
