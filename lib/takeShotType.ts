/**
 * What kind of shot a take is (owner, 14 Oct 2026: "A) params.shotType - yes. B) the 13 types = exactly the shot recipes"; docs/plans/step-0-data.md item 1b): the second label
 * Particl Auto will route on, beside the job (lib/takeJob.ts). A closed list of the 13 recipes, stored as `params.shotType`, written only by the server at admission in the same insert
 * as the take (no column, no migration), never part of a quote or its fingerprint, and never on a sound (a shot type describes a picture).
 *
 * Only three recipes are told by a fact the take already carries, its Setup's shot size: an establishing shot is Establishing wide, an over-the-shoulder shot is Over-the-shoulder, an
 * insert is Detail. Every other recipe (an emotional close-up, a pack shot, a product reveal, talking to camera ...) is the person's or the board's to name, so it comes only from a hint
 * on the request (`body.shotType`), checked: on the list, on a picture, and for those three, not contradicting a size the Setup names. A take with neither is `null` ("not recorded"), never a guess.
 * A hint beats the Setup's shot size (an Aerial reveal can be an extreme wide); the Setup only fills in where nothing was said.
 */
export const SHOT_TYPES = [
  "establishing_wide", "emotional_close_up", "product_reveal", "pack_shot", "talking_to_camera", "walk_and_talk", "action_beat",
  "detail", "over_the_shoulder", "aerial_reveal", "slow_motion_moment", "match_cut", "custom",
] as const;
export type ShotType = (typeof SHOT_TYPES)[number];

/** The one name each recipe has on a screen. */
export const SHOT_TYPE_LABELS: Record<ShotType, string> = {
  establishing_wide: "Establishing wide", emotional_close_up: "Emotional close-up", product_reveal: "Product reveal", pack_shot: "Pack shot",
  talking_to_camera: "Talking to camera", walk_and_talk: "Walk and talk", action_beat: "Action beat", detail: "Detail", over_the_shoulder: "Over-the-shoulder",
  aerial_reveal: "Aerial reveal", slow_motion_moment: "Slow-motion moment", match_cut: "Match cut", custom: "Custom",
};

export const isShotType = (value: unknown): value is ShotType => typeof value === "string" && (SHOT_TYPES as readonly string[]).includes(value);

/** The Setup shot sizes that tell a recipe for certain (lib/studio.ts: evs Establishing, ots Over shoulder, insert Insert). */
const BY_SHOT_SIZE: Record<string, ShotType> = { evs: "establishing_wide", ots: "over_the_shoulder", insert: "detail" };

export type ShotTypeFacts = { kind: "video" | "image" | "audio"; /** The Setup's shot size (`shotSpec.shot`). */ shot?: string | null };

/** A request's hint: absent, a recipe that fits (a picture, and where the Setup decides it, not contradicting a size the Setup names), or an error to answer with a 400. */
export function shotTypeHint(value: unknown, facts: ShotTypeFacts): { hint: ShotType | null } | { error: string } {
  if (value === undefined || value === null) return { hint: null };
  if (!isShotType(value)) return { error: "Name the shot type from the list, or leave it out." };
  if (facts.kind === "audio") return { error: "A sound has no shot type." };
  const decided = Object.entries(BY_SHOT_SIZE).find(([, type]) => type === value)?.[0];
  /* Refused only where the Setup NAMES a different size; with the size unset (the Auto default) the hint is accepted. */
  if (decided && facts.shot != null && facts.shot !== decided) return { error: `This take's shot size is not ${SHOT_TYPE_LABELS[value].toLowerCase()}: that comes from the Setup, not from a request.` };
  return { hint: value };
}

/** The shot type to store: the checked hint, else what the Setup's shot size says for certain, else null. */
export function shotTypeOf(facts: ShotTypeFacts & { hint?: ShotType | null }): ShotType | null {
  if (facts.kind === "audio") return null;
  return facts.hint ?? (facts.shot ? BY_SHOT_SIZE[facts.shot] ?? null : null);
}

type Row = { kind?: unknown; params?: unknown };

/** A take's shot type as read: the stored one, else the three certain cases from the Setup it stored, else null (not recorded). Never a guess. */
export function shotTypeOfRow(row: Row): ShotType | null {
  if (String(row.kind ?? "video") === "audio") return null;
  let params: Record<string, unknown> = {};
  if (row.params && typeof row.params === "object") params = row.params as Record<string, unknown>;
  else if (typeof row.params === "string") { try { params = JSON.parse(row.params) as Record<string, unknown>; } catch { /* unreadable: no facts */ } }
  if (isShotType(params.shotType)) return params.shotType;
  const spec = params.shotSpec;
  const shot = spec && typeof spec === "object" ? (spec as Record<string, unknown>).shot : undefined;
  return typeof shot === "string" ? BY_SHOT_SIZE[shot] ?? null : null;
}

/** `shotTypeOfRow` in SQL over `generations g`, for the `?shotType=` filter. NULL where it is not recorded. */
export const SHOT_TYPE_SQL = `CASE WHEN g.kind = 'audio' OR NOT json_valid(g.params) THEN NULL ELSE COALESCE(
  json_extract(g.params,'$.shotType'),
  CASE json_extract(g.params,'$.shotSpec.shot') WHEN 'evs' THEN 'establishing_wide' WHEN 'ots' THEN 'over_the_shoulder' WHEN 'insert' THEN 'detail' END) END`;
