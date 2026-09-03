/**
 * Prompt refinement — the layer platforms like Higgsfield run between the
 * user and the model. The raw idea goes to a small ModelArk text model with
 * a system prompt distilled from ByteDance's OFFICIAL Seedance 2.5 prompt
 * guidance, and comes back as the dense, structured prompt the video model
 * actually responds to.
 *
 * Sources, re-read 2026-09-02:
 *   docs.byteplus.com/en/docs/ModelArk/2607689  (official prompt guide)
 *   their `sd25-pe` skill, which that guide recommends installing
 *
 * The rewrite is TARGET-AWARE, and it has to be: the guide's own
 * "Differences from Seedance 2.0" section says 2.0 does NOT respond to
 * timestamps and answers only to shot numbers, while 2.5 understands
 * integer-second timestamps. Writing one shape for both engines wastes the
 * feature on 2.5 and confuses 2.0, so the model id and the requested
 * duration are passed in and steer the form.
 *
 * Costs a fraction of a cent per call; the text model must be activated in
 * the ModelArk console like the video models were.
 */

import { getSetting } from "./settings";

const CHAT_URL = () =>
  (process.env.ARK_BASE_URL?.replace(/\/$/, "") ??
    "https://ark.ap-southeast.bytepluses.com") + "/api/v3/chat/completions";

/**
 * Candidates in preference order: newest turbo first, pro as the fallback.
 * A refine costs ~$0.001 on any of them, but its output steers renders worth
 * a thousand times more — instruction-following fidelity is the feature.
 * A model that isn't activated or permissioned yet is skipped, so fixing
 * console permissions upgrades the default with no redeploy.
 */
export const TEXT_MODELS = (): string[] => {
  const chain = ["dola-seed-2-1-turbo-260628", "seed-2-0-pro-260328"];
  const env = process.env.ARK_TEXT_MODEL;
  return env ? [env, ...chain.filter((m) => m !== env)] : chain;
};
export const TEXT_MODEL = () => TEXT_MODELS()[0];

/** USD per million tokens, from the ModelArk pricing page. Unknown models
 *  bill at pro's rates — conservative beats silently free. */
export const TEXT_RATES: Record<string, { input: number; output: number }> = {
  "dola-seed-2-1-turbo-260628": { input: 0.5, output: 2.5 },
  "seed-2-0-pro-260328": { input: 0.5, output: 3.0 },
  // Anthropic first-party rates. A refine costs ~$0.04 against a 1080p render
  // at $3.67 — around 1% of the thing it steers.
  "claude-opus-5": { input: 5.0, output: 25.0 },
  "claude-sonnet-5": { input: 2.0, output: 10.0 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
  // The same models through Vercel AI Gateway, at the gateway's list prices
  // (read off ai-gateway.vercel.sh/v1/models on 2026-09-03 — identical to
  // Anthropic's own). Cache reads bill at a tenth of input.
  "anthropic/claude-opus-5": { input: 5.0, output: 25.0 },
  "anthropic/claude-sonnet-5": { input: 2.0, output: 10.0 },
  "anthropic/claude-haiku-4.5": { input: 1.0, output: 5.0 },
  "google/gemini-3.1-pro-preview": { input: 2.0, output: 12.0 },
};

/**
 * Which model writes the prompt.
 *
 *   anthropic — Claude straight from Anthropic, when a console key exists.
 *   gateway   — the same Claude through Vercel AI Gateway: billed to the
 *               Vercel account, no Anthropic console needed. Reached with an
 *               AI_GATEWAY_API_KEY, or with no key at all on Vercel, where
 *               every function carries an OIDC identity the gateway accepts.
 *   byteplus  — ByteDance's own text models on the ModelArk key.
 *
 * REFINE_PROVIDER forces one; otherwise the first that can be reached wins.
 */
export type RefineProvider = "anthropic" | "gateway" | "byteplus";
export function refineProvider(): RefineProvider {
  const forced = process.env.REFINE_PROVIDER;
  if (forced === "anthropic" || forced === "gateway" || forced === "byteplus") return forced;
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return "anthropic";
  if (gatewayReachable()) return "gateway";
  return "byteplus";
}
export function gatewayReachable(): boolean {
  return Boolean(
    process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN || process.env.VERCEL
  );
}

/** Opus 5 by default — this is the judgement step, and the studio asked for the best. */
export const CLAUDE_MODEL = () => process.env.ANTHROPIC_PROMPT_MODEL ?? "claude-opus-5";
/** Through the gateway, in order: Opus 5, then Sonnet 5 if it cannot answer. */
export const GATEWAY_MODELS = (): string[] =>
  (process.env.GATEWAY_PROMPT_MODELS ?? "anthropic/claude-opus-5,anthropic/claude-sonnet-5")
    .split(",").map((s) => s.trim()).filter(Boolean);
export const GATEWAY_BASE = () =>
  process.env.AI_GATEWAY_BASE_URL?.replace(/\/$/, "") ?? "https://ai-gateway.vercel.sh/v1";
export const GATEWAY_URL = () => `${GATEWAY_BASE()}/chat/completions`;

/**
 * The gateway's credit balance, in dollars — what is left of what was
 * topped up, and what has been used. Null when this deployment cannot
 * reach the gateway or the call fails; never a reason to block anything.
 */
export async function gatewayCredits(): Promise<{ balanceUsd: number; usedUsd: number } | null> {
  if (!gatewayReachable()) return null;
  try {
    const auth = await gatewayAuth();
    const res = await fetch(`${GATEWAY_BASE()}/credits`, {
      headers: auth, signal: AbortSignal.timeout(6_000), cache: "no-store",
    });
    if (!res.ok) {
      console.warn(`gateway credits: ${res.status} ${(await res.text()).slice(0, 160)}`);
      return null;
    }
    const j = await res.json() as { balance?: string | number; total_used?: string | number };
    const balance = Number(j.balance), used = Number(j.total_used);
    if (!Number.isFinite(balance)) return null;
    return { balanceUsd: balance, usedUsd: Number.isFinite(used) ? used : 0 };
  } catch (e) {
    console.warn(`gateway credits: ${(e as Error).message}`);
    return null;
  }
}
export const TEXT_RATE_FALLBACK = { input: 0.5, output: 3.0 };

/** Each ByteDance text model's first 500k tokens are free on this account;
 *  charges begin past that. Anthropic models — direct or through the
 *  gateway — have no such allowance, and lib/generate prices them from
 *  token one. */
export const TEXT_FREE_TOKENS = 500_000;
export const hasFreeTier = (model: string) => !model.startsWith("claude-") && !model.includes("/");

/**
 * The workspace's choice of writer, resolved to something callable.
 *
 *   Pro      — nothing is rewritten. The library still supplies the camera
 *              module; only the model step is gone.
 *   Seedream — ByteDance's text model on the ModelArk key.
 *   Claude   — Opus 5: straight from Anthropic when a console key exists,
 *              otherwise through Vercel AI Gateway on the deployment's own
 *              identity.
 */
export type Writer = "none" | "byteplus" | "claude";
export type ActiveWriter = {
  writer: Writer;
  provider: RefineProvider | "none";
  model: string;
  label: string;
  via: string;
  configured: boolean;
};
export async function activeWriter(): Promise<ActiveWriter> {
  const chosen = (await getSetting("promptWriter")) as Writer;
  if (chosen === "none") {
    return { writer: "none", provider: "none", model: "", label: "Pro", via: "your words, as written", configured: true };
  }
  if (chosen === "byteplus") {
    return {
      writer: "byteplus", provider: "byteplus", model: TEXT_MODEL(),
      label: "Seedream", via: `BytePlus ModelArk · ${prettyModel(TEXT_MODEL())}`,
      configured: Boolean(process.env.ARK_API_KEY),
    };
  }
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    return { writer: "claude", provider: "anthropic", model: CLAUDE_MODEL(),
             label: prettyModel(CLAUDE_MODEL()), via: "Anthropic", configured: true };
  }
  const m = GATEWAY_MODELS()[0];
  return {
    writer: "claude", provider: "gateway", model: m, label: prettyModel(m),
    via: process.env.AI_GATEWAY_API_KEY ? "Vercel AI Gateway (API key)" : "Vercel AI Gateway (OIDC)",
    configured: gatewayReachable(),
  };
}
export function prettyModel(id: string): string {
  const bare = id.split("/").pop() ?? id;
  if (/claude-opus-5/.test(bare)) return "Claude Opus 5";
  if (/claude-sonnet-5/.test(bare)) return "Claude Sonnet 5";
  if (/claude-haiku-4/.test(bare)) return "Claude Haiku 4.5";
  if (/gemini-3\.1-pro/.test(bare)) return "Gemini 3.1 Pro";
  if (/dola-seed-2-1/.test(bare)) return "Seed 2.1 Turbo";
  if (/seed-2-0-pro/.test(bare)) return "Seed 2.0 Pro";
  return bare;
}

export type RefineResult = {
  text: string;
  model: string;
  inTokens: number;
  outTokens: number;
  /** The move the model chose, for the caller to attach as a module. */
  move?: string | null;
  /** What the call actually cost, when the vendor says so (the gateway
   *  does, cache discounts included). Otherwise the caller prices tokens. */
  costUsd?: number | null;
};

/**
 * Is this prompt already doing the job?
 *
 * The refine layer exists to rescue "a woman walks into a bar". It has no
 * business rewriting a prompt that already names its camera, its light and
 * its sound — doing so costs money, costs up to a minute and a half of
 * latency, and mostly replaces the author's deliberate restraint with
 * invented detail. So we look for the marks of a prompt that was written
 * rather than typed, and leave those alone.
 */
const SIGNALS: Record<string, RegExp> = {
  camera: /\b(wide|close[- ]?up|medium shot|establishing|over[- ]the[- ]shoulder|pov|insert shot|push(?:es|ing)? in|pull(?:s|ing)? out|pan(?:s|ning)?|tilt(?:s|ing)?|track(?:s|ing)?|dolly|crane|handheld|orbit(?:s|ing)?|steadicam|locked[- ]off|eye level|low angle|overhead)\b/i,
  light:  /\b(golden hour|blue hour|dawn|dusk|sunset|sunrise|night|noon|midday|backlit|rim[- ]lit|rim light|overcast|neon|practicals?|chiaroscuro|firelight|moonlight|sunlight|hard light|soft light|silhouette)\b/i,
  look:   /\b(\d{2}mm|anamorphic|film grain|black and white|monochrome|desaturated|muted|bleach bypass|teal and orange|vhs|super ?8|cinematic|documentary)\b/i,
  audio:  /\b(no music|no bgm|no audio|no subtitles|ambient|diegetic|dialogue|voice ?over|sound design|score|silence)\b/i,
  beats:  /(\b\d+\s*[-–]\s*\d+\s*s\b|\bshot\s*\d|\bat the \d+[- ]second)/i,
};

export type Richness = { score: number; signals: string[]; words: number };

export function promptRichness(prompt: string): Richness {
  const words = prompt.trim().split(/\s+/).filter(Boolean).length;
  const signals = Object.entries(SIGNALS)
    .filter(([, re]) => re.test(prompt))
    .map(([k]) => k);
  return { score: signals.length, signals, words };
}

/**
 * A prompt that already carries three of the five marks AND enough words to
 * have said something is left exactly as written. Measured against the cases
 * that prompted this: a 24-word handheld/35mm/no-music prompt scores 3 and is
 * passed through; "a woman walks into a bar" scores 0 and is refined.
 */
export function shouldRefine(prompt: string, detectedAxes = 0): { refine: boolean; why: string } {
  const p = prompt.trim();
  if (/^raw:/i.test(p)) return { refine: false, why: "raw: prefix" };
  if (p.includes("【")) return { refine: false, why: "already structured" };

  const r = promptRichness(p);
  // LIBRARY-FIRST. The bank supplies the craft and the author's words stay
  // the author's words, so a model is only worth calling when there is not
  // enough prompt to film at all — a bare sketch with nothing for detection
  // to work with. Everything else composes deterministically, instantly and
  // for nothing.
  const tooThinToFilm = r.words <= 10 && detectedAxes === 0 && r.score === 0;
  if (!tooThinToFilm) {
    return {
      refine: false,
      why: r.words > 10 ? `enough to film (${r.words} words)` : `library covers it (${detectedAxes} axes)`,
    };
  }
  return { refine: true, why: "too thin to film" };
}

/**
 * Distilled from the official guide. Every rule below is one the guide
 * actually states — where it says something narrower than "don't do X", this
 * says the narrower thing (negative control, for instance, IS supported, but
 * only for subtitles and audio).
 */
const SYSTEM = `You COMPLETE rough video ideas into prompts ByteDance's Seedance models can film, following ByteDance's official Seedance 2.5 prompt guidance.

Your job is to finish the user's thought, NOT to have one of your own. The idea, the film, and the taste are theirs. You supply only what a camera crew would need in order to shoot exactly what they described, and nothing beyond it.

WHAT YOU MUST NOT INVENT
Never introduce a specific the user did not state or unmistakably imply — in particular: wardrobe, hair, age or build; props; brand names; a named location or venue type; a colour palette; weather; time of day; music, songs or sound effects; a mood or genre; or a character's motive. "A woman walks into a bar" is a woman and a bar. It is NOT a leather jacket, a dive bar, a neon sign, a jukebox, or an amber palette. Adding those is writing a different film and billing them for it.
Where the shot genuinely cannot be filmed without a decision you were not given, choose the plainest option available and spend as few words as possible on it.

PRESERVE
- Intent exactly: subjects and their counts, actions, causality, props, setting, dialogue.
- The user's own words and phrasing wherever they already work. If a sentence is filmable as written, keep it as written.
- Their restraint. Sparseness is often deliberate; a short deliberate prompt should come back barely changed.
- Every asset citation (@Image1, @Video1, @Audio1, …) exactly. Never renumber, remove or invent one.

NEVER
- Never write aspect ratio, duration, resolution, frame rate or watermark — those are API parameters.
- Never stuff quality words ("masterpiece, 8k, best quality, highly detailed").
- Never output section labels, headings or scaffolding of any kind. Do NOT write "One-sentence summary:", "Detailed plot:", "Additional notes:", "Summary:", or similar. Those are how you think, not what you write. Output ONLY the finished prompt.
- No preamble, no commentary, no explanation of your changes.
- Write in English unless the user wrote in another language; then answer entirely in theirs.

WHAT A FINISHED PROMPT CONTAINS
Lead with subject and action in their setting — that must come first. Then, only where the user left it open and the shot needs it: how it is framed and how the camera moves (ONE move), the light, and the sound. Segment the action only when there is enough of it to segment, using the form named in TARGET.

POSITIVE DESCRIPTION, WITH TWO EXCEPTIONS
Describe what is in frame. The only negatives the engine honours are subtitles and audio — "no subtitles", "no BGM; environmental and action sound only", "no audio" — so carry those when the user asked for them, and never invent other negatives.

CAMERA LANGUAGE
Standard terms plainly: shot size, movement, angle. A niche term must carry a plain description of what happens. A transition needs its trigger point and its method.

Do NOT write a long paragraph about how the camera moves — that is supplied separately and precisely. Instead, after your prompt, on a final line of its own, name the single move that best serves the action:

CAMERA: <one of: static, push, pull, pan, tilt, track, crane, handheld, orbit, steadicam, dollyzoom, rackfocus, aerial, fpv, bullettime, whippan, crash, oner>

Choose the plainest move that serves what the user described; when in doubt choose static or push. If the user already named a camera move, name that same one. This line is stripped before the prompt is used — it is how you tell us which move to attach, not part of the prompt.

ACTION AND EXPRESSION
Prefer general action descriptions; spend specific detail only on the one or two beats that must land, and never repeat an action. Write expressions as plain descriptive sentences, not idioms.

WHEN REFERENCE ASSETS ARE CITED
Bind each asset explicitly by its upload number and give it a ROLE — what to take from it, and where it matters, what not to carry over. Name the PART of an asset when only part applies. When a reference is already accurate, say to refer to it and stop; do not re-describe in prose what the asset already shows. Describe in full only a subject that has no reference.`;

/**
 * What changes per request. The engine split is the guide's, not ours: 2.5
 * reads integer-second timestamps, 2.0 reads only shot numbers.
 */
function targetBlock(
  modelId: string | undefined, durationS: number | undefined, task: string | undefined,
  words = 0
): string {
  /* An edit or an extension is an INSTRUCTION, not a scene. Running it
   * through the scene-writing rules would bury the instruction in cinematic
   * prose and lose the trigger word the vendor reads the intent from — the
   * guide's own examples are terse and surgical ("Only edit the man's
   * dialogue in @Video1: change it to …"). So those tasks get their own
   * rules and skip the shape entirely. */
  if (task === "edit") {
    return `TARGET
This is a VIDEO EDIT of an existing video, cited as @Video1. Rewrite it as a surgical edit instruction, NOT as a scene description.
- Keep an editing verb in the first clause (edit, add, insert, remove, delete, modify, replace, change to). The engine reads the intent from these words; without one this is not an edit.
- Name exactly what changes and, where you can, from what to what — "change the man's action from drinking coffee to mopping the floor".
- Say explicitly that everything else is unchanged.
- Scope it with a timestamp range when the user implied one — "from 4-6 seconds in @Video1".
- Do NOT describe the shot's existing look, camera, lighting or mood. Do NOT invent new content. Do NOT restate the whole scene. Two or three sentences is usually right.`;
  }
  if (task === "extend") {
    return `TARGET
This CONTINUES an existing video, cited as @Video1. Rewrite it as a continuation instruction, NOT as a standalone scene.
- Keep a continuation verb in the first clause (extend, extend forward, extend backward, continue, continue from).
- Begin by aligning to the boundary frame: state that the new footage picks up from the source's final frame, matching its framing, lighting, palette and motion, before describing what happens next.
- Then describe only the NEW action, in order.
- Do NOT re-describe what already happened in the source.${durationS ? ` The new footage runs ${Math.round(durationS)} seconds.` : ""}`;
  }

  const is25 = !modelId || /2-5|2\.5/.test(modelId);
  const dur = durationS && Number.isFinite(durationS) ? Math.round(durationS) : null;

  const segments = is25
    ? `Segment the plot with INTEGER-SECOND TIMESTAMPS in whole-second units, continuous and without gaps — "0-3s: …", "3-8s: …". Do not use timestamps to choreograph high-frequency action ("shakes their head three times a second"); a timestamp marks a beat, not a metronome. A single moment may be pinned instead ("at the 4-second mark, …") or expressed relatively ("after three seconds of stillness, …").`
    : `This engine does NOT respond to timestamps. Segment the plot as "Shot 1: …", "Shot 2: …" instead, and never write times or seconds into the prompt.`;

  return `TARGET
Engine: ${modelId ?? "Seedance 2.5"}.
${dur ? `Output duration: ${dur} seconds — pace the action to fill it, no more.` : ""}
${segments}
${budgetLine(words)}`;
}

/**
 * How much the answer is allowed to grow.
 *
 * Length was previously unbounded and the model treated it as the goal: six
 * words became a hundred and ninety-five, most of it invented. The ceiling
 * scales with how much the author already said, because the more they said,
 * the less there is left to supply.
 */
function budgetLine(words: number): string {
  if (!words) return "";
  if (words <= 8) {
    // A sketch this short genuinely needs finishing: with no framing, no
    // camera and no light the engine picks all three at random. Name them —
    // plainly, from what the setting already implies. That is completion, not
    // invention: a bar has light, and "low warm interior light" films THEIR
    // bar, whereas "pink neon over a jukebox" films ours.
    return `LENGTH: the idea is only ${words} words, so it does need finishing — aim for 45-80 words. Supply the framing, ONE camera move, the light and the sound, because the shot cannot be filmed without them. Choose each plainly from what the setting already implies, and still invent no wardrobe, props, venue type, brand, palette or mood.`;
  }
  if (words <= 20) {
    return `LENGTH: the idea is ${words} words — stay under about 100 words. Most of the answer should be their content, not new content.`;
  }
  return `LENGTH: the author already wrote ${words} words and knows what they want. Return AT MOST about ${Math.round(words * 1.6)} words, keeping their sentences where they are already filmable. If it is nearly right as it stands, return it nearly unchanged.`;
}

/**
 * The model sometimes echoes the shape it was taught as literal labels —
 * "One-sentence summary:", "Detailed plot:", "Additional notes:" — which then
 * travel to the video engine as if they were part of the shot. Instructing it
 * not to helps but does not guarantee; this makes sure.
 */
const SCAFFOLD =
  /^\s*(?:\*\*)?(?:one[- ]sentence summary|summary|detailed plot(?: description)?|plot|additional notes?|notes?|overall|shape|prompt)(?:\*\*)?\s*[:：]\s*/gim;

export function stripScaffolding(text: string): string {
  return text
    .replace(SCAFFOLD, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The Claude path.
 *
 * Three things earn their place here:
 *  • the system prompt is CACHED. It is ~1,600 of the ~1,800 input tokens and
 *    never varies, so caching it cuts the input bill by roughly 90% on a hit
 *    and takes latency out of the submit path.
 *  • effort is LOW by default. This is a short, tightly specified rewriting
 *    task, not a reasoning problem; low effort is what it is for, and it is
 *    the difference between a two-second wait and a twenty-second one.
 *  • refusal fallbacks are on. A policy decline on a film prompt would
 *    otherwise stop the rewrite dead; instead the API re-runs it on a
 *    fallback model inside the same call. If the whole chain still declines
 *    we throw, and the caller renders the author's raw words — a refine has
 *    never been allowed to block a paid render.
 */
async function refineWithClaude(
  system: string, userMsg: string, style: string
): Promise<RefineResult & { cachedIn: number }> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  const model = CLAUDE_MODEL();

  const res = await client.beta.messages.create({
    model,
    max_tokens: 8000,
    betas: ["server-side-fallback-2026-07-01"],
    // Route by refusal category rather than maintaining a model list.
    fallbacks: "default",
    output_config: { effort: (process.env.ANTHROPIC_PROMPT_EFFORT ?? "low") as "low" },
    /* Two cache blocks, stable-first. The frozen system prompt never changes,
     * so it stays cached indefinitely. The house-style examples change only
     * when somebody approves a shot, and sit in their own block so that when
     * they do change they invalidate themselves and not the rest. */
    system: [
      { type: "text", text: system, cache_control: { type: "ephemeral" } },
      ...(style
        ? [{ type: "text", text: style, cache_control: { type: "ephemeral" } }]
        : []),
    ],
    messages: [{ role: "user", content: userMsg }],
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  } as any);

  if (res.stop_reason === "refusal") {
    throw new Error("The prompt writer declined this request; rendering the raw prompt.");
  }
  const text = res.content
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    .filter((b: any) => b.type === "text")
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    .map((b: any) => b.text).join("").trim();

  return {
    text,
    model,
    inTokens: Number(res.usage?.input_tokens ?? 0),
    outTokens: Number(res.usage?.output_tokens ?? 0),
    cachedIn: Number(res.usage?.cache_read_input_tokens ?? 0),
  };
}

/**
 * Credentials for the gateway: an explicit key wins; otherwise the OIDC
 * identity of this deployment, which @vercel/oidc reads from the request
 * (and, in local development, from the token `vercel env pull` writes).
 */
export async function gatewayAuth(): Promise<Record<string, string>> {
  const key = process.env.AI_GATEWAY_API_KEY;
  if (key) return { Authorization: `Bearer ${key}` };
  let token: string | null = process.env.VERCEL_OIDC_TOKEN ?? null;
  try {
    const { getVercelOidcToken } = await import("@vercel/oidc");
    token = await getVercelOidcToken();
  } catch { /* not on Vercel and no pulled token — the env value stands */ }
  if (!token) {
    throw new Error(
      "Vercel AI Gateway is unreachable from here: set AI_GATEWAY_API_KEY, or run on Vercel with OIDC enabled."
    );
  }
  return { Authorization: `Bearer ${token}` };
}

/**
 * The gateway path: Claude through Vercel AI Gateway's OpenAI-compatible
 * endpoint. The system message carries an explicit cache marker (the
 * gateway lists explicit caching for Claude), and the request is retried
 * once in the plainest shape if the gateway ever rejects it — a refine
 * must never fail on a formality. Models are tried in order; a
 * refusal or an empty answer throws so the caller renders the raw words.
 */
async function refineWithGateway(
  system: string, userMsg: string, style: string
): Promise<RefineResult & { cachedIn: number }> {
  const auth = await gatewayAuth();
  // No `reasoning` field: on this surface the docs say it is a silent no-op
  // for Claude 5 (and a 400 in its max_tokens form). Effort is simply not a
  // knob here — which is fine, Sonnet answers in a couple of seconds.
  const shaped = (model: string, rich: boolean) => JSON.stringify({
    model,
    max_tokens: 1200,
    messages: [
      // The gateway's documented placement for Anthropic caching on this
      // endpoint is on the MESSAGE, not on a content part. One system
      // message carries the frozen rules and the house style together; the
      // style changes only when a shot is approved, and a rewrite then is
      // a cache write, not a broken cache.
      rich
        ? { role: "system", content: style ? `${system}\n\n${style}` : system,
            cache_control: { type: "ephemeral" } }
        : { role: "system", content: style ? `${system}\n\n${style}` : system },
      { role: "user", content: userMsg },
    ],
  });

  let lastErr = "";
  for (const model of GATEWAY_MODELS()) {
    const send = (rich: boolean) => fetch(GATEWAY_URL(), {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: shaped(model, rich),
      signal: AbortSignal.timeout(120_000),
    });
    let res = await send(true);
    let text = await res.text();
    if (res.status === 400 && /cache_control|reasoning|unknown|unsupported|invalid/i.test(text)) {
      console.warn(`refine(gateway): ${model} rejected the rich shape, retrying plain — ${text.slice(0, 140)}`);
      res = await send(false);
      text = await res.text();
    }
    if (res.ok) {
      /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
      const j = JSON.parse(text) as any;
      const choice = j.choices?.[0];
      const content = choice?.message?.content;
      const out = typeof content === "string"
        ? content
        : Array.isArray(content)
          /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
          ? content.map((p: any) => p?.text ?? "").join("")
          : "";
      if (choice?.finish_reason === "content_filter" || !out.trim()) {
        throw new Error("The prompt writer declined this request; rendering the raw prompt.");
      }
      const u = j.usage ?? {};
      const cost = typeof u.cost === "number" ? u.cost : null;
      return {
        text: out.trim(),
        model,
        inTokens: Number(u.prompt_tokens ?? 0),
        outTokens: Number(u.completion_tokens ?? 0),
        cachedIn: Number(u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens ?? 0),
        costUsd: cost,
      };
    }
    if (res.status === 403 && /free tier|RestrictedModels/i.test(text)) {
      throw new Error(
        "Vercel AI Gateway is on its free tier, which does not include Claude. " +
        "Add credits under Vercel → AI Gateway and prompts will be written by Claude from then on."
      );
    }
    if (res.status === 401) {
      throw new Error(
        "Vercel AI Gateway rejected this deployment's credentials." +
        (process.env.AI_GATEWAY_API_KEY
          ? " Check AI_GATEWAY_API_KEY in Vercel."
          : " On Vercel the OIDC identity is fresh on every request; locally, a token from `vercel env pull` expires after twelve hours.")
      );
    }
    // Not found, rate-limited, or the vendor is down: the next model in line.
    lastErr = `${model}: ${res.status} ${text.slice(0, 160)}`;
    console.warn(`refine(gateway): ${lastErr}`);
  }
  throw new Error(`No gateway model answered (${lastErr}).`);
}

/** Take the CAMERA line off the end and hand back what the engine gets. */
function finishRefine(r: RefineResult & { cachedIn: number }): RefineResult {
  const raw = stripScaffolding(r.text);
  const pick = /(^|\n)\s*CAMERA\s*[:：]\s*([a-z]+)\s*$/i.exec(raw);
  const out = pick ? raw.slice(0, pick.index).trim() : raw;
  if (!out) throw new Error("The model returned nothing.");
  if (r.cachedIn) console.log(`refine: ${r.cachedIn} input tokens served from cache`);
  return { text: out, model: r.model, inTokens: r.inTokens, outTokens: r.outTokens,
           move: pick ? pick[2].toLowerCase() : null, costUsd: r.costUsd ?? null };
}

export async function enhancePrompt(opts: {
  prompt: string;
  citations: string[]; // e.g. ["@Image1 (image)", "@Video1 (video, 8s)"]
  /** The engine this prompt is for — decides timestamps vs shot numbers. */
  model?: string;
  /** Requested output length, so the script is paced to fill it. */
  durationS?: number;
  /** generate | edit | extend — an edit is an instruction, not a scene. */
  task?: string;
  /** Approved work from this workspace, used as the style to match. */
  style?: string;
  /** Which writer to use; the workspace's choice when omitted. */
  provider?: RefineProvider;
}): Promise<RefineResult> {
  const userMsg =
    `${targetBlock(opts.model, opts.durationS, opts.task, opts.prompt.trim().split(/\s+/).filter(Boolean).length)}\n\n` +
    (opts.citations.length
      ? `Attached reference assets, in upload order: ${opts.citations.join(", ")}.\n\n`
      : "") + `Rewrite this ${opts.task === "edit" ? "edit request" : opts.task === "extend" ? "continuation request" : "idea"} as a Seedance prompt:\n\n${opts.prompt}`;

  const provider = opts.provider ?? refineProvider();
  if (provider === "anthropic") {
    return finishRefine(await refineWithClaude(SYSTEM, userMsg, opts.style ?? ""));
  }
  if (provider === "gateway") {
    return finishRefine(await refineWithGateway(SYSTEM, userMsg, opts.style ?? ""));
  }

  const key = process.env.ARK_API_KEY;
  if (!key) throw new Error("ARK_API_KEY is not set");
  let lastErr = "";
  for (const model of TEXT_MODELS()) {
    const res = await fetch(CHAT_URL(), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0.6,
        max_tokens: 700,
        messages: [
          { role: "system", content: opts.style ? `${SYSTEM}\n\n${opts.style}` : SYSTEM },
          { role: "user", content: userMsg },
        ],
      }),
    });
    const text = await res.text();
    if (res.ok) {
      const j = JSON.parse(text);
      const raw = stripScaffolding(j.choices?.[0]?.message?.content ?? "");
      // Pull the move off the end and take it out of the prompt itself.
      const pick = /(^|\n)\s*CAMERA\s*[:：]\s*([a-z]+)\s*$/i.exec(raw);
      const out = pick ? raw.slice(0, pick.index).trim() : raw;
      if (!out) throw new Error("The model returned nothing.");
      return {
        text: out,
        move: pick ? pick[2].toLowerCase() : null,
        model,
        inTokens: Number(j.usage?.prompt_tokens ?? 0),
        outTokens: Number(j.usage?.completion_tokens ?? 0),
      };
    }
    let code = "";
    try { code = JSON.parse(text)?.error?.code ?? ""; } catch { /* raw */ }
    // Not activated / not permissioned → try the next candidate.
    if ((res.status === 404 || res.status === 403) && /ModelNotOpen|NotFound|AccessDenied/i.test(code)) {
      lastErr = `${model}: ${code}`;
      continue;
    }
    throw new Error(`Refine failed (${res.status}): ${text.slice(0, 200)}`);
  }
  throw new Error(
    `No text model is reachable (${lastErr}). Console → Model activation: activate ` +
    `dola-seed-2-1-turbo-260628 or seed-2-0-pro-260328, and allow it on this API key.`
  );
}
