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
  /** The move the model chose, for the caller to attach as a module. */
  move?: string | null;
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

export async function enhancePrompt(opts: {
  prompt: string;
  citations: string[]; // e.g. ["@Image1 (image)", "@Video1 (video, 8s)"]
  /** The engine this prompt is for — decides timestamps vs shot numbers. */
  model?: string;
  /** Requested output length, so the script is paced to fill it. */
  durationS?: number;
  /** generate | edit | extend — an edit is an instruction, not a scene. */
  task?: string;
}): Promise<RefineResult> {
  const key = process.env.ARK_API_KEY;
  if (!key) throw new Error("ARK_API_KEY is not set");

  const userMsg =
    `${targetBlock(opts.model, opts.durationS, opts.task, opts.prompt.trim().split(/\s+/).filter(Boolean).length)}\n\n` +
    (opts.citations.length
      ? `Attached reference assets, in upload order: ${opts.citations.join(", ")}.\n\n`
      : "") + `Rewrite this ${opts.task === "edit" ? "edit request" : opts.task === "extend" ? "continuation request" : "idea"} as a Seedance prompt:\n\n${opts.prompt}`;

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
          { role: "system", content: SYSTEM },
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
