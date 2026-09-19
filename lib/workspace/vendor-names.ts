/**
 * Vendor and competitor names that must never appear in workspace UI copy
 * (brief decision 5). Internal ids, env vars, API paths and code identifiers
 * keep their names; this list is for strings a user can read.
 */
export const VENDOR_NAMES = [
  "Seedance",
  "ByteDance",
  "ModelArk",
  "Higgsfield",
  "Genjutsu",
  "Soul ID",
  "ElevenLabs",
  "OpenAI",
  "GPT",
  "ChatGPT",
  "Claude",
  "Anthropic",
  "Blender",
  "Kling",
  "Veo",
  "Gemini",
  "Nano Banana",
  "Topaz",
  "fal",
  "Wan",
  "Runway",
  "Luma",
  "Sora",
  "Midjourney",
  "Flux",
  "Vercel",
] as const;

const pattern = new RegExp(
  `\\b(${VENDOR_NAMES.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "i",
);

/** The first vendor name found in `text`, or null. */
export function vendorNameIn(text: string): string | null {
  return pattern.exec(text)?.[1] ?? null;
}
