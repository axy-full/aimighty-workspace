/**
 * The board tab's progress ring (redesign P3; prototype README A: "the board tab shows a progress ring"): how far along
 * the work a board has running is, and about how long is left, from the jobs tray. No engine reports a percentage, so a
 * take's share is the same honest figure its card's bar shows: its time so far over the engine's typical time, capped at
 * 90% (lib/v12/renderState.ts BAR_CAP). The tray row does not name the engine, so the typical time is the kind's
 * (lib/v12/typicalTimeDefaults.ts). A board's ring is the average of its running takes. Pure.
 */
import { changing, type TrayJob } from "../jobsTray";
import { BAR_CAP, fmtTimeLeft } from "./renderState";
import { defaultTypical } from "./typicalTimeDefaults";

export type BoardRing = { pct: number; leftMs: number; count: number; words: string };

export function boardRings(jobs: readonly TrayJob[], now: number): Map<string, BoardRing> {
  const by = new Map<string, { pcts: number[]; left: number }>();
  for (const job of jobs) {
    if (!job.draftId || !changing(job)) continue;
    const typical = defaultTypical(null, job.kind);
    const elapsed = Math.max(0, now - job.createdAt);
    const pct = Math.min(BAR_CAP, Math.max(0.04, (BAR_CAP * elapsed) / Math.max(1, typical.highMs)));
    const left = Math.max(0, typical.highMs - elapsed);
    const entry = by.get(job.draftId) ?? { pcts: [], left: 0 };
    entry.pcts.push(pct);
    entry.left = Math.max(entry.left, left);
    by.set(job.draftId, entry);
  }
  return new Map([...by].map(([id, e]) => {
    const pct = e.pcts.reduce((a, b) => a + b, 0) / e.pcts.length;
    return [id, { pct, leftMs: e.left, count: e.pcts.length, words: `Rendering · ${fmtTimeLeft(e.left)}` }];
  }));
}

/** "about 2 min left" for a take the tray shows in flight, by the kind's typical time (the tray row does not name the engine); null once it is past it. */
export function jobTimeLeft(job: Pick<TrayJob, "kind" | "createdAt">, now: number): string | null {
  const left = defaultTypical(null, job.kind).highMs - Math.max(0, now - job.createdAt);
  return left > 0 ? fmtTimeLeft(left) : null;
}
