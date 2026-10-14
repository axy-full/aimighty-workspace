/**
 * What a take was FOR in the production: its job label (owner, 14 Oct 2026: "job label = A (purpose)"; docs/plans/step-0-data.md item 1).
 *
 * `kind` and `task` already say what the engine did, so the label adds only the missing fact, the purpose, from a closed list. It is stored as `params.job`, written only by the
 * server at admission in the same insert as the take (no column, no migration), and never changes a price: it is not part of any quote or of its fingerprint.
 *
 * `jobOf` derives it from facts the server already holds (the kind, the task, a final's `finalOf`, a draft, the audio task, a shot the take is filed on, the composer's Use as
 * row); a hint from the request (`body.job`) counts only where the facts do not decide, and only if it is on the list and fits the kind (a bad hint is a 400, never ignored).
 * Takes made before this carry no label; `jobOfRow` and `JOB_SQL` read one for them only where the facts are certain, and everything else is `null` ("not recorded").
 */
export const JOBS = ["storyboard", "keyframe", "cast", "element", "shot_draft", "shot_final", "shot", "fix", "upscale", "voice", "music", "sound", "ad", "other"] as const;
export type Job = (typeof JOBS)[number];
export type JobKind = "video" | "image" | "audio";

export const isJob = (value: unknown): value is Job => typeof value === "string" && (JOBS as readonly string[]).includes(value);

/** The kinds of take each job can be. */
const FITS: Record<Job, readonly JobKind[]> = {
  storyboard: ["image"], keyframe: ["image"], cast: ["image"], element: ["image"],
  shot_draft: ["video"], shot_final: ["video"], shot: ["video"],
  fix: ["image", "video"], upscale: ["image", "video"],
  voice: ["audio"], music: ["audio"], sound: ["audio"],
  ad: ["video", "image"], other: ["video", "image", "audio"],
};

/** The jobs the take itself decides, from facts the server holds: a request can never name one it is not. */
const FACT_ONLY: readonly Job[] = ["fix", "upscale", "shot_draft", "shot_final", "voice", "music", "sound"];

export type JobFacts = {
  kind: JobKind;
  /** The take's task: generate, edit, extend, motion, upscale, reframe or genjutsu (a video or a still); speech, dialogue, voiceChange, dub, sound or music (audio). */
  task?: string | null;
  /** A final made from a draft. */
  finalOf?: boolean;
  /** A draft take. */
  draft?: boolean;
  /** Filed against a shot of the production. */
  onShot?: boolean;
  /** The composer's Use as row for a still: first, cast or loose. */
  useAs?: string | null;
  /** A hint from the request, already checked by `jobHint`. */
  hint?: Job | null;
};

/** The job label to store. */
export function jobOf(facts: JobFacts): Job {
  const task = facts.task ?? "generate";
  if (facts.kind === "audio") {
    if (task === "speech" || task === "dialogue" || task === "voiceChange" || task === "dub") return "voice";
    if (task === "sound") return "sound";
    if (task === "music") return "music";
    return facts.hint ?? "other";
  }
  if (task === "upscale") return "upscale";
  if (task !== "generate") return "fix";
  if (facts.kind === "video") {
    if (facts.finalOf) return "shot_final";
    if (facts.draft) return "shot_draft";
    return facts.hint ?? (facts.onShot ? "shot" : "other");
  }
  return facts.hint ?? (facts.useAs === "first" ? "keyframe" : facts.useAs === "cast" ? "cast" : "other");
}

/** A request's hint: absent (`undefined` or `null`), a job that fits the kind and, if the take decides it for itself, agrees with the take, or an error to answer with a 400. */
export function jobHint(value: unknown, facts: Omit<JobFacts, "hint">): { hint: Job | null } | { error: string } {
  if (value === undefined || value === null) return { hint: null };
  if (!isJob(value)) return { error: "Name the take's job from the list, or leave it out." };
  if (!FITS[value].includes(facts.kind)) return { error: `A ${facts.kind} take cannot be a ${value.replace("_", " ")}.` };
  if (FACT_ONLY.includes(value) && jobOf(facts) !== value) return { error: `This take is not a ${value.replace("_", " ")}: that comes from the take itself, not from a request.` };
  return { hint: value };
}

type Row = { kind?: unknown; task?: unknown; params?: unknown };

/** A take's label as read: the stored one, else one of the certain cases for takes made before the label existed, else `null` (not recorded). Never a guess. */
export function jobOfRow(row: Row): Job | null {
  let params: Record<string, unknown> = {};
  if (row.params && typeof row.params === "object") params = row.params as Record<string, unknown>;
  else if (typeof row.params === "string") { try { params = JSON.parse(row.params) as Record<string, unknown>; } catch { /* unreadable: no facts */ } }
  if (isJob(params.job)) return params.job;
  const kind = String(row.kind ?? "video"), task = String(row.task ?? "generate");
  if (kind === "audio") {
    if (task === "speech" || task === "dialogue" || task === "voiceChange" || params.task === "dub") return "voice";
    return task === "sound" ? "sound" : task === "music" ? "music" : null;
  }
  if (task === "upscale") return "upscale";
  if (task !== "generate") return "fix";
  if (typeof params.finalOf === "string" && params.finalOf) return "shot_final";
  if (params.draft === true || (typeof params.finalGenId === "string" && params.finalGenId)) return "shot_draft";
  return null;
}

/** `jobOfRow` in SQL over `generations g`: the same certain cases, for the `?job=` filter. NULL where the take's job is not recorded. */
export const JOB_SQL = `COALESCE(
  CASE WHEN json_valid(g.params) THEN json_extract(g.params,'$.job') END,
  CASE WHEN g.kind = 'audio' THEN
    CASE WHEN g.task IN ('speech','dialogue','voiceChange') OR (json_valid(g.params) AND json_extract(g.params,'$.task') = 'dub') THEN 'voice'
         WHEN g.task = 'sound' THEN 'sound' WHEN g.task = 'music' THEN 'music' END
  WHEN g.task = 'upscale' THEN 'upscale'
  WHEN g.task <> 'generate' THEN 'fix'
  WHEN json_valid(g.params) AND COALESCE(json_extract(g.params,'$.finalOf'),'') <> '' THEN 'shot_final'
  WHEN json_valid(g.params) AND (json_extract(g.params,'$.draft') = 1 OR COALESCE(json_extract(g.params,'$.finalGenId'),'') <> '') THEN 'shot_draft'
  END)`;
