/**
 * The prompt enhancer, as data (design/particl-suites/README.md › Prompt
 * enhancer). Pure: who rewrites, under which instruction, what may not be
 * rewritten, and what counts as a usable answer. The route
 * (app/api/prompt/enhance) only authenticates, quotes and charges.
 *
 * Owner, 21 September 2026: Higgsfield's enhancer is the default for Gen;
 * Claude or OpenAI only when chosen.
 *
 * What "Higgsfield" means here, precisely. Higgsfield publishes no text-in /
 * text-out enhancer: in github.com/higgsfield-ai the only enhancer is the
 * `enhance_prompt` boolean a generation request carries, applied on their
 * servers while the job runs. What they do publish is the rule set their own
 * agents write prompts by — skills/higgsfield-generate/references/
 * prompt-engineering.md — and that is the instruction used below, verbatim in
 * substance. So the Higgsfield provider is Higgsfield's rules, run on this
 * workspace's routed writer; a catalogue job whose schema has the flag also
 * sends `enhance_prompt: true` and shows the text their servers return.
 */
export const ENHANCER_PROVIDERS = ["higgsfield", "claude", "openai"] as const;
export type EnhancerProvider = (typeof ENHANCER_PROVIDERS)[number];
export const DEFAULT_ENHANCER: EnhancerProvider = "higgsfield";

export const ENHANCER_LABEL: Record<EnhancerProvider, string> = { higgsfield: "Higgsfield", claude: "Claude", openai: "OpenAI" };
/** The note line under the Workspace › General selector. */
export const ENHANCER_NOTE: Record<EnhancerProvider, string> = {
  higgsfield: "Higgsfield's published prompt rules. The default.",
  claude: "Anthropic's Claude writes the prompt.",
  openai: "OpenAI writes the prompt, on the direct connection.",
};

export function isEnhancerProvider(value: unknown): value is EnhancerProvider {
  return typeof value === "string" && (ENHANCER_PROVIDERS as readonly string[]).includes(value);
}

export const ENHANCE_MODES = ["video", "image", "audio", "3d"] as const;
export type EnhanceMode = (typeof ENHANCE_MODES)[number];
export function isEnhanceMode(value: unknown): value is EnhanceMode {
  return typeof value === "string" && (ENHANCE_MODES as readonly string[]).includes(value);
}

export const ENHANCE_MAX_PROMPT = 4000;
export const ENHANCE_MAX_WORDS = 80;
export const ENHANCE_MAX_TOKENS = 400;

/** `raw:` means "send my words": never enhanced, by Enhance or by Auto. */
export function isRawPrompt(prompt: string): boolean {
  return /^\s*raw:/i.test(prompt);
}
export function stripRaw(prompt: string): string {
  return prompt.replace(/^\s*raw:\s*/i, "");
}

/** `@Image1`, `@Video1`, `@name` — what the composer binds references by. */
export function citationsIn(prompt: string): string[] {
  return [...new Set(prompt.match(/@[A-Za-z][\w-]*/g) ?? [])];
}

export type EnhanceContext = {
  mode: EnhanceMode;
  /** A start frame or source video anchors the picture: describe motion only. */
  anchored?: boolean;
  /** An image reference is being changed: describe the change only. */
  editing?: boolean;
  /** The engine's display name, so the writer knows what it is writing for. */
  engine?: string | null;
};

const MEDIUM: Record<EnhanceMode, string> = {
  video: "subject + setting + style; camera (lens, angle, and motion verbs: dolly in, tracking shot, slow push, whip pan); lighting; medium",
  image: "subject + setting + style; camera (lens, angle); lighting; medium",
  audio: "source or voice + setting + style; pace and dynamics; texture; medium",
  "3d": "subject + form and proportions + style; materials and surface; lighting for the turntable; medium",
};

/** One instruction for every provider (README › Interactions › Prompt enhancer). */
export function enhancerSystem(context: EnhanceContext): string {
  return [
    "You rewrite a rough idea into ONE concrete generation prompt. These are Higgsfield's published prompt rules.",
    `Order it: ${MEDIUM[context.mode]}.`,
    "Be concrete and sensory. Keep it under 80 words; models distort with long prompts.",
    "Phrase negatives positively: \"tack sharp\" instead of \"no blur\", \"uninhabited landscape\" instead of \"no people\".",
    context.anchored ? "A start frame or source clip already fixes the picture: describe the MOTION (camera verbs, subject motion). Do not redescribe the frame." : "",
    context.editing && !context.anchored ? "An image is being changed: describe WHAT CHANGES. Do not redescribe the input." : "",
    "Keep every citation such as @Image1, @Video1 or @name exactly as written, each one still present.",
    "Never add real public figures, trademarks, branded characters or sexual content. Never invent a brand or a person that is not in the idea.",
    context.engine ? `It will be sent to ${context.engine}.` : "",
    'Return ONLY a JSON object: {"prompt": string} — no prose, no code fence.',
  ].filter(Boolean).join(" ");
}

export function enhancerMessages(prompt: string, context: EnhanceContext): { role: "system" | "user"; content: string }[] {
  return [{ role: "system", content: enhancerSystem(context) }, { role: "user", content: prompt.trim().slice(0, ENHANCE_MAX_PROMPT) }];
}

export type ParsedEnhancement = { ok: true; prompt: string } | { ok: false; reason: string };

/**
 * The writer's answer, or why it cannot be used. A dropped citation would
 * silently unbind a reference, so it is refused rather than repaired.
 */
export function parseEnhanced(text: string, original: string): ParsedEnhancement {
  const body = text.replace(/```(?:json)?/gi, "").trim();
  let prompt = "";
  const start = body.indexOf("{"), end = body.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(body.slice(start, end + 1)) as { prompt?: unknown };
      if (typeof parsed.prompt === "string") prompt = parsed.prompt;
    } catch { /* not JSON: read it as the prompt itself below */ }
  }
  if (!prompt && start < 0) prompt = body;
  prompt = prompt.replace(/^["'“”]+|["'“”]+$/g, "").replace(/\s+/g, " ").trim();
  if (!prompt) return { ok: false, reason: "The writer answered, but not with a prompt. Try once more." };
  const missing = citationsIn(original).filter((citation) => !citationsIn(prompt).includes(citation));
  if (missing.length) return { ok: false, reason: `The rewrite dropped ${missing.join(", ")}. Your prompt is unchanged; try once more.` };
  return { ok: true, prompt: prompt.slice(0, ENHANCE_MAX_PROMPT) };
}

/**
 * Which text model writes for a provider: the first of these the catalogue is
 * serving, lightest first so an enhancement stays the smallest charge. The
 * Higgsfield provider has no model of its own (see the header), so it uses the
 * workspace's routed writer and falls back to this list.
 */
export const ENHANCER_MODELS: Record<EnhancerProvider, readonly string[]> = {
  claude: ["anthropic/claude-haiku-4.5", "anthropic/claude-sonnet-5", "anthropic/claude-sonnet-4.6", "anthropic/claude-sonnet-4.5"],
  openai: ["openai/gpt-5-mini", "openai/gpt-4.1-mini", "openai/gpt-5-nano", "openai/gpt-4o-mini", "openai/gpt-5.2"],
  higgsfield: ["anthropic/claude-haiku-4.5", "google/gemini-3.5-flash", "openai/gpt-5-mini", "anthropic/claude-sonnet-5", "anthropic/claude-sonnet-4.6"],
};

export function pickEnhancerModel(provider: EnhancerProvider, availableIds: readonly string[], routed?: string | null): string | null {
  const available = new Set(availableIds);
  if (provider === "higgsfield" && routed && available.has(routed)) return routed;
  return ENHANCER_MODELS[provider].find((id) => available.has(id)) ?? null;
}
