import { csvCell } from "./csvCell";
import { failureLine, type FailureLine } from "./errors";
import { displayModelName, providerOf } from "./models";
import { PROVIDER_NAME, parseOutcome, takeFailure } from "./providerOutcome";
import { fromTenths } from "./runLimit";
import {
  COMMAND_STATES, DECIDERS, JOB_STATUSES, PRODUCTS, REFUND_STATUSES,
  type CommandState, type Decider, type JobProduct, type JobStatus, type RefundStatus,
} from "./quotedJobs/vocabulary";

/**
 * THE serializer for v30 jobs (docs/plans/v30-data-model.md § 4.4; PR A3). It is the only code that turns a stored
 * `quoted_jobs` row (with its take, provenance and receipt) into JSON, CSV or a sentence, and every v30 read model
 * (History, aggregates, CSV export, step receipts, error lines, Recreate) must go through it.
 *
 * Rule 1 of the owner's 17 Oct brief: an Agent job never exposes its engine. Not in the API, History, receipts, exports
 * or error messages. A Director job exposes what it chose.
 *   - decider 'agent': an allowlist of fields that cannot hold an engine (ids, the closed lists, the quote, the actual,
 *     timestamps, our own error sentence). No engine, model or provider; no settings, prompt or inputs. A failure line
 *     is told `provider: null`, so it says "The provider" and never a name, and carries no provider code or words.
 *     Recreate hands Director an EMPTY engine (brief rule 6). As a last layer, every free-text field of an Agent output
 *     that contains the engine's id or name (or the take's model, or its recorded engine, model or provider) is dropped.
 *   - decider 'director': the engine it chose (id and label), its settings, inputs and prompt.
 *
 * Money (CLAUDE.md § Pricing): no vendor cost ever leaves here, for either decider. The stored row carries none, and a
 * take's settings are an allowlist, so a cost a take's params happen to hold is never copied. The quote is in credits
 * for a workspace that pays in credits; a dollar quote (the house, where credits do not apply) is never sent to one.
 * The actual is the meter's, through its workspace replica `credit_receipts` (lib/creditReceipts.ts): never stored here.
 *
 * Pure: no database. The store (lib/quotedJobs/store.ts) reads the rows and hands them here.
 */

/** A stored job row as the store reads it: `quoted_jobs.*` plus the joined columns it aliases. */
export type StoredJob = Record<string, unknown>;
/** A stored command row as the store reads it: `agent_commands.*` plus `total_credits` and `job_count`. */
export type StoredCommand = Record<string, unknown>;

export type ViewOptions = {
  /** Does the viewing workspace pay in credits (lib/credits.ts creditsApply)? Then no dollar figure and no vendor billing state is sent. */
  credits: boolean;
};

export type JobQuote = { credits: number } | { usd: number };
export type JobEngine = { id: string; label: string };

export type PublicJob = {
  id: string;
  productionId: string | null;
  stepId: string | null;
  nodeId: string | null;
  commandId: string | null;
  decider: Decider;
  product: JobProduct;
  status: JobStatus;
  /** The price shown before it ran. */
  quote: JobQuote | null;
  /** What was charged, from the meter's receipt; null until there is one. */
  actual: { credits: number } | null;
  /** What the vendor did with a failed or cancelled job. Null for a workspace that pays in credits (see below) and until it fails. */
  refundStatus: RefundStatus | null;
  takeId: string | null;
  /** Our own sentence for a failure; never a vendor's words. */
  error: string | null;
  createdBy: string;
  quotedAt: number;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** Director only: what it chose. Always null for an Agent job. */
  engine: JobEngine | null;
  settings: Record<string, string | number | boolean> | null;
  inputs: { ports: string[]; cast: string[] } | null;
  prompt: string | null;
};

export type PublicCommand = {
  id: string;
  productionId: string | null;
  stepId: string | null;
  instruction: string;
  state: CommandState;
  /** The total shown before it ran. */
  quote: JobQuote | null;
  /** The sum of its jobs' receipts (never stored); null where credits do not apply. */
  total: { credits: number } | null;
  jobs: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
};

export type Recipe = { product: JobProduct; engine: string; settings: Record<string, string | number | boolean>; inputs: { ports: string[]; cast: string[] }; prompt: string };

/* ── reading a stored row ─────────────────────────────────────────────── */

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const oneOf = <T extends string>(list: readonly T[], v: unknown, fallback: T): T => (list.includes(v as T) ? (v as T) : fallback);
const json = (v: unknown): unknown => {
  if (typeof v !== "string" || !v) return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
};
const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/**
 * A take's settings anyone may see: the shape of the render, never who made it or what it cost. An allowlist, so a
 * credential fingerprint, a vendor cost or an engine name a take's params hold is never copied (none of these names
 * an engine).
 */
export const SETTING_KEYS = [
  "ratio", "resolution", "duration", "seed", "cameraFixed", "generateAudio", "task", "fps60", "draft",
  "characterOrientation", "outputFormat", "sourceResolution",
] as const;

function settingsOf(row: StoredJob): Record<string, string | number | boolean> {
  const params = record(json(row.take_params)) ?? {};
  const recorded = record(json(row.take_recorded));
  const setup = record(recorded?.setup) ?? {};
  const out: Record<string, string | number | boolean> = {};
  for (const key of SETTING_KEYS) {
    const v = params[key];
    if (typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) out[key] = v;
  }
  /* The Setup carried in (lib/setup.ts): angle, move, light … Keys are Setup's own names; values are option ids or words. */
  for (const [key, v] of Object.entries(setup)) if (/^[a-z][a-zA-Z]{0,31}$/.test(key) && typeof v === "string") out[`setup.${key}`] = v;
  return out;
}

function inputsOf(row: StoredJob): { ports: string[]; cast: string[] } {
  const recorded = record(json(row.take_recorded));
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return { ports: strings(recorded?.ports), cast: strings(recorded?.cast) };
}

function quoteOf(tenths: unknown, usd: unknown, opts: ViewOptions): JobQuote | null {
  const t = num(tenths);
  if (t !== null) return { credits: fromTenths(t) };
  const d = num(usd);
  /* A dollar quote is for the house alone (credits do not apply there); a workspace that pays in credits never gets one. */
  return d !== null && !opts.credits ? { usd: d } : null;
}

/** Everything that names this job's engine: its id, the take's model, the recorded engine, model and provider, and their names. */
function engineNeedles(row: StoredJob): string[] {
  const recorded = record(json(row.take_recorded));
  const outcome = parseOutcome(row.take_outcome);
  const ids = [str(row.engine), str(row.take_model), str(recorded?.engine), str(recorded?.model), str(recorded?.provider)].filter((x): x is string => !!x);
  const names = ids.flatMap((id) => [displayModelName(id), providerOf(id)]).filter((x): x is string => !!x && x !== "Engine");
  if (outcome) names.push(outcome.provider, PROVIDER_NAME[outcome.provider]);
  return [...new Set([...ids, ...names].map((n) => n.trim().toLowerCase()).filter((n) => n.length >= 3 && n !== "the engine"))];
}

/** The last layer for an Agent output: a free-text value naming the engine is dropped, never sent. */
function scrub<T>(value: T, needles: string[]): T {
  if (!needles.length) return value;
  const names = (s: string) => needles.some((n) => s.toLowerCase().includes(n));
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return names(v) ? null : v;
    if (Array.isArray(v)) return v.map(walk).filter((x) => x !== null);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k]) => !names(k)).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/* ── the views ────────────────────────────────────────────────────────── */

export const deciderOf = (row: StoredJob): Decider => oneOf(DECIDERS, row.decider, "agent");

/** One job as any v30 read model sends it. An unreadable decider is read as Agent: the stricter side. */
export function publicJob(row: StoredJob, opts: ViewOptions): PublicJob {
  const decider = deciderOf(row);
  const receipt = num(row.receipt_credits);
  const refund = str(row.refund_status);
  const base = {
    id: String(row.id),
    productionId: str(row.production_id),
    stepId: str(row.step_id),
    nodeId: str(row.node_id),
    commandId: str(row.command_id),
    decider,
    product: oneOf(PRODUCTS, row.product, "generation"),
    status: oneOf(JOB_STATUSES, row.status, "queued"),
    quote: quoteOf(row.quote_tenths, row.quote_usd, opts),
    actual: opts.credits && receipt !== null ? { credits: receipt } : null,
    /* What a vendor did with a job on the platform's key stays off a credit workspace's pages, as a take's billing does
       today (lib/providerOutcome.ts takeFailure): the credits it was charged (`actual`) say what it cost. */
    refundStatus: !opts.credits && refund && (REFUND_STATUSES as readonly string[]).includes(refund) ? (refund as RefundStatus) : null,
    takeId: str(row.take_id),
    error: str(row.error_public),
    createdBy: String(row.created_by ?? ""),
    quotedAt: Number(row.quoted_at),
    createdAt: Number(row.created_at),
    startedAt: num(row.started_at),
    finishedAt: num(row.finished_at),
  };
  if (decider === "agent") {
    const view: PublicJob = { ...base, engine: null, settings: null, inputs: null, prompt: null };
    return { ...view, error: scrub(view.error, engineNeedles(row)) };
  }
  const engine = str(row.engine);
  return {
    ...base,
    engine: engine ? { id: engine, label: displayModelName(engine) } : null,
    settings: row.take_id ? settingsOf(row) : null,
    inputs: row.take_id ? inputsOf(row) : null,
    prompt: str(row.take_prompt),
  };
}

export const publicJobs = (rows: StoredJob[], opts: ViewOptions): PublicJob[] => rows.map((row) => publicJob(row, opts));

/**
 * The failure line for a job whose take failed, from the take's own outcome. An Agent job's line is built with no
 * provider, no provider code and no provider words, so it says "The provider" and our own sentence only.
 */
export function jobErrorLine(row: StoredJob, opts: ViewOptions): FailureLine | null {
  const status = oneOf(JOB_STATUSES, row.status, "queued");
  if (status !== "failed" && status !== "cancelled") return null;
  const failure = takeFailure(parseOutcome(row.take_outcome), { credits: opts.credits });
  if (deciderOf(row) === "agent") {
    const line = failureLine({ ...failure, provider: null, code: failure.kind, message: null }, { cancelled: status === "cancelled" });
    return scrub(line, engineNeedles(row));
  }
  return failureLine(failure, { cancelled: status === "cancelled" });
}

/** What Recreate starts from. An Agent job hands Director an empty engine (brief rule 6); a Director job its own. */
export function recreateRecipe(row: StoredJob): Recipe {
  const product = oneOf(PRODUCTS, row.product, "generation");
  const recipe: Recipe = { product, engine: "", settings: settingsOf(row), inputs: inputsOf(row), prompt: str(row.take_prompt) ?? "" };
  if (deciderOf(row) === "director") return { ...recipe, engine: str(row.engine) ?? "" };
  const clean = scrub(recipe, engineNeedles(row));
  return { ...clean, engine: "", prompt: clean.prompt ?? "" };
}

/** The CSV of jobs, one row each, every cell through csvCell. The engine column is empty on every Agent row. */
export const JOB_CSV_HEADER = ["job", "production", "step", "decider", "product", "status", "quote_credits", "quote_usd", "credits", "refund_status", "engine", "engine_id", "prompt", "created_at"] as const;

export function jobCsv(rows: StoredJob[], opts: ViewOptions): string {
  const lines = [JOB_CSV_HEADER.join(",")];
  for (const row of rows) {
    const job = publicJob(row, opts);
    const credits = job.quote && "credits" in job.quote ? job.quote.credits : null;
    const usd = job.quote && "usd" in job.quote ? job.quote.usd : null;
    lines.push([
      job.id, job.productionId, job.stepId, job.decider, job.product, job.status, credits, usd, job.actual?.credits ?? null,
      job.refundStatus, job.engine?.label ?? null, job.engine?.id ?? null, job.prompt, new Date(job.createdAt).toISOString(),
    ].map((cell) => csvCell(cell)).join(","));
  }
  return lines.join("\n") + "\n";
}

/** One Agent command: the instruction, its quoted total, and the sum of its jobs' receipts. Commands carry no engine. */
export function publicCommand(row: StoredCommand, opts: ViewOptions): PublicCommand {
  const total = num(row.total_credits);
  return {
    id: String(row.id),
    productionId: str(row.production_id),
    stepId: str(row.step_id),
    instruction: String(row.instruction ?? ""),
    state: oneOf(COMMAND_STATES, row.state, "quoted"),
    quote: quoteOf(row.quote_tenths, row.quote_usd, opts),
    total: opts.credits ? { credits: total ?? 0 } : null,
    jobs: num(row.job_count) ?? 0,
    createdBy: String(row.created_by ?? ""),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}
