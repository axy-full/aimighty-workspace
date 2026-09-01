/**
 * The Studio — prompt by category, and cinematic shot control.
 *
 * Artlist's Studio is built on the observation that most people describing a
 * shot leave out the things that decide how it looks. A director says "wide,
 * slow push in, golden hour, anamorphic" — a prompt box gets "a woman walks
 * on a beach". The gap isn't vocabulary, it's recall.
 *
 * So the categories below aren't a style picker; they're the crew's checklist
 * turned into chips. Choosing them builds a spec that's appended to the prose
 * as one clean camera-and-look sentence, in the order a shot is actually
 * described. The spec is stored on the render, so re-opening a shot brings
 * the chips back set — the whole point of a shot control is being able to
 * change ONE thing and run it again.
 *
 * Deliberately NOT free text: every value here is a phrase the engines
 * respond to. The prose box stays the place for anything else.
 */

export type Category = {
  key: string;
  label: string;
  /** One-line explanation shown under the group. */
  hint: string;
  options: { value: string; label: string; phrase: string }[];
};

export const CATEGORIES: Category[] = [
  {
    key: "shot",
    label: "Shot size",
    hint: "How much of the subject the frame holds.",
    options: [
      { value: "ecu", label: "Extreme close", phrase: "extreme close-up" },
      { value: "cu", label: "Close-up", phrase: "close-up" },
      { value: "mcu", label: "Medium close", phrase: "medium close-up" },
      { value: "ms", label: "Medium", phrase: "medium shot" },
      { value: "mls", label: "Medium wide", phrase: "medium wide shot" },
      { value: "ws", label: "Wide", phrase: "wide shot" },
      { value: "evs", label: "Establishing", phrase: "extreme wide establishing shot" },
      { value: "ots", label: "Over shoulder", phrase: "over-the-shoulder shot" },
      { value: "pov", label: "POV", phrase: "point-of-view shot" },
      { value: "insert", label: "Insert", phrase: "insert shot of the detail" },
    ],
  },
  {
    key: "angle",
    label: "Angle",
    hint: "Where the camera sits relative to the subject.",
    options: [
      { value: "eye", label: "Eye level", phrase: "at eye level" },
      { value: "low", label: "Low", phrase: "from a low angle" },
      { value: "high", label: "High", phrase: "from a high angle" },
      { value: "dutch", label: "Dutch", phrase: "with a dutch tilt" },
      { value: "top", label: "Top down", phrase: "from directly overhead" },
      { value: "ground", label: "Ground level", phrase: "from ground level" },
    ],
  },
  {
    key: "move",
    label: "Camera move",
    hint: "One move per shot — engines blur when asked for two.",
    options: [
      { value: "static", label: "Locked off", phrase: "the camera locked off" },
      { value: "push", label: "Push in", phrase: "the camera pushing slowly in" },
      { value: "pull", label: "Pull out", phrase: "the camera pulling slowly out" },
      { value: "pan", label: "Pan", phrase: "the camera panning across" },
      { value: "tilt", label: "Tilt", phrase: "the camera tilting up" },
      { value: "track", label: "Tracking", phrase: "the camera tracking alongside" },
      { value: "crane", label: "Crane", phrase: "the camera craning up and back" },
      { value: "handheld", label: "Handheld", phrase: "handheld, breathing slightly" },
      { value: "orbit", label: "Orbit", phrase: "the camera orbiting the subject" },
      { value: "steadicam", label: "Steadicam", phrase: "a smooth steadicam follow" },
    ],
  },
  {
    key: "lens",
    label: "Lens",
    hint: "Focal length changes the shape of a face and the depth of a street.",
    options: [
      { value: "14", label: "14mm", phrase: "shot on a 14mm lens" },
      { value: "24", label: "24mm", phrase: "shot on a 24mm lens" },
      { value: "35", label: "35mm", phrase: "shot on a 35mm lens" },
      { value: "50", label: "50mm", phrase: "shot on a 50mm lens" },
      { value: "85", label: "85mm", phrase: "shot on an 85mm lens" },
      { value: "135", label: "135mm", phrase: "shot on a 135mm lens" },
      { value: "macro", label: "Macro", phrase: "shot on a macro lens" },
      { value: "anamorphic", label: "Anamorphic", phrase: "anamorphic, with oval bokeh and a horizontal flare" },
    ],
  },
  {
    key: "light",
    label: "Lighting",
    hint: "The quality and source of the light — not the hour, which is its own row.",
    options: [
      { value: "natural", label: "Natural", phrase: "lit naturally" },
      { value: "soft", label: "Soft", phrase: "under soft diffused light" },
      { value: "hard", label: "Hard", phrase: "in hard direct light with deep shadows" },
      { value: "practical", label: "Practicals", phrase: "lit by practical lights in frame" },
      { value: "neon", label: "Neon", phrase: "lit by coloured neon" },
      { value: "rim", label: "Rim light", phrase: "rim-lit against a dark background" },
      { value: "back", label: "Backlit", phrase: "backlit, the subject in silhouette against the source" },
      { value: "chiaro", label: "Chiaroscuro", phrase: "chiaroscuro lighting, one hard source" },
      { value: "candle", label: "Firelight", phrase: "lit by firelight" },
      { value: "mixed", label: "Mixed colour", phrase: "under mixed colour temperatures" },
    ],
  },
  {
    key: "time",
    label: "Time of day",
    hint: "The hour lives here alone — golden hour is a time, not a lighting setup, and having it in both rows let one shot ask for dusk and golden hour at once.",
    options: [
      { value: "dawn", label: "Dawn", phrase: "at dawn" },
      { value: "morning", label: "Morning", phrase: "in the morning" },
      { value: "midday", label: "Midday", phrase: "at midday" },
      { value: "afternoon", label: "Afternoon", phrase: "in the late afternoon" },
      { value: "golden", label: "Golden hour", phrase: "at golden hour, in warm low sun" },
      { value: "dusk", label: "Dusk", phrase: "at dusk" },
      { value: "blue", label: "Blue hour", phrase: "at blue hour, in cool fading light" },
      { value: "night", label: "Night", phrase: "at night" },
    ],
  },
  {
    key: "look",
    label: "Look",
    hint: "Stock and grade — how the image is finished.",
    options: [
      { value: "clean", label: "Clean digital", phrase: "clean digital capture" },
      { value: "16mm", label: "16mm", phrase: "on 16mm film with visible grain" },
      { value: "35mm", label: "35mm film", phrase: "on 35mm film" },
      { value: "vhs", label: "VHS", phrase: "on degraded VHS tape" },
      { value: "bleach", label: "Bleach bypass", phrase: "graded with a bleach-bypass look" },
      { value: "teal", label: "Teal & orange", phrase: "graded teal and orange" },
      { value: "bw", label: "Black & white", phrase: "in black and white" },
      { value: "muted", label: "Muted", phrase: "in a desaturated, muted grade" },
    ],
  },
  {
    key: "mood",
    label: "Mood",
    hint: "",
    options: [
      { value: "calm", label: "Calm", phrase: "calm and unhurried" },
      { value: "tense", label: "Tense", phrase: "tense and uneasy" },
      { value: "joyful", label: "Joyful", phrase: "warm and joyful" },
      { value: "epic", label: "Epic", phrase: "epic in scale" },
      { value: "intimate", label: "Intimate", phrase: "intimate and quiet" },
      { value: "melancholy", label: "Melancholy", phrase: "melancholy" },
      { value: "documentary", label: "Documentary", phrase: "observational, documentary in feel" },
    ],
  },
  {
    key: "pace",
    label: "Motion",
    hint: "",
    options: [
      { value: "realtime", label: "Real time", phrase: "at real-time speed" },
      { value: "slowmo", label: "Slow motion", phrase: "in slow motion" },
      { value: "ramp", label: "Speed ramp", phrase: "with a speed ramp into slow motion" },
      { value: "timelapse", label: "Timelapse", phrase: "as a timelapse" },
    ],
  },
];

/** One selection per category. Empty string = not chosen. */
export type ShotSpec = Record<string, string>;

/**
 * Render the spec as the sentence a director would actually say, in the order
 * a shot gets described: framing, then camera, then light and look, then feel.
 * Categories the user left alone contribute nothing — silence beats padding,
 * and quality-word stuffing is exactly what the refine layer strips out.
 */
export function specToPhrase(spec: ShotSpec): string {
  const pick = (key: string) => {
    const cat = CATEGORIES.find((c) => c.key === key);
    const opt = cat?.options.find((o) => o.value === spec[key]);
    return opt?.phrase ?? "";
  };

  const framing = [pick("shot"), pick("angle")].filter(Boolean).join(", ");
  const camera = [pick("move"), pick("lens")].filter(Boolean).join(", ");
  const world = [pick("time"), pick("light"), pick("look")].filter(Boolean).join(", ");
  const feel = [pick("mood"), pick("pace")].filter(Boolean).join(", ");

  return [framing, camera, world, feel].filter(Boolean).join(". ");
}

/** How many controls are set — drives the "3 set" badge on the panel. */
export function specCount(spec: ShotSpec): number {
  return CATEGORIES.reduce((n, c) => n + (spec[c.key] ? 1 : 0), 0);
}

/**
 * The prompt as submitted: the prose the person wrote, then the spec.
 * The prose leads because the subject and action must come first — that's
 * what ByteDance's own optimizer expects, and burying the action behind a
 * wall of camera language is how you get a beautiful shot of nothing.
 */
export function composePrompt(prose: string, spec: ShotSpec): string {
  const phrase = specToPhrase(spec);
  const body = prose.trim();
  if (!phrase) return body;
  if (!body) return phrase;
  return `${body.replace(/[.\s]+$/, "")}. ${phrase}.`;
}
