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
  options: {
    value: string; label: string;
    /** Short form, for the chip summary shown in the UI. */
    phrase: string;
    /**
     * Long form — a self-contained camera module.
     *
     * Higgsfield publish their prompt bank openly, and the thing worth taking
     * from it is not their wording but their METHOD, stated on the page
     * itself: "the move stays separate from the scene, so the prompt works
     * even when you swap the frame." Their camera prompts average ~76 words
     * where ours were six, and the extra words are all doing one job —
     * foreclosing the wrong reading. Each module is: the physical motion in
     * real units, the framing rule that follows from it, an explicit refusal
     * of the neighbouring moves it gets confused with, then speed and end
     * state.
     *
     * These are written here, in that shape. None is copied.
     */
    module?: string;
  }[];
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
    hint: "One move per shot — engines blur when asked for two. A technique that travels overrides this row.",
    options: [
      { value: "static", label: "Locked off", phrase: "the camera locked off",
        module: "The camera is locked on a tripod and does not move at any point: no push, no drift, no handheld breath, no stabiliser float, no reframing. Angle, height and distance to the subject are fixed from first frame to last, so every bit of movement in the shot belongs to the subject and none to the camera. The final framing is identical to the opening framing."  },
      { value: "push", label: "Push in", phrase: "the camera pushing slowly in",
        module: "The camera travels forward along its axis toward the subject in one continuous move, closing roughly a third of the distance across the shot and easing to a stop at the end. This is physical travel, not a zoom: the field of view never changes, so foreground edges sweep out past the frame with real parallax. No pan, no tilt, no zoom, no handheld drift; lens height stays constant throughout."  },
      { value: "pull", label: "Pull out", phrase: "the camera pulling slowly out",
        module: "The camera travels backward along its axis away from the subject in one continuous move, opening the frame to reveal the space around them, and decelerates into a held final composition. Physical travel only: the field of view is fixed, so the surroundings enter by parallax rather than by zooming. No pan, no tilt, no zoom, no crane; lens height stays constant."  },
      { value: "pan", label: "Pan", phrase: "the camera panning across",
        module: "The camera rotates horizontally from a single fixed position, like a head turning, sweeping across the scene at one smooth constant speed and easing gently to rest on its final composition. The camera body does not travel: no dolly, no truck, no arc, no slide, no zoom, no tilt. The horizon stays level and new space enters from the leading edge of frame purely through rotation."  },
      { value: "tilt", label: "Tilt", phrase: "the camera tilting up",
        module: "The camera rotates vertically upward from a fixed position at constant speed, starting on its lower anchor and finishing with the subject framed in the upper third, decelerating into a static hold. Rotation only: no crane, no pedestal rise, no dolly, no zoom, no horizontal drift. The camera's position in space never changes; only its angle does."  },
      { value: "track", label: "Tracking", phrase: "the camera tracking alongside",
        module: "The camera travels laterally alongside the subject, holding a constant distance and a constant lens height so the subject stays in the same part of frame while the background slides past behind them. Sideways travel only: no orbit, no arc, no zoom, no tilt, no handheld wobble. The move runs at the subject's own pace and settles when they settle."  },
      { value: "crane", label: "Crane", phrase: "the camera craning up and back",
        module: "The camera rises vertically on a jib through the shot, with a continuous gentle downward tilt that keeps the subject anchored low in frame as the space opens out above and around them. One unbroken vertical reveal: no lateral orbit, no truck, no zoom, no speed changes, easing into a high held final frame."  },
      { value: "handheld", label: "Handheld", phrase: "handheld, breathing slightly",
        module: "The camera is hand-held: it breathes with small, irregular, organic corrections in weight and angle, never mechanical and never a repeating loop. The operator keeps the subject in frame with slight late reframes that follow the action rather than anticipating it. No dolly track, no gimbal glide, no zoom; the unsteadiness stays subtle enough to read as presence, not as shake."  },
      { value: "orbit", label: "Orbit", phrase: "the camera orbiting the subject",
        module: "The camera arcs laterally around the subject on a constant radius at a constant lens height, keeping them centred while the background rotates continuously behind them. Arc travel only: no push in, no pull out, no zoom, no tilt, no change of radius. The move runs at one smooth speed and eases to rest on a clean final angle."  },
      { value: "steadicam", label: "Steadicam", phrase: "a smooth steadicam follow",
        module: "The camera follows the subject on a stabilised rig: continuous fluid travel with no jitter and no track, floating at a constant lens height and holding a constant distance behind or beside them, absorbing their changes of direction a beat late. No zoom, no tilt, no handheld shake; the glide is unbroken from first frame to last."  },
      { value: "panleft", label: "Pan left", phrase: "the camera panning left",
        module: "The camera rotates horizontally to the left from a single fixed position, sweeping across the scene at one constant speed and easing to rest on its final composition. The camera body does not travel: no dolly, no truck, no arc, no slide, no zoom, no tilt. The horizon stays level and new space enters from the left edge purely through rotation." },
      { value: "tiltdown", label: "Tilt down", phrase: "the camera tilting down",
        module: "The camera rotates vertically downward from a fixed position at one constant speed, starting on its upper anchor and finishing framed on the subject below, decelerating into a static hold. Rotation only: no crane descent, no pedestal, no dolly, no zoom, no horizontal drift. The camera's position in space never changes; only its angle does." },
      { value: "truckleft", label: "Truck left", phrase: "the camera trucking left",
        module: "The camera travels bodily to the left at a constant lens height, parallel to the scene, so the whole frame slides sideways and near objects sweep past faster than far ones. Lateral travel only: no rotation, no pan, no arc, no zoom, no tilt. One constant speed, easing to a stop on the final composition." },
      { value: "truckright", label: "Truck right", phrase: "the camera trucking right",
        module: "The camera travels bodily to the right at a constant lens height, parallel to the scene, so the whole frame slides sideways with near objects sweeping past faster than far ones. Lateral travel only: no rotation, no pan, no arc, no zoom, no tilt. One constant speed, easing to a stop on the final composition." },
      { value: "pedup", label: "Pedestal up", phrase: "the camera rising on the pedestal",
        module: "The camera rises vertically at a constant speed while its angle stays exactly level \u2014 the lens height changes, the framing direction does not. Pure vertical travel: no tilt, no crane arc, no zoom, no lateral drift. The move eases to a stop and holds the new height." },
      { value: "peddown", label: "Pedestal down", phrase: "the camera lowering on the pedestal",
        module: "The camera descends vertically at a constant speed while its angle stays exactly level \u2014 only the lens height changes. Pure vertical travel: no tilt, no crane arc, no zoom, no lateral drift. The move eases to a stop and holds the lower height." },
      { value: "zoomin", label: "Zoom in", phrase: "the lens zooming in",
        module: "The camera body is locked and does not travel; the entire move is optical, a focal-length change only, tightening smoothly and evenly across the shot with no steps and no wobble. Because the camera never moves there is no parallax: the background holds the same apparent size relative to the subject while the framing closes in. No dolly, no pan, no tilt." },
      { value: "zoomout", label: "Zoom out", phrase: "the lens zooming out",
        module: "The camera body is locked and does not travel; the entire move is optical, a focal-length change only, widening smoothly and evenly across the shot. Because the camera never moves there is no parallax: the background holds the same apparent size relative to the subject while more of the scene enters frame. No dolly, no pan, no tilt." },
      { value: "cranedown", label: "Crane down", phrase: "the camera craning down",
        module: "The camera descends on a jib from a high position toward the subject in one continuous move, with a gentle continuous upward tilt that keeps them framed as the surrounding space closes in above. One unbroken descent: no lateral orbit, no truck, no zoom, no speed changes, easing into a low held final frame." },
      { value: "lead", label: "Leading", phrase: "the camera leading the subject",
        module: "The camera travels backward ahead of the subject as they advance, holding a constant distance and lens height so they stay the same size in frame while the world opens up behind the camera and streams past on both sides. Backward travel only, matched exactly to their pace: no zoom, no orbit, no tilt, no drift in distance." },
      { value: "followbehind", label: "Following", phrase: "the camera following behind",
        module: "The camera travels forward behind the subject at their own pace, holding a constant distance and lens height so their back stays fixed in frame while the space ahead reveals itself over their shoulders. Forward travel only: no zoom, no orbit, no sudden distance changes; the camera absorbs their direction changes a beat late." },
      { value: "chase", label: "Chase", phrase: "the camera chasing the subject",
        module: "The camera pursues the subject at speed, close behind and slightly low, its path bending late through their turns so the framing is always catching up rather than anticipating. Urgent and continuous, carrying real momentum: no cuts, no zoom, no static holds; the distance closes and opens with the chase rather than staying locked." },
      { value: "lowtrack", label: "Low tracking", phrase: "a low tracking shot",
        module: "The camera travels alongside the subject at ground level, the lens only slightly above the surface so the foreground streaks past in the near field and the subject towers against the space beyond. Lateral travel at one constant speed and one constant low height: no rise, no tilt, no zoom, no orbit." },
      { value: "topdown", label: "Top down", phrase: "a top-down shot",
        module: "The camera looks straight down at the scene from directly overhead, the lens axis perpendicular to the ground so the frame reads as a flat plan of the space. It holds that vertical angle throughout \u2014 no tilt off the vertical, no roll, no zoom \u2014 travelling only if it travels level, parallel to the ground." },
      { value: "snorricam", label: "Snorricam", phrase: "a snorricam shot",
        module: "The camera is rigged to the subject and moves exactly with them, so their head and torso stay locked and near-motionless in the centre of frame while the entire world behind them pitches, swings and rushes past. The subject never drifts in frame: every bit of instability belongs to the background." },
      { value: "motioncontrol", label: "Motion control", phrase: "a motion-control move",
        module: "The camera flies one fast, perfectly repeatable machined path through the scene, gliding between framings with soft ease-in and ease-out and brief readable holds at each. Rig-precise throughout: no handheld shake, no whip, no speed ramps, no drift; the same path could be run again identically." },
      { value: "arc", label: "Arc", phrase: "the camera arcing around",
        module: "The camera travels a partial curve around the subject at a constant radius and constant lens height, revealing them from a new angle without completing a circle. Arc travel only: no push in, no pull out, no zoom, no radius drift; one smooth speed easing to rest on the new angle." },
      { value: "flythrough", label: "Fly through", phrase: "the camera flying through the space",
        module: "The camera travels continuously forward through the space, passing gaps, doorways and obstacles without stopping, the geometry sweeping past close on both sides. One unbroken forward path: no cuts, no hovering, no zoom, no reversal; speed stays smooth through the whole traverse." },
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
      { value: "natural", label: "Natural", phrase: "lit naturally",
        module: "Lit by available light only, with no visible fixtures and no added fill; contrast falls where the real source puts it." },
      { value: "soft", label: "Soft", phrase: "under soft diffused light",
        module: "Lit by a large diffused source: soft-edged shadows, a gentle falloff across the subject, and no hard specular highlights." },
      { value: "hard", label: "Hard", phrase: "in hard direct light with deep shadows",
        module: "Lit by a small hard source: crisp shadow edges, bright speculars, and deep unfilled shadow on the unlit side." },
      { value: "practical", label: "Practicals", phrase: "lit by practical lights in frame",
        module: "Lit by fixtures visible inside the frame, so the light has a source the audience can see and falls off with distance from it." },
      { value: "neon", label: "Neon", phrase: "lit by coloured neon",
        module: "Lit by coloured signage in frame, throwing saturated colour across the subject and reflecting in wet or glossy surfaces." },
      { value: "rim", label: "Rim light", phrase: "rim-lit against a dark background",
        module: "Lit from behind so the subject's edge separates as a bright outline against a darker background, with the front left in shadow." },
      { value: "back", label: "Backlit", phrase: "backlit, the subject in silhouette against the source",
        module: "Lit from directly behind the subject, reducing them toward silhouette while the source flares around their outline." },
      { value: "chiaro", label: "Chiaroscuro", phrase: "chiaroscuro lighting, one hard source",
        module: "One hard source and no fill: the lit side reads fully, the unlit side falls to near black, and the division across the face is the composition." },
      { value: "candle", label: "Firelight", phrase: "lit by firelight",
        module: "Lit by low warm flame at close range, flickering slightly, falling off fast into darkness beyond the subject." },
      { value: "mixed", label: "Mixed colour", phrase: "under mixed colour temperatures",
        module: "Lit by sources of different colour temperature at once, so warm and cool fall on different planes of the same frame." },
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
      { value: "clean", label: "Clean digital", phrase: "clean digital capture",
        module: "Clean modern digital capture: neutral colour, full detail retained in both highlight and shadow, no grain and no stylisation." },
      { value: "16mm", label: "16mm", phrase: "on 16mm film with visible grain",
        module: "Shot on 16mm: visible grain structure, slightly soft resolution, gentle halation on highlights and a modest contrast range." },
      { value: "35mm", label: "35mm film", phrase: "on 35mm film",
        module: "Shot on 35mm film: fine grain, smooth highlight rolloff, rich but not over-saturated colour, and organic contrast rather than digital." },
      { value: "vhs", label: "VHS", phrase: "on degraded VHS tape",
        module: "Degraded analogue tape: soft resolution, colour bleeding at edges, tracking noise and slightly unstable horizontal sync." },
      { value: "bleach", label: "Bleach bypass", phrase: "graded with a bleach-bypass look",
        module: "Bleach-bypass treatment: silver retained, so contrast is raised hard, colour is heavily desaturated and blacks are dense." },
      { value: "teal", label: "Teal & orange", phrase: "graded teal and orange",
        module: "Graded teal and orange: skin pushed warm against cooled shadows and background, contrast in the colour rather than the exposure." },
      { value: "bw", label: "Black & white", phrase: "in black and white",
        module: "Black and white: no colour information at all, the image carried entirely by tonal separation and contrast." },
      { value: "muted", label: "Muted", phrase: "in a desaturated, muted grade",
        module: "Desaturated grade: colour pulled well back toward neutral, contrast kept low and flat, nothing in the frame reading as vivid." },
    ],
  },
  {
    key: "technique",
    label: "Technique",
    hint: "Named moves the engine knows by name. The niche ones carry their own explanation, because ByteDance's guide says an unusual term only lands as [term + what actually happens].",
    options: [
      { value: "oner", label: "One-shot", phrase: "shot as a single continuous take, no cuts",
        module: "The entire shot is one continuous take: no cuts, no hidden transitions, no jump in time or position at any point. The camera and the action run unbroken from first frame to last."  },
      { value: "dollyzoom", label: "Dolly zoom", phrase: "a dolly zoom: the camera tracks back while the lens zooms in, so the subject holds its size and the background swells behind it",
        module: "The camera physically travels toward the subject while the lens simultaneously widens, the two motions perfectly synchronised and starting and ending together. The subject's size in frame stays exactly constant throughout; the background behind them visibly stretches and recedes into depth. Constant lens height, no pan, no tilt, no handheld drift."  },
      { value: "rackfocus", label: "Rack focus", phrase: "a rack focus: the foreground falls out of focus as the subject behind it sharpens",
        module: "The camera is locked off and the only change in the shot is focus. It holds sharp on the far plane, then racks once, smoothly and continuously with no hunting and no overshoot, to the near subject. Exactly one plane is sharp at any moment and the other falls to clean bokeh. The composition itself never changes."  },
      { value: "aerial", label: "Aerial", phrase: "an aerial view descending over the scene",
        module: "The camera flies high above the scene and descends steadily toward it in one continuous move, the horizon dropping through frame as altitude is lost. Smooth powered flight throughout: no handheld shake, no zoom, no abrupt corrections, easing into its final altitude and framing."  },
      { value: "fpv", label: "FPV", phrase: "an FPV drone shot flying continuously through the space",
        module: "The camera flies continuously through the space in a single unbroken first-person move, banking into its turns and carrying real momentum through gaps and around obstacles. Aggressive, fluid and always travelling: no cuts, no hovering, no zoom, no static holds."  },
      { value: "bullettime", label: "Bullet time", phrase: "bullet time: the action holds nearly frozen while the camera orbits around it",
        module: "The action holds very nearly frozen \u2014 motion continues at a small fraction of real speed \u2014 while the camera arcs around the subject at full speed on a constant radius. The subject stays centred throughout; the surroundings sweep past behind them. No zoom and no change of radius during the arc."  },
      { value: "whippan", label: "Whip pan", phrase: "a whip pan: the camera snaps sideways, the frame smearing into motion blur",
        module: "The camera snaps sideways at high speed in a single hard rotation, the frame smearing into directional motion blur through the middle of the move, then arrests abruptly on its new composition and holds it steady. Rotation only: no travel, no zoom."  },
      { value: "crash", label: "Crash zoom", phrase: "a crash zoom punching suddenly in on the subject",
        module: "The camera rushes in on the subject in one fast, decisive move that starts immediately at full speed and stops hard on a tight final framing. Sudden and aggressive throughout, with no easing at the start, no drift, no pan and no tilt."  },
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
  {
    key: "sound",
    label: "Sound",
    hint: "",
    options: [
      { value: "ambient", label: "Ambient only", phrase: "no BGM; environmental and action sound only" },
      { value: "music", label: "Music-led", phrase: "carried by music" },
      { value: "dialogue", label: "Dialogue-led", phrase: "carried by dialogue, with the room's own sound under it" },
      { value: "silent", label: "Silent", phrase: "no audio" },
    ],
  },
  {
    key: "titles",
    label: "Titles",
    hint: "Subtitles and audio are the only things the engine reliably takes a NO for — everything else should be described positively.",
    options: [
      { value: "none", label: "No subtitles", phrase: "no subtitles" },
    ],
  },
];

/**
 * The camera modules, addressable by id, and a reader that spots which move a
 * written prompt is already asking for.
 *
 * This is what makes the treatment universal rather than a Studio feature.
 * If someone types "handheld" we are not inventing a camera by expanding it
 * into the full module — they chose the move, we supply the sixty words that
 * stop the engine reading it as something else. That is exactly the division
 * Higgsfield draws: the operator picks, the system is rigorous about it.
 */
export function moduleFor(kind: "move" | "technique", value: string): string {
  const cat = CATEGORIES.find((c) => c.key === kind);
  return cat?.options.find((o) => o.value === value)?.module ?? "";
}

/**
 * Does this text already carry one of our camera modules?
 *
 * Checked against the module texts themselves rather than by grepping for
 * "no pan, no tilt" — the static module's exclusions are "no push, no drift,
 * no reframing", so a keyword guard misses it and a second module gets
 * stapled on underneath the first.
 */
export function hasCameraModule(text: string): boolean {
  const t = text.toLowerCase();
  for (const key of ["move", "technique"] as const) {
    const cat = CATEGORIES.find((c) => c.key === key);
    for (const o of cat?.options ?? []) {
      const m = o.module;
      // A distinctive opening fragment is enough, and survives light editing.
      if (m && t.includes(m.slice(0, 48).toLowerCase())) return true;
    }
  }
  return false;
}

export const MOVE_IDS = [
  "static", "push", "pull", "pan", "tilt", "track", "crane", "handheld", "orbit", "steadicam",
] as const;

/** Words that mean a given move, checked longest-first so "push in" wins over "pan". */
const MOVE_WORDS: [string, RegExp][] = [
  ["dollyzoom", /\bdolly[- ]?zoom|vertigo (?:shot|effect)\b/i],
  ["bullettime", /\bbullet[- ]?time\b/i],
  ["rackfocus",  /\brack focus|pull focus\b/i],
  ["whippan",    /\bwhip[- ]?pan\b/i],
  ["crash",      /\bcrash zoom\b/i],
  ["fpv",        /\bfpv\b/i],
  ["aerial",     /\baerial|drone shot\b/i],
  ["oner",       /\bone[- ]?shot|long take|oner\b/i],
  ["snorricam",  /\bsnorricam\b/i],
  ["motioncontrol", /\bmotion[- ]control\b/i],
  ["topdown",    /\btop[- ]down|straight down|directly overhead\b/i],
  ["flythrough", /\bfly[- ]?through\b/i],
  ["lowtrack",   /\blow tracking|ground[- ]level tracking\b/i],
  ["chase",      /\bchase (?:shot|cam)|chasing|\bchases\b/i],
  ["lead",       /\bleading (?:shot|the subject)|walk(?:s|ing)? backward(?:s)? ahead|ahead of the subject\b/i],
  ["followbehind", /\bfollow(?:s|ing)? behind|from behind|\btrails? behind\b/i],
  ["pedup",      /\bpedestal up\b/i],
  ["peddown",    /\bpedestal down\b/i],
  ["truckleft",  /\btruck(?:s|ing)? left\b/i],
  ["truckright", /\btruck(?:s|ing)? right\b/i],
  ["panleft",    /\bpan(?:s|ning)? left\b/i],
  ["tiltdown",   /\btilt(?:s|ing)? down\b/i],
  ["cranedown",  /\bcrane(?:s|ing)? down\b/i],
  ["zoomin",     /\bzoom(?:s|ing)? in\b/i],
  ["zoomout",    /\bzoom(?:s|ing)? out\b/i],
  ["arc",        /\barc(?:s|ing)? (?:around|round)|\barcing\b/i],
  ["steadicam",  /\bsteadicam|gimbal\b/i],
  ["handheld",   /\bhand[- ]?held\b/i],
  ["orbit",      /\borbit|circles? (?:around|the subject)\b/i],
  ["crane",      /\bcrane|jib\b/i],
  ["push",       /\bpush(?:es|ing)? in|dolly in|moves? in on\b/i],
  ["pull",       /\bpull(?:s|ing)? (?:out|back)|dolly out|pulls? away\b/i],
  ["track",      /\btrack(?:s|ing)?|follows? alongside|truck\b/i],
  ["tilt",       /\btilt(?:s|ing)? (?:up|down)\b/i],
  ["pan",        /\bpan(?:s|ning)?\b/i],
  ["static",     /\blocked[- ]?off|static shot|fixed camera|tripod\b/i],
];

const TECHNIQUE_IDS = new Set(["dollyzoom","bullettime","rackfocus","whippan","crash","fpv","aerial","oner"]);

/** Which move is this text already asking for, if any? */
export function detectMove(text: string): { kind: "move" | "technique"; value: string } | null {
  for (const [value, re] of MOVE_WORDS) {
    if (re.test(text)) {
      return { kind: TECHNIQUE_IDS.has(value) ? "technique" : "move", value };
    }
  }
  return null;
}

/**
 * Read a written prompt and work out which library entries it is already
 * asking for.
 *
 * This is what makes the engine library-first. Higgsfield never rewrite the
 * scene — their bank supplies craft and the author's words stay the author's
 * words. To do the same we have to recognise the craft someone has already
 * named, so "handheld, 35mm, no music" resolves to three library entries and
 * needs no model at all.
 *
 * Only unambiguous words count. When a term is missing we leave the axis
 * empty rather than guessing — an unfilled axis is the engine's choice to
 * make, and inventing one here would be the same fault we removed.
 */
const AXIS_WORDS: Record<string, [string, RegExp][]> = {
  shot: [
    ["ecu",   /\bextreme close[- ]?up\b/i],
    ["mcu",   /\bmedium close[- ]?up\b/i],
    ["cu",    /\bclose[- ]?up\b/i],
    ["mls",   /\bmedium wide\b/i],
    ["ms",    /\bmedium shot\b/i],
    ["evs",   /\bestablishing\b/i],
    ["ws",    /\bwide shot|wide angle\b/i],
    ["ots",   /\bover[- ]the[- ]shoulder\b/i],
    ["pov",   /\bpov|point[- ]of[- ]view|first[- ]person\b/i],
    ["insert",/\binsert shot\b/i],
  ],
  angle: [
    ["dutch",  /\bdutch (?:tilt|angle)\b/i],
    ["top",    /\btop[- ]down|overhead|bird'?s[- ]eye\b/i],
    ["ground", /\bground level\b/i],
    ["low",    /\blow angle\b/i],
    ["high",   /\bhigh angle\b/i],
    ["eye",    /\beye[- ]level\b/i],
  ],
  lens: [
    ["anamorphic", /\banamorphic\b/i],
    ["macro",      /\bmacro\b/i],
    ["14",  /\b14\s?mm\b/i], ["24", /\b24\s?mm\b/i], ["35", /\b35\s?mm\b/i],
    ["50",  /\b50\s?mm\b/i], ["85", /\b85\s?mm\b/i], ["135", /\b135\s?mm\b/i],
  ],
  time: [
    ["golden", /\bgolden hour\b/i],
    ["blue",   /\bblue hour\b/i],
    ["dawn",   /\bdawn|sunrise|first light\b/i],
    ["dusk",   /\bdusk|sunset\b/i],
    ["night",  /\bnight|after dark\b/i],
    ["midday", /\bmidday|noon\b/i],
    ["morning",/\bmorning\b/i],
    ["afternoon", /\bafternoon\b/i],
  ],
  light: [
    ["chiaro",   /\bchiaroscuro\b/i],
    ["rim",      /\brim[- ]?lit|rim light|backlit\b/i],
    ["neon",     /\bneon\b/i],
    ["practical",/\bpracticals?\b/i],
    ["candle",   /\bfirelight|candlelit|candlelight\b/i],
    ["hard",     /\bhard (?:light|sun)|harsh sun\b/i],
    ["soft",     /\bsoft light|diffused|overcast\b/i],
    ["natural",  /\bnatural light\b/i],
  ],
  look: [
    ["bw",     /\bblack and white|monochrome\b/i],
    ["16mm",   /\b16\s?mm\b/i],
    ["35mm",   /\b35\s?mm film\b/i],
    ["vhs",    /\bvhs\b/i],
    ["bleach", /\bbleach bypass\b/i],
    ["teal",   /\bteal and orange\b/i],
    ["muted",  /\bmuted|desaturated\b/i],
  ],
  pace: [
    ["slowmo",    /\bslow[- ]?mo(?:tion)?\b/i],
    ["timelapse", /\btime[- ]?lapse\b/i],
    ["ramp",      /\bspeed ramp\b/i],
  ],
  sound: [
    ["silent",   /\bno audio|silent\b/i],
    ["ambient",  /\bno (?:music|bgm|score)|ambient (?:only|sound)|diegetic\b/i],
    ["dialogue", /\bdialogue|speaks|says\b/i],
    ["music",    /\bmusic[- ]led|scored\b/i],
  ],
  titles: [
    ["none", /\bno subtitles?\b/i],
  ],
};

/** Everything the prompt already specifies, as a ShotSpec. */
export function detectSpec(text: string): ShotSpec {
  const spec: ShotSpec = {};
  for (const [axis, table] of Object.entries(AXIS_WORDS)) {
    for (const [value, re] of table) {
      if (re.test(text)) { spec[axis] = value; break; }
    }
  }
  const move = detectMove(text);
  if (move) spec[move.kind] = move.value;
  return spec;
}

/**
 * When nobody named a camera, pick one from what the subject is doing rather
 * than leaving the engine to invent a move. Travel for travel, stillness for
 * stillness — and static when it is genuinely unclear, because a locked
 * camera adds no motion the author did not ask for.
 */
export function inferMove(text: string): string {
  if (/\b(walk|walks|walking|run|runs|running|rides?|riding|drives?|driving|cycles?|bikes?|moves? through|crosses|chases?)\b/i.test(text)) return "track";
  if (/\b(reveals?|opens? (?:out|up)|emerges?|arrives?|approach(?:es)?)\b/i.test(text)) return "push";
  if (/\b(looks?|stares?|waits?|stands?|sits?|watch(?:es)?|holds?|pauses?)\b/i.test(text)) return "static";
  return "static";
}

/** Techniques that already specify how the camera travels. */
export const MOVEMENT_TECHNIQUES = new Set([
  "dollyzoom", "aerial", "fpv", "bullettime", "whippan", "crash",
]);

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
  const movingTechnique = MOVEMENT_TECHNIQUES.has(spec.technique ?? "");
  const camera = [movingTechnique ? "" : pick("move"), pick("lens"), pick("technique")]
    .filter(Boolean).join(", ");
  const world = [pick("time"), pick("light"), pick("look")].filter(Boolean).join(", ");
  const feel = [pick("mood"), pick("pace")].filter(Boolean).join(", ");
  const constraints = [pick("sound"), pick("titles")].filter(Boolean).join(". ");

  return [framing, camera, world, feel, constraints].filter(Boolean).join(". ");
}

/**
 * The camera as a self-contained block.
 *
 * A move written properly runs sixty to eighty words — most of them refusing
 * the moves it would otherwise be confused with — so it cannot be folded into
 * a comma list beside "golden hour" and "tense". It goes after the scene as
 * its own paragraph, which is also what keeps it portable: the same block is
 * correct whatever the shot in front of it happens to be.
 */
export function cameraModule(spec: ShotSpec): string {
  const mod = (key: string) => {
    const cat = CATEGORIES.find((c) => c.key === key);
    return cat?.options.find((o) => o.value === spec[key])?.module ?? "";
  };
  const movingTechnique = MOVEMENT_TECHNIQUES.has(spec.technique ?? "");
  return [movingTechnique ? "" : mod("move"), mod("technique")]
    .filter(Boolean).join(" ");
}

/**
 * Camera, light and look as one craft block.
 *
 * Light and look modules are deliberately shorter than the camera's. A camera
 * instruction has to refuse the moves it gets confused with, which is what
 * costs the words; light needs a source, a quality and a direction and should
 * then stop. Each is its own sentence group so the engine reads them as
 * separate specifications rather than one run-on.
 */
export function craftModules(spec: ShotSpec): string {
  const mod = (key: string) => {
    const cat = CATEGORIES.find((c) => c.key === key);
    return cat?.options.find((o) => o.value === spec[key])?.module ?? "";
  };
  return [cameraModule(spec), mod("light"), mod("look")]
    .filter(Boolean).join("\n\n");
}

/** The short line — framing, light, look, feel — without the camera block. */
export function sceneLine(spec: ShotSpec): string {
  const pick = (key: string) => {
    const cat = CATEGORIES.find((c) => c.key === key);
    return cat?.options.find((o) => o.value === spec[key])?.phrase ?? "";
  };
  const framing = [pick("shot"), pick("angle")].filter(Boolean).join(", ");
  // Light and look are carried by their own modules now — restating the short
  // phrase here would say the same thing twice, worse.
  const world = pick("time");
  const feel = [pick("mood"), pick("pace")].filter(Boolean).join(", ");
  const lens = pick("lens");
  // Each of these becomes its own sentence, so each one is capitalised —
  // including the two constraints, which are separate sentences themselves.
  const cap = (t: string) => (t ? t[0].toUpperCase() + t.slice(1) : t);
  return [framing, lens, world, feel, pick("sound"), pick("titles")]
    .filter(Boolean).map(cap).join(". ");
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
  const body = prose.trim().replace(/[.\s]+$/, "");
  const scene = sceneLine(spec);
  const camera = craftModules(spec);

  const parts: string[] = [];
  if (body) parts.push(scene ? `${body}. ${scene}.` : `${body}.`);
  else if (scene) parts.push(`${scene}.`);
  // The camera block sits on its own, after the scene it applies to.
  if (camera) parts.push(camera);
  return parts.join("\n\n");
}
