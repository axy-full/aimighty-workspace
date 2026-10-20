import type { ShotTakes, ShotVersion } from "@/components/graphite/board/cards/take/take-model";
import { REJECT_REASON_MAX, cleanRejectReason, judgeable, rejectReasonProblem } from "@/components/graphite/board/cards/take/take-model";
import { downloadUrl } from "@/lib/preview";
import { SHOT_REASONS, shotCardState } from "./shot-card";
import type { CardStatus } from "./card-model";

/**
 * The v25 preview's rules (design/particl-prototype-25 README: "Double-click or Space: Preview with versions, Compare, ✓ / ✕ for the version shown,
 * Download, ← / →. Script preview has Script · Beats · Breakdown tabs; sound cards show a waveform."). Pure: no React, no fetch
 * (tests/unit/v25-preview-model.spec.ts). The board's data builds `PreviewItemView`s; the component draws them.
 */
export type PreviewKindV = "picture" | "video" | "sound" | "text";

export type PreviewVersionView = {
  /** The take's generation id: what ✓ and ✕ act on. Absent on an item that is not a take (a script page). */
  genId?: string;
  /** "v2". */
  label: string;
  /** The picture, clip or sound to show; null while there is none. */
  url: string | null;
  /** A picture to draw for a version whose url is a clip or a sound (its frame), else the url itself when it is a still. */
  poster: string | null;
  status: CardStatus;
  /** Who approved it, by name, when the server said. */
  approvedBy?: string | null;
  /**
   * Whether ✓ and ✕ may act on this version: for a take, the card's own rule (take-model `judgeable`: finished, its picture here), so an upload never
   * carries marks, even beside a take that does. False on anything that is not a take.
   */
  judgeable: boolean;
};

export type PreviewTab = { id: string; label: string; text: string };

export type PreviewItemView = {
  id: string;
  title: string;
  kind: PreviewKindV;
  versions: PreviewVersionView[];
  /** Index of the version first shown (the shot's shown one). */
  shown: number;
  /** A page of words (kind text): shown whole, or by tab. */
  text?: string;
  tabs?: PreviewTab[];
  /** "Runway": the one place a model's name may show, as "Powered by …". */
  poweredBy?: string;
  /**
   * Whether any version of the card can be judged (for a shot: one of its takes is finished with its picture here). ✓ and ✕ then show only for a version
   * on screen whose own `judgeable` is true. False on anything that is not a take (a script, a sound demo).
   */
  canJudge: boolean;
  reasons: readonly string[];
};

export const clampIndex = (i: number, n: number) => (n <= 0 ? 0 : Math.max(0, Math.min(n - 1, Math.floor(i))));

/** "v2 of 3" when the item has more than one version, else "". */
export const versionOf = (item: Pick<PreviewItemView, "versions">, index: number) => (item.versions.length > 1 ? `${item.versions[clampIndex(index, item.versions.length)].label} of ${item.versions.length}` : "");

/**
 * Compare needs two versions to set side by side, each with its own media: pictures, clips (two players) or sounds (two players). A page of words has one
 * text for the card, not one a version, so it has no Compare.
 */
export const canCompare = (item: Pick<PreviewItemView, "versions" | "kind">) => item.kind !== "text" && item.versions.length > 1;

/** Compare puts the version before the one on screen (A) beside it (B); the first version is compared with itself's successor. */
export function compareSides(item: Pick<PreviewItemView, "versions">, index: number): { a: number; b: number } {
  const b = clampIndex(index, item.versions.length);
  return b > 0 ? { a: b - 1, b } : { a: 0, b: Math.min(1, item.versions.length - 1) };
}

/** ← / → through the cards of the step, wrapping at either end. */
export function stepId(ids: readonly string[], current: string, direction: 1 | -1): string {
  const at = ids.indexOf(current);
  if (at < 0 || !ids.length) return ids[0] ?? current;
  return ids[(at + direction + ids.length) % ids.length];
}

/** The word on ✓: what pressing it does to the version on screen. */
export const approveLabel = (item: Pick<PreviewItemView, "versions">, index: number) => {
  const v = item.versions[clampIndex(index, item.versions.length)];
  return v?.status === "approved" ? "Approved" : item.versions.length > 1 ? `Approve ${v?.label ?? ""}`.trim() : "Approve";
};

/** Whether ✓ and ✕ act on the version on screen: the card can be judged, and so can that version (its own `judgeable`). */
export const judgeVersion = (item: PreviewItemView, index: number): PreviewVersionView | null => {
  const v = item.versions[clampIndex(index, item.versions.length)];
  return item.canJudge && v && v.judgeable && v.genId && v.url && (v.status === "ready" || v.status === "approved" || v.status === "rejected") ? v : null;
};

/** What the reasons panel says when a reason is too long: the trail's own hint is about a reason that is too short. */
export const REASON_TOO_LONG = `Too long: ${REJECT_REASON_MAX} characters at most.`;

/** Why ✕'s reason cannot be sent, or null: too short (the trail's hint, "Say why…"), or too long (a chip and a full line can pass the limit). */
export function reasonProblem(reason: string): string | null {
  return cleanRejectReason(reason).length > REJECT_REASON_MAX ? REASON_TOO_LONG : rejectReasonProblem(reason);
}

/** "0:03 / 0:08". */
export function timeLabel(seconds: number, duration: number): string {
  const f = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, "0")}`;
  return `${f(seconds)} / ${f(duration)}`;
}

/** One frame back or forward, at the clip's frame rate (24 when unknown), kept inside the clip. */
export const stepFrame = (t: number, duration: number, direction: 1 | -1, fps = 24) => Math.max(0, Math.min(duration, t + direction / (fps > 0 ? fps : 24)));

/**
 * The bars a sound card draws: a fixed, repeatable shape for the take (the prototype's "drawn" waveform), not an analysis of the file. The same id always
 * gives the same bars, 12 to 100 percent tall.
 */
export function waveBars(seed: string, count = 40): number[] {
  let h = 2166136261;
  for (const ch of seed) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  const out: number[] = [];
  for (let i = 0; i < count; i++) { h = (Math.imul(h ^ (h >>> 15), 2246822519) + 374761393) >>> 0; out.push(12 + (h % 89)); }
  return out;
}

/** Where Download points for a version: the original file as an attachment. */
export const versionDownload = (v: Pick<PreviewVersionView, "url">) => (v.url ? downloadUrl(v.url) : null);

const statusOf = (v: ShotVersion): CardStatus => shotCardState({ shown: v, versions: [v] }).status;

/** A shot's takes as a preview item (the board's Shots step): its versions oldest first, opening on the one the board shows. */
export function previewItemOfShot(row: Pick<ShotTakes, "nodeId" | "title" | "versions" | "shown" | "frame">): PreviewItemView {
  const versions = row.versions.map((v): PreviewVersionView => ({
    genId: v.genId, label: v.label, url: v.url, poster: v.media === "image" ? v.url : row.frame?.kind === "image" ? row.frame.url : null, status: statusOf(v), approvedBy: v.approvedBy,
    judgeable: judgeable(v),
  }));
  const shownAt = row.shown ? row.versions.findIndex((v) => v.genId === row.shown!.genId) : -1;
  const media = row.shown?.media ?? row.versions[row.versions.length - 1]?.media ?? null;
  return {
    id: row.nodeId, title: row.title, kind: media === "video" ? "video" : media === "audio" ? "sound" : "picture", versions, shown: shownAt >= 0 ? shownAt : Math.max(0, versions.length - 1),
    canJudge: row.versions.some((v) => judgeable(v)), reasons: SHOT_REASONS,
  };
}
