import { judgeable, needsReview, type ShotTakes, type ShotVersion, type TakeNote } from "../cards/take/take-model";
import { reviewVersion } from "./review-model";

/*
 * Crew review's internal part (Gaps A frames, "Crew review"), pure: which take the panel is about, who has weighed in, and the
 * words it shows. Reviewers are the people who wrote notes on the take (the team's, and a client's through a review link
 * when there is one); a note is a note, so the panel offers Add a note, and the two decisions, Approve and Reject with a
 * reason. Both decisions are free and only a person makes them (use-judge: a signed-in person at a browser).
 */

/** The shots a person can review, in production order. */
export const reviewable = (rows: readonly ShotTakes[]): ShotTakes[] => rows.filter((r) => r.versions.some(judgeable));

/** The shot the panel opens on: the one asked for, else the first with a take that waits for a person, else the first reviewable. */
export function panelShot(rows: readonly ShotTakes[], nodeId: string | null): ShotTakes | null {
  const list = reviewable(rows);
  return list.find((r) => r.nodeId === nodeId) ?? list.find((r) => r.shown && needsReview(r.shown)) ?? list[0] ?? null;
}

export const panelVersion = (row: ShotTakes, pickedId?: string | null): ShotVersion | null => reviewVersion(row, pickedId);

export type Reviewer = { name: string; client: boolean };
/** Who has weighed in on these notes, once each, in the order they first spoke. */
export function reviewersOf(notes: readonly TakeNote[]): Reviewer[] {
  const seen = new Set<string>();
  const out: Reviewer[] = [];
  for (const n of notes) {
    const client = n.guest === true;
    const key = `${client ? "c" : "t"}:${n.author}`;
    if (!seen.has(key)) { seen.add(key); out.push({ name: client ? "Client" : n.author, client }); }
  }
  return out;
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** "Shot 3 · v1 · 2 reviewers". */
export function panelSub(row: ShotTakes, version: ShotVersion, reviewers: readonly Reviewer[]): string {
  return `Shot ${row.index} · ${version.label} · ${reviewers.length ? count(reviewers.length, "reviewer") : "no notes yet"}`;
}

/** The note's time: "10:19". */
export const noteTime = (at: number): string => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** The earlier versions of a shot, newest first, with how many notes each has: "v2 · 2 notes". */
export function earlierTakes(row: ShotTakes, current: ShotVersion, notes: ReadonlyMap<string, readonly TakeNote[]>): { key: string; label: string; said: string }[] {
  return row.versions.filter((v) => v.genId !== current.genId && judgeable(v)).reverse().map((v) => {
    const n = notes.get(v.genId)?.length ?? 0;
    const state = v.status === "approved" ? "approved" : v.status === "changes" ? "rejected" : null;
    return { key: v.genId, label: `Shot ${row.index} · ${v.label}`, said: [n ? count(n, "note") : "no notes", state].filter(Boolean).join(" · ") };
  });
}

export const NOTE_MAX = 500;
/** Why a note cannot be added, or null. */
export const noteProblem = (text: string): string | null => (text.replace(/\s+/g, " ").trim().length < 2 ? "Write the note first." : text.length > NOTE_MAX ? `Keep it under ${NOTE_MAX} characters.` : null);
