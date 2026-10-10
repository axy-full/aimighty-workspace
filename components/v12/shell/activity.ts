import { changing, trayWhen, type TrayJob } from "@/lib/jobsTray";
import type { QueueItem } from "@/lib/control-room/queue";

/**
 * The header's Activity pill and its dropdown (docs/redesign/inventory.md § 5.4): what needs you (the approvals queue,
 * GET /api/control-room/approvals) and what is running (the jobs tray, GET /api/jobs?view=tray), across all boards or
 * the open one. Pure: rows are built from what the two routes sent (tests/unit/v12-header-model.spec.ts).
 */
export type ActivityScope = "all" | "board";

export type NeedsRow = { kind: "needs"; id: string; name: string; meta: string; draftId: string | null; item: QueueItem };
export type RunningRow = { kind: "running"; id: string; name: string; meta: string; draftId: string | null; job: TrayJob };
export type LookRow = { kind: "look"; id: string; name: string; meta: string; draftId: string | null; job: TrayJob };
export type ActivityGroups = { needs: NeedsRow[]; running: RunningRow[]; look: LookRow[] };

/** How long a failed or unconfirmed take stays under "Needs a look": a day, as the jobs tray keeps it. */
export const LOOK_MS = 24 * 3600_000;

/** "2 need you · 3 running", "3 running", "2 need you", or "Activity" when nothing waits or runs. */
export function activityLabel(needs: number, running: number): string {
  if (needs > 0 && running > 0) return `${needs} need you · ${running} running`;
  if (needs > 0) return `${needs} need you`;
  if (running > 0) return `${running} running`;
  return "Activity";
}

/** The dot: orange when anything needs you, blue and pulsing while something runs, quiet otherwise. */
export function activityTone(needs: number, running: number): "waiting" | "live" | "idle" {
  return needs > 0 ? "waiting" : running > 0 ? "live" : "idle";
}

/** "4 min so far", or "just started". */
export function sinceWords(job: Pick<TrayJob, "stage" | "createdAt" | "settledAt">, now: number): string {
  const age = trayWhen(job, now);
  return age === "just now" ? "just started" : `${age} so far`;
}

export function activityGroups(jobs: readonly TrayJob[], items: readonly QueueItem[], options: { scope: ActivityScope; draftId: string | null; now: number; heldWord: (job: TrayJob) => string | null }): ActivityGroups {
  const mine = (draftId: string | null) => options.scope === "all" || (options.draftId !== null && draftId === options.draftId);
  const needs: NeedsRow[] = items
    .filter((item) => mine(item.project.draftId))
    .map((item) => ({
      kind: "needs", id: item.id, name: item.title, draftId: item.project.draftId, item,
      meta: [item.project.name ?? item.where, item.note].filter(Boolean).join(" · "),
    }));
  const running: RunningRow[] = jobs
    .filter((job) => changing(job) && mine(job.draftId))
    .map((job) => {
      const held = options.heldWord(job);
      return {
        kind: "running", id: job.id, name: job.name, draftId: job.draftId, job,
        meta: [job.projectName ?? "Make", job.label, sinceWords(job, options.now), held ? `${held} held` : null].filter(Boolean).join(" · "),
      };
    });
  /* What today's Jobs pill offered and the frame would otherwise hide: a take that failed, or one whose outcome is not
     confirmed yet. Opened at its card, where Retry and Check again live. */
  const look: LookRow[] = jobs
    .filter((job) => (job.stage === "failed" || job.stage === "unconfirmed") && mine(job.draftId) && (job.settledAt == null || options.now - job.settledAt < LOOK_MS))
    .map((job) => ({
      kind: "look", id: job.id, name: job.name, draftId: job.draftId, job,
      meta: [job.projectName ?? "Make", job.label].filter(Boolean).join(" · "),
    }));
  return { needs, running, look };
}

/** The stages where the ledger has reserved a take's credits: it has started (lib/generationAdmission.ts reserves on start). */
const RESERVED_STAGES: ReadonlySet<TrayJob["stage"]> = new Set(["rendering", "confirming"]);

/**
 * "N held" only for credits the ledger really holds: a take that has started on Particl's own engines. A queued take
 * holds nothing yet: one waiting for a free slot carries the figure its start will reserve (lib/jobsTray.ts, the
 * release quote), which is a price, not a hold, so no figure is said for it. A connected account's figure is its
 * quote, not a hold.
 */
export function heldPrice<T>(job: Pick<TrayJob, "source" | "price" | "stage">, label: (price: NonNullable<TrayJob["price"]>) => T): T | null {
  if (!job.price || job.source === "account" || job.price.unit === "account-cr" || !RESERVED_STAGES.has(job.stage)) return null;
  return label(job.price);
}

/** Per board: what its tab's dot says (approvals waiting win over rendering). */
export function boardStates(jobs: readonly TrayJob[], items: readonly QueueItem[]): Map<string, "waiting" | "live"> {
  const states = new Map<string, "waiting" | "live">();
  for (const job of jobs) if (job.draftId && changing(job)) states.set(job.draftId, "live");
  for (const item of items) if (item.project.draftId) states.set(item.project.draftId, "waiting");
  return states;
}
