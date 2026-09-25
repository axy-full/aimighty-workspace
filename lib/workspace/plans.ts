/**
 * The Atomik plan registry: one plan per workspace page (23 pages).
 *
 * Every step names the real route it calls. A plan whose work has no backend
 * today is registered with `runnable → {ok:false, reason:"Not runnable yet — …"}`
 * and `missingBackend`, and its steps' executors refuse to run; it never
 * animates progress. Paid plans stop at a gate whose price is a live quote
 * from the route that will charge it, and their dispatch executors take the
 * ApprovedQuote only `run-engine.ts` can mint.
 *
 * Copy rules (brief decision 5, 04 "Derived values"): no vendor or competitor
 * names, no fixture counts or prices. A count appears only when it comes
 * from the page's data or from what a step actually read.
 */

import {
  bodies,
  call,
  follow,
  idempotencyKey,
  newId,
  plural,
  shortHash,
  stableKey,
} from "./plan-helpers";
import type {
  ApprovedQuote,
  BackendRef,
  CallExecutor,
  DispatchExecutor,
  GateExecutor,
  GateQuote,
  NamedBody,
  Plan,
  PlanContext,
  PlanStep,
  PlanStepKind,
  QuotePart,
  RunIO,
  Runnable,
  StepOutcome,
  WorkspacePageId,
  WorkspaceSuite,
} from "./plan-types";
import { WORKSPACE_PLAN_PAGES } from "./plan-types";

/** Same lifetime the product already gives a Particl quote (lib/quote.ts QUOTE_TTL_MS). */
export const PARTICL_QUOTE_TTL_MS = 120_000;

const OK: Runnable = { ok: true };
const notYet = (why: string): Runnable => ({ ok: false, reason: `Not runnable yet — ${why}` });

/* ------------------------------------------------------------ builders */

function step(
  label: string,
  kind: PlanStepKind,
  detail: PlanStep["detail"] | string,
  executor: PlanStep["executor"],
): PlanStep {
  return {
    label,
    kind,
    detail: typeof detail === "string" ? () => detail : detail,
    executor,
  };
}

const run = (
  backend: BackendRef,
  fn: (ctx: PlanContext, io: RunIO) => Promise<StepOutcome>,
): CallExecutor => ({ type: "call", backend, run: fn });

const local = (
  name: string,
  fn: (ctx: PlanContext, io: RunIO) => StepOutcome,
): CallExecutor => ({
  type: "call",
  backend: { method: "LOCAL", path: name },
  run: async (ctx, io) => fn(ctx, io),
});

/** Executor for a step whose backend does not exist. It refuses, never pretends. */
const missing = (what: string): CallExecutor => ({
  type: "call",
  backend: { method: "LOCAL", path: `missing: ${what}` },
  run: async () => {
    throw new Error(`Not runnable yet — ${what}.`);
  },
});

const needProject = (ctx: PlanContext): Runnable =>
  ctx.projectId ? OK : notYet("open a project first.");
const needProduction = (ctx: PlanContext): Runnable =>
  ctx.productionId ? OK : notYet("this project has no production yet.");

const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);

/* ------------------------------------------- Particl generation (Boards, Rig, Marketing) */

type GenerateQuote = {
  estimatedCredits: number;
  price: number;
  unit: "cr" | "usd";
  fingerprint: string;
};

/** POST /api/generate/quote for each body; the quote forces refine:false, so the body sent back does too. */
function generationGate(
  list: (ctx: PlanContext) => NamedBody[],
  line: (parts: QuotePart[], ctx: PlanContext) => string,
): GateExecutor {
  return {
    type: "gate",
    backend: { method: "POST", path: "/api/generate/quote" },
    inputKey: (ctx) => stableKey(list(ctx)),
    quote: async (ctx): Promise<GateQuote> => {
      const items = list(ctx);
      if (!items.length) throw new Error("Nothing to price. Nothing was dispatched.");
      const parts: QuotePart[] = [];
      for (const item of items) {
        const body = { ...item.body, refine: false };
        const quote = await call<GenerateQuote>(ctx, "/api/generate/quote", { body });
        parts.push({
          credits: quote.estimatedCredits,
          fingerprint: quote.fingerprint,
          body,
          meta: { name: item.name },
        });
      }
      return {
        unit: "cr",
        parts,
        expiresAt: Date.now() + PARTICL_QUOTE_TTL_MS,
        line: line(parts, ctx),
      };
    },
  };
}

type Admitted = { id: string; status: string; held?: boolean };

/** POST /api/generate once per approved part, with exactly its maxCredits and quoteFingerprint. */
function generationDispatch(prefix: string, noun: string): DispatchExecutor {
  return {
    type: "dispatch",
    backend: { method: "POST", path: "/api/generate" },
    dispatch: async (ctx, _io, approved: ApprovedQuote) => {
      const admitted: Admitted[] = [];
      for (const part of approved.parts) {
        const result = await call<Admitted>(ctx, "/api/generate", {
          body: { ...part.body, maxCredits: part.credits, quoteFingerprint: part.fingerprint },
          headers: { "Idempotency-Key": idempotencyKey(prefix, part, approved) },
        });
        admitted.push({ id: result.id, status: result.status, held: result.held });
      }
      const held = admitted.filter((item) => item.held || item.status === "held").length;
      return {
        detail: held
          ? `${plural(admitted.length - held, noun)} sent · ${held} held`
          : `${plural(admitted.length, noun)} sent`,
        io: { admitted },
      };
    },
  };
}

/** GET /api/jobs/[id] once per admitted job: file what the server says, not a guess. */
const fileJobs = (noun: string): CallExecutor =>
  run({ method: "GET", path: "/api/jobs/[id]" }, async (ctx, io) => {
    const admitted = (io.admitted as Admitted[] | undefined) ?? [];
    const states: Record<string, number> = {};
    for (const job of admitted) {
      const { generation } = await call<{ generation: { status: string } }>(
        ctx,
        `/api/jobs/${encodeURIComponent(job.id)}`,
      );
      states[generation.status] = (states[generation.status] ?? 0) + 1;
    }
    const summary = Object.entries(states)
      .map(([state, n]) => `${n} ${state}`)
      .join(" · ");
    return {
      detail: summary || `No ${noun}s filed`,
      io: { filed: states },
    };
  });

const partsLine = (parts: QuotePart[], noun: string, tail: string) =>
  `${plural(parts.length, noun)}, priced one by one. ${tail}`;

/* --------------------------------------------------------------- audio (Edit & Sound) */

type AudioQuote = { estimatedCredits: number; price: number; unit: string };

const stemsOf = (ctx: PlanContext) =>
  (ctx.request?.stems ?? [])
    .filter((stem) => bodies([stem]).length === 1)
    .map((stem) => ({
      name: stem.name,
      body: stem.body,
      route: stem.route === "/api/audio/dub" ? ("/api/audio/dub" as const) : ("/api/audio" as const),
    }));

/*
 * The audio routes enforce the approved price through maxCredits only; they
 * issue no fingerprint. The part's fingerprint is therefore a local hash of
 * the exact body and price, used for the input check and the Idempotency-Key.
 */
const audioGate: GateExecutor = {
  type: "gate",
  backend: { method: "POST", path: "/api/audio (quoteOnly)" },
  inputKey: (ctx) => stableKey(stemsOf(ctx)),
  quote: async (ctx) => {
    const stems = stemsOf(ctx);
    if (!stems.length) throw new Error("No stems to price. Nothing was dispatched.");
    const parts: QuotePart[] = [];
    for (const stem of stems) {
      const quote = await call<AudioQuote>(ctx, stem.route, {
        body: { ...stem.body, quoteOnly: true },
      });
      parts.push({
        credits: quote.estimatedCredits,
        fingerprint: shortHash(`${stem.route}|${stableKey(stem.body)}|${quote.estimatedCredits}`),
        body: stem.body,
        meta: { name: stem.name, route: stem.route },
      });
    }
    return {
      unit: "cr",
      parts,
      expiresAt: Date.now() + PARTICL_QUOTE_TTL_MS,
      line: `${parts.map((part) => String(part.meta?.name ?? "Stem")).join(", ")}. Priced per generation; failed generations are not billed.`,
    };
  },
};

const audioDispatch: DispatchExecutor = {
  type: "dispatch",
  backend: { method: "POST", path: "/api/audio" },
  dispatch: async (ctx, _io, approved) => {
    const admitted: Admitted[] = [];
    for (const part of approved.parts) {
      const route = String(part.meta?.route ?? "/api/audio");
      const result = await call<Admitted>(ctx, route, {
        body: { ...part.body, maxCredits: part.credits },
        headers: { "Idempotency-Key": idempotencyKey("ws-audio", part, approved) },
      });
      admitted.push({ id: result.id, status: result.status, held: result.held });
    }
    return { detail: `${plural(admitted.length, "stem")} sent`, io: { admitted } };
  },
};

/* ---------------------------------------- connected account (Motion, Swap, Generate) */

type ConsumerJob = {
  id: string;
  status: string;
  quoteCredits: number | null;
  quoteExpiresAt: number | null;
  workspaceId: string | null;
  workspaceName?: string | null;
  input?: Record<string, unknown>;
  result?: { original?: { asset?: { url?: string } } } | null;
  originalAvailable?: boolean;
};

function connectedGate(
  route: string,
  input: (ctx: PlanContext) => Record<string, unknown> | null,
  line: (input: Record<string, unknown>, job: ConsumerJob) => string,
): GateExecutor {
  return {
    type: "gate",
    backend: { method: "POST", path: `${route} {action:"quote"}` },
    inputKey: (ctx) => stableKey(input(ctx)),
    quote: async (ctx) => {
      const value = input(ctx);
      if (!value || !ctx.projectId) throw new Error("Nothing to price. Nothing was dispatched.");
      const { job } = await call<{ job: ConsumerJob }>(ctx, route, {
        body: { action: "quote", draftId: ctx.projectId, input: value, idempotencyKey: newId(ctx) },
      });
      if (job.status !== "quoted" || job.quoteCredits == null || !job.workspaceId)
        throw new Error("The connected account did not return a price. Nothing was dispatched.");
      return {
        unit: "connected",
        parts: [
          {
            credits: job.quoteCredits,
            fingerprint: job.id,
            quoteId: job.id,
            body: { draftId: ctx.projectId, id: job.id },
            meta: { workspaceId: job.workspaceId, workspaceName: job.workspaceName ?? null },
          },
        ],
        expiresAt: job.quoteExpiresAt,
        line: line(value, job),
      };
    },
  };
}

/** Submit exactly the approved wallet and credits; the route refuses anything else (approval_changed). */
function connectedDispatch(route: string, noun: string): DispatchExecutor {
  return {
    type: "dispatch",
    backend: { method: "POST", path: `${route} {action:"submit"}` },
    dispatch: async (ctx, _io, approved) => {
      const [part] = approved.parts;
      const { job } = await call<{ job: ConsumerJob }>(ctx, route, {
        body: {
          action: "submit",
          draftId: part.body.draftId,
          id: part.quoteId,
          workspaceId: part.meta?.workspaceId,
          credits: part.credits,
        },
      });
      if (job.status === "failed") throw new Error(`The ${noun} was refused. Failed jobs are not billed.`);
      return { detail: job.status, io: { job } };
    },
  };
}

const connectedStatus = (route: string): CallExecutor =>
  run({ method: "POST", path: `${route} {action:"status"}` }, async (ctx, io) => {
    const job = io.job as ConsumerJob | undefined;
    if (!job || !ctx.projectId) return { detail: "No job to follow" };
    const { job: next } = await call<{ job: ConsumerJob }>(ctx, route, {
      body: { action: "status", draftId: ctx.projectId, id: job.id },
    });
    return { detail: next.status, io: { job: next } };
  });

const refsOf = (input: Record<string, unknown>) => count(input.references);

/* -------------------------------------------------------------- the registry */

const GENJUTSU = "/api/higgsfield/consumer/genjutsu";
const CONNECTED_GENERATION = "/api/higgsfield/consumer/generation";
const SHORTS = "/api/higgsfield/consumer/shorts";

const boards = (ctx: PlanContext) => bodies(ctx.request?.boards);
const shots = (ctx: PlanContext) => bodies(ctx.request?.shots);
const variants = (ctx: PlanContext) => bodies(ctx.request?.variants);

const genjutsuInput =
  (key: "motion" | "swap", variant: "motion-transfer" | "object-swap") =>
  (ctx: PlanContext): Record<string, unknown> | null => {
    const value = ctx.request?.[key];
    return value && typeof value === "object" ? { ...value, variant } : null;
  };
const motionInput = genjutsuInput("motion", "motion-transfer");
const swapInput = genjutsuInput("swap", "object-swap");
/** The Shorts page's current input, supplied through the page-request seam. */
const shortsInput = (ctx: PlanContext): Record<string, unknown> | null => {
  const value = ctx.request?.shorts;
  return value && typeof value === "object" ? { ...value } : null;
};
const generationInput = (ctx: PlanContext): Record<string, unknown> | null => {
  const value = ctx.request?.generation;
  return value && typeof value === "object" ? { ...value } : null;
};

const hasSource = (input: Record<string, unknown> | null) =>
  !!input && !!input.source && typeof input.source === "object";

type DevelopmentQuote = {
  estimateCredits: number;
  estimateUsd?: number;
  sourceHash: string;
  chunks: number;
};
type DevelopmentJob = {
  id: string;
  requestId: string;
  status: string;
  result?: { scenes?: unknown[]; ideas?: unknown[] } | null;
  error?: string | null;
};
type AtomikQuote = { estimateCredits: number; estimateUsd?: number };
type AtomikJob = {
  id: string;
  requestId: string;
  status: string;
  plan?: { steps?: string[] } | null;
  error?: string | null;
};
type PipelineRun = {
  id: string;
  revision: number;
  state: string;
  name: string;
  context: { projectId: string };
  stages: { definition: { id: string; kind: string } }[];
  attempts: { state: string }[];
  quotes: {
    id: string;
    stageId: string;
    baseRevision: number;
    approvedAt: number | null;
    expiresAt: number;
  }[];
};

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "uncertain"]);

const developmentKind = (ctx: PlanContext) =>
  ctx.request?.development?.kind ?? (ctx.data.hasScript ? "screenplay" : "idea");

const agentRequest = (ctx: PlanContext) =>
  ctx.request?.agent?.request?.trim() ||
  "Read every stage of this project and propose the shortest route to a delivered film, with each step priced.";

async function pipelineRuns(ctx: PlanContext) {
  const { runs } = await call<{ runs: PipelineRun[] }>(
    ctx,
    `/api/pipelines?projectId=${encodeURIComponent(ctx.productionId ?? "")}`,
  );
  // Fail closed on another production's runs (as the Atomik suite does).
  return runs.filter((item) => item.context?.projectId === ctx.productionId);
}

const interrupted = (item: PipelineRun) =>
  !["succeeded", "cancelled"].includes(item.state) &&
  item.attempts.some((attempt) => ["queued", "submitting", "running"].includes(attempt.state));

const waitingQuotes = (item: PipelineRun) =>
  ["draft", "awaiting_approval", "needs_review", "blocked"].includes(item.state)
    ? item.quotes.filter((quote) => quote.approvedAt === null && quote.baseRevision === item.revision)
    : [];

function plan(
  page: WorkspacePageId,
  spec: Omit<Plan, "page" | "suite" | "paid" | "completesPage"> & {
    completesPage?: boolean;
  },
): Plan {
  const suite = (Object.keys(WORKSPACE_PLAN_PAGES) as WorkspaceSuite[]).find((key) =>
    (WORKSPACE_PLAN_PAGES[key] as readonly string[]).includes(page),
  )!;
  return {
    ...spec,
    page,
    suite,
    paid: spec.steps.some((item) => item.executor.type === "gate"),
    completesPage: spec.completesPage ?? true,
  };
}

export const PLANS: Record<WorkspacePageId, Plan> = {
  /* ============================================================ Particl */

  brief: plan("brief", {
    title: "Develop the brief and script",
    line: "Reads the saved brief or script and returns directions, or scenes with proposed coverage. Text model, priced before it runs.",
    priceLabel: "Quote at gate · text model",
    doneLine: (_ctx, io) => {
      const job = io.development as DevelopmentJob | undefined;
      const scenes = count(job?.result?.scenes);
      const ideas = count(job?.result?.ideas);
      if (job?.status !== "succeeded") return "Development sent · still running";
      return scenes
        ? `Script broken into ${plural(scenes, "scene")}`
        : `${plural(ideas, "direction")} drafted`;
    },
    runnable: needProject,
    steps: [
      step(
        "Read the saved source",
        "read",
        (ctx) => (developmentKind(ctx) === "idea" ? "brief and direction" : "script"),
        run({ method: "GET", path: "/api/workbench/development" }, async (ctx) => {
          const data = await call<{ configured: boolean; models: { id: string }[] }>(
            ctx,
            `/api/workbench/development?projectId=${encodeURIComponent(ctx.projectId ?? "")}`,
          );
          const model = ctx.request?.development?.model ?? data.models[0]?.id;
          if (!data.configured || !model) throw new Error("Script development isn't set up in this workspace.");
          return { io: { developmentModel: model, developmentRequestId: newId(ctx) } };
        }),
      ),
      step("Approval gate", "gate", "live quote", {
        type: "gate",
        backend: { method: "POST", path: "/api/workbench/development (quoteOnly)" },
        inputKey: (ctx, io) =>
          stableKey([ctx.projectId, developmentKind(ctx), io.developmentModel, ctx.request?.development?.instructions ?? ""]),
        quote: async (ctx, io) => {
          const body = {
            projectId: ctx.projectId,
            requestId: io.developmentRequestId,
            kind: developmentKind(ctx),
            model: io.developmentModel,
            effort: "auto",
            ...(ctx.request?.development?.instructions ? { instructions: ctx.request.development.instructions } : {}),
          };
          const quote = await call<DevelopmentQuote>(ctx, "/api/workbench/development", {
            body: { ...body, quoteOnly: true },
          });
          return {
            unit: "cr",
            parts: [
              {
                credits: quote.estimateCredits,
                fingerprint: quote.sourceHash,
                body,
                meta: quote.estimateUsd == null ? {} : { maxUsd: quote.estimateUsd },
              },
            ],
            expiresAt: null,
            line: `${plural(quote.chunks, "source section")} read by a text model. Charged up to the approved amount.`,
          };
        },
      }),
      step("Develop", "dispatch", "text model", {
        type: "dispatch",
        backend: { method: "POST", path: "/api/workbench/development" },
        dispatch: async (ctx, _io, approved) => {
          const [part] = approved.parts;
          const { job } = await call<{ job: DevelopmentJob }>(ctx, "/api/workbench/development", {
            body: {
              ...part.body,
              sourceHash: part.fingerprint,
              maxCredits: part.credits,
              ...(part.meta?.maxUsd == null ? {} : { maxUsd: part.meta.maxUsd }),
            },
          });
          return { detail: job.status, io: { development: job } };
        },
      }),
      step(
        "File the result",
        "file",
        "→ Brief & Script",
        run({ method: "GET", path: "/api/workbench/development?requestId" }, async (ctx, io) => {
          const job = io.development as DevelopmentJob;
          const query = new URLSearchParams({ projectId: ctx.projectId ?? "", requestId: job.requestId });
          const { value } = await follow(
            ctx,
            async () =>
              (await call<{ jobs: DevelopmentJob[] }>(ctx, `/api/workbench/development?${query}`)).jobs.find(
                (item) => item.requestId === job.requestId,
              ) ?? job,
            (item) => TERMINAL.has(item.status),
          );
          if (value.status === "failed") throw new Error(value.error || "Development failed. Failed runs are not billed.");
          return { detail: value.status, io: { development: value } };
        }),
      ),
    ],
  }),

  boards: plan("boards", {
    title: "Board every scene",
    line: "Prices each board on the Boards page, then renders them. Boards are billed per image, so the run stops for approval first.",
    priceLabel: "Quote at gate",
    doneLine: (_ctx, io) => `${plural(count(io.admitted), "board")} sent to render`,
    runnable: (ctx) => {
      const project = needProject(ctx);
      if (!project.ok) return project;
      return boards(ctx).length ? OK : notYet("add board prompts on Boards first.");
    },
    steps: [
      step(
        "Read the board list",
        "read",
        (ctx) => plural(boards(ctx).length, "board"),
        local("request.boards", (ctx) => ({ detail: plural(boards(ctx).length, "board") })),
      ),
      step(
        "Approval gate",
        "gate",
        "live quote",
        generationGate(boards, (parts) => partsLine(parts, "board", "Settled on completion; failed renders are not billed.")),
      ),
      step("Render the boards", "dispatch", (ctx) => plural(boards(ctx).length, "board"), generationDispatch("ws-boards", "board")),
      step("File to Boards", "file", "→ Boards", fileJobs("board")),
    ],
  }),

  cast: plan("cast", {
    title: "Lock cast and elements",
    line: "Locks every cast member and element on this production so the shots that cite them stop drifting. Free.",
    priceLabel: "Free",
    doneLine: (_ctx, io) => `${plural(Number(io.locked ?? 0), "element")} locked · free`,
    runnable: needProduction,
    steps: [
      step(
        "Read cast and elements",
        "read",
        "this production",
        run({ method: "GET", path: "/api/rig/elements" }, async (ctx) => {
          const { elements } = await call<{ elements: { id: string; locked: boolean }[] }>(
            ctx,
            `/api/rig/elements?projectId=${encodeURIComponent(ctx.productionId ?? "")}`,
          );
          const open = elements.filter((item) => !item.locked).map((item) => item.id);
          return { detail: `${plural(elements.length, "element")} · ${open.length} unlocked`, io: { unlocked: open } };
        }),
      ),
      step(
        "Lock each element",
        "file",
        "",
        run({ method: "PUT", path: "/api/rig/elements/[id] {locked:true}" }, async (ctx, io) => {
          const ids = (io.unlocked as string[] | undefined) ?? [];
          for (const id of ids)
            await call(ctx, `/api/rig/elements/${encodeURIComponent(id)}`, { method: "PUT", body: { locked: true } });
          return { detail: plural(ids.length, "element") + " locked", io: { locked: ids.length } };
        }),
      ),
    ],
  }),

  astra: plan("astra", {
    title: "Render the 3D layout",
    line: "Renders the saved scene in the 3D runtime and files the layout for Rig to cite. Compute is reserved at the quoted maximum.",
    priceLabel: "Quote at gate",
    doneLine: (_ctx, io) => {
      const job = io.astraJob as { status?: string } | undefined;
      return job?.status === "succeeded" ? "Layout rendered · filed for Rig" : "Layout render sent";
    },
    runnable: (ctx) => {
      const project = needProject(ctx);
      if (!project.ok) return project;
      return /^[a-f0-9]{64}$/.test(ctx.request?.astra?.sourceDigest ?? "")
        ? OK
        : notYet("save the scene in Astra first.");
    },
    steps: [
      step(
        "Read the saved scene",
        "read",
        (ctx) => ctx.request?.astra?.source ?? "scene",
        local("request.astra", (ctx) => ({
          io: { astraRequestId: newId(ctx).replace(/[^a-zA-Z0-9_-]/g, "") },
          detail: ctx.request?.astra?.source ?? "scene",
        })),
      ),
      step("Approval gate", "gate", "live quote", {
        type: "gate",
        backend: { method: "POST", path: "/api/workbench/astra-blender/render (quoteOnly)" },
        inputKey: (ctx) => stableKey([ctx.projectId, ctx.request?.astra]),
        quote: async (ctx, io) => {
          const body = {
            projectId: ctx.projectId,
            requestId: io.astraRequestId,
            source: ctx.request?.astra?.source ?? "scene",
            sourceDigest: ctx.request?.astra?.sourceDigest,
          };
          const { quote } = await call<{
            quote: { estimateCredits: number; quoteDigest: string; expiresAt: number };
          }>(ctx, "/api/workbench/astra-blender/render", { body: { ...body, quoteOnly: true } });
          return {
            unit: "cr",
            parts: [{ credits: quote.estimateCredits, fingerprint: quote.quoteDigest, body }],
            expiresAt: quote.expiresAt,
            line: "Reserves the maximum render time; the final charge follows reported compute.",
          };
        },
      }),
      step("Render", "dispatch", "3D runtime", {
        type: "dispatch",
        backend: { method: "POST", path: "/api/workbench/astra-blender/render" },
        dispatch: async (ctx, _io, approved) => {
          const [part] = approved.parts;
          const { job } = await call<{ job: { id: string; status: string } }>(
            ctx,
            "/api/workbench/astra-blender/render",
            { body: { ...part.body, quoteDigest: part.fingerprint, maxCredits: part.credits } },
          );
          return { detail: job.status, io: { astraJob: job } };
        },
      }),
      step(
        "File the layout",
        "file",
        "→ Rig",
        run({ method: "GET", path: "/api/workbench/astra-blender/render?requestId" }, async (ctx, io) => {
          const query = new URLSearchParams({ projectId: ctx.projectId ?? "", requestId: String(io.astraRequestId) });
          const { value } = await follow(
            ctx,
            async () =>
              (await call<{ jobs: { requestId: string; status: string }[] }>(
                ctx,
                `/api/workbench/astra-blender/render?${query}`,
              )).jobs.find((job) => job.requestId === io.astraRequestId) ??
              (io.astraJob as { status: string }),
            (job) => TERMINAL.has(job.status),
          );
          if (value.status === "failed") throw new Error("The render failed. Unused compute is released.");
          return { detail: value.status, io: { astraJob: value } };
        }),
      ),
    ],
  }),

  rig: plan("rig", {
    title: "Render every ready shot",
    line: "Resolves each ready shot's request, quotes it and renders it. Priced before anything is sent.",
    priceLabel: "Quote at gate",
    // Rig's page completes when its renders do, not when they are dispatched (04).
    completesPage: false,
    doneLine: (_ctx, io) => `${plural(count(io.admitted), "shot")} sent to render`,
    runnable: (ctx) => {
      const project = needProject(ctx);
      if (!project.ok) return project;
      return shots(ctx).length ? OK : notYet("no shot is ready to render.");
    },
    steps: [
      step(
        "Resolve references",
        "read",
        (ctx) => plural(shots(ctx).length, "shot"),
        local("request.shots", (ctx) => ({ detail: plural(shots(ctx).length, "shot") })),
      ),
      step(
        "Approval gate",
        "gate",
        "live quote",
        generationGate(shots, (parts) => partsLine(parts, "shot", "Failed renders are not billed.")),
      ),
      step("Render", "dispatch", (ctx) => plural(shots(ctx).length, "shot"), generationDispatch("ws-rig", "shot")),
      step("File the takes", "file", "→ Takes", fileJobs("take")),
    ],
  }),

  takes: plan("takes", {
    title: "Triage the project library",
    line: "Compares versions against the direction and marks what is worth cutting with. Editorial judgement, not a prediction.",
    priceLabel: "Not runnable yet",
    doneLine: () => "Library triaged",
    missingBackend:
      "A take-review endpoint that reads a project's takes with the direction and returns a structured recommendation per take (e.g. an editor-role action on /api/workbench/atomik returning {takeId, verdict, reason}[]). The agent route today returns only a free-text plan.",
    runnable: () => notYet("there is no take-triage service to call."),
    steps: [
      step("Read uploads and takes", "read", "", missing("take triage has no backend")),
      step("Score against the direction", "compute", "", missing("take triage has no backend")),
    ],
  }),

  edit: plan("edit", {
    title: "Score the film",
    line: "Generates the stems set up on Edit & Sound against the cut. Audio is billed per generation, so the run stops for approval first.",
    priceLabel: "Quote at gate",
    doneLine: (_ctx, io) => `${plural(count(io.admitted), "stem")} sent to generate`,
    runnable: (ctx) => {
      const project = needProject(ctx);
      if (!project.ok) return project;
      return stemsOf(ctx).length ? OK : notYet("set up a dialogue, effects or music stem first.");
    },
    steps: [
      step(
        "Read the cut",
        "read",
        (ctx) => plural(stemsOf(ctx).length, "stem"),
        local("request.stems", (ctx) => ({ detail: plural(stemsOf(ctx).length, "stem") })),
      ),
      step("Approval gate", "gate", "live quote", audioGate),
      step("Generate stems", "dispatch", (ctx) => plural(stemsOf(ctx).length, "stem"), audioDispatch),
      step("File to the edit", "file", "→ Edit & Sound", fileJobs("stem")),
    ],
  }),

  deliver: plan("deliver", {
    title: "Package the approved takes",
    line: "Collects every approved take under the workspace's file naming, with the shot list beside them. Free.",
    priceLabel: "Free",
    doneLine: (_ctx, io) => `Package ready · ${plural(Number(io.approved ?? 0), "approved take")}`,
    runnable: needProduction,
    steps: [
      step(
        "Read the approved takes",
        "read",
        "selects",
        run({ method: "GET", path: "/api/export/selects?format=csv" }, async (ctx) => {
          const path = `/api/export/selects?${new URLSearchParams({ projectId: ctx.productionId ?? "", format: "csv" })}`;
          const response = await ctx.fetch(path, { cache: "no-store" });
          if (!response.ok) {
            const data = (await response.json().catch(() => null)) as { error?: string } | null;
            throw new Error(data?.error || `The request failed (${response.status}).`);
          }
          const rows = (await response.text()).split(/\r?\n/).filter((line) => line.trim()).length - 1;
          return { detail: plural(Math.max(rows, 0), "take"), io: { approved: Math.max(rows, 0) } };
        }),
      ),
      step(
        "Package",
        "file",
        "→ Deliver",
        local("packageUrl", (ctx) => ({
          detail: "zip ready",
          io: {
            packageUrl: `/api/export/selects?${new URLSearchParams({ projectId: ctx.productionId ?? "", format: "zip" })}`,
          },
        })),
      ),
    ],
  }),

  /* ============================================================ Atomik */

  agent: plan("agent", {
    title: "Plan the rest of the project",
    line: "Reads every stage and proposes the shortest route to a delivered film. Text model, priced before it runs.",
    priceLabel: "Quote at gate · text model",
    doneLine: (_ctx, io) => {
      const job = io.agentJob as AtomikJob | undefined;
      return job?.status === "succeeded"
        ? `Plan ready · ${plural(count(job.plan?.steps), "step")}`
        : "Planning sent · still running";
    },
    runnable: needProject,
    steps: [
      step(
        "Read the project",
        "read",
        "every stage",
        local("request.agent", (ctx) => ({ io: { agentRequestId: newId(ctx) } })),
      ),
      step("Approval gate", "gate", "live quote", {
        type: "gate",
        backend: { method: "POST", path: "/api/workbench/atomik (quoteOnly)" },
        inputKey: (ctx) => stableKey([ctx.projectId, agentRequest(ctx), ctx.request?.agent?.role ?? null]),
        quote: async (ctx, io) => {
          const body = {
            projectId: ctx.projectId,
            requestId: io.agentRequestId,
            request: agentRequest(ctx),
            suite: "atomik",
            ...(ctx.request?.agent?.role ? { role: ctx.request.agent.role } : {}),
          };
          const quote = await call<AtomikQuote>(ctx, "/api/workbench/atomik", { body: { ...body, quoteOnly: true } });
          return {
            unit: "cr",
            parts: [
              {
                credits: quote.estimateCredits,
                fingerprint: shortHash(`${stableKey(body)}|${quote.estimateCredits}`),
                body,
              },
            ],
            expiresAt: null,
            line: "One planning pass by a text model. Charged up to the approved amount.",
          };
        },
      }),
      step("Propose the plan", "dispatch", "text model", {
        type: "dispatch",
        backend: { method: "POST", path: "/api/workbench/atomik" },
        dispatch: async (ctx, _io, approved) => {
          const [part] = approved.parts;
          const { job } = await call<{ job: AtomikJob }>(ctx, "/api/workbench/atomik", {
            body: { ...part.body, maxCredits: part.credits },
          });
          return { detail: job.status, io: { agentJob: job } };
        },
      }),
      step(
        "File the plan",
        "file",
        "→ Agent",
        run({ method: "GET", path: "/api/workbench/atomik?requestId" }, async (ctx, io) => {
          const job = io.agentJob as AtomikJob;
          const { value } = await follow(
            ctx,
            async () =>
              (await call<{ jobs: AtomikJob[] }>(
                ctx,
                `/api/workbench/atomik?requestId=${encodeURIComponent(job.requestId)}`,
              )).jobs.find((item) => item.requestId === job.requestId) ?? job,
            (item) => TERMINAL.has(item.status),
          );
          if (value.status === "failed") throw new Error(value.error || "Planning failed. Failed runs are not billed.");
          return { detail: `${plural(count(value.plan?.steps), "step")}`, io: { agentJob: value } };
        }),
      ),
    ],
  }),

  runs: plan("runs", {
    title: "Resume interrupted runs",
    line: "Finds runs whose work stopped mid-flight and wakes their saved intent. It never quotes or approves anything new.",
    priceLabel: "Free",
    doneLine: (_ctx, io) => {
      const n = count(io.interrupted);
      return n ? `${plural(n, "run")} woken` : "No interrupted runs";
    },
    runnable: needProduction,
    steps: [
      step(
        "Read the runs",
        "read",
        (ctx) => (ctx.data.runs == null ? "" : plural(ctx.data.runs, "run")),
        run({ method: "GET", path: "/api/pipelines" }, async (ctx) => {
          const runs = await pipelineRuns(ctx);
          return { detail: plural(runs.length, "run"), io: { runs } };
        }),
      ),
      step(
        "Find interrupted work",
        "compute",
        "",
        local("interrupted(run)", (_ctx, io) => {
          const list = ((io.runs as PipelineRun[]) ?? []).filter(interrupted);
          return { detail: `${list.length} found`, io: { interrupted: list.map((item) => item.id) } };
        }),
      ),
      step(
        "Wake each run",
        "file",
        "",
        run({ method: "POST", path: "/api/pipelines/[id] {action:\"recover\"}" }, async (ctx, io) => {
          const ids = (io.interrupted as string[]) ?? [];
          for (const id of ids)
            await call(ctx, `/api/pipelines/${encodeURIComponent(id)}`, { body: { action: "recover" } });
          return { detail: `${ids.length} woken` };
        }),
      ),
    ],
  }),

  generate: plan("generate", {
    title: "Generate on the connected account",
    line: "Checks the request against the model's declared limits, takes a live quote and submits once. Billed in the connected account's credits.",
    priceLabel: "Quote at gate",
    doneLine: (_ctx, io) => `Generation ${String((io.job as ConsumerJob | undefined)?.status ?? "submitted")}`,
    runnable: (ctx) => {
      const project = needProject(ctx);
      if (!project.ok) return project;
      const input = generationInput(ctx);
      return input && typeof input.model === "string" ? OK : notYet("choose a workflow and model on Generate first.");
    },
    steps: [
      step(
        "Read the request",
        "read",
        (ctx) => String(generationInput(ctx)?.type ?? ""),
        local("request.generation", (ctx) => ({ detail: plural(count(generationInput(ctx)?.medias), "reference") })),
      ),
      step(
        "Approval gate",
        "gate",
        "live quote",
        connectedGate(CONNECTED_GENERATION, generationInput, (input, job) =>
          `${plural(count(input.medias), "reference")}. Originals are copied to the connected account at quote time; charged to its selected wallet${job.workspaceName ? ` (${job.workspaceName})` : ""}.`,
        ),
      ),
      step("Submit", "dispatch", "once", connectedDispatch(CONNECTED_GENERATION, "generation")),
      step("Follow the job", "file", "→ Generate", connectedStatus(CONNECTED_GENERATION)),
    ],
  }),

  recipes: plan("recipes", {
    title: "Turn this project into a recipe",
    line: "Captures the latest successful run as a saved plan and opens it as a new draft run. Nothing is priced or sent until you approve its stages.",
    priceLabel: "Free",
    doneLine: (_ctx, io) => `Recipe saved · ${plural(Number(io.recipeStages ?? 0), "stage")}`,
    runnable: needProduction,
    steps: [
      step(
        "Read successful runs",
        "read",
        "",
        run({ method: "GET", path: "/api/pipelines" }, async (ctx) => {
          const runs = (await pipelineRuns(ctx)).filter((item) => item.state === "succeeded");
          if (!runs.length) throw new Error("No run has succeeded on this production yet, so there is nothing to capture.");
          return { detail: plural(runs.length, "run"), io: { source: runs[0] } };
        }),
      ),
      step(
        "Extract the structure",
        "compute",
        "",
        local("recipeFromRun", (_ctx, io) => {
          const source = io.source as PipelineRun & { stages: { definition: Record<string, unknown> }[] };
          // Only the saved plan: no attempt, approval or provider output is reused.
          const spec = {
            schemaVersion: 1,
            name: source.name,
            context: { ...source.context },
            stages: source.stages.map((stage) => structuredClone(stage.definition)),
          };
          return { detail: plural(spec.stages.length, "stage"), io: { spec, recipeStages: spec.stages.length } };
        }),
      ),
      step(
        "Save the recipe",
        "file",
        "→ Runs",
        run({ method: "POST", path: "/api/pipelines" }, async (ctx, io) => {
          const { run: created } = await call<{ run: { id: string } }>(ctx, "/api/pipelines", {
            body: { spec: io.spec, expectedVersion: 0 },
          });
          return { detail: "draft run opened", io: { recipeRunId: created.id } };
        }),
      ),
    ],
  }),

  builds: plan("builds", {
    title: "Build a client review tool",
    line: "Generates a small app where the client watches takes and leaves notes.",
    priceLabel: "Not runnable yet",
    doneLine: () => "Build deployed",
    missingBackend:
      "An app-build service (generate, store, deploy, return a live URL) with its own quote and approval. The nearest existing feature is the review link (POST /api/shares → /review/[token] with notes), which is not a build.",
    runnable: () => notYet("there is no build service to call."),
    steps: [
      step("Design the interface", "compute", "", missing("builds have no backend")),
      step("Deploy", "dispatch", "", missing("builds have no backend")),
    ],
  }),

  skills: plan("skills", {
    title: "Audit installed skills",
    line: "Reports what each skill can reach, what it costs and whether its credential is configured.",
    priceLabel: "Not runnable yet",
    doneLine: () => "Skills audited",
    missingBackend:
      "A skills registry endpoint listing installed skills with their scopes, prices and credential state (e.g. GET /api/skills). Nothing in the app installs or lists skills today.",
    runnable: () => notYet("there is no skills registry to read."),
    steps: [
      step("Enumerate skills", "read", "", missing("skills have no backend")),
      step("Report scope", "compute", "", missing("skills have no backend")),
    ],
  }),

  models: plan("models", {
    title: "Check every shot against its engine",
    line: "Reads each engine's real limits and reports which shots ask for a ratio, resolution or duration it does not offer. Report only; nothing is changed.",
    priceLabel: "Free",
    doneLine: (_ctx, io) => {
      const n = Number(io.outOfRange ?? 0);
      return n ? `${plural(n, "shot")} outside engine limits` : "Every shot within engine limits";
    },
    runnable: (ctx) => (shots(ctx).length ? OK : notYet("no shot settings to check on Rig.")),
    steps: [
      step(
        "Read the engine catalogue",
        "read",
        "",
        run({ method: "GET", path: "/api/workbench/engines" }, async (ctx) => {
          const { models } = await call<{
            models: { id: string; resolutions: string[]; ratios: string[]; durations: number[] }[];
          }>(ctx, "/api/workbench/engines");
          return { detail: plural(models.length, "engine"), io: { engines: models } };
        }),
      ),
      step(
        "Compare shot settings",
        "compute",
        (ctx) => plural(shots(ctx).length, "shot"),
        local("engine limits", (ctx, io) => {
          const engines = (io.engines as { id: string; resolutions: string[]; ratios: string[]; durations: number[] }[]) ?? [];
          const problems: { shot: string; field: string }[] = [];
          for (const shot of shots(ctx)) {
            const engine = engines.find((item) => item.id === shot.body.model);
            if (!engine) {
              problems.push({ shot: shot.name, field: "model" });
              continue;
            }
            const { resolution, ratio, duration } = shot.body as { resolution?: string; ratio?: string; duration?: number };
            if (resolution && engine.resolutions?.length && !engine.resolutions.includes(resolution))
              problems.push({ shot: shot.name, field: "resolution" });
            if (ratio && engine.ratios?.length && !engine.ratios.includes(ratio)) problems.push({ shot: shot.name, field: "ratio" });
            if (duration != null && engine.durations?.length && !engine.durations.includes(duration))
              problems.push({ shot: shot.name, field: "duration" });
          }
          const outOfRange = new Set(problems.map((item) => item.shot)).size;
          return { detail: `${outOfRange} outside limits`, io: { problems, outOfRange } };
        }),
      ),
    ],
  }),

  approvals: plan("approvals", {
    title: "Clear the approval queue",
    line: "Re-prices every waiting stage so no stale quote is approved, then lists them for one pass of approvals.",
    priceLabel: "Free",
    doneLine: (_ctx, io) => `${plural(Number(io.requoted ?? 0), "gate")} re-estimated`,
    runnable: needProduction,
    steps: [
      step(
        "Read waiting gates",
        "read",
        "",
        run({ method: "GET", path: "/api/pipelines" }, async (ctx) => {
          const runs = await pipelineRuns(ctx);
          const waiting = runs.flatMap((item) =>
            waitingQuotes(item).map((quote) => ({ runId: item.id, stageId: quote.stageId })),
          );
          const unique = [...new Map(waiting.map((item) => [`${item.runId}:${item.stageId}`, item])).values()];
          return { detail: `${unique.length} waiting`, io: { waiting: unique } };
        }),
      ),
      step(
        "Re-estimate live",
        "quote",
        "",
        run({ method: "POST", path: "/api/pipelines/[id] {action:\"quote\"}" }, async (ctx, io) => {
          const waiting = (io.waiting as { runId: string; stageId: string }[]) ?? [];
          let requoted = 0;
          for (const item of waiting) {
            // Read the run's current revision right before quoting it.
            const { run: current } = await call<{ run: PipelineRun }>(ctx, `/api/pipelines/${encodeURIComponent(item.runId)}`);
            await call(ctx, `/api/pipelines/${encodeURIComponent(item.runId)}`, {
              body: { action: "quote", revision: current.revision, stageId: item.stageId },
            });
            requoted += 1;
          }
          return { detail: `${requoted} re-priced`, io: { requoted } };
        }),
      ),
      step(
        "Present for approval",
        "compute",
        "→ Approvals",
        local("approvals list", (_ctx, io) => ({ detail: `${Number(io.requoted ?? 0)} ready` })),
      ),
    ],
  }),

  budget: plan("budget", {
    title: "Reconcile the ledger",
    line: "Matches every settled generation to its billed amount and reports spend by engine and person.",
    priceLabel: "Not runnable yet",
    doneLine: () => "Ledger reconciled",
    missingBackend:
      "An on-demand, workspace-scoped reconcile endpoint (e.g. POST /api/ledger-checks/reconcile) running lib/reconcile.ts. Today reconcileWorkspaces only runs from the /api/cron/sync job, and /api/usage reports drift only for workspaces not billed in credits.",
    runnable: () => notYet("the ledger reconcile only runs on the nightly job."),
    steps: [
      step("Read settled jobs", "read", "", missing("on-demand reconcile has no backend")),
      step("Match billed amounts", "compute", "", missing("on-demand reconcile has no backend")),
    ],
  }),

  /* ============================================================ Moleculr */

  marketing: plan("marketing", {
    title: "Build the campaign set",
    line: "Takes the variants set up on Marketing Studio, prices each one and renders the set. Generation is billed per variant, so the run stops for approval first.",
    priceLabel: "Quote at gate",
    doneLine: (_ctx, io) => `${plural(count(io.admitted), "variant")} sent to render`,
    runnable: (ctx) => {
      const project = needProject(ctx);
      if (!project.ok) return project;
      return variants(ctx).length ? OK : notYet("configure the variant set on Marketing Studio first.");
    },
    steps: [
      step(
        "Read brief and product",
        "read",
        (ctx) => plural(variants(ctx).length, "variant"),
        local("request.variants", (ctx) => ({ detail: plural(variants(ctx).length, "variant") })),
      ),
      step(
        "Approval gate",
        "gate",
        "live quote",
        generationGate(variants, (parts) =>
          partsLine(parts, "variant", "Prompt enhancement, where chosen, is included in each price."),
        ),
      ),
      step("Render the variants", "dispatch", (ctx) => plural(variants(ctx).length, "variant"), generationDispatch("ws-marketing", "variant")),
      step("File to the campaign", "file", "→ Marketing Studio", fileJobs("variant")),
    ],
  }),

  /* ============================================================ Subatomik */

  motion: plan("motion", {
    title: "Recast the motion",
    line: "Resolves your originals, preserves reference order and takes a live quote before submission.",
    priceLabel: "Quote at gate",
    doneLine: (_ctx, io) => `Motion transfer ${String((io.job as ConsumerJob | undefined)?.status ?? "submitted")}`,
    runnable: (ctx) => {
      const project = needProject(ctx);
      if (!project.ok) return project;
      return hasSource(motionInput(ctx)) ? OK : notYet("choose a source video on Motion Transfer first.");
    },
    steps: [
      step(
        "Resolve originals",
        "read",
        "yours",
        local("request.motion", (ctx) => ({ detail: plural(refsOf(motionInput(ctx) ?? {}), "reference") })),
      ),
      step(
        "Preserve reference order",
        "compute",
        (ctx) => plural(refsOf(motionInput(ctx) ?? {}), "reference"),
        local("reference order", (ctx) => ({ detail: "order kept", io: { order: count(motionInput(ctx)?.references) } })),
      ),
      step(
        "Approval gate",
        "gate",
        "live quote",
        connectedGate(GENJUTSU, motionInput, (input, job) =>
          `${String(input.resolution ?? "")}${input.resolution ? ", " : ""}${plural(refsOf(input), "ordered reference")}. Originals are copied to the connected account at quote time; charged to its selected wallet${job.workspaceName ? ` (${job.workspaceName})` : ""}.`,
        ),
      ),
      step("Submit", "dispatch", (ctx) => String(motionInput(ctx)?.resolution ?? ""), connectedDispatch(GENJUTSU, "motion transfer")),
      step("Follow the job", "file", "→ Motion Transfer", connectedStatus(GENJUTSU)),
    ],
  }),

  swap: plan("swap", {
    title: "Swap the product",
    line: "Names the element to replace, orders the replacement references and quotes live before submission.",
    priceLabel: "Quote at gate",
    doneLine: (_ctx, io) => `Object swap ${String((io.job as ConsumerJob | undefined)?.status ?? "submitted")}`,
    runnable: (ctx) => {
      const project = needProject(ctx);
      if (!project.ok) return project;
      return hasSource(swapInput(ctx)) ? OK : notYet("choose a source video on Object Swap first.");
    },
    steps: [
      step(
        "Resolve originals",
        "read",
        "yours",
        local("request.swap", (ctx) => ({ detail: plural(refsOf(swapInput(ctx) ?? {}), "reference") })),
      ),
      step(
        "Order references",
        "compute",
        (ctx) => plural(refsOf(swapInput(ctx) ?? {}), "reference"),
        local("reference order", (ctx) => ({ detail: "order kept", io: { order: count(swapInput(ctx)?.references) } })),
      ),
      step(
        "Approval gate",
        "gate",
        "live quote",
        connectedGate(GENJUTSU, swapInput, (input, job) =>
          `${String(input.resolution ?? "")}${input.resolution ? ", " : ""}${plural(refsOf(input), "ordered reference")}. Approved against the exact wallet${job.workspaceName ? ` (${job.workspaceName})` : ""} and amount.`,
        ),
      ),
      step("Submit", "dispatch", (ctx) => String(swapInput(ctx)?.resolution ?? ""), connectedDispatch(GENJUTSU, "object swap")),
      step("Follow the job", "file", "→ Object Swap", connectedStatus(GENJUTSU)),
    ],
  }),

  shorts: plan("shorts", {
    title: "Make a set of shorts",
    line: "Restyles one project video into short clips, quotes the whole set live, and files every collected clip.",
    priceLabel: "Quote at gate",
    doneLine: (_ctx, io) => `Shorts ${String((io.job as ConsumerJob | undefined)?.status ?? "submitted")}`,
    runnable: (ctx) => {
      const project = needProject(ctx);
      if (!project.ok) return project;
      const input = shortsInput(ctx);
      return hasSource(input) && !!input?.preset ? OK : notYet("Needs Shorts data: choose a source video and a style on Shorts first.");
    },
    steps: [
      step(
        "Resolve the source",
        "read",
        "yours",
        local("request.shorts", (ctx) => ({ detail: String(shortsInput(ctx)?.aspectRatio ?? "") })),
      ),
      step(
        "Approval gate",
        "gate",
        "live quote",
        connectedGate(SHORTS, shortsInput, (input, job) =>
          `${String(input.aspectRatio ?? "")}${input.aspectRatio ? ", " : ""}one price for the whole set of clips. The source is copied to the connected account at quote time; charged to its selected wallet${job.workspaceName ? ` (${job.workspaceName})` : ""}.`,
        ),
      ),
      step("Submit", "dispatch", (ctx) => String(shortsInput(ctx)?.aspectRatio ?? ""), connectedDispatch(SHORTS, "set of shorts")),
      step("Follow the session", "file", "→ Shorts", connectedStatus(SHORTS)),
    ],
  }),

  sources: plan("sources", {
    title: "Verify the source library",
    line: "Re-hashes every original and confirms duration and dimensions against what the models accept.",
    priceLabel: "Not runnable yet",
    doneLine: () => "Sources verified",
    missingBackend:
      "An endpoint that re-reads each stored original, recomputes its SHA-256 and measures duration and dimensions against the stored receipt and the model limits (e.g. POST /api/higgsfield/consumer/genjutsu {action:\"verify\"}). Hashes are only computed once, when an original is collected.",
    runnable: () => notYet("nothing re-hashes stored originals on request."),
    steps: [
      step("Re-hash originals", "read", "", missing("source verification has no backend")),
      step("Check duration and dimensions", "compute", "", missing("source verification has no backend")),
    ],
  }),

  compare: plan("compare", {
    title: "Build the comparison",
    line: "Loads the original and the result of a finished job so they open split on one clock.",
    priceLabel: "Free",
    doneLine: () => "Comparison ready",
    runnable: needProject,
    steps: [
      step(
        "Load the jobs",
        "read",
        "",
        run({ method: "GET", path: GENJUTSU }, async (ctx) => {
          const { jobs } = await call<{ jobs: ConsumerJob[] }>(
            ctx,
            `${GENJUTSU}?draftId=${encodeURIComponent(ctx.projectId ?? "")}`,
          );
          const wanted = ctx.request?.compare?.jobId;
          const job = wanted
            ? jobs.find((item) => item.id === wanted)
            : jobs.find((item) => item.status === "completed" && item.originalAvailable);
          if (!job || job.status !== "completed" || !job.result?.original?.asset?.url)
            throw new Error("No finished result with a retained original to compare yet.");
          return { detail: "1 result", io: { compareJob: job } };
        }),
      ),
      step(
        "Pair original and result",
        "compute",
        "",
        local("comparison pair", (_ctx, io) => {
          const job = io.compareJob as ConsumerJob;
          return {
            detail: "paired",
            io: { comparison: { source: job.input?.source ?? null, result: job.result?.original?.asset?.url ?? null } },
          };
        }),
      ),
    ],
  }),

  history: plan("history", {
    title: "Reconcile connected credits",
    line: "Re-reads every unsettled job on this project so each one ends completed, failed or with its receipt recorded.",
    priceLabel: "Free",
    doneLine: (_ctx, io) => `${plural(Number(io.reconciled ?? 0), "job")} reconciled`,
    runnable: needProject,
    steps: [
      step(
        "Read result history",
        "read",
        "",
        run({ method: "GET", path: GENJUTSU }, async (ctx) => {
          const { jobs } = await call<{ jobs: ConsumerJob[] }>(
            ctx,
            `${GENJUTSU}?draftId=${encodeURIComponent(ctx.projectId ?? "")}`,
          );
          const open = jobs.filter((job) => ["accepted", "dispatching", "uncertain"].includes(job.status));
          return { detail: `${plural(jobs.length, "job")} · ${open.length} unsettled`, io: { open: open.map((job) => job.id) } };
        }),
      ),
      step(
        "Match credit receipts",
        "file",
        "",
        run({ method: "POST", path: `${GENJUTSU} {action:"status"}` }, async (ctx, io) => {
          const ids = (io.open as string[]) ?? [];
          const states: Record<string, number> = {};
          for (const id of ids) {
            const { job } = await call<{ job: ConsumerJob }>(ctx, GENJUTSU, {
              body: { action: "status", draftId: ctx.projectId, id },
            });
            states[job.status] = (states[job.status] ?? 0) + 1;
          }
          const summary = Object.entries(states).map(([state, n]) => `${n} ${state}`).join(" · ");
          return { detail: summary || "nothing unsettled", io: { reconciled: ids.length } };
        }),
      ),
    ],
  }),
};

export const PLAN_PAGES = Object.keys(PLANS) as WorkspacePageId[];

/** Page-id aliases from lib/suites.ts, so an old id finds its plan. */
export const PLAN_ALIASES: Record<string, WorkspacePageId> = {
  storyboard: "boards",
  characters: "cast",
  "astra-blender": "astra",
  canvas: "rig",
  assets: "takes",
  export: "deliver",
  "motion-transfer": "motion",
  "object-swap": "swap",
  script: "brief",
  moodboard: "boards",
  elements: "cast",
};

export function planFor(page: string | null | undefined): Plan | null {
  if (!page) return null;
  const id = (page in PLANS ? page : PLAN_ALIASES[page]) as WorkspacePageId | undefined;
  return id ? PLANS[id] : null;
}

/** Every string a plan can put on screen, for the no-vendor-names check. */
export function planCopy(item: Plan, ctx: PlanContext): string[] {
  const out = [item.title, item.line, item.priceLabel, item.doneLine(ctx, {})];
  const runnable = item.runnable(ctx);
  if (!runnable.ok) out.push(runnable.reason);
  for (const s of item.steps) out.push(s.label, s.detail(ctx, {}));
  return out;
}
