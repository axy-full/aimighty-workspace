import { isFinished, shotTakes, type ShotVersion } from "@/components/graphite/board/cards/take/take-model";
import type { BoardCard, BoardSource } from "@/lib/board/types";
import { latestRound, type BoardRound } from "@/lib/v12/rounds";

/** One take as the compare shows it. */
export type CompareSide = { genId: string; url: string; media: "image" | "video"; label: string; engine: string; at: number };
export type CompareShot = { shot: number; title: string; r1: CompareSide | null; r2: CompareSide | null };
export type RoundVariant = "changed" | "cut" | "deliver";
export type RoundCardData = { variant: RoundVariant; round: BoardRound; board: string; shots: number; compare: CompareShot[] };

const sideOf = (v: ShotVersion | undefined): CompareSide | null =>
  v && v.url && (v.media === "image" || v.media === "video") ? { genId: v.genId, url: v.url, media: v.media, label: v.label, engine: v.engine, at: v.createdAt } : null;

/**
 * The cards of the newest client round (redesign P2-c): "what changed" on the Storyboard stage, Compare R1 / R2 and the share
 * in Cut, the share in Deliver. R1 is the take each shot had when the plan was approved (kept in the round); R2 is the shot's
 * newest finished take since. Pure.
 */
export function deriveRounds(src: Pick<BoardSource, "kind" | "project" | "library">): BoardCard[] {
  if (src.kind !== "studio") return [];
  const round = latestRound(src.project.boardRounds);
  if (!round) return [];
  const rows = shotTakes(src.project, src.library);
  const compare: CompareShot[] = round.changes.map((c) => {
    const row = rows.find((r) => r.index === c.shot);
    const first = row?.versions.find((v) => v.genId === round.before[String(c.shot)]);
    const later = row?.versions.filter((v) => isFinished(v) && v.createdAt >= round.at).at(-1);
    return { shot: c.shot, title: row ? row.title : `Shot ${c.shot}`, r1: sideOf(first), r2: sideOf(later) };
  });
  const base = { round, board: src.project.name, shots: rows.length, compare };
  const card = (variant: RoundVariant, region: "storyboard" | "cut" | "deliver"): BoardCard => ({
    id: `round:${variant}`, kind: "round", region, order: 9500, state: "done", summary: `Round ${round.n} · ${round.changes.length} changed`, data: { variant, ...base } satisfies RoundCardData,
  });
  return [card("changed", "storyboard"), card("cut", "cut"), card("deliver", "deliver")];
}
