import { displayModelName } from "../models";

/*
 * The sample's plan, from what the ledger RECORDED for the production's own jobs (lead decisions 38 and 40). Nothing
 * here asks Atomik, reserves, charges or invents a figure: a take's price is the credits the ledger holds for that
 * job (its settled charge, or the quote it was reserved at while it still ran), and a take the ledger holds nothing
 * for has no price on the card. Pure: the server reads the rows (lib/demo/recorded.server.ts), this shapes them.
 *
 * The result is stream 4's `SampleStep[]`, the input of `samplePlanModel(steps, line)` (board/cards/plan/sample.ts):
 * "Make N shots", one step per shot, the fix allowance and the total all come from it. No `rig_agent_runs` row is
 * ever written, because that would fabricate an approval.
 */

/** One of the production's jobs, as the ledger and the take row record it. Vendor dollars are never read, so they are not here. */
export type RecordedJob = {
  id: string;
  kind: "video" | "image" | "audio" | string;
  model: string;
  /** The production's shot this take is filed under; null for a still, a look or a track. */
  shotId: string | null;
  version: number;
  /** The take's review mark is "approved". */
  approved: boolean;
  seconds: number | null;
  resolution: string | null;
  createdAt: number;
  /** The credits the ledger recorded for this job; null when it recorded nothing (a price is never guessed). */
  credits: number | null;
  /** True when `credits` is the settled charge; false when it is still the reservation (the quote). */
  settled: boolean;
};

export type SampleShotRow = { id: string; position: number };

/** Stream 4's step, structurally (board/cards/plan/sample.ts › SampleStep). */
export type SampleStep = { title: string; meta: string; credits: number; kind?: "take" | "still" };

export type SamplePlan = {
  /** One step per shot, in production order, each at its recorded price. */
  steps: SampleStep[];
  /** The shots whose chosen take the ledger holds no price for, left off the card. "Shot N". */
  unpriced: string[];
  /** Everything the ledger recorded across the production's jobs (looks, storyboard, every take and fix), in credits. */
  recorded: { settled: number; quoted: number };
};

const clean = (n: number | null | undefined): number | null => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null);

/** The take a shot's plan line stands for: its approved version (the latest of them), else its newest. */
export function chosenTake(jobs: readonly RecordedJob[]): RecordedJob | null {
  const ordered = [...jobs].sort((a, b) => a.version - b.version || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return [...ordered].reverse().find((j) => j.approved) ?? ordered.at(-1) ?? null;
}

/** "Seedance 2.5 · 5 s · 1080p": the engine's name as the app shows it, the take's own length and size. */
export function stepMeta(job: Pick<RecordedJob, "model" | "seconds" | "resolution">): string {
  const parts = [displayModelName(job.model)];
  if (job.seconds && job.seconds > 0) parts.push(`${Number.isInteger(job.seconds) ? job.seconds : Math.round(job.seconds * 10) / 10} s`);
  if (job.resolution) parts.push(job.resolution);
  return parts.join(" · ");
}

export function samplePlan(shots: readonly SampleShotRow[], jobs: readonly RecordedJob[]): SamplePlan {
  const steps: SampleStep[] = [];
  const unpriced: string[] = [];
  [...shots].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)).forEach((shot, i) => {
    const take = chosenTake(jobs.filter((j) => j.kind === "video" && j.shotId === shot.id));
    if (!take) return;
    const title = `Shot ${i + 1}`;
    const credits = clean(take.credits);
    if (credits === null) { unpriced.push(title); return; }
    steps.push({ title, meta: stepMeta(take), credits, kind: "take" });
  });
  let settled = 0, quoted = 0;
  for (const job of jobs) {
    const credits = clean(job.credits);
    if (credits === null) continue;
    if (job.settled) settled += credits; else quoted += credits;
  }
  return { steps, unpriced, recorded: { settled, quoted } };
}
