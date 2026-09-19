/**
 * The Atomik ACTIVITY log and the Library footer NEXT line, both derived from
 * real data (04 "Derived values — never hardcode these"). No seeded lines:
 * an empty project shows an empty log.
 *
 * Sources, merged newest first:
 *  - media jobs          GET /api/jobs?projectId=<production>&mine=1
 *  - pipeline runs       GET /api/pipelines?projectId=<production>
 *  - agent (text) jobs   GET /api/workbench/atomik?projectId=<draft>
 *  - this session's completed Atomik runs (the engine's `session`)
 */

import type { Plan } from "./plan-types";
import { formatCredits, type ActivityEntry, type EngineState } from "./run-engine";
import { planFor } from "./plans";

export type ActivityGeneration = {
  id: string;
  title: string | null;
  shotTitle?: string | null;
  prompt?: string | null;
  kind: string;
  status: string;
  creditsBilled: number | null;
  createdAt: number;
  updatedAt: number;
};

export type ActivityPipelineRun = {
  id: string;
  name: string;
  state: string;
  updatedAt: number;
};

export type ActivityAgentJob = {
  id: string;
  status: string;
  request: string;
  credits?: number | null;
  updatedAt?: number;
  createdAt?: number;
};

/** "just now", "6 min", "1 hr", "3 d" — same scale as the design's ACTIVITY meta. */
export function ago(at: number, now: number) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr`;
  return `${Math.round(h / 24)} d`;
}

const nameOf = (job: ActivityGeneration) =>
  job.title?.trim() ||
  job.shotTitle?.trim() ||
  (job.prompt?.trim() ? job.prompt.trim().slice(0, 48) : `${job.kind} take`);

const clip = (text: string, n = 60) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

export function activityFromJobs(jobs: ActivityGeneration[], now: number): ActivityEntry[] {
  return jobs.map((job) => {
    const name = nameOf(job);
    const cost =
      job.status === "succeeded" && job.creditsBilled != null
        ? formatCredits(job.creditsBilled, "cr")
        : null;
    const label =
      job.status === "succeeded"
        ? `Rendered ${name}`
        : job.status === "failed"
          ? `${name} failed`
          : job.status === "held"
            ? `${name} held`
            : job.status === "cancelled"
              ? `${name} cancelled`
              : `Rendering ${name}`;
    const meta = [
      ago(job.updatedAt, now),
      job.status === "failed" ? "not billed" : cost,
    ]
      .filter(Boolean)
      .join(" · ");
    return { id: `job:${job.id}`, label: clip(label), meta, at: job.updatedAt, source: "job" as const };
  });
}

const RUN_STATE: Record<string, string> = {
  draft: "drafted",
  awaiting_approval: "waiting on approval",
  running: "running",
  paused: "paused",
  needs_review: "needs review",
  blocked: "blocked",
  succeeded: "finished",
  cancelled: "cancelled",
};

export function activityFromRuns(runs: ActivityPipelineRun[], now: number): ActivityEntry[] {
  return runs.map((item) => ({
    id: `run:${item.id}`,
    label: clip(`Run ${item.name} ${RUN_STATE[item.state] ?? item.state}`),
    meta: ago(item.updatedAt, now),
    at: item.updatedAt,
    source: "pipeline" as const,
  }));
}

export function activityFromAgentJobs(jobs: ActivityAgentJob[], now: number): ActivityEntry[] {
  return jobs.flatMap((job) => {
    const at = job.updatedAt ?? job.createdAt;
    if (at == null) return [];
    const verb =
      job.status === "succeeded"
        ? "Planned"
        : job.status === "failed"
          ? "Planning failed:"
          : "Planning";
    const meta = [
      ago(at, now),
      job.status === "succeeded" && job.credits != null ? formatCredits(job.credits, "cr") : null,
      job.status === "failed" ? "not billed" : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return [{ id: `agent:${job.id}`, label: clip(`${verb} ${job.request}`), meta, at, source: "agent" as const }];
  });
}

/** Merge sources newest first, dropping duplicates by id. Session lines are re-aged against `now`. */
export function mergeActivity(
  session: ActivityEntry[],
  sources: ActivityEntry[][],
  now: number,
  limit = 5,
): ActivityEntry[] {
  const seen = new Set<string>();
  return [...session.map((entry) => ({ ...entry, meta: ago(entry.at, now) })), ...sources.flat()]
    .sort((a, b) => b.at - a.at)
    .filter((entry) => (seen.has(entry.id) ? false : (seen.add(entry.id), true)))
    .slice(0, limit);
}

/**
 * Read the three real feeds. A source that fails is left out and reported in
 * `errors`; nothing is filled in its place.
 */
export async function loadActivity(
  fetcher: typeof fetch,
  ids: { projectId: string | null; productionId: string | null },
  now = Date.now(),
): Promise<{ entries: ActivityEntry[][]; errors: string[] }> {
  const errors: string[] = [];
  const read = async <T,>(path: string): Promise<T | null> => {
    try {
      const response = await fetcher(path, { cache: "no-store" });
      if (!response.ok) throw new Error(`${path} ${response.status}`);
      return (await response.json()) as T;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      return null;
    }
  };
  const production = ids.productionId ? encodeURIComponent(ids.productionId) : null;
  const draft = ids.projectId ? encodeURIComponent(ids.projectId) : null;
  const [jobs, pipelines, agent] = await Promise.all([
    production
      ? read<{ generations: ActivityGeneration[] }>(`/api/jobs?projectId=${production}&mine=1&limit=20&sync=0`)
      : null,
    production ? read<{ runs: (ActivityPipelineRun & { context?: { projectId?: string } })[] }>(`/api/pipelines?projectId=${production}`) : null,
    draft ? read<{ jobs: ActivityAgentJob[] }>(`/api/workbench/atomik?projectId=${draft}`) : null,
  ]);
  return {
    entries: [
      activityFromJobs(jobs?.generations ?? [], now),
      activityFromRuns(
        (pipelines?.runs ?? []).filter((item) => item.context?.projectId === ids.productionId),
        now,
      ),
      activityFromAgentJobs(agent?.jobs ?? [], now),
    ],
    errors,
  };
}

/* ------------------------------------------------------------------ NEXT line */

export type NextLineData = {
  page: string;
  /** A render in flight on this project, from the real job feed. */
  rendering?: { name: string } | null;
  /** Shots ready to render (status ready/queued), from real shot data. Rig only. */
  readyShots?: { name: string }[];
};

/**
 * The Library footer NEXT sentence, in 04's priority order:
 * waiting price → running step → rendering → ready shots → plan title.
 */
export function nextLine(state: Pick<EngineState, "run">, data: NextLineData): string {
  const plan: Plan | null = planFor(data.page);
  const run = state.run && state.run.page === (plan?.page ?? data.page) ? state.run : null;

  if (run?.status === "waiting" && run.quote)
    return `Waiting on your approval — ${formatCredits(run.quote.credits, run.quote.unit)}.`;
  if (run?.status === "running" && plan) {
    const step = plan.steps[Math.min(run.i, plan.steps.length - 1)];
    return `${step.label}…`;
  }
  if (data.rendering) return `Rendering ${data.rendering.name}. Nothing else is blocked.`;
  const ready = plan?.page === "rig" ? (data.readyShots ?? []) : [];
  if (ready.length)
    return `${ready.length} ${ready.length === 1 ? "shot is" : "shots are"} ready to render. Start with ${ready[0].name}.`;
  if (plan) return `${plan.title} — ${plan.priceLabel.toLowerCase()}.`;
  return "Nothing waiting on this page.";
}
