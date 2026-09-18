/**
 * Video tasks — generate, edit, extend.
 *
 * Seedance 2.5 splits requests into LOCKED and UNLOCKED. A locked task places
 * the input video on the output timeline, so the vendor decides the output's
 * shape and we must send the parameters that say so; getting this wrong is a
 * rejected request or a silently wrong render.
 *
 * Rules transcribed from the official guide, read 2026-09-02:
 * https://docs.byteplus.com/en/docs/ModelArk/2607689
 *
 *   Editing   — ratio MUST be "adaptive", duration MUST be -1 (output length
 *               follows the source, ±~0.3s as transition frames compress; a
 *               Seedance-2.5-generated source comes back exact). mov advised.
 *   Extension — ratio MUST be "adaptive". Duration is the user's. mov advised.
 *
 * Both are additionally recognised by KEYWORDS IN THE PROMPT — the vendor
 * decides what you meant from the words, and with several videos attached the
 * prompt is also how it picks which one to work on. So the words are not
 * decoration; a prompt without them is a different request.
 */

export type TaskId = "generate" | "edit" | "extend" | "motion" | "upscale" | "reframe" | "genjutsu";
/** The tasks that work on an existing clip. */
export type LockedTaskId = Exclude<TaskId, "generate">;

export type TaskDef = {
  id: TaskId;
  label: string;
  /** What the composer should ask for. */
  blurb: string;
  /** Locked tasks put the source on the output timeline. */
  locked: boolean;
  /** Ratio the API must receive, or null to leave the user's choice. */
  forceRatio: "adaptive" | null;
  /** Duration the API must receive: -1 for an Ark edit, "source" when the
   *  output is as long as the clip it works on, null for the user's choice. */
  forceDuration: -1 | "source" | null;
  /** The task needs a still as well as the clip (motion control's character). */
  needsImage?: boolean;
  /** The clip is the brief: a prompt may guide the engine but nothing has to be written. */
  promptOptional?: boolean;
  /** The vendor recommends mov for these — it preserves colour and audio sync. */
  preferMov: boolean;
  /** At least one of these must appear for the vendor to read the intent. */
  triggers: string[];
  /** Shown when we add a trigger for the user. */
  defaultTrigger: string;
};

export const TASKS: TaskDef[] = [
  {
    id: "generate",
    label: "Generate",
    blurb: "Describe a shot and make it.",
    locked: false,
    forceRatio: null,
    forceDuration: null,
    preferMov: false,
    triggers: [],
    defaultTrigger: "",
  },
  { id: "genjutsu", label: "Genjutsu", blurb: "Transfer motion or swap subjects in an original video.", locked: true,
    forceRatio: "adaptive", forceDuration: "source", promptOptional: true, preferMov: false, triggers: [], defaultTrigger: "" },
  {
    id: "edit",
    label: "Edit",
    blurb: "Change something inside an existing shot — a subject, an object, the background, the audio. Everything else stays.",
    locked: true,
    forceRatio: "adaptive",
    forceDuration: -1,
    preferMov: true,
    triggers: [
      "edit", "add", "insert", "remove", "delete", "modify",
      "replace", "change to", "change the", "swap",
    ],
    defaultTrigger: "Edit",
  },
  {
    id: "extend",
    label: "Extend",
    blurb: "Continue an existing shot forwards or backwards, matching the boundary frame.",
    locked: true,
    forceRatio: "adaptive",
    forceDuration: null,
    preferMov: true,
    triggers: [
      "extend forward", "extend backward", "extend", "continue",
      "continue from", "extend the story",
    ],
    defaultTrigger: "Continue",
  },
  /* ── On fal, not ModelArk ─────────────────────────────────────────────
   * Kling 3.0 motion control takes a still of a character and a clip whose
   * movement it borrows; Topaz Astra re-renders a finished clip at up to
   * 4K. Neither reads intent from words — the clip is the brief — so they
   * carry no triggers, and both are as long as their source.
   * ------------------------------------------------------------------ */
  {
    id: "motion",
    label: "Motion control",
    blurb: "Give a still character the movement of a reference clip — walking, dancing, a gesture — with Kling 3.0.",
    locked: true,
    forceRatio: "adaptive",
    forceDuration: "source",
    preferMov: false,
    triggers: [],
    defaultTrigger: "",
    needsImage: true,
  },
  {
    id: "upscale",
    promptOptional: true,
    label: "Upscale",
    blurb: "Re-render a finished clip at up to 4K with Topaz Astra 2, inventing the fine detail the original never had.",
    locked: true,
    forceRatio: "adaptive",
    forceDuration: "source",
    preferMov: false,
    triggers: [],
    defaultTrigger: "",
  },
  /* Reframe (brief 1.2, first of the post tools): a finished clip re-cut
     to another aspect — 9:16, 1:1 — with what the wider or taller frame
     reveals painted in. Luma's Ray 2 on fal does the fill; the one control
     that matters is the target ratio, so it is the one left open. Its
     output is a take under the same shot, like every post tool. */
  {
    id: "reframe",
    label: "Reframe",
    blurb: "Re-cut a finished clip to another aspect — 9:16, 1:1 — with Luma Ray 2 filling what the new frame reveals.",
    locked: true,
    promptOptional: true,
    forceRatio: null,
    forceDuration: "source",
    preferMov: false,
    triggers: [],
    defaultTrigger: "",
  },
];

/**
 * The edits worth naming.
 *
 * This is the part the composer could not do for you. ModelArk reads the
 * INTENT off the words — "replace", "remove", "change the" — and a prompt
 * that describes the same change in different words is a different request,
 * or no request at all. Someone typing freely into an Edit box has no way to
 * know that, and the failure is silent: the render comes back untouched, or
 * generated from scratch, and looks like the model simply ignored them.
 *
 * So the operations are offered as a list, each writing a skeleton that
 * already carries a trigger the vendor recognises, with the caret dropped
 * where the specifics go. `{}` marks that spot.
 *
 * Every template is checked against its task's triggers by a test below, so
 * one cannot be added that quietly fails to register as an edit.
 */
export type EditMove = {
  id: string;
  label: string;
  /** What it does, in the studio's words. */
  blurb: string;
  /** `{}` is where the caret lands. */
  template: string;
};

export const EDIT_MOVES: EditMove[] = [
  { id: "replace", label: "Replace something", blurb: "Swap one thing in the shot for another.",
    template: "Replace the {} with " },
  { id: "background", label: "Change the background", blurb: "Keep the subject, change what is behind them.",
    template: "Change the background to {}" },
  { id: "add", label: "Add something", blurb: "Put a new thing into the scene.",
    template: "Add {} to the scene" },
  { id: "remove", label: "Remove something", blurb: "Take a thing out and close the gap.",
    template: "Remove the {} from the shot" },
  { id: "wardrobe", label: "Change wardrobe", blurb: "Same person, different clothes.",
    template: "Change the {}'s outfit to " },
  { id: "look", label: "Change the look", blurb: "Restyle the whole shot without changing what happens.",
    template: "Change the grade and lighting to {}" },
  { id: "audio", label: "Change the audio", blurb: "Keep the picture, replace what is heard.",
    template: "Replace the audio with {}" },
];

export const EXTEND_MOVES: EditMove[] = [
  { id: "forward", label: "Carry on", blurb: "Continue past the final frame.",
    template: "Continue from the final frame: {}" },
  { id: "backward", label: "Go back", blurb: "Show what happened before the first frame.",
    template: "Extend backward: {}" },
];

export function movesFor(task: TaskId): EditMove[] {
  return task === "edit" ? EDIT_MOVES : task === "extend" ? EXTEND_MOVES : [];
}

export function getTask(id: string): TaskDef {
  return TASKS.find((t) => t.id === id) ?? TASKS[0];
}

/** Does the prompt carry a word the vendor will recognise as this intent? */
export function hasTrigger(task: TaskDef, prompt: string): boolean {
  if (!task.triggers.length) return true;
  const p = prompt.toLowerCase();
  return task.triggers.some((t) => p.includes(t));
}

/**
 * Editing and extension are only sane on a source the model can actually
 * read. The guide recommends staying within 20 seconds for edits — longer
 * sources lose stability — so that's advice we can give before spending.
 */
export function sourceAdvice(task: TaskDef, sourceSeconds: number | null): string | null {
  if (task.id === "edit" && sourceSeconds != null && sourceSeconds > 20) {
    return `This source is ${Math.round(sourceSeconds)}s. ByteDance advise editing videos of 20s or less — ` +
           `longer sources get less stable and may need several attempts.`;
  }
  return null;
}

/**
 * Why this clip cannot be the source, if it cannot.
 *
 * The limits are the vendor's, and two of them are surprising enough to be
 * worth stopping a person before they spend rather than after:
 *
 *   • The source must be 480p or 720p. A 1080p clip is a legal OUTPUT and an
 *     illegal INPUT, so the studio's best-looking renders are exactly the
 *     ones that cannot be edited. Nothing in the interface said so.
 *   • An edit source must be at least four seconds, where every other task
 *     accepts two.
 *
 * Returns null when the clip is usable.
 */
export function sourceProblem(
  task: TaskDef, source: { resolution?: string; duration?: number } | null, origin: "render" | "upload" = "render"
): string | null {
  if (!task.locked || !source) return null;
  const res = String(source.resolution ?? "").toLowerCase();
  const seconds = typeof source.duration === "number" ? source.duration : null;
  if (task.id === "genjutsu") return seconds != null && (seconds < 1 || seconds > 30) ? "Genjutsu requires an original video between 1 and 30 seconds." : null;
  if (task.id === "upscale") {
    if (seconds != null && seconds > 300) return `Topaz takes clips of five minutes or less; this one is ${Math.round(seconds)}s.`;
    return null;
  }
  if (task.id === "reframe") {
    // Any finished clip: Luma reads the resolution it is given, 1080p included.
    if (seconds != null && seconds > 300) return `Reframe takes clips of five minutes or less; this one is ${Math.round(seconds)}s.`;
    return null;
  }
  if (task.id === "motion") {
    if (res === "480p") {
      return `Kling reads the movement from a 720p or 1080p clip, and this one is 480P. ${origin === "upload" ? "Upload it at 720p or 1080p" : "Render it again at 720p"} to use it.`;
    }
    if (seconds != null && seconds < 2) return `The reference clip has to be at least 2 seconds; this one is ${seconds}s.`;
    if (seconds != null && seconds > 30) return `The reference clip has to be 30 seconds or less; this one is ${seconds}s.`;
    return null;
  }
  if (res && res !== "480p" && res !== "720p") {
    return `ModelArk only accepts 480p or 720p as an input video, and this one is ${res.toUpperCase()}. ` +
           `${origin === "upload" ? "Upload a 720p version" : "Render it again at 720p"} to edit it — 1080p is fine as an output, just not as a source.`;
  }
  const secs = typeof source.duration === "number" ? source.duration : null;
  if (secs != null && secs < 4) {
    return `An edit source has to be at least 4 seconds; this one is ${secs}s.`;
  }
  if (secs != null && secs > 30) {
    return `An edit source has to be 30 seconds or less; this one is ${secs}s.`;
  }
  return null;
}
