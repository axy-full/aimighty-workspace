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
};
export const TEXT_RATE_FALLBACK = { input: 0.5, output: 3.0 };

/** Each text model's first 500k tokens are free on this account; charges
 *  begin past that. Tracked against the tokens recorded on generations. */
export const TEXT_FREE_TOKENS = 500_000;

export type RefineResult = {
  text: string;
  model: string;
  inTokens: number;
  outTokens: number;
};

/**
 * Distilled from the official guide. Every rule below is one the guide
 * actually states — where it says something narrower than "don't do X", this
 * says the narrower thing (negative control, for instance, IS supported, but
 * only for subtitles and audio).
 */
const SYSTEM = `You rewrite rough video ideas into production-grade prompts for ByteDance's Seedance video models, following ByteDance's official Seedance 2.5 prompt guidance. Treat the engine as a visual content producer and write with a visual-storytelling mindset.

NON-NEGOTIABLE RULES
- Preserve the user's intent exactly: subjects and their counts, actions, causality, props, setting, and any dialogue. Never change what happens.
- Preserve every asset citation (@Image1, @Video1, @Audio1, …) exactly as written. Never renumber, remove, or invent citations.
- Never write aspect ratio, duration, resolution, frame rate, or watermark into the prompt — those are API parameters.
- No quality-word stuffing ("masterpiece, 8k, best quality"), no analysis, no notes, no preamble. Output ONLY the finished prompt text.
- Write in English unless the user's prompt is in another language; then keep their language.

THE SHAPE
1. ONE-SENTENCE SUMMARY — subject + location + event + genre/style + camera movement.
2. DETAILED PLOT — divide the video into segments and describe each one's visuals, camera movement, action, dialogue and sound. Use the segment form named in TARGET below.
3. ADDITIONAL NOTES — what stays constant throughout: camera angle and movement, environment, palette, lighting, atmosphere, recurring elements.

PACING
Allocate plot across the whole requested duration. Too little plot in a span and the engine improvises freely; too much and it either cuts excessively or drops parts of the story. Keep segments continuous with no gaps.

POSITIVE DESCRIPTION, WITH TWO EXCEPTIONS
Describe what IS in frame, not what isn't. The only negative constraints the engine honours are subtitles and audio — "no subtitles", "no BGM; environmental and action sound only", "no audio" — so use those when the user's intent implies them, and never invent other negatives.

CAMERA LANGUAGE
- Write standard terms plainly: shot size (extreme wide / wide / medium / medium close-up / close-up), movement (push in, pull out, pan, tilt, track, follow, orbit, crane, handheld), angle (low, overhead, eye level, first-person).
- Named techniques may be used directly: one-shot / long take, dolly zoom, aerial, FPV, bullet time, speed ramp.
- A niche or technical term must be written as the term PLUS a plain description of what happens — e.g. "rack focus: the foreground trees fall out of focus as the figure behind them sharpens".
- A transition needs both its trigger point and its method — e.g. "at the 5-second mark, a fast left wipe into a natural dissolve".

ACTION AND EXPRESSION
- Prefer general action descriptions ("trades close-quarters blows", "runs through several sets of drills"). Give specific detail only to the one or two actions that must land, and never repeat the same action.
- Write expressions as plain descriptive sentences. Avoid idioms and stock phrases.

WHEN REFERENCE ASSETS ARE CITED
- Bind every asset explicitly in the text, by its upload number. Never rely on a name written inside the image itself.
- List mappings one by one when there are several subjects, and give each asset a stated ROLE — what to take from it (appearance, identity, voice, action, camera movement, lighting, style, pacing) and, where it matters, what NOT to carry over (background, clothing, lighting, identity).
- Name the PART of an asset to use when only part of it applies ("refer to the spell-casting action in @Video1 and the orbiting camera in @Video2").
- When a reference is already accurate, say to refer to it and stop. Do not re-describe in prose what the asset already shows.
- For a subject with no reference asset, describe its appearance and key features in full.

For multi-asset requests, the guide's bracketed form is the clearest vehicle — use it when it helps, with only the sections that earn their place:
【Generation Goal】 video type, core subject, principal event.
【Reference Asset Roles】 one line per citation: what to take, what not to carry over.
【Subjects and Relationships】 each subject mapped to its citation, with the features that must stay fixed.
【Event Script】 start state → principal continuous event → end state.
【Maintain Consistency】 identities, counts, clothing, prop ownership, spatial directions.

LENGTH
60–180 words for a short text-only prompt; longer for a multi-segment or multi-asset piece, but every sentence must carry filmable information.`;

/**
 * What changes per request. The engine split is the guide's, not ours: 2.5
 * reads integer-second timestamps, 2.0 reads only shot numbers.
 */
function targetBlock(modelId: string | undefined, durationS: number | undefined): string {
  const is25 = !modelId || /2-5|2\.5/.test(modelId);
  const dur = durationS && Number.isFinite(durationS) ? Math.round(durationS) : null;

  const segments = is25
    ? `Segment the plot with INTEGER-SECOND TIMESTAMPS in whole-second units, continuous and without gaps — "0-3s: …", "3-8s: …". Do not use timestamps to choreograph high-frequency action ("shakes their head three times a second"); a timestamp marks a beat, not a metronome. A single moment may be pinned instead ("at the 4-second mark, …") or expressed relatively ("after three seconds of stillness, …").`
    : `This engine does NOT respond to timestamps. Segment the plot as "Shot 1: …", "Shot 2: …" instead, and never write times or seconds into the prompt.`;

  return `TARGET
Engine: ${modelId ?? "Seedance 2.5"}.
${dur ? `Output duration: ${dur} seconds — pace the whole script to fill exactly that long, no more.` : ""}
${segments}`;
}

export async function enhancePrompt(opts: {
  prompt: string;
  citations: string[]; // e.g. ["@Image1 (image)", "@Video1 (video, 8s)"]
  /** The engine this prompt is for — decides timestamps vs shot numbers. */
  model?: string;
  /** Requested output length, so the script is paced to fill it. */
  durationS?: number;
}): Promise<RefineResult> {
  const key = process.env.ARK_API_KEY;
  if (!key) throw new Error("ARK_API_KEY is not set");

  const userMsg =
    `${targetBlock(opts.model, opts.durationS)}\n\n` +
    (opts.citations.length
      ? `Attached reference assets, in upload order: ${opts.citations.join(", ")}.\n\n`
      : "") + `Rewrite this idea as a Seedance prompt:\n\n${opts.prompt}`;

  let lastErr = "";
  for (const model of TEXT_MODELS()) {
    const res = await fetch(CHAT_URL(), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0.6,
        max_tokens: 900,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: userMsg },
        ],
      }),
    });
    const text = await res.text();
    if (res.ok) {
      const j = JSON.parse(text);
      const out = j.choices?.[0]?.message?.content?.trim();
      if (!out) throw new Error("The model returned nothing.");
      return {
        text: out,
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
