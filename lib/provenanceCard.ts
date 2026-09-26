import type { Recorded } from "./provenance";

/**
 * Reading a provenance record out loud (brief 3, surface 1c).
 *
 * The card's one job is to be exact, so its hardest requirement is the
 * opposite of a nice-looking screen: where something was not recorded it has
 * to say so, in the same weight as everything else. A take made before the
 * record existed has no seed and no rule ids, and inventing either would make
 * "make another from exactly this" a lie in the one place it must not be.
 *
 * Pure.
 */

export type Row = { kind: string; value: string; meta: string; visual: boolean };

export const NOT_RECORDED = "not recorded";

/** "1920 × 1080", and the frame the engine actually metered when it differs. */
export function frameLine(c: Recorded["conditions"]): { file: string; billed: string } {
  const file = c.width && c.height ? `${c.width} × ${c.height}` : NOT_RECORDED;
  const billed = c.billedWidth && c.billedHeight ? `${c.billedWidth} × ${c.billedHeight}` : "";
  return { file, billed: billed && billed !== file ? billed : "" };
}

/** "0:05" from seconds. */
export function durationLine(seconds: number | null): string {
  if (seconds == null || !(seconds > 0)) return NOT_RECORDED;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** The seed, or the truth. */
export const seedLine = (seed: number | null): string => (seed == null ? NOT_RECORDED : String(seed));

/** "3 rules", or none, or the truth for a take made before they were kept. */
export function rulesLine(rules: string[] | null | undefined): string {
  if (!rules) return NOT_RECORDED;
  if (!rules.length) return "no rules in scope";
  return `${rules.length} rule${rules.length === 1 ? "" : "s"}`;
}

/**
 * The PRODUCED BY rows.
 *
 * Ports first, because they are what the shot was made OF; then the engine
 * and the rules, which are how. A record with no ports says so rather than
 * showing an empty list, since "nothing was bound" and "we did not write it
 * down" are different facts and only one of them is reassuring.
 */
export function producedBy(r: Recorded | null): Row[] {
  if (!r) return [];
  const rows: Row[] = [];
  for (const [name, kind] of namesOf(r.cast)) {
    rows.push({ kind, value: name, meta: "", visual: true });
  }
  rows.push({ kind: "ENGINE", value: r.model || NOT_RECORDED, meta: r.provider ?? "", visual: false });
  rows.push({ kind: "RULES IN SCOPE", value: rulesLine(r.rules), meta: "", visual: false });
  return rows;
}

/* A cited name is all the record has for what it was: the ports carry ids,
   and the names are what a person wrote. Both are shown, and neither is
   dressed up as the other. */
function namesOf(cast: string[] | null | undefined): [string, string][] {
  if (!cast || !cast.length) return [];
  return cast.map((n) => [n, "CITED"]);
}

/** Whether this take can be made again exactly. It cannot without a seed. */
export function canRepeatExactly(r: Recorded | null): boolean {
  return Boolean(r && r.conditions.seed != null);
}

/**
 * Where "Make another from this" goes: Generate, in the take's own mode,
 * with its prompt loaded (GenWorkspace's `promptFrom` handoff), where the
 * new take is priced on its own button. Null for a kind Generate does not
 * make. An exact repeat (same versions, Setup, rules and seed) is not built,
 * so the card does not promise one.
 */
export function makeAnotherHref(take: { id: string; kind: string }): string | null {
  const mode = take.kind === "image" ? "images" : take.kind === "video" || take.kind === "audio" ? take.kind : null;
  return mode ? `/generate?${new URLSearchParams({ mode, promptFrom: take.id })}` : null;
}

/** The footnote under the primary: what "Make another" carries, and what it does not. */
export function repeatNote(r: Recorded | null): string {
  return r
    ? "Starts from this prompt in Generate. Engine, Setup and seed are set again there."
    : "Starts from this take's prompt in Generate. Nothing else was recorded for it.";
}
