import { STUDIO_GROUP } from "@/lib/board/regions";
import type { BoardCard, BoardSource, GroupData } from "@/lib/board/types";
import { validateSequence, type Project } from "@/lib/workbench/studio";
import type { LibraryEntry } from "@/lib/workspace/library";
import { assetStill, type CastStill } from "../cast/cast-model";
import { clock, shotListState, shotTakes, type ShotTakes } from "../take/take-model";
import { specRows, type SpecRow } from "../deliver/spec-check";

/*
 * The Cut and Deliver region (README § 3.1 frame i), derived from today's data and nothing else. Pure: no React.
 *
 * - The cut is the edit's own sequence (`project.shots`, the clips Edit & Sound plays and exports), in order. A clip
 *   is "Shot N · vK" when the take it holds is one of a Rig shot's takes, else the clip's own name. It counts as an
 *   approved take when that take is approved in the library (the rule Edit & Sound uses).
 * - A shot with no clip in the cut is said to be waiting, in the Shots region's own words (needs review, rendering…).
 * - The cut is complete when every shot has its approved take in the cut. Until then the delivery checks read
 *   "pending": they are not answered for a cut that is not finished (DECISIONS 39 e).
 */

export type CutClip = {
  id: string;
  /** "Shot 2 · v2", or the clip's own name. */
  label: string;
  /** "Shot 2 v2" for the list; the same words without the separator. */
  short: string;
  seconds: number;
  still: CastStill | null;
  approved: boolean;
  shot: number | null;
};
export type CutWaiting = { shot: number; word: string };
export type CutData = {
  clips: CutClip[];
  approved: number;
  seconds: number;
  waiting: CutWaiting[];
  complete: boolean;
  aspect: string;
  fps: number;
  /** Why the sequence cannot be rendered or exported as it is (the validator's words), or null. */
  problem: string | null;
};

export const secondsWords = (s: number) => `${Number.isInteger(s) ? s : Math.round(s * 10) / 10} s`;

/** The words that say why the sequence cannot be rendered yet, or null. Pure: the same check the exporters run. */
export function sequenceProblem(project: Project): string | null {
  try { validateSequence(project); return null; } catch (cause) { return cause instanceof Error ? cause.message : "The sequence cannot be rendered."; }
}

export function cutOf(project: Project, rows: readonly ShotTakes[], library: readonly LibraryEntry[]): CutData {
  const assets = new Map([...project.assets, ...(project.sharedAssets ?? [])].map((a) => [a.id, a] as const));
  const approvedGen = new Set(library.flatMap((e) => (e.asset.origin === "generation" && e.asset.value.reviewState === "approved" ? [e.asset.value.id] : [])));
  const where = new Map<string, { row: ShotTakes; label: string }>();
  for (const row of rows) for (const v of row.versions) where.set(v.genId, { row, label: v.label });
  const fps = Math.max(1, project.fps);
  const inCut = new Set<number>();
  const clips: CutClip[] = project.shots.map((s) => {
    const asset = assets.get(s.assetId);
    const at = asset?.generationId ? where.get(asset.generationId) : undefined;
    if (at) inCut.add(at.row.index);
    const name = (asset?.name || s.name || "Clip").trim();
    return {
      id: s.id, label: at ? `Shot ${at.row.index} · ${at.label}` : name, short: at ? `Shot ${at.row.index} ${at.label}` : name, seconds: s.duration / fps, still: assetStill(asset),
      approved: Boolean(asset?.generationId && approvedGen.has(asset.generationId)), shot: at?.row.index ?? null,
    };
  });
  /* A clip holding the first version reads "Shot 1", not "Shot 1 · v1": a version is said only once there is more than one. */
  for (const clip of clips) {
    const at = clip.shot ? rows.find((r) => r.index === clip.shot) : undefined;
    if (at && at.versions.length < 2) { clip.label = `Shot ${at.index}`; clip.short = clip.label; }
  }
  const waiting: CutWaiting[] = rows.filter((r) => !inCut.has(r.index)).map((r) => ({ shot: r.index, word: shotListState(r)?.word.toLowerCase() ?? "no take yet" }));
  const approved = clips.filter((c) => c.approved).length;
  const complete = rows.length > 0 ? waiting.length === 0 && clips.length > 0 && clips.every((c) => c.approved) : clips.length > 0 && clips.every((c) => c.approved);
  return {
    clips, approved, seconds: clips.reduce((n, c) => n + c.seconds, 0), waiting, complete, aspect: project.aspect, fps: project.fps,
    problem: project.shots.length ? sequenceProblem(project) : "Add takes to the cut first.",
  };
}

/** "2 approved takes · 0:10". */
export function cutMeta(cut: Pick<CutData, "approved" | "seconds">): string {
  return `${cut.approved.toLocaleString("en-US")} approved ${cut.approved === 1 ? "take" : "takes"} · ${clock(cut.seconds)}`;
}

/** The delivery rows for this cut (see spec-check.ts). */
export const deliverRows = (cut: CutData): SpecRow[] => specRows({ aspect: cut.aspect, fps: cut.fps, seconds: cut.seconds, complete: cut.complete, empty: cut.clips.length === 0 });

export const CUT_GROUP = STUDIO_GROUP.cut;
export const CUT_CARD = "cut:the-cut";
export const DELIVER_CARD = "deliver:master";

export type CutCardData = { cut: CutData };

/** The Cut and Deliver cards, once there is a shot or a clip to say something about. */
export function deriveCut(src: Pick<BoardSource, "kind" | "project" | "library">): BoardCard[] {
  if (src.kind !== "studio") return [];
  const rows = shotTakes(src.project, src.library);
  const cut = cutOf(src.project, rows, src.library);
  if (!rows.length && !cut.clips.length) return [];
  const meta = cutMeta(cut);
  const group: GroupData = { title: "Cut and deliver", meta, columns: 2 };
  const state = cut.complete ? "done" : cut.clips.length ? "working" : "empty";
  return [
    { id: CUT_GROUP, kind: "group", region: "cut", order: -1, state: "empty", summary: meta, data: group },
    { id: CUT_CARD, kind: "cut", region: "cut", order: 0, group: CUT_GROUP, state, summary: meta, data: { cut } satisfies CutCardData },
    { id: DELIVER_CARD, kind: "deliver", region: "deliver", order: 1, group: CUT_GROUP, state: cut.complete ? "done" : "empty", summary: cut.complete ? "Ready to render" : "Waiting on the cut", data: { cut } satisfies CutCardData },
  ];
}
