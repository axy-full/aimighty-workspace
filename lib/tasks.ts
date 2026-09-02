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

export type TaskId = "generate" | "edit" | "extend";

export type TaskDef = {
  id: TaskId;
  label: string;
  /** What the composer should ask for. */
  blurb: string;
  /** Locked tasks put the source on the output timeline. */
  locked: boolean;
  /** Ratio the API must receive, or null to leave the user's choice. */
  forceRatio: "adaptive" | null;
  /** Duration the API must receive, or null for the user's choice. */
  forceDuration: -1 | null;
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
];

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
