import {
  CONNECTED_GENERATION_ENDPOINT, connectedRecoverable, connectedStatusRequest, parseConnectedJob, type ConnectedJob,
} from "@/lib/higgsfield-consumer/generation-client";

/**
 * Connected-account renders finish even when nobody is looking.
 *
 * A job submitted from Gen or a Business composer is polled by that view
 * while it is on screen; the poll (the route's `status` action) is also what
 * collects the finished original into Particl. Leave the view mid-render and
 * nothing polled it again, so a render the account had already charged for
 * never reached Takes. The collector is the shell's own poller: it lists the
 * open project's jobs (GET ?draftId=, the route's existing read) and keeps
 * reading every submitted one until it settles, whichever page is open.
 *
 * Never a paid call: `status` only reads the job, and the route leases each
 * provider read, so a view and the collector reading the same job cannot
 * double anything. A view that is polling its own job says so (watch), and
 * the collector leaves that job to it until the view lets go. The shell's
 * strip names the job a Generate composer is polling (show): the collector
 * leaves that one be too, and forgets it once the composer has settled and
 * announced it.
 */
export const COLLECT_POLL_MS = 20_000;
/** After a failed read (network, rate limit): wait this long before the next. */
export const COLLECT_BACKOFF_MS = 60_000;
/** A job the account has not accepted yet (dispatching, uncertain) is read this many times, then left for the next listing. */
export const COLLECT_UNSETTLED_POLLS = 6;

type Tracked = {
  draftId: string; nextAt: number; unsettled: number;
  /** Handed over by a view mid-submit: the server may not have seen the submit yet, so "quoted" is not final. */
  handed: boolean;
};
type Timer = unknown;

export type CollectorDeps = {
  /** A workspace-scoped fetch (the shell's X-Workbench-Scope). */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** A job this collector brought to completed or failed. */
  onSettled: (job: ConnectedJob) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
};

export class ConnectedCollector {
  private readonly jobs = new Map<string, Tracked>();
  private readonly watched = new Set<string>();
  /** The job the shell's strip shows in flight: a Generate composer is polling it. */
  private shown: string | null = null;
  private timer: Timer = null;
  private reading = false;
  /** A 401/403 (signed out, not the owner): nothing here can read jobs, so it stops asking. */
  private disabled = false;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => Timer;
  private readonly clearTimer: (timer: Timer) => void;

  constructor(private readonly deps: CollectorDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  /** The ids this collector is following (for tests and the shell). */
  tracking(): string[] {
    return [...this.jobs.keys()];
  }

  /** A view is polling this job itself: leave it alone until release(). */
  watch(id: string) {
    this.watched.add(id);
  }

  /** The view let go (it settled the job, or it unmounted): a job still in flight is followed from here. */
  release(draftId: string, job: Pick<ConnectedJob, "id" | "status"> | null) {
    if (!job) return;
    this.watched.delete(job.id);
    if (connectedRecoverable(job)) this.adopt(draftId, job.id, true);
    else this.jobs.delete(job.id);
    this.schedule();
  }

  /**
   * The strip's job: in flight, a composer is polling it, so it is not read
   * here; settled (done), the composer has announced it, so it is forgotten
   * without a second toast. Once the strip moves on while the job is still in
   * flight, it is read from here.
   */
  show(id: string | null, done: boolean) {
    if (done && id) this.jobs.delete(id);
    const next = done ? null : id;
    if (next === this.shown) return;
    this.shown = next;
    this.reschedule();
  }

  adopt(draftId: string, id: string, handed = false) {
    if (this.disabled) return;
    const tracked = this.jobs.get(id);
    if (tracked) { tracked.handed ||= handed; return; }
    this.jobs.set(id, { draftId, nextAt: this.now(), unsettled: 0, handed });
    this.schedule();
  }

  /** Read the project's saved jobs and follow every one that was submitted and has not settled. */
  async list(draftId: string): Promise<void> {
    if (this.disabled || !draftId) return;
    let response: Response;
    try {
      response = await this.deps.fetch(`${CONNECTED_GENERATION_ENDPOINT}?draftId=${encodeURIComponent(draftId)}`, { cache: "no-store" });
    } catch { return; }
    if (response.status === 401 || response.status === 403) { this.stop(); this.disabled = true; return; }
    if (!response.ok) return;
    const body = await response.json().catch(() => null) as { jobs?: unknown[] } | null;
    for (const raw of Array.isArray(body?.jobs) ? body.jobs : []) {
      let job: ConnectedJob;
      try { job = parseConnectedJob(raw, draftId); } catch { continue; }
      if (connectedRecoverable(job) && !this.watched.has(job.id)) this.adopt(draftId, job.id);
    }
  }

  stop() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.jobs.clear();
  }

  /** A job a view reads itself (watched, or the strip's) is not read here. */
  private leftToView(id: string) {
    return this.watched.has(id) || this.shown === id;
  }

  private reschedule() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.schedule();
  }

  private schedule() {
    if (this.timer !== null || this.disabled) return;
    const due = [...this.jobs].filter(([id]) => !this.leftToView(id)).map(([, job]) => job.nextAt);
    if (!due.length) return;
    const wait = Math.max(0, Math.min(...due) - this.now());
    this.timer = this.setTimer(() => { this.timer = null; void this.tick(); }, wait);
  }

  /** Read every job that is due, once, in turn. */
  async tick(): Promise<void> {
    if (this.reading || this.disabled) return;
    this.reading = true;
    try {
      for (const [id, tracked] of [...this.jobs]) {
        if (this.disabled) break;
        /* Stopped, settled or released since the loop began: not this loop's to read. */
        if (this.jobs.get(id) !== tracked || this.leftToView(id) || tracked.nextAt > this.now()) continue;
        await this.read(id, tracked);
      }
    } finally {
      this.reading = false;
      this.schedule();
    }
  }

  private async read(id: string, tracked: Tracked) {
    let response: Response;
    try {
      response = await this.deps.fetch(CONNECTED_GENERATION_ENDPOINT, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(connectedStatusRequest(tracked.draftId, id)),
      });
    } catch {
      tracked.nextAt = this.now() + COLLECT_BACKOFF_MS;
      return;
    }
    if (response.status === 401 || response.status === 403) { this.stop(); this.disabled = true; return; }
    const body = await response.json().catch(() => null) as { job?: unknown; pollAfterSeconds?: number } | null;
    /* The shell stopped this collector (another workspace, signed out) while the read was out. */
    if (this.jobs.get(id) !== tracked) return;
    if (!response.ok || !body?.job) {
      /* 404: the job is not this draft's any more; anything else is read again later. */
      if (response.status === 404) this.jobs.delete(id);
      else tracked.nextAt = this.now() + COLLECT_BACKOFF_MS;
      return;
    }
    let job: ConnectedJob;
    try { job = parseConnectedJob(body.job, tracked.draftId); } catch { this.jobs.delete(id); return; }
    if (job.status === "completed" || job.status === "failed") {
      this.jobs.delete(id);
      this.deps.onSettled(job);
      return;
    }
    /* A job handed over mid-submit may still read "quoted" until the server has taken the submit. */
    if (!connectedRecoverable(job) && !(tracked.handed && job.status === "quoted")) { this.jobs.delete(id); return; }
    /* Accepted jobs are read until they settle; one the account has not accepted is left after a few reads. */
    tracked.unsettled = job.status === "accepted" ? 0 : tracked.unsettled + 1;
    if (tracked.unsettled >= COLLECT_UNSETTLED_POLLS) { this.jobs.delete(id); return; }
    const after = typeof body.pollAfterSeconds === "number" && Number.isFinite(body.pollAfterSeconds) ? body.pollAfterSeconds * 1000 : 0;
    tracked.nextAt = this.now() + Math.max(COLLECT_POLL_MS, Math.min(after, 5 * 60_000));
  }
}

/* The shell's one collector (useConnectedCollector mounts it); views reach it through these. */
let shared: ConnectedCollector | null = null;
export function setSharedCollector(collector: ConnectedCollector | null) {
  shared = collector;
}
export function watchConnectedJob(id: string) {
  shared?.watch(id);
}
export function releaseConnectedJob(draftId: string, job: Pick<ConnectedJob, "id" | "status"> | null) {
  shared?.release(draftId, job);
}
export function showConnectedJob(id: string | null, done: boolean) {
  shared?.show(id, done);
}
export function listConnectedJobs(draftId: string): Promise<void> {
  return shared ? shared.list(draftId) : Promise.resolve();
}
