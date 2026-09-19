/**
 * The Atomik run engine: a framework-agnostic state machine that runs one
 * plan at a time against real backends (04-interactions-and-state.md, "Run
 * lifecycle", made real).
 *
 *   start(page)   not running → run from step 0 (or resume from run.i on the
 *                 same page); running on the same page → pause.
 *   step          advances only when its executor's promise resolves. There
 *                 is no fake tick. Read/compute steps that resolve instantly
 *                 are held for at most VISUAL_PACING_MS so the step list is
 *                 legible — visual pacing only, labelled as such below.
 *   gate          obtains a fresh live quote, then stops at "waiting".
 *   approve()     re-validates the quote (expiry, inputs); stale → re-quote,
 *                 stay waiting with "Quote refreshed — …"; fresh → mint an
 *                 ApprovedQuote and continue.
 *   decline()     drops the run: "Run held. Nothing was dispatched."
 *   done          completed[page], the plan's done line prepended to the
 *                 session activity as "just now".
 *
 * Paid dispatch cannot happen without approval by construction: the dispatch
 * executor's signature requires an ApprovedQuote, the only function that
 * creates one (`mintApproved`) is private to this module, and every token is
 * re-checked at runtime (minted here, same run, same quote, not expired,
 * inputs unchanged) immediately before the executor is called.
 *
 * The handoff's two real bugs are designed out: all mutable run machinery
 * (current step index, the approved token, the in-flight loop) lives on the
 * engine instance, never in a closure over React state; and state
 * transitions are plain assignments followed by a notify — there are no
 * updater functions for a framework to replay or discard, so no side effect
 * can be lost or doubled.
 */

import type {
  ApprovedQuote,
  GateExecutor,
  GateQuote,
  LiveQuote,
  Plan,
  PlanContext,
  RunIO,
} from "./plan-types";

/** Upper bound of the visual pacing for instantaneous read/compute steps. */
export const VISUAL_PACING_MS = 300;
/** A quote is never trusted for longer than this, whatever the route says. */
export const QUOTE_MAX_AGE_MS = 5 * 60_000;
/** A quote this close to expiry is treated as expired at approve/dispatch time. */
export const QUOTE_EXPIRY_MARGIN_MS = 10_000;

export const DECLINED_TOAST = "Run held. Nothing was dispatched.";

export type RunStatus = "running" | "waiting" | "paused" | "done" | "failed";

export type RunView = {
  id: string;
  page: string;
  /** Index of the current step (== steps.length when done). */
  i: number;
  status: RunStatus;
  approved: boolean;
  /** The live quote at the gate, if one has been obtained. */
  quote: LiveQuote | null;
  /** True while the gate is fetching (or refreshing) its quote. */
  quoting: boolean;
  /** True while a paid dispatch request is in flight. */
  dispatching: boolean;
  /** True once any paid dispatch has been sent in this run. */
  dispatched: boolean;
  /** Visible message, e.g. "Quote refreshed — price changed from 18 cr to 21 cr." */
  notice: string | null;
  error: string | null;
  /** Step details reported by executors once they ran (index → text). */
  details: Record<number, string>;
};

export type ActivityEntry = {
  id: string;
  label: string;
  meta: string;
  at: number;
  source: "session" | "job" | "pipeline" | "agent";
};

export type EngineState = {
  run: RunView | null;
  completed: Record<string, true>;
  /** Runs completed in this session, newest first. */
  session: ActivityEntry[];
  toast: string | null;
  /** Why the last start() was refused (not runnable, another run dispatching). */
  notice: string | null;
};

export type EngineOptions = {
  plans: Partial<Record<string, Plan>>;
  context: () => PlanContext;
  now?: () => number;
  /** Timer used only for VISUAL_PACING_MS; injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  newId?: () => string;
};

export type StartResult =
  | { ok: true; action: "started" | "resumed" | "paused" | "waiting" }
  | { ok: false; reason: string };

export type ApproveResult =
  | { ok: true }
  | { ok: false; reason: "not-waiting" | "refreshed" | "quote-failed" };

export function formatCredits(credits: number, unit: LiveQuote["unit"]) {
  const n = credits.toLocaleString("en-US");
  return unit === "cr" ? `${n} cr` : `${n} ${credits === 1 ? "credit" : "credits"}`;
}

/* ---------------------------------------------------------------- tokens */

const MINTED = new WeakSet<object>();

function mintApproved(quote: LiveQuote, runId: string): ApprovedQuote {
  const token = Object.freeze({ ...quote, parts: quote.parts.map((part) => Object.freeze({ ...part })), runId }) as unknown as ApprovedQuote;
  MINTED.add(token);
  return token;
}

/** True only for a token minted by approve() in this module. */
export function isApprovedQuote(value: unknown): value is ApprovedQuote {
  return typeof value === "object" && value !== null && MINTED.has(value);
}

/* ------------------------------------------------------------ the engine */

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

let counter = 0;
const defaultId = () => `run-${Date.now().toString(36)}-${(counter += 1)}`;

export class AtomikRunEngine {
  private state: EngineState = {
    run: null,
    completed: {},
    session: [],
    toast: null,
    notice: null,
  };
  private readonly listeners = new Set<() => void>();
  private io: RunIO = {};
  private token: ApprovedQuote | null = null;
  /** Id of the run whose step loop is currently awaiting an executor. */
  private looping: string | null = null;
  private readonly plans: EngineOptions["plans"];
  private context: () => PlanContext;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly newId: () => string;

  constructor(options: EngineOptions) {
    this.plans = options.plans;
    this.context = options.context;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.newId = options.newId ?? defaultId;
  }

  /* ------------------------------------------------------------ store API */

  getState = (): EngineState => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Swap the context source (the React hook keeps it pointed at the latest render). */
  setContext(context: () => PlanContext) {
    this.context = context;
  }

  private set(patch: Partial<EngineState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  private patchRun(runId: string, patch: Partial<RunView>) {
    const run = this.state.run;
    if (!run || run.id !== runId) return false;
    this.set({ run: { ...run, ...patch } });
    return true;
  }

  private current(runId: string) {
    const run = this.state.run;
    return run && run.id === runId ? run : null;
  }

  clearToast = () => {
    if (this.state.toast !== null) this.set({ toast: null });
  };

  clearNotice = () => {
    if (this.state.notice !== null) this.set({ notice: null });
  };

  /** The run to show on `page` (the panel shows a run only on its own page). */
  runFor(page: string) {
    const run = this.state.run;
    return run && run.page === page ? run : null;
  }

  /* ------------------------------------------------------------- commands */

  start = (page: string): StartResult => {
    const plan = this.plans[page];
    if (!plan) return this.refuse("Nothing to run on this page.");
    const run = this.state.run;

    if (run && run.page === page) {
      if (run.status === "running") {
        this.patchRun(run.id, { status: "paused" });
        return { ok: true, action: "paused" };
      }
      if (run.status === "waiting") return { ok: true, action: "waiting" };
      if (run.status === "paused" || run.status === "failed") {
        const runnable = plan.runnable(this.context());
        if (!runnable.ok) return this.refuse(runnable.reason);
        this.patchRun(run.id, { status: "running", error: null, notice: null });
        this.set({ notice: null });
        void this.advance(run.id);
        return { ok: true, action: "resumed" };
      }
      // done → run again from the top.
    }

    const runnable = plan.runnable(this.context());
    if (!runnable.ok) return this.refuse(runnable.reason);

    if (run && run.page !== page && run.status !== "done") {
      if (run.dispatching)
        return this.refuse(
          `${this.plans[run.page]?.title ?? "Another run"} is dispatching. Wait for it to finish.`,
        );
    }
    let toast = this.state.toast;
    if (run && run.page !== page && run.status !== "done" && run.status !== "failed")
      toast = run.dispatched
        ? `${this.plans[run.page]?.title ?? "The previous run"} stopped. Its dispatched jobs continue.`
        : `${this.plans[run.page]?.title ?? "The previous run"} held. Nothing was dispatched.`;

    const id = this.newId();
    this.io = {};
    this.token = null;
    this.set({
      notice: null,
      toast,
      run: {
        id,
        page,
        i: 0,
        status: "running",
        approved: false,
        quote: null,
        quoting: false,
        dispatching: false,
        dispatched: false,
        notice: null,
        error: null,
        details: {},
      },
    });
    void this.advance(id);
    return { ok: true, action: "started" };
  };

  pause = () => {
    const run = this.state.run;
    if (run && run.status === "running") this.patchRun(run.id, { status: "paused" });
  };

  approve = async (): Promise<ApproveResult> => {
    const run = this.state.run;
    if (!run || run.status !== "waiting" || !run.quote || run.quoting)
      return { ok: false, reason: "not-waiting" };
    const plan = this.plans[run.page];
    const gate = plan ? gateOf(plan) : null;
    if (!plan || !gate) return { ok: false, reason: "not-waiting" };

    const ctx = this.context();
    const stale = this.staleness(run.quote, gate.executor, ctx);
    if (stale) {
      const refreshed = await this.requote(run.id, gate.executor, ctx, run.quote);
      return { ok: false, reason: refreshed ? "refreshed" : "quote-failed" };
    }
    this.token = mintApproved(run.quote, run.id);
    this.patchRun(run.id, {
      approved: true,
      status: "running",
      notice: null,
      error: null,
    });
    void this.advance(run.id);
    return { ok: true };
  };

  decline = () => {
    const run = this.state.run;
    if (!run || run.approved || run.dispatched) return false;
    if (run.status !== "waiting" && !run.quoting) return false;
    this.token = null;
    this.io = {};
    this.set({ run: null, toast: DECLINED_TOAST });
    return true;
  };

  /* --------------------------------------------------------------- the loop */

  private refuse(reason: string): StartResult {
    this.set({ notice: reason });
    return { ok: false, reason };
  }

  private staleness(quote: LiveQuote, gate: GateExecutor, ctx: PlanContext) {
    if (this.now() >= quote.expiresAt - QUOTE_EXPIRY_MARGIN_MS) return "expired";
    if (gate.inputKey(ctx, this.io) !== quote.inputKey) return "changed";
    return null;
  }

  private async fetchQuote(gate: GateExecutor, ctx: PlanContext): Promise<LiveQuote> {
    const inputKey = gate.inputKey(ctx, this.io);
    const raw: GateQuote = await gate.quote(ctx, this.io);
    const quotedAt = this.now();
    if (!raw || !Array.isArray(raw.parts) || raw.parts.length === 0)
      throw new Error("The quote came back empty. Nothing was dispatched.");
    for (const part of raw.parts) {
      if (!Number.isInteger(part.credits) || part.credits < 0)
        throw new Error("The quote came back without a credit price. Nothing was dispatched.");
      if (typeof part.fingerprint !== "string" || part.fingerprint.length === 0)
        throw new Error("The quote came back without a fingerprint. Nothing was dispatched.");
    }
    const credits = raw.parts.reduce((sum, part) => sum + part.credits, 0);
    const cap = quotedAt + QUOTE_MAX_AGE_MS;
    return {
      unit: raw.unit,
      parts: raw.parts,
      credits,
      quotedAt,
      expiresAt: raw.expiresAt == null ? cap : Math.min(raw.expiresAt, cap),
      inputKey,
      line: raw.line,
    };
  }

  /** Replace a stale quote; the run stays waiting and must be approved again. */
  private async requote(
    runId: string,
    gate: GateExecutor,
    ctx: PlanContext,
    previous: LiveQuote | null,
  ) {
    this.token = null;
    this.patchRun(runId, { quoting: true, approved: false, status: "waiting" });
    try {
      const quote = await this.fetchQuote(gate, ctx);
      if (!this.current(runId)) return false;
      const before = previous ? formatCredits(previous.credits, previous.unit) : null;
      const after = formatCredits(quote.credits, quote.unit);
      const notice =
        before === null
          ? null
          : before === after
            ? `Quote refreshed — price unchanged at ${after}. Approve again to continue.`
            : `Quote refreshed — price changed from ${before} to ${after}.`;
      this.patchRun(runId, { quote, quoting: false, status: "waiting", notice, error: null });
      return true;
    } catch (error) {
      this.patchRun(runId, {
        quote: null,
        quoting: false,
        status: "failed",
        error: message(error),
      });
      return false;
    }
  }

  private finish(runId: string, plan: Plan) {
    const run = this.current(runId);
    if (!run) return;
    const label = plan.doneLine(this.context(), this.io);
    this.token = null;
    const at = this.now();
    this.set({
      run: { ...run, i: plan.steps.length, status: "done", dispatching: false },
      completed: plan.completesPage
        ? { ...this.state.completed, [plan.page]: true }
        : this.state.completed,
      session: [
        { id: `${runId}:done`, label, meta: "just now", at, source: "session" as const },
        ...this.state.session,
      ].slice(0, 20),
      toast: label,
    });
  }

  private async advance(runId: string): Promise<void> {
    if (this.looping === runId) return; // the in-flight loop picks the change up
    this.looping = runId;
    try {
      for (;;) {
        const run = this.current(runId);
        if (!run || run.status !== "running") return;
        const plan = this.plans[run.page];
        if (!plan) return;
        if (run.i >= plan.steps.length) {
          this.finish(runId, plan);
          return;
        }
        const index = run.i;
        const step = plan.steps[index];
        const executor = step.executor;
        const ctx = this.context();
        let detail: string | undefined;

        try {
          if (executor.type === "gate") {
            if (!run.approved || !this.token) {
              this.patchRun(runId, { quoting: true, approved: false });
              const quote = await this.fetchQuote(executor, ctx);
              if (!this.current(runId)) return;
              this.patchRun(runId, { quote, quoting: false, status: "waiting" });
              return; // stop here: nothing moves until approve() or decline()
            }
            detail = `Approved ${formatCredits(this.token.credits, this.token.unit)}`;
          } else if (executor.type === "dispatch") {
            const gateIndex = plan.steps.findIndex((item) => item.executor.type === "gate");
            const gate = gateIndex >= 0 ? (plan.steps[gateIndex].executor as GateExecutor) : null;
            const token = this.token;
            const valid =
              gate !== null &&
              run.approved &&
              isApprovedQuote(token) &&
              token.runId === runId &&
              run.quote !== null &&
              token.inputKey === run.quote.inputKey &&
              token.credits === run.quote.credits &&
              !this.staleness(token, gate, ctx);
            if (!valid) {
              // Never dispatch on a stale or missing approval: back to the gate.
              this.token = null;
              if (!gate || gateIndex < 0) throw new Error("This plan has no approval gate. Nothing was dispatched.");
              this.patchRun(runId, { i: gateIndex, approved: false });
              await this.requote(runId, gate, ctx, run.quote);
              return;
            }
            this.patchRun(runId, { dispatching: true, dispatched: true });
            try {
              const outcome = await executor.dispatch(ctx, this.io, token);
              if (outcome.io) this.io = { ...this.io, ...outcome.io };
              detail = outcome.detail;
            } finally {
              this.patchRun(runId, { dispatching: false });
            }
            // One approval pays for one dispatch.
            this.token = null;
          } else {
            const started = this.now();
            const outcome = await executor.run(ctx, this.io);
            if (outcome.io) this.io = { ...this.io, ...outcome.io };
            detail = outcome.detail;
            if (step.kind === "read" || step.kind === "compute") {
              // VISUAL PACING ONLY: an instantaneous read/compute is held for
              // at most VISUAL_PACING_MS so the user can see it tick. No
              // progress is invented; the step already completed for real.
              const left = VISUAL_PACING_MS - (this.now() - started);
              if (left > 0) await this.sleep(Math.min(left, VISUAL_PACING_MS));
            }
          }
        } catch (error) {
          const current = this.current(runId);
          if (current && current.dispatched && executor.type === "dispatch") this.token = null;
          if (current)
            this.patchRun(runId, {
              status: "failed",
              quoting: false,
              dispatching: false,
              error: message(error),
            });
          return;
        }

        const current = this.current(runId);
        if (!current) return;
        const details = detail ? { ...current.details, [index]: detail } : current.details;
        // After a dispatch the approval is spent; a later resume re-gates.
        const approved = executor.type === "dispatch" ? false : current.approved;
        this.set({ run: { ...current, i: index + 1, details, approved } });
        // A pause during the step keeps its result and stops before the next.
      }
    } finally {
      if (this.looping === runId) this.looping = null;
    }
  }
}

function gateOf(plan: Plan) {
  const index = plan.steps.findIndex((step) => step.executor.type === "gate");
  if (index < 0) return null;
  return { index, executor: plan.steps[index].executor as GateExecutor };
}

function message(error: unknown) {
  return error instanceof Error && error.message
    ? error.message
    : "The step failed. Nothing further was dispatched.";
}
