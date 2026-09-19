/**
 * Types shared by the Atomik plan registry (`plans.ts`) and the run engine
 * (`run-engine.ts`). No runtime code lives here except the page-id lists.
 *
 * The one rule this file exists to enforce: a paid dispatch executor can only
 * be called with an `ApprovedQuote`, and the only code able to produce one is
 * the run engine's `approve()` (see `run-engine.ts`, `mintApproved`). The brand
 * symbol below is declared, not exported, so no other module can spell the
 * type without a cast, and the engine re-checks every token at runtime.
 */

export type WorkspaceSuite = "particl" | "atomik" | "moleculr" | "subatomik";

/** Page ids of the redesigned workspace (brief, "Architecture contract"). */
export const WORKSPACE_PLAN_PAGES = {
  particl: ["brief", "boards", "cast", "astra", "rig", "takes", "edit", "deliver"],
  atomik: ["agent", "runs", "generate", "recipes", "builds", "skills", "models", "approvals", "budget"],
  moleculr: ["marketing"],
  subatomik: ["motion", "swap", "sources", "compare", "history"],
} as const satisfies Record<WorkspaceSuite, readonly string[]>;

export type WorkspacePageId =
  (typeof WORKSPACE_PLAN_PAGES)[WorkspaceSuite][number];

export type PlanStepKind =
  | "read"
  | "compute"
  | "quote"
  | "gate"
  | "dispatch"
  | "file";

/** Where a step's work actually happens. Every runnable step names one. */
export type BackendRef = {
  method: "GET" | "POST" | "PUT" | "LOCAL";
  /** API path as the route file serves it, or the pure lib function for LOCAL. */
  path: string;
};

/** Credits as the customer sees them: Particl credits, or the connected account's own credits. */
export type CreditUnit = "cr" | "connected";

/** One priced request inside a quote. Dispatch sends exactly these fields back. */
export type QuotePart = {
  /** Exact credits approved for this request (sent back as maxCredits or the route's equivalent). */
  credits: number;
  /** Route-issued proof of the priced inputs (fingerprint, quoteDigest, quote id...). */
  fingerprint: string;
  /** The route's own quote id where it issues one (pipelines, connected account). */
  quoteId?: string;
  /** The exact request body that was priced; dispatch re-sends it unchanged. */
  body: Record<string, unknown>;
  /** Free-form route data the dispatch needs (e.g. connected wallet id, pipeline revision). */
  meta?: Record<string, unknown>;
};

export type LiveQuote = {
  unit: CreditUnit;
  /** Sum of parts; the figure on the gate card and the Approve button. */
  credits: number;
  parts: QuotePart[];
  /** Epoch ms. The engine caps this at quotedAt + QUOTE_MAX_AGE_MS. */
  expiresAt: number;
  quotedAt: number;
  /** Stable key of the inputs that were priced; a different key at approve time means "input changed". */
  inputKey: string;
  /** One line explaining the charge, built from the quote itself (no fixture numbers). */
  line: string;
};

/**
 * What a gate's quote executor returns. The engine adds the total, the input
 * key and the timestamps, and caps the lifetime, so a plan cannot mislabel them.
 */
export type GateQuote = {
  unit: CreditUnit;
  parts: QuotePart[];
  /** Server-stated expiry (epoch ms), or null when the route states none. */
  expiresAt: number | null;
  line: string;
};

declare const APPROVED: unique symbol;

/**
 * A quote the user approved in this run. Only `run-engine.ts` mints these; a
 * dispatch executor's signature requires one, so a paid call cannot be
 * written without going through the gate.
 */
export type ApprovedQuote = Readonly<LiveQuote> & {
  readonly [APPROVED]: true;
  readonly runId: string;
};

/**
 * Project facts a plan may cite. Every field is optional: a plan's copy uses a
 * count only when the caller supplied it from real data, never a default.
 */
export type PlanData = {
  projectName?: string | null;
  /** Scenes in the saved script. */
  scenes?: number;
  /** Shots on the project and those ready to render (status ready/queued). */
  shots?: { id: string; name: string; status: string }[];
  /** Takes / library items (uploads + generations) on the project. */
  takes?: number;
  /** Settled Particl credits across the project's jobs. */
  settledCredits?: number;
  /** Connected-account sources the user selected on a Subatomik page. */
  sources?: number;
  /** Pipeline runs visible to the user. */
  runs?: number;
  /** Whether the project has a saved script / brief (Brief & Script picks its mode). */
  hasScript?: boolean;
};

/**
 * Everything a plan needs from the page that runs it. `request` is the page's
 * current, user-edited request for the paid pages (a shot list, a Subatomik
 * form, a marketing variant set). The engine reads the context again at every
 * step, so an edit between quote and approve is detected.
 */
export type PlanContext = {
  /** Workbench project (draft) id — the `project` in the /workspace URL. */
  projectId: string | null;
  /** The production the draft maps to (jobs, pipelines, rig elements, selects). */
  productionId?: string | null;
  data: PlanData;
  request?: PlanRequest | null;
  /** The page's scoped fetch (workspace/actor headers already attached). */
  fetch: typeof fetch;
  /** Wait between real job-status polls; injectable for tests. */
  wait?: (ms: number) => Promise<void>;
  /** Idempotency / request ids; defaults to crypto.randomUUID. */
  newId?: () => string;
};

/** A request body a page has already built for one of the existing routes. */
export type NamedBody = { name: string; body: Record<string, unknown> };

/**
 * The page's current request for the plans that dispatch work. Each shape is
 * exactly what the existing route takes; the plans never invent fields.
 */
export type PlanRequest = {
  /** Boards: /api/generate bodies for image engines, one per board. */
  boards?: NamedBody[];
  /** Rig: /api/generate bodies, one per ready shot. */
  shots?: NamedBody[];
  /** Edit & Sound: /api/audio (or /api/audio/dub) bodies, one per stem. */
  stems?: (NamedBody & { route?: "/api/audio" | "/api/audio/dub" })[];
  /** Marketing: /api/generate bodies carrying `marketing`, one per variant. */
  variants?: NamedBody[];
  /** Subatomik: the connected-account form input (source, references, resolution, prompt). */
  motion?: Record<string, unknown>;
  swap?: Record<string, unknown>;
  /** Atomik Generate: the connected-account generation input. */
  generation?: Record<string, unknown>;
  /** Astra: the saved scene's digest (astraSceneDigest) and source. */
  astra?: { sourceDigest: string; source?: "scene" | "native" };
  /** Brief & Script: development options. */
  development?: {
    kind?: "idea" | "screenplay" | "adfilm";
    model?: string;
    instructions?: string;
  };
  /** Atomik agent: what to ask for (defaults to planning the rest of the project). */
  agent?: { request?: string; role?: string };
  /** Compare: the connected-account job to compare against its source. */
  compare?: { jobId?: string };
};

/** Scratch space a run carries between its steps (a read step's result, a draft id). */
export type RunIO = Record<string, unknown>;

export type StepOutcome = {
  /** Optional replacement for the step's detail once it has run (e.g. "3 found"). */
  detail?: string;
  io?: RunIO;
};

export type CallExecutor = {
  type: "call";
  backend: BackendRef;
  run: (ctx: PlanContext, io: RunIO) => Promise<StepOutcome>;
};

export type GateExecutor = {
  type: "gate";
  backend: BackendRef;
  /** Obtain a fresh live quote. Must not dispatch anything. */
  quote: (ctx: PlanContext, io: RunIO) => Promise<GateQuote>;
  /** The inputs the quote priced, from the current context; compared at approve time. */
  inputKey: (ctx: PlanContext, io: RunIO) => string;
};

export type DispatchExecutor = {
  type: "dispatch";
  backend: BackendRef;
  dispatch: (
    ctx: PlanContext,
    io: RunIO,
    approved: ApprovedQuote,
  ) => Promise<StepOutcome>;
};

export type StepExecutor = CallExecutor | GateExecutor | DispatchExecutor;

export type PlanStep = {
  label: string;
  kind: PlanStepKind;
  detail: (ctx: PlanContext, io: RunIO) => string;
  executor: StepExecutor;
};

export type Runnable = { ok: true } | { ok: false; reason: string };

export type Plan = {
  page: WorkspacePageId;
  suite: WorkspaceSuite;
  title: string;
  line: string;
  /** "Free · text model", "Quote at gate"... never a fixed price. */
  priceLabel: string;
  doneLine: (ctx: PlanContext, io: RunIO) => string;
  steps: PlanStep[];
  /** Paid plans only. */
  paid: boolean;
  /** Whether completing the run marks the page complete (Rig waits for its renders). */
  completesPage: boolean;
  runnable: (ctx: PlanContext) => Runnable;
  /**
   * For non-runnable plans: the backend that would have to exist. Also shown
   * in the PR report table. Empty for runnable plans.
   */
  missingBackend?: string;
};
