import {
  CONNECTED_GENERATION_ENDPOINT, connectedRecoverable, connectedStatusRequest, parseConnectedJob, type ConnectedJob,
} from "@/lib/higgsfield-consumer/generation-client";
import { checkingProblem, resumeGivesUp, resumeProblem } from "@/lib/higgsfield-consumer/resume";
import { presentTimeout } from "@/lib/poll";

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
 *
 * It is also what a page shows about those jobs (lib/shell/use-resumed-jobs.ts:
 * Gen's picked-up takes, the Ads and Image ads rows from earlier): every job it
 * has seen in flight, its latest state, whether it is still being read, and a
 * failed read in the product's words. The pages fetch nothing themselves, so
 * each job has one reader and one toast.
 *
 * Asking is bounded: a job the account has not accepted is read a few times;
 * a read that would fail the same way every time (a job made on an earlier
 * account connection, or one that is gone) stops at once; and a job given up
 * on — here, or by its own view — is taken up again by a later listing only
 * once the listing shows it moved. Its pace is its own (at least 20 s between
 * reads, the reply's pollAfterSeconds when longer), and like every status
 * read (lib/poll) it asks nothing while the tab is hidden or offline: the read
 * that fell due is made when the page is back.
 */
export const COLLECT_POLL_MS = 20_000;
/** After a failed read (network, rate limit): wait this long before the next. */
export const COLLECT_BACKOFF_MS = 60_000;
/** A job the account has not accepted yet (dispatching, uncertain) is read this many times, then left until a listing shows it moved. */
export const COLLECT_UNSETTLED_POLLS = 6;

type Tracked = {
  draftId: string; nextAt: number; unsettled: number;
  /** Handed over by a view mid-submit: the server may not have seen the submit yet, so "quoted" is not final. */
  handed: boolean;
};
type Timer = unknown;
/** What a page shows about one job: its latest state, whether it is still being read (here, or by its own view), and a failed read in the product's words. */
export type CollectedJob = { job: ConnectedJob; following: boolean; problem: string | null };

export type CollectorDeps = {
  /** A workspace-scoped fetch (the shell's X-Workbench-Scope). */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** A job this collector brought to completed or failed. */
  onSettled: (job: ConnectedJob) => void;
  /** What collected() shows has changed. */
  onChange?: () => void;
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
  /** A 401/403 (signed out, not the owner, or the account needs reconnecting): nothing here can read jobs, so it stops asking. */
  private disabled = false;
  /** Why it stopped, in the product's words, for the jobs it leaves. */
  private halted: string | null = null;
  /** Every job seen in flight (listed or read), with its latest state and the last failed read: what the pages show. */
  private readonly seen = new Map<string, { job: ConnectedJob; problem: string | null }>();
  /** Jobs no longer read, with the status they had then: a listing that shows the same status does not take one up again. */
  private readonly given = new Map<string, string>();
  private version = 0;
  private readonly shownFor = new Map<string, { version: number; jobs: CollectedJob[] }>();
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => Timer;
  private readonly clearTimer: (timer: Timer) => void;

  constructor(private readonly deps: CollectorDeps) {
    this.now = deps.now ?? Date.now;
    /* Never while the tab is hidden or offline (lib/poll's presentTimeout returns its own cancel). */
    this.setTimer = deps.setTimer ?? ((fn, ms) => presentTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((timer) => (timer as () => void)());
  }

  /** The ids this collector is following (for tests and the shell). */
  tracking(): string[] {
    return [...this.jobs.keys()];
  }

  /**
   * What the pages show for this project: every job seen in flight here, with
   * its latest state. The same array until something changes (a React store).
   */
  collected(draftId: string): readonly CollectedJob[] {
    const hit = this.shownFor.get(draftId);
    if (hit && hit.version === this.version) return hit.jobs;
    const jobs = [...this.seen.values()].filter(({ job }) => job.draftId === draftId).map(({ job, problem }) => {
      const open = connectedRecoverable(job);
      return {
        job,
        following: open && !this.disabled && (this.jobs.has(job.id) || this.leftToView(job.id)),
        problem: problem ?? (open && this.disabled ? this.halted : null),
      };
    });
    this.shownFor.set(draftId, { version: this.version, jobs });
    return jobs;
  }

  /** A view is polling this job itself (or reading it back): leave it alone until release() or unwatch(). */
  watch(id: string) {
    this.watched.add(id);
    this.changed();
  }

  /** The view let go (it settled the job, or it unmounted): a job still in flight is followed from here. */
  release(draftId: string, job: Pick<ConnectedJob, "id" | "status"> | null) {
    if (!job) return;
    this.watched.delete(job.id);
    if (connectedRecoverable(job)) {
      /* Its view gave up on it (a read that fails the same way every time): not taken up here either. */
      if (this.given.get(job.id) !== job.status) { this.given.delete(job.id); this.adopt(draftId, job.id, true); }
    }
    /* Settled by its view, which showed it: nothing left for a page to pick up. */
    else { this.jobs.delete(job.id); this.seen.delete(job.id); }
    this.changed();
    this.schedule();
  }

  /** A view's read of this job failed the way every read would: nobody reads it again until a listing shows it moved. */
  forgo(id: string, status: string) {
    this.jobs.delete(id);
    this.given.set(id, status);
    this.changed();
  }

  /**
   * A view stopped reading back a job it had not taken over: one this
   * collector follows is read from here again; `forget` drops one that was
   * never sent or that the server does not know.
   */
  unwatch(id: string, forget = false) {
    this.watched.delete(id);
    if (forget) { this.jobs.delete(id); this.seen.delete(id); }
    this.changed();
    this.reschedule();
  }

  /**
   * The strip's job: in flight, a composer is polling it, so it is not read
   * here; settled (done), the composer has announced it, so it is forgotten
   * without a second toast. Once the strip moves on while the job is still in
   * flight, it is read from here.
   */
  show(id: string | null, done: boolean) {
    if (done && id) { this.jobs.delete(id); this.seen.delete(id); this.changed(); }
    const next = done ? null : id;
    if (next === this.shown) return;
    this.shown = next;
    this.changed();
    this.reschedule();
  }

  adopt(draftId: string, id: string, handed = false) {
    if (this.disabled) return;
    const tracked = this.jobs.get(id);
    if (tracked) { tracked.handed ||= handed; return; }
    this.jobs.set(id, { draftId, nextAt: this.now(), unsettled: 0, handed });
    this.changed();
    this.schedule();
  }

  /** Read the project's saved jobs and follow every one that was submitted and has not settled. */
  async list(draftId: string): Promise<void> {
    if (this.disabled || !draftId) return;
    let response: Response;
    try {
      response = await this.deps.fetch(`${CONNECTED_GENERATION_ENDPOINT}?draftId=${encodeURIComponent(draftId)}`, { cache: "no-store" });
    } catch { return; }
    if (response.status === 401 || response.status === 403) { this.halt(null); return; }
    if (!response.ok) return;
    const body = await response.json().catch(() => null) as { jobs?: unknown[] } | null;
    for (const raw of Array.isArray(body?.jobs) ? body.jobs : []) {
      let job: ConnectedJob;
      try { job = parseConnectedJob(raw, draftId); } catch { continue; }
      if (connectedRecoverable(job)) {
        /* A listing is no news of a failed read: the last one's note stays until the next read. */
        this.seen.set(job.id, { job, problem: this.seen.get(job.id)?.problem ?? null });
        /* Given up on, and still as it was: asking again would get the same answer. */
        if (this.given.get(job.id) === job.status) continue;
        this.given.delete(job.id);
        if (!this.watched.has(job.id)) this.adopt(draftId, job.id);
      } else if (this.seen.has(job.id)) this.seen.set(job.id, { job, problem: null });
    }
    this.changed();
  }

  stop() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.jobs.clear();
    this.changed();
  }

  private halt(problem: string | null) {
    this.stop();
    this.disabled = true;
    this.halted = problem;
    this.changed();
  }

  private changed() {
    this.version++;
    this.deps.onChange?.();
  }

  /** A failed read, said on the job until its next good read. */
  private trouble(id: string, problem: string) {
    const seen = this.seen.get(id);
    if (seen) this.seen.set(id, { ...seen, problem });
  }

  /** Stop reading a job no read can move, or whose read would fail the same way again. */
  private giveUp(id: string, status: string, problem: string | null) {
    this.jobs.delete(id);
    this.given.set(id, status);
    if (problem) this.trouble(id, problem);
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
    } catch (error) {
      if (this.jobs.get(id) !== tracked) return;
      tracked.nextAt = this.now() + COLLECT_BACKOFF_MS;
      this.trouble(id, checkingProblem(error));
      this.changed();
      return;
    }
    const body = await response.json().catch(() => null) as { job?: unknown; pollAfterSeconds?: number; error?: string; code?: string } | null;
    if (response.status === 401 || response.status === 403) { this.halt(resumeProblem({ status: response.status, code: body?.code }, body?.error)); return; }
    /* The shell stopped this collector (another workspace, signed out) while the read was out. */
    if (this.jobs.get(id) !== tracked) return;
    if (!response.ok || !body?.job) {
      const failure = { status: response.status, code: body?.code };
      /* Gone (404: not this draft's any more), or made on an earlier account connection: every read would
         fail the same way, so asking stops. Anything else (an outage, a rate limit, full storage) is read again later. */
      if (resumeGivesUp(failure)) this.giveUp(id, this.seen.get(id)?.job.status ?? "", resumeProblem(failure, body?.error));
      /* Said in fixed words (lib/higgsfield-consumer/resume `checkingProblem`), never the route's own text. */
      else { tracked.nextAt = this.now() + COLLECT_BACKOFF_MS; this.trouble(id, checkingProblem(failure)); }
      this.changed();
      return;
    }
    let job: ConnectedJob;
    try { job = parseConnectedJob(body.job, tracked.draftId); } catch { this.jobs.delete(id); this.changed(); return; }
    /* Kept for the pages, except a handed-over submit the server has not taken yet. */
    if (job.status !== "quoted" || this.seen.has(id)) this.seen.set(id, { job, problem: null });
    if (job.status === "completed" || job.status === "failed") {
      this.jobs.delete(id);
      this.changed();
      this.deps.onSettled(job);
      return;
    }
    /* A job handed over mid-submit may still read "quoted" until the server has taken the submit. */
    if (!connectedRecoverable(job) && !(tracked.handed && job.status === "quoted")) { this.jobs.delete(id); this.changed(); return; }
    /* Accepted jobs are read until they settle; one the account has not accepted is left after a few reads. */
    tracked.unsettled = job.status === "accepted" ? 0 : tracked.unsettled + 1;
    if (tracked.unsettled >= COLLECT_UNSETTLED_POLLS) { this.giveUp(id, job.status, null); this.changed(); return; }
    const after = typeof body.pollAfterSeconds === "number" && Number.isFinite(body.pollAfterSeconds) ? body.pollAfterSeconds * 1000 : 0;
    tracked.nextAt = this.now() + Math.max(COLLECT_POLL_MS, Math.min(after, 5 * 60_000));
    this.changed();
  }
}

/* The shell's one collector (useConnectedCollector mounts it); views reach it through these. */
let shared: ConnectedCollector | null = null;
const listeners = new Set<() => void>();
const NONE: readonly CollectedJob[] = [];
/** Tell the pages showing collected jobs to read them again. */
export function announceCollected() {
  for (const listener of [...listeners]) listener();
}
export function setSharedCollector(collector: ConnectedCollector | null) {
  shared = collector;
  announceCollected();
}
/** useSyncExternalStore's subscribe for collectedJobs(). */
export function subscribeCollected(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
/** The open project's jobs as the shell's collector has them (none for a member, or before it is mounted). */
export function collectedJobs(draftId: string): readonly CollectedJob[] {
  return shared ? shared.collected(draftId) : NONE;
}
export function watchConnectedJob(id: string) {
  shared?.watch(id);
}
export function unwatchConnectedJob(id: string, forget = false) {
  shared?.unwatch(id, forget);
}
export function forgoConnectedJob(id: string, status: string) {
  shared?.forgo(id, status);
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
