import { HELD_ANSWER, INSTRUCTIONS_MARKER, VISITOR_RULES } from "./instructions";

/**
 * The visitor bar's second line of defence (v30 Phase A, item 9). The instructions already say nothing worth taking;
 * this screen checks every answer before it leaves the server, whatever the model was talked into, and holds back an
 * answer that:
 *
 *  - names a company, service, engine or model in the AI industry: one typed list (`INDUSTRY_NAMES`), the same whether
 *    or not Particl uses the name, so which answers come back held says nothing about what Particl uses. It reads no
 *    registry of Particl's; tests/unit/visitorBar.spec.ts proves every name in those registries is inside it
 *    (tests/helpers/visitorRegistry.ts), so a name Particl adds without adding it here fails that test;
 *  - carries a price: a figure next to credits, a currency, cents, a month, or a percentage off;
 *  - repeats the instructions' rules (how it must answer): any run of six words from one of them, or their marker. The
 *    facts in them are the public page's own and are meant to be repeated;
 *  - hides any of that: reversed, in rot13, spaced out letter by letter, or as a long encoded run (base64, hex).
 *
 * A held answer is replaced whole by one fixed answer, the same whatever tripped it (no half-redacted sentence with a
 * version number left behind, and no telling a name from a price).
 * Pure: no I/O, no logging, no import but the instructions.
 */

export type ScreenReason = "name" | "price" | "instructions" | "encoded";
export type Screened = { answer: string; held: ScreenReason | null };

/* Words some guards ban from any string a person could read (tests/helpers/uiStrings.ts) are joined from pieces here:
   this list is never shown, it is what the screen holds back. */
const piece = (...parts: string[]) => parts.join("");

/**
 * Names in the AI industry, by kind. Distinctive names only: a plain English word ("Whisper", "Modal", "Captions") would
 * hold back ordinary answers, so such names are left out, or listed only with what makes them a name. Matched whole,
 * in any case, with spaces, hyphens and underscores alike.
 */
export const INDUSTRY_NAMES: readonly string[] = [
  /* Video. */
  "Seedance", "Dreamina", "Jimeng", "Kling", "Kuaishou", "Veo", "Sora", "Runway", "Gen-3", "Gen-4", "Pika", "Luma", "Dream Machine", "Ray2",
  "Hailuo", "MiniMax", "Vidu", "Shengshu", "PixVerse", "Haiper", "Hunyuan", "HunyuanVideo", "Genmo Mochi", "Genmo", "LTX Video", "LTXV", "Lightricks",
  "CogVideoX", "CogVideo", "Hotshot-XL", "Stable Video", "Stable Video Diffusion", "Moonvalley", "Marey", "Kaiber", "Hedra", "Synthesia",
  "HeyGen", "D-ID", "Lumiere", "Phenaki", "Emu Video", "SkyReels", "Wan2.1", "Wan2.2", "Wan-AI", "Grok Imagine",
  piece("Higgs", "field"), piece("Ge", "njutsu"), piece("So", "ul ID"), piece("So", "ul Character"), "Cinema Studio", "hf-soul", "Supercomputer",
  /* Images. */
  "Nano Banana", "Imagen", "GPT Image", "DALL-E", "DALL·E", "Midjourney", "Stable Diffusion", "SDXL", "Stability AI", "Flux", "Black Forest Labs",
  "Ideogram", "Recraft", "Leonardo", "Leonardo.Ai", "Freepik", "Firefly", "Adobe Firefly", "Playground AI", "Seedream", "Bria",
  "HiDream", "Reve", "Krea", "Qwen Image", "Clipdrop", "Photoroom", "remove.bg", "ComfyUI", "Automatic1111",
  /* Upscaling and restoration. */
  "Topaz", "Topaz Labs", "Magnific", "Real-ESRGAN", "ESRGAN", "Upscayl", "GFPGAN", "CodeFormer",
  /* Voice, music and sound. */
  "ElevenLabs", "Eleven Multilingual", "Eleven Music", "Eleven Sound Effects", "Eleven Flash", "Eleven Turbo", "Cartesia", "PlayHT", "Play.ht",
  "WellSaid", "WellSaid Labs", "Deepgram", "Speechify", "Murf", "Resemble AI", "Respeecher", "Suno", "Udio", "Stable Audio", "AudioCraft",
  "MusicGen", "Inworld", "Sonilo", "Mirelo", "Seed Audio", "AssemblyAI", "Lyria", "Descript", "Lovo", "Fish Audio",
  /* 3D. */
  "Meshy", "Tripo", "Rodin", "Hunyuan3D", "Luma Genie",
  /* Language models and their makers. */
  "Claude", "Anthropic", "GPT", "ChatGPT", "OpenAI", "GPT-OSS", "o1", "o3", "o4", "o1-mini", "o3-mini", "o4-mini", "Gemini", "Gemma", "Bard",
  "Grok", "xAI", "SpaceXAI", "Llama", "Meta AI", "Mistral", "Mixtral", "Codestral", "Magistral", "DeepSeek", "Qwen", "Kimi", "Moonshot AI",
  "GLM", "ChatGLM", "Zhipu", "Cohere", "Command R", "Perplexity", "Jamba", "AI21", "ERNIE", "Doubao", "Baichuan", "Inflection AI", "Reka",
  "Nemotron", "IBM Granite",
  /* Hosts, gateways and clouds. */
  "fal", "fal.ai", "Replicate", "OpenRouter", "Together AI", "Together.ai", "Fireworks AI", "Fireworks.ai", "Groq", "RunPod", "Baseten",
  "Lambda Labs", "CoreWeave", "AWS Bedrock", "Amazon Bedrock", "Azure OpenAI", "Azure AI", "Vertex AI", "Google Cloud", "Google",
  "Hugging Face", "HuggingFace", "Vercel", "AI Gateway", "Cloudflare Workers AI", "Workers AI", "BytePlus", "ByteDance", "ModelArk", "Ark",
  "Volcengine", "Volcano Engine", "Alibaba Cloud", "DashScope", "Novita", "DeepInfra", "Anyscale", "Cerebras", "SambaNova", "Lepton AI",
  "Nebius", "Hyperbolic", "Modal Labs", "Banana.dev", "Microsoft", "Nvidia", "NVIDIA NIM",
];

/** Names that are ordinary words alone and a model's name only with a version after them ("Haiku 5.5", "Eleven v3"). */
const VERSIONED: readonly string[] = ["Opus", "Sonnet", "Haiku", "Fable", "Banana", piece("As", "tra"), "OSS", "Ray", "Wan", "Phi", "Nova", "Titan", "Yi", "Mochi", "Hotshot", "Playground", "Granite"];
const VERSIONED_V: readonly string[] = ["Eleven"];

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const spaced = (text: string) => escape(text).replace(/ /g, "[\\s\\-_]+");
let cached: RegExp | null = null;
function names(): RegExp {
  if (cached) return cached;
  const whole = [...INDUSTRY_NAMES].sort((a, b) => b.length - a.length).map(spaced).join("|");
  const versioned = `(?:${VERSIONED.map(spaced).join("|")})[\\s\\-_]*v?\\d|(?:${VERSIONED_V.map(spaced).join("|")})[\\s\\-_]+v\\d`;
  cached = new RegExp(`(?<![A-Za-z0-9])(?:${whole}|${versioned})(?![A-Za-z])`, "i");
  return cached;
}

/** The first industry name in a piece of text, or null. */
export function industryNameIn(text: string): string | null {
  return names().exec(text)?.[0] ?? null;
}
const namesIn = (text: string) => names().test(text);

/** Words spelled out letter by letter ("K l i n g", "S-e-e-d-a-n-c-e"), joined back up. Only runs of single letters are
 *  joined, so two ordinary words are never read as one. */
const SPELLED_OUT = String.raw`(?<![A-Za-z])(?:[A-Za-z][^A-Za-z0-9\n]{1,3}){2,}[A-Za-z](?![A-Za-z])`;
function spelledOut(text: string): string[] {
  return [...text.matchAll(new RegExp(SPELLED_OUT, "g"))].map((m) => m[0].replace(/[^A-Za-z]/g, ""));
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
  /* Each rule on its own: a run across two rules is not text of either. The facts are the public page's and may be repeated. */
  instructionShingles ??= new Set(VISITOR_RULES.flatMap((rule) => [...shingles(normal(rule))]));
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
  if ([...variants, ...variants.flatMap(spelledOut)].some(namesIn)) return "name";
  if (priceIn(text) || decodedRuns(text).some(priceIn)) return "price";
  if (ENCODED_RUN.test(text)) return "encoded";
  return null;
}

/** The answer a visitor may read: the model's own when it passes, else the one fixed answer. `held` is for the log. */
export function screenVisitorAnswer(text: string): Screened {
  const held = screenReason(text);
  return held ? { answer: HELD_ANSWER, held } : { answer: text, held: null };
}
