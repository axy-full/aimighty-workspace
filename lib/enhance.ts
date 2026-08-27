/**
 * Prompt refinement — the layer platforms like Higgsfield run between the
 * user and the model. The raw idea goes to a small ModelArk text model with
 * a system prompt distilled from ByteDance's OFFICIAL Seedance 2.5 prompt
 * optimizer (their published `sd25-pe` skill), and comes back as the dense,
 * structured prompt the video model actually responds to.
 *
 * Costs a fraction of a cent per call on seed-2-0-mini; the text model must
 * be activated in the ModelArk console like the video models were.
 */

const CHAT_URL = () =>
  (process.env.ARK_BASE_URL?.replace(/\/$/, "") ??
    "https://ark.ap-southeast.bytepluses.com") + "/api/v3/chat/completions";

export const TEXT_MODEL = () => process.env.ARK_TEXT_MODEL ?? "seed-2-0-mini-260428";

const SYSTEM = `You rewrite rough video ideas into production-grade prompts for ByteDance's Seedance 2.5 / 2.0 video models, following ByteDance's official Seedance prompt-optimization guidance.

NON-NEGOTIABLE RULES
- Preserve the user's intent exactly: subjects and their counts, actions, causality, props, setting, and any dialogue. Never change what happens.
- Preserve every asset citation (@Image1, @Video1, …) exactly as written. Never renumber, remove, or invent citations.
- Never write aspect ratio, duration, resolution, frame rate, or watermark into the prompt — those are API parameters.
- No negative-constraint boilerplate, no quality-word stuffing ("masterpiece, 8k"), no analysis or notes. Output ONLY the finished prompt text.
- Write in English unless the user's prompt is in another language; then keep their language.

HOW TO EXPAND A THIN PROMPT
Enrich sparse ideas into concrete, filmable specifics — one coherent scene, not a list of adjectives. Follow this structure (merge lines naturally; drop a line only if the user's intent makes it irrelevant):
1. Subject and main action in a specific environment — concrete details of appearance, movement, and place.
2. Visuals: style or mood, light source and quality, palette, texture.
3. Camera: shot size, position, and ONE clear movement or cut pattern (e.g. "begins in a medium shot observing the hands, then slowly pushes in").
4. Sound: ambience, effects, music, or dialogue — only if audio fits the request.

WHEN CITATIONS ARE PRESENT
Use ByteDance's structured form with these bracketed sections, only the ones needed:
【Generation Goal】 one or two sentences: video type, core subject, principal event.
【Reference Asset Roles】 one line per citation: what to take from it (appearance / structure / material / action / camera movement / pacing / voice) AND what NOT to carry over (identity, clothing, background, scene).
【Subjects and Relationships】 map each subject to its citation; state features that must stay fixed.
【Event Script】 start state → principal continuous event → end state.
【Maintain Consistency】 identities, counts, clothing, prop ownership, spatial directions to keep stable.

LENGTH
Aim for 60–180 words for text-only prompts; the structured form may run longer but stays tight. Every sentence must add filmable information.`;

export async function enhancePrompt(opts: {
  prompt: string;
  citations: string[]; // e.g. ["@Image1 (image)", "@Video1 (video, 8s)"]
}): Promise<string> {
  const key = process.env.ARK_API_KEY;
  if (!key) throw new Error("ARK_API_KEY is not set");

  const userMsg =
    (opts.citations.length
      ? `Attached reference assets: ${opts.citations.join(", ")}.\n\n`
      : "") + `Rewrite this idea as a Seedance prompt:\n\n${opts.prompt}`;

  const res = await fetch(CHAT_URL(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: TEXT_MODEL(),
      temperature: 0.6,
      max_tokens: 900,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: userMsg },
      ],
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    let code = "";
    try { code = JSON.parse(text)?.error?.code ?? ""; } catch { /* raw */ }
    if (res.status === 404 && /ModelNotOpen|NotFound/i.test(code)) {
      throw new Error(
        `The text model ${TEXT_MODEL()} isn't activated on this ModelArk account. ` +
        `Console → Model activation → activate it (same as the video models), then try again.`
      );
    }
    throw new Error(`Refine failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const j = JSON.parse(text);
  const out = j.choices?.[0]?.message?.content?.trim();
  if (!out) throw new Error("The model returned nothing.");
  return out;
}
