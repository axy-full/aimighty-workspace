import { judgeable, needsReview, type ShotTakes, type ShotVersion } from "../cards/take/take-model";

/*
 * Review mode (README § 3.1 l, § 6; U1 item 6), pure: which takes it steps through, which version it shows and
 * compares, and what each key does. J and K are the previous and next take (README § 6; the master's J and K
 * switch versions, but the README is the spec). A approves, R rejects with a reason, Space plays, C cycles the
 * compare view, Esc closes.
 */

export type CompareMode = "single" | "side" | "slider";
export const COMPARE_MODES: readonly CompareMode[] = ["single", "side", "slider"];
export const COMPARE_LABEL: Record<CompareMode, string> = { single: "Single", side: "Side by side", slider: "Slider" };
export const nextCompare = (mode: CompareMode): CompareMode => COMPARE_MODES[(COMPARE_MODES.indexOf(mode) + 1) % COMPARE_MODES.length];

/** The shots with a take a person can judge, in production order: one stop per shot ("take 2 of 3"). */
export function reviewQueue(rows: readonly ShotTakes[]): ShotTakes[] {
  return rows.filter((r) => r.versions.some(judgeable));
}

/** Where review mode opens: the shot holding the take asked for, else the first that waits for a person, else the first. */
export function startIndex(queue: readonly ShotTakes[], takeId: string | null | undefined): number {
  if (!queue.length) return -1;
  const asked = takeId ? queue.findIndex((r) => r.versions.some((v) => v.id === takeId || v.genId === takeId)) : -1;
  if (asked >= 0) return asked;
  const waiting = queue.findIndex((r) => r.shown && needsReview(r.shown));
  return waiting >= 0 ? waiting : 0;
}

/** The version review mode shows for a shot: the one picked, else the shot's current one, else its newest judgeable one. */
export function reviewVersion(row: ShotTakes, pickedId?: string | null): ShotVersion | null {
  const ok = row.versions.filter(judgeable);
  return ok.find((v) => v.genId === pickedId || v.id === pickedId)
    ?? (row.shown && judgeable(row.shown) ? row.shown : null)
    ?? ok[ok.length - 1] ?? null;
}

/**
 * What the shown version is compared with: the approved version when it is another one, else the version just
 * before it, else the one after it. Null with a single version: there is nothing to compare.
 */
export function compareBase(row: ShotTakes, version: ShotVersion): ShotVersion | null {
  const ok = row.versions.filter(judgeable);
  const approved = ok.find((v) => v.status === "approved" && v.genId !== version.genId);
  if (approved) return approved;
  const at = ok.findIndex((v) => v.genId === version.genId);
  if (at > 0) return ok[at - 1];
  return at >= 0 && at + 1 < ok.length ? ok[at + 1] : null;
}

/** "take 2 of 3 · v2". */
export const positionWords = (index: number, count: number, label: string) => `take ${index + 1} of ${count} · ${label}`;

export type ReviewAction = "prev" | "next" | "approve" | "reject" | "play" | "compare" | "close";

/** The review keys (README § 6). Modifier chords belong to the browser and the shell, never to review mode. */
export function reviewAction(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey">): ReviewAction | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.key === "Escape") return "close";
  if (e.key === " " || e.key === "Spacebar") return "play";
  switch (e.key.toLowerCase()) {
    case "j": return "prev";
    case "k": return "next";
    case "a": return "approve";
    case "r": return "reject";
    case "c": return "compare";
    default: return null;
  }
}

/** The key hints, in the master's order and words. */
export const REVIEW_KEYS: readonly { key: string; label: string }[] = [
  { key: "J", label: "previous" }, { key: "K", label: "next" }, { key: "A", label: "approve" },
  { key: "R", label: "reject" }, { key: "Space", label: "play" }, { key: "C", label: "compare" },
];

/** A key typed into a field is the field's, except Esc, which the field itself handles. */
export function typingIn(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
}
