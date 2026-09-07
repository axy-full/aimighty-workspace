/**
 * The prompt writer's gate and price, readable by the browser (brief 1.8):
 * whether an idea is too thin to film — the only case the writer runs — and
 * what one call costs, so the button can say so before anything is pressed.
 * No Node imports. The writer itself lives in lib/enhance.ts.
 */
export type Richness = { score: number; signals: string[]; words: number };

const SIGNALS: Record<string, RegExp> = {
  camera: /\b(wide|close[- ]?up|medium shot|establishing|over[- ]the[- ]shoulder|pov|insert shot|push(?:es|ing)? in|pull(?:s|ing)? out|pan(?:s|ning)?|tilt(?:s|ing)?|track(?:s|ing)?|dolly|crane|handheld|steadicam|orbit|zoom(?:s|ing)?|rack focus|whip pan|static camera|locked[- ]off)\b/i,
  light:  /\b(golden hour|blue hour|dawn|dusk|sunset|sunrise|night|noon|midday|backlit|rim[- ]lit|rim light|overcast|neon|practicals?|chiaroscuro|firelight|moonlight|sunlight|soft light|hard light|high[- ]key|low[- ]key|silhouette)\b/i,
  look:   /\b(\d{2}mm|anamorphic|film grain|black and white|monochrome|desaturated|muted|bleach bypass|teal and orange|vhs|super ?8|cinematic|documentary)\b/i,
  audio:  /\b(no music|no bgm|no audio|no subtitles|ambient|diegetic|dialogue|voice ?over|sound design|score|silence)\b/i,
  beats:  /(\b\d+\s*[-–]\s*\d+\s*s\b|\bshot\s*\d|\bat the \d+[- ]second)/i,
};

export function promptRichness(prompt: string): Richness {
  const words = prompt.trim().split(/\s+/).filter(Boolean).length;
  const signals = Object.entries(SIGNALS).filter(([, re]) => re.test(prompt)).map(([k]) => k);
  return { score: signals.length, signals, words };
}

/** The writer runs only for an idea too thin to film: ten words or fewer, no axis detected, no signal in the words. */
export function shouldRefine(prompt: string, detectedAxes = 0): { refine: boolean; why: string } {
  const p = prompt.trim();
  if (/^raw:/i.test(p)) return { refine: false, why: "raw: prefix" };
  if (p.includes("【")) return { refine: false, why: "already structured" };
  const r = promptRichness(p);
  const tooThinToFilm = r.words <= 10 && detectedAxes === 0 && r.score === 0;
  if (!tooThinToFilm) {
    return { refine: false, why: r.words > 10 ? `enough to film (${r.words} words)` : `library covers it (${detectedAxes} axes)` };
  }
  return { refine: true, why: "too thin to film" };
}

/** Dollars per million tokens, in and out, by model id — the gateway's and the vendors' own rates. */
export const TEXT_RATES: Record<string, { input: number; output: number }> = {
  "dola-seed-2-1-turbo-260628": { input: 0.5, output: 2.5 },
  "seed-2-0-pro-260328": { input: 0.5, output: 3.0 },
  "claude-opus-5": { input: 5.0, output: 25.0 },
  "claude-sonnet-5": { input: 2.0, output: 10.0 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
  "anthropic/claude-opus-5": { input: 5.0, output: 25.0 },
  "anthropic/claude-sonnet-5": { input: 2.0, output: 10.0 },
  "anthropic/claude-haiku-4.5": { input: 1.0, output: 5.0 },
  "google/gemini-3.1-pro-preview": { input: 2.0, output: 12.0 },
};

/** The writer's frozen instruction is about this long; a finished prompt about this long. */
export const SYSTEM_TOKENS = 1400;
export const OUT_TOKENS = 220;

export function rateFor(model: string): { input: number; output: number } | null {
  return TEXT_RATES[model] ?? TEXT_RATES[model.replace(/^anthropic\//, "")] ?? null;
}

/** What one writer call costs at list price, before caching: the instruction, the house style and the idea in; a prompt out. */
export function estimateRefineUsd(model: string, promptChars: number, styleChars = 0): number | null {
  const rate = rateFor(model);
  if (!rate) return null;
  const inTokens = SYSTEM_TOKENS + Math.ceil(styleChars / 4) + Math.ceil(promptChars / 4);
  return Math.round(((inTokens * rate.input + OUT_TOKENS * rate.output) / 1e6) * 1e5) / 1e5;
}
