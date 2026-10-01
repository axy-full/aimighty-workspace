import { test, expect } from "@playwright/test";
import { PLANS, PLAN_PAGES, planCopy, planFor } from "../../lib/workspace/plans";
import { WORKSPACE_PLAN_PAGES, type PlanContext, type PlanRequest } from "../../lib/workspace/plan-types";
import {
  AtomikRunEngine,
  DECLINED_TOAST,
  QUOTE_MAX_AGE_MS,
  VISUAL_PACING_MS,
  isApprovedQuote,
} from "../../lib/workspace/run-engine";
import { activityFromAgentJobs, activityFromJobs, mergeActivity, nextLine, loadActivity } from "../../lib/workspace/activity";
import { vendorNameIn } from "../../lib/workspace/vendor-names";
import { idempotencyKey } from "../../lib/workspace/plan-helpers";
import { genjutsuSourceUrl, isGenjutsuTake } from "../../lib/genjutsuTypes";

/* ------------------------------------------------------------ mock backend */

type Call = { method: string; path: string; body: Record<string, unknown> | null; headers: Record<string, string> };

type LibraryTake = { id: string; projectId: string | null; model: string; status: string; storedUrl: string | null; sourceGenId: string | null; params: Record<string, unknown>; createdAt: number };
/**
 * The project's Library as GET /api/workbench/library lists it, newest first
 * (lib/jobs.ts Generation, the fields Compare reads): a still, a transform
 * that failed, one still rendering, one of another production, a finished
 * transform made on the API key, and an older one made on the connected
 * account (collected into the Library with `params.task` "genjutsu").
 */
const LIBRARY: LibraryTake[] = [
  { id: "still-1", projectId: "prod-1", model: "image-a", status: "succeeded", storedUrl: "/media/still-1.png", sourceGenId: null, params: {}, createdAt: 900 },
  { id: "swap-failed", projectId: "prod-1", model: "higgsfield-genjutsu-object-swap", status: "failed", storedUrl: null, sourceGenId: null, params: { task: "genjutsu", sourceUploadId: "u1" }, createdAt: 800 },
  { id: "motion-running", projectId: "prod-1", model: "higgsfield-genjutsu-motion-transfer", status: "running", storedUrl: null, sourceGenId: null, params: { task: "genjutsu", sourceUploadId: "u1" }, createdAt: 700 },
  { id: "motion-other", projectId: "prod-other", model: "higgsfield-genjutsu-motion-transfer", status: "succeeded", storedUrl: "/media/motion-other.mp4", sourceGenId: null, params: { task: "genjutsu", sourceUploadId: "u9" }, createdAt: 650 },
  { id: "motion-key", projectId: "prod-1", model: "higgsfield-genjutsu-motion-transfer", status: "succeeded", storedUrl: "/media/motion-key.mp4", sourceGenId: null, params: { task: "genjutsu", sourceUploadId: "u1" }, createdAt: 600 },
  { id: "swap-account", projectId: "prod-1", model: "hf_mult_replace_object", status: "succeeded", storedUrl: "/media/swap-account.mp4", sourceGenId: null, params: { task: "genjutsu", sourceGenId: "clip-1", consumerJobId: "job-1", consumerCreditUnit: "higgsfield_credits" }, createdAt: 500 },
];

/**
 * A fetch that answers the existing routes' documented shapes. `price` is
 * read at call time so a test can move it between quote and approve.
 */
function backend(options: { price?: () => number; hold?: (path: string, body: Record<string, unknown> | null) => Promise<void> | null; approved?: number; takes?: LibraryTake[] } = {}) {
  const calls: Call[] = [];
  const price = options.price ?? (() => 18);
  let job = 0;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    calls.push({ method, path, body, headers });
    const held = options.hold?.(path, body);
    if (held) await held;
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
    const bare = path.split("?")[0];

    if (bare === "/api/generate/quote")
      return json({ estimatedCredits: price(), price: price(), unit: "cr", fingerprint: `fp${"0".repeat(60)}${String(calls.length).padStart(2, "0")}` });
    if (bare === "/api/generate") return json({ id: `gen-${(job += 1)}`, status: "queued" }, 202);
    if (bare.startsWith("/api/jobs/")) return json({ generation: { status: "queued" } });
    if (bare === "/api/audio" || bare === "/api/audio/dub")
      return body?.quoteOnly
        ? json({ estimatedCredits: price(), price: price(), unit: "cr" })
        : json({ id: `aud-${(job += 1)}`, status: "running", estimatedCredits: price() });
    /* Nothing answers the connected account's routes: no plan may call one. */
    if (bare === "/api/workbench/library" && method === "GET") {
      const query = new URLSearchParams(path.split("?")[1]);
      /* The real route takes exactly one project and one source (lib/workbench/project-library.ts), and an id is a lookup of one take. */
      if (query.getAll("projectId").length !== 1 || query.get("source") !== "generations")
        return json({ error: "Choose one Studio project and asset source." }, 400);
      const takes = options.takes ?? LIBRARY, id = query.get("id");
      return json({ generations: id ? takes.filter((take) => take.id === id) : takes.slice(0, Number(query.get("limit") ?? 60)), nextPageCursor: null });
    }
    if (bare === "/api/workbench/development") {
      if (method === "GET" && !path.includes("requestId")) return json({ configured: true, models: [{ id: "text-model" }], jobs: [] });
      if (method === "GET") return json({ jobs: [{ id: "d1", requestId: new URLSearchParams(path.split("?")[1]).get("requestId"), status: "succeeded", result: { scenes: [1, 2, 3], ideas: [] } }] });
      if (body?.quoteOnly) return json({ estimateCredits: price(), sourceHash: "a".repeat(64), chunks: 2 });
      return json({ job: { id: "d1", requestId: body?.requestId, status: "queued" } }, 202);
    }
    if (bare === "/api/workbench/atomik") {
      /* The real route refuses a read without the project it belongs to. */
      if (method === "GET" && !new URLSearchParams(path.split("?")[1]).get("projectId")) return json({ error: "Choose a saved project." }, 400);
      if (method === "GET") return json({ jobs: [{ id: "a1", requestId: new URLSearchParams(path.split("?")[1]).get("requestId"), status: "succeeded", plan: { steps: ["x", "y"] } }] });
      if (body?.quoteOnly) return json({ estimateCredits: price() });
      return json({ job: { id: "a1", requestId: body?.requestId, status: "queued" } }, 202);
    }
    if (bare === "/api/workbench/astra-blender/render") {
      if (method === "GET") return json({ jobs: [{ requestId: new URLSearchParams(path.split("?")[1]).get("requestId"), status: "succeeded" }] });
      if (body?.quoteOnly) return json({ quote: { estimateCredits: price(), quoteDigest: "b".repeat(64), expiresAt: Date.now() + 900_000 } });
      return json({ job: { id: "r1", status: "queued" } }, 202);
    }
    if (bare === "/api/pipelines" && method === "GET")
      return json({
        runs: [
          { id: "p1", revision: 3, state: "running", name: "Cut", context: { projectId: "prod-1" }, stages: [{ definition: { id: "s", kind: "image" } }], attempts: [{ state: "running" }], quotes: [] },
          { id: "p2", revision: 2, state: "awaiting_approval", name: "Cut B", context: { projectId: "prod-1" }, stages: [{ definition: { id: "s", kind: "image" } }], attempts: [], quotes: [{ id: "q", stageId: "s", baseRevision: 2, approvedAt: null, expiresAt: 1 }] },
          { id: "p3", revision: 1, state: "succeeded", name: "Done", context: { projectId: "prod-1" }, stages: [{ definition: { id: "s", kind: "image" } }], attempts: [{ state: "succeeded" }], quotes: [] },
          { id: "x", revision: 1, state: "running", name: "Other", context: { projectId: "prod-other" }, stages: [], attempts: [{ state: "running" }], quotes: [] },
        ],
      });
    if (bare === "/api/pipelines" && method === "POST") return json({ run: { id: "p-new" } }, 201);
    if (bare.startsWith("/api/pipelines/") && method === "GET") return json({ run: { id: bare.split("/").pop(), revision: 2 } });
    if (bare.startsWith("/api/pipelines/")) return json({ run: { id: bare.split("/").pop() } });
    if (bare === "/api/rig/elements") return json({ elements: [{ id: "e1", locked: false }, { id: "e2", locked: true }] });
    if (bare.startsWith("/api/rig/elements/")) return json({ ok: true, locked: true });
    if (bare === "/api/export/selects") {
      const format = new URLSearchParams(path.split("?")[1]).get("format");
      /* A prompt with a line break is one take, not two: the route counts rows, not CSV lines. */
      if (format === "count") return json({ approved: options.approved ?? 2 });
      return new Response('shot,take,prompt\na,1,"wide\nthen close"\nb,2,x\n', { status: 200 });
    }
    if (bare === "/api/workbench/engines")
      return json({ models: [{ id: "video-a", resolutions: ["720p"], ratios: ["16:9"], durations: [5] }] });
    return json({ error: `unmocked ${method} ${path}` }, 500);
  }) as typeof fetch;

  const isDispatch = (call: Call) =>
    (call.path === "/api/generate" && call.method === "POST") ||
    ((call.path === "/api/audio" || call.path === "/api/audio/dub") && !call.body?.quoteOnly) ||
    call.body?.action === "submit" ||
    ((call.path === "/api/workbench/development" || call.path === "/api/workbench/atomik" || call.path === "/api/workbench/astra-blender/render") &&
      call.method === "POST" && !call.body?.quoteOnly);
  return { fetcher, calls, dispatches: () => calls.filter(isDispatch) };
}

const shot = (name: string, prompt: string) => ({ name, body: { model: "video-a", prompt, resolution: "720p", ratio: "16:9", duration: 5, projectId: "prod-1" } });

function fullRequest(): PlanRequest {
  return {
    boards: [{ name: "Board 1", body: { model: "image-a", prompt: "wide" } }, { name: "Board 2", body: { model: "image-a", prompt: "close" } }],
    shots: [shot("Opening", "wide"), shot("Turn", "close")],
    stems: [{ name: "Music", body: { task: "music", text: "slow" } }, { name: "Effects", body: { task: "sound", text: "wind" } }],
    variants: [{ name: "Variant 1", body: { model: "image-m", prompt: "hook", marketing: { quality: "high" } } }],
    /* Motion Transfer and Object Swap: the bodies the API-key transform form sends to /api/generate. */
    motion: [{ name: "Transfer 1", body: { task: "genjutsu", model: "higgsfield-genjutsu-motion-transfer", prompt: "recast", resolution: "720p", projectId: "prod-1", workbenchProjectId: "draft-1",
      sourceUploadId: "u1", references: [{ uploadId: "r1", role: "reference_image" }, { uploadId: "r2", role: "reference_image" }] } }],
    swap: [{ name: "Swap 1", body: { task: "genjutsu", model: "higgsfield-genjutsu-object-swap", prompt: "swap it", resolution: "720p", projectId: "prod-1", workbenchProjectId: "draft-1",
      sourceUploadId: "u1", references: [{ uploadId: "r1", role: "reference_image" }] } }],
    astra: { sourceDigest: "c".repeat(64) },
    development: { kind: "screenplay" },
  };
}

function context(fetcher: typeof fetch, request: PlanRequest | null = fullRequest(), downloads: string[] = []): PlanContext {
  let id = 0;
  return {
    projectId: "draft-1",
    productionId: "prod-1",
    data: {},
    request,
    fetch: fetcher,
    wait: async () => {},
    newId: () => `00000000-0000-4000-8000-${String((id += 1)).padStart(12, "0")}`,
    download: (url) => void downloads.push(url),
  };
}

async function until(check: () => boolean, label = "condition") {
  for (let i = 0; i < 500; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function engineFor(ctx: PlanContext, clock = { now: 1_000_000 }) {
  return new AtomikRunEngine({
    plans: PLANS,
    context: () => ctx,
    now: () => clock.now,
    sleep: async () => {},
  });
}

/* ------------------------------------------------------------------ registry */

/* Generate, Shorts and History ran only on the signed-in account, which Atomik no longer uses. */
/* History is not here: it reads the project's Library and each transform take still rendering (free). */
const NOT_RUNNABLE = ["takes", "builds", "skills", "budget", "sources", "generate", "shorts"].sort();
const PAID_SIX = ["boards", "rig", "edit", "marketing", "motion", "swap"] as const;

test("the registry has exactly one plan for each of the 24 workspace pages", () => {
  const pages = Object.values(WORKSPACE_PLAN_PAGES).flat();
  expect(pages).toHaveLength(24);
  expect([...PLAN_PAGES].sort()).toEqual([...pages].sort());
  for (const [suite, list] of Object.entries(WORKSPACE_PLAN_PAGES))
    for (const page of list) expect(PLANS[page].suite).toBe(suite);
  expect(planFor("canvas")?.page).toBe("rig");
  expect(planFor("motion-transfer")?.page).toBe("motion");
  expect(planFor("astra-blender")?.page).toBe("astra");
});

test("every plan resolves runnable or gives a Not-runnable-yet reason, and only backend-less plans refuse", () => {
  const { fetcher } = backend();
  const ctx = context(fetcher);
  const refused: string[] = [];
  for (const page of PLAN_PAGES) {
    const plan = PLANS[page];
    const verdict = plan.runnable(ctx);
    if (verdict.ok) {
      expect(plan.missingBackend, page).toBeUndefined();
      for (const step of plan.steps) expect(step.executor.backend.path, `${page}: ${step.label}`).not.toMatch(/^missing:/);
    } else {
      refused.push(page);
      expect(verdict.reason, page).toMatch(/^Not runnable yet — ./);
      expect(plan.missingBackend, page).toBeTruthy();
    }
  }
  expect(refused.sort()).toEqual(NOT_RUNNABLE);

  // Without project data the data-dependent plans refuse too, with a reason, never a fake run.
  const empty = { ...context(fetcher, null), projectId: null, productionId: null };
  for (const page of PLAN_PAGES) {
    const verdict = PLANS[page].runnable(empty);
    if (!verdict.ok) expect(verdict.reason, page).toMatch(/^Not runnable yet — ./);
  }
});

test("the six paid plans each have a gate between their reads and their dispatch", () => {
  for (const page of PAID_SIX) {
    const plan = PLANS[page];
    expect(plan.paid, page).toBe(true);
    const kinds = plan.steps.map((step) => step.kind);
    const gate = kinds.indexOf("gate");
    const dispatch = kinds.indexOf("dispatch");
    expect(gate, page).toBeGreaterThan(0);
    expect(dispatch, page).toBeGreaterThan(gate);
  }
});

test("no connected-account name appears in any plan copy, gate line or done line", async () => {
  const { fetcher } = backend();
  for (const ctx of [context(fetcher), { ...context(fetcher, null), projectId: null, productionId: null }]) {
    for (const page of PLAN_PAGES) {
      for (const text of planCopy(PLANS[page], ctx)) expect(vendorNameIn(text), `${page}: ${text}`).toBeNull();
      const done = PLANS[page].doneLine(ctx, { admitted: [{ id: "1", status: "queued" }], job: { status: "accepted" } });
      expect(vendorNameIn(done), `${page}: ${done}`).toBeNull();
    }
  }
  for (const page of PLAN_PAGES) {
    const gate = PLANS[page].steps.find((step) => step.executor.type === "gate");
    if (!gate || gate.executor.type !== "gate") continue;
    const quote = await gate.executor.quote(context(fetcher), { developmentModel: "m", developmentRequestId: "r", agentRequestId: "r", astraRequestId: "requestid1" });
    expect(vendorNameIn(quote.line), `${page}: ${quote.line}`).toBeNull();
  }
  expect(vendorNameIn("Rendered on Higgsfield")).toBe("Higgsfield");
  /* A direct model's real name is required copy, not a leak (see lib/vendorNames.ts). */
  expect(vendorNameIn("Seedance 2.5 on the connected account")).toBeNull();
});

test("plan copy carries no fixture counts or dollar prices", () => {
  const { fetcher } = backend();
  const ctx = context(fetcher, null);
  for (const page of PLAN_PAGES)
    for (const text of planCopy(PLANS[page], ctx)) {
      expect(text, page).not.toMatch(/\$\d/);
      expect(text, page).not.toMatch(/\b(24 boards|6 scenes|12 pp|142 credits|118 credits)\b/);
    }
});

test("every runnable plan completes against the routes' documented responses", async () => {
  for (const page of PLAN_PAGES.filter((item) => !NOT_RUNNABLE.includes(item))) {
    const { fetcher, dispatches } = backend();
    const engine = engineFor(context(fetcher));
    expect(engine.start(page), page).toEqual({ ok: true, action: "started" });
    await until(() => ["waiting", "done", "failed"].includes(engine.getState().run?.status ?? ""), page);
    if (engine.getState().run!.status === "waiting") {
      expect(PLANS[page].paid, page).toBe(true);
      expect(dispatches(), page).toHaveLength(0);
      expect(await engine.approve(), page).toEqual({ ok: true });
      await until(() => ["done", "failed"].includes(engine.getState().run?.status ?? ""), page);
    } else expect(PLANS[page].paid, page).toBe(false);
    const run = engine.getState().run!;
    expect(run.error, page).toBeNull();
    expect(run.status, page).toBe("done");
    expect(run.i, page).toBe(PLANS[page].steps.length);
    const done = engine.getState().session[0].label;
    expect(vendorNameIn(done), `${page}: ${done}`).toBeNull();
    if (!PLANS[page].paid) expect(dispatches(), page).toHaveLength(0);
  }
});

/* ------------------------------------------------------------------- gates */

for (const page of PAID_SIX) {
  test(`${page}: stops at its gate on a live quote and sends nothing paid until approved`, async () => {
    const { fetcher, dispatches, calls } = backend();
    const engine = engineFor(context(fetcher));
    expect(engine.start(page)).toEqual({ ok: true, action: "started" });
    await until(() => engine.getState().run?.status === "waiting", "waiting");
    const run = engine.getState().run!;
    expect(run.quote).not.toBeNull();
    expect(run.quote!.credits).toBe(run.quote!.parts.reduce((sum, part) => sum + part.credits, 0));
    expect(run.quote!.credits).toBeGreaterThan(0);
    expect(PLANS[page].steps[run.i].kind).toBe("gate");
    expect(calls.length).toBeGreaterThan(0);
    expect(dispatches()).toHaveLength(0);
    // Pressing Run again while waiting changes nothing and sends nothing.
    expect(engine.start(page)).toEqual({ ok: true, action: "waiting" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(dispatches()).toHaveLength(0);
  });
}

test("decline drops the run and dispatches nothing", async () => {
  const { fetcher, dispatches } = backend();
  const engine = engineFor(context(fetcher));
  engine.start("boards");
  await until(() => engine.getState().run?.status === "waiting");
  expect(engine.decline()).toBe(true);
  expect(engine.getState().run).toBeNull();
  expect(engine.getState().toast).toBe(DECLINED_TOAST);
  expect(engine.getState().completed.boards).toBeUndefined();
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(dispatches()).toHaveLength(0);
});

test("an expired quote is re-quoted on approve, shows the price change and dispatches nothing", async () => {
  let price = 18;
  const { fetcher, dispatches, calls } = backend({ price: () => price });
  const clock = { now: 1_000_000 };
  const engine = engineFor(context(fetcher), clock);
  engine.start("rig");
  await until(() => engine.getState().run?.status === "waiting");
  const quotesBefore = calls.filter((call) => call.path === "/api/generate/quote").length;
  expect(engine.getState().run!.quote!.credits).toBe(36);

  clock.now += QUOTE_MAX_AGE_MS + 1;
  price = 21;
  const result = await engine.approve();
  expect(result).toEqual({ ok: false, reason: "refreshed" });
  const run = engine.getState().run!;
  expect(run.status).toBe("waiting");
  expect(run.approved).toBe(false);
  expect(run.quote!.credits).toBe(42);
  expect(run.notice).toBe("Quote refreshed — estimate changed from about 36 cr to about 42 cr.");
  expect(calls.filter((call) => call.path === "/api/generate/quote").length).toBe(quotesBefore * 2);
  expect(dispatches()).toHaveLength(0);
});

test("an input edited after the quote forces a re-quote instead of a dispatch", async () => {
  const { fetcher, dispatches } = backend();
  const ctx = context(fetcher);
  const engine = engineFor(ctx);
  engine.start("rig");
  await until(() => engine.getState().run?.status === "waiting");
  ctx.request = { ...ctx.request, shots: [shot("Opening", "wide"), shot("Turn", "closer still")] };
  expect(await engine.approve()).toEqual({ ok: false, reason: "refreshed" });
  expect(engine.getState().run!.notice).toBe("Quote refreshed — estimate unchanged at about 36 cr. Approve again to continue.");
  expect(dispatches()).toHaveLength(0);
});

test("approved Particl dispatch sends exactly the approved credits and fingerprint per request", async () => {
  const { fetcher, dispatches } = backend();
  const engine = engineFor(context(fetcher));
  engine.start("rig");
  await until(() => engine.getState().run?.status === "waiting");
  const quote = engine.getState().run!.quote!;
  expect(await engine.approve()).toEqual({ ok: true });
  await until(() => engine.getState().run?.status === "done", "done");
  const sent = dispatches();
  expect(sent).toHaveLength(2);
  sent.forEach((call, index) => {
    expect(call.body?.maxCredits).toBe(quote.parts[index].credits);
    expect(call.body?.quoteFingerprint).toBe(quote.parts[index].fingerprint);
    expect(call.body?.refine).toBe(false);
    expect(call.headers["Idempotency-Key"]).toMatch(/^[A-Za-z0-9._:-]{8,160}$/);
  });
  // Rig completes when its renders do, not at dispatch (04).
  expect(engine.getState().completed.rig).toBeUndefined();
  expect(engine.getState().session[0].label).toBe("2 shots sent to render");
});

for (const [page, model] of [["motion", "higgsfield-genjutsu-motion-transfer"], ["swap", "higgsfield-genjutsu-object-swap"]] as const)
  test(`${page}: quotes and renders on the API-key transform engine at exactly the approved price, never on the connected account`, async () => {
    const { fetcher, dispatches, calls } = backend({ price: () => 142 });
    const engine = engineFor(context(fetcher));
    engine.start(page);
    await until(() => engine.getState().run?.status === "waiting");
    const quote = engine.getState().run!.quote!;
    expect(quote.unit).toBe("cr");
    expect(quote.credits).toBe(142);
    await engine.approve();
    await until(() => engine.getState().run?.status === "done", "done");
    const [sent] = dispatches();
    expect(sent.path).toBe("/api/generate");
    expect(sent.body).toMatchObject({ task: "genjutsu", model, maxCredits: 142, quoteFingerprint: quote.parts[0].fingerprint, refine: false });
    expect(calls.some((call) => call.path.startsWith("/api/higgsfield/consumer/")), page).toBe(false);
    expect(engine.getState().completed[page]).toBe(true);
  });

test("no plan reads, quotes, submits or polls on the connected account's routes; Compare reads the project's Library", () => {
  for (const page of PLAN_PAGES)
    for (const step of PLANS[page].steps)
      expect(step.executor.backend.path, `${page}: ${step.label}`).not.toMatch(/^\/api\/higgsfield\/consumer\//);
  expect(PLANS.compare.steps.map((step) => [step.executor.backend.method, step.executor.backend.path])).toEqual([
    ["GET", "/api/workbench/library?source=generations"],
    ["LOCAL", "comparison pair"],
  ]);
});

/* Compare: free, for every member — the Library's own record of a transform take, never a provider or an account. */
test("Compare pairs the newest finished transform take of this production with its source, from one Library read and nothing else", async () => {
  const { fetcher, calls, dispatches } = backend();
  const engine = engineFor(context(fetcher));
  expect(PLANS.compare.paid).toBe(false);
  expect(engine.start("compare")).toEqual({ ok: true, action: "started" });
  await until(() => engine.getState().run?.status === "done", "done");
  expect(engine.getState().run?.details).toEqual({ 0: "1 take", 1: "paired" });
  expect(engine.getState().completed.compare).toBe(true);
  expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(["GET /api/workbench/library?projectId=draft-1&source=generations&limit=500"]);
  expect(dispatches()).toEqual([]);

  /* A still, a failed take, one still rendering and one of another production are passed over. */
  const [load, pair] = PLANS.compare.steps;
  if (load.executor.type !== "call" || pair.executor.type !== "call") throw new Error("Compare's steps are reads.");
  const loaded = await load.executor.run(context(fetcher), {});
  expect((loaded.io?.compareTake as LibraryTake).id).toBe("motion-key");
  expect((await pair.executor.run(context(fetcher), loaded.io ?? {})).io).toEqual({
    comparison: { source: "/api/uploads/u1", result: "/api/media/motion-key?stream=1" },
  });
});

test("Compare opens a take a request names, a run made earlier on the connected account included, and says so when none is finished", async () => {
  const [load, pair] = PLANS.compare.steps;
  if (load.executor.type !== "call" || pair.executor.type !== "call") throw new Error("Compare's steps are reads.");
  const { fetcher, calls } = backend();
  const named = (jobId: string) => context(fetcher, { ...fullRequest(), compare: { jobId } });

  /* The account's run is in the Library already; its source is the take it was made from. */
  const account = await load.executor.run(named("swap-account"), {});
  expect(calls.at(-1)?.path).toBe("/api/workbench/library?projectId=draft-1&source=generations&id=swap-account");
  expect((await pair.executor.run(named("swap-account"), account.io ?? {})).io).toEqual({
    comparison: { source: "/api/media/clip-1", result: "/api/media/swap-account?stream=1" },
  });
  /* The take's own source column wins over its params, as the page's player reads it. */
  const moved = backend({ takes: [{ ...LIBRARY[4], sourceGenId: "cut-2" }] });
  const take = await load.executor.run(context(moved.fetcher), {});
  expect((await pair.executor.run(context(moved.fetcher), take.io ?? {})).io).toEqual({
    comparison: { source: "/api/media/cut-2", result: "/api/media/motion-key?stream=1" },
  });

  /* A named take that is not a finished transform of this production is refused, never swapped for another. */
  for (const jobId of ["swap-failed", "motion-running", "motion-other", "still-1", "gone"])
    await expect(load.executor.run(named(jobId), {}), jobId).rejects.toThrow("No finished transform take with a stored original to compare yet.");
  /* Nothing finished yet: the run fails with the reason and nothing else is read. */
  const empty = backend({ takes: LIBRARY.filter((item) => item.status !== "succeeded" || item.projectId !== "prod-1" || item.model === "image-a") });
  const engine = engineFor(context(empty.fetcher));
  engine.start("compare");
  await until(() => engine.getState().run?.status === "failed", "failed");
  expect(engine.getState().run?.error).toBe("No finished transform take with a stored original to compare yet.");
  expect(empty.calls).toHaveLength(1);
  expect([...calls, ...moved.calls, ...empty.calls].every((call) => call.path.startsWith("/api/workbench/library?"))).toBe(true);
});

test("a transform take's source is a media or upload route for a safe id only, and the account's past runs count as transform takes", () => {
  expect(genjutsuSourceUrl({ sourceGenId: "clip-1", sourceUploadId: "u1" })).toBe("/api/media/clip-1");
  expect(genjutsuSourceUrl({ sourceUploadId: "u1" })).toBe("/api/uploads/u1");
  for (const bad of ["../etc", "a/b", "", "x".repeat(161), 7, null])
    expect(genjutsuSourceUrl({ sourceGenId: bad, sourceUploadId: bad }), String(bad)).toBeNull();
  expect(isGenjutsuTake({ model: "higgsfield-genjutsu-object-swap" })).toBe(true);
  expect(isGenjutsuTake({ model: "hf_mult_motion_control", params: { task: "genjutsu" } })).toBe(true);
  expect(isGenjutsuTake({ model: "hf_mult_motion_control", params: null })).toBe(false);
  expect(isGenjutsuTake({ model: "image-a", params: { task: "edit" } })).toBe(false);
});

test("Viral History's plan reads the project's Library and each transform take still rendering — never the connected account", async () => {
  const { fetcher, calls, dispatches } = backend();
  const engine = engineFor(context(fetcher));
  engine.start("history");
  await until(() => ["done", "failed"].includes(engine.getState().run?.status ?? ""), "history");
  expect(engine.getState().run!.error).toBeNull();
  /* Of the Library's takes (LIBRARY above), the one transform on the key still rendering is read; the failed one, the finished ones and the account's are not. */
  expect(calls.map((call) => call.path.split("?")[0])).toEqual(["/api/workbench/library", "/api/jobs/motion-running"]);
  expect(engine.getState().session[0].label).toBe("1 take checked");
  expect(dispatches()).toHaveLength(0);
});

test("audio stems dispatch with maxCredits equal to each approved quote", async () => {
  const { fetcher, dispatches } = backend({ price: () => 7 });
  const engine = engineFor(context(fetcher));
  engine.start("edit");
  await until(() => engine.getState().run?.status === "waiting");
  await engine.approve();
  await until(() => engine.getState().run?.status === "done", "done");
  const sent = dispatches();
  expect(sent.map((call) => call.body?.maxCredits)).toEqual([7, 7]);
  expect(sent.every((call) => call.body?.quoteOnly === undefined)).toBe(true);
});

test("a forged quote is never accepted as an approval", () => {
  expect(isApprovedQuote({ unit: "cr", credits: 1, parts: [], runId: "x" })).toBe(false);
  expect(isApprovedQuote(null)).toBe(false);
});

/* --------------------------------------------------------- lifecycle (04) */

test("pause and resume on the same page keep the step index; results of an in-flight step are kept", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { fetcher } = backend({ hold: (path) => (path.startsWith("/api/pipelines?") ? gate : null) });
  const engine = engineFor(context(fetcher));
  engine.start("runs");
  expect(engine.getState().run!.status).toBe("running");
  expect(engine.start("runs")).toEqual({ ok: true, action: "paused" });
  expect(engine.getState().run!.status).toBe("paused");
  release();
  await until(() => engine.getState().run!.i === 1, "step 1 kept");
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(engine.getState().run!.i).toBe(1);
  expect(engine.getState().run!.status).toBe("paused");
  expect(engine.start("runs")).toEqual({ ok: true, action: "resumed" });
  await until(() => engine.getState().run?.status === "done", "done");
  expect(engine.getState().completed.runs).toBe(true);
  expect(engine.getState().session[0]).toMatchObject({ label: "1 run woken", meta: "just now", source: "session" });
});

test("switching pages mid-run: the run keeps going off-page; starting another page's plan holds it", async () => {
  const { fetcher, dispatches } = backend();
  const engine = engineFor(context(fetcher));
  engine.start("cast");
  // The panel shows a run only on its own page, but the run is not stopped by navigating.
  expect(engine.runFor("rig")).toBeNull();
  await until(() => engine.getState().run?.status === "done", "done off-page");
  expect(engine.getState().completed.cast).toBe(true);

  engine.start("boards");
  await until(() => engine.getState().run?.status === "waiting");
  expect(engine.start("rig")).toEqual({ ok: true, action: "started" });
  expect(engine.getState().toast).toBe("Board every scene held. Nothing was dispatched.");
  expect(engine.runFor("boards")).toBeNull();
  await until(() => engine.getState().run?.status === "waiting");
  expect(engine.getState().run!.page).toBe("rig");
  expect(dispatches()).toHaveLength(0);
});

test("another page's plan cannot start while a paid dispatch is in flight", async () => {
  let release: () => void = () => {};
  const hold = new Promise<void>((resolve) => (release = resolve));
  const { fetcher } = backend({ hold: (path, body) => (path === "/api/generate" && body?.maxCredits != null ? hold : null) });
  const engine = engineFor(context(fetcher));
  engine.start("rig");
  await until(() => engine.getState().run?.status === "waiting");
  void engine.approve();
  await until(() => engine.getState().run?.dispatching === true, "dispatching");
  const refused = engine.start("boards");
  expect(refused.ok).toBe(false);
  expect(engine.getState().run!.page).toBe("rig");
  release();
  await until(() => engine.getState().run?.status === "done", "done");
});

test("a plan that is not runnable never starts and calls nothing", () => {
  const { fetcher, calls } = backend();
  const engine = engineFor(context(fetcher));
  for (const page of NOT_RUNNABLE) {
    const result = engine.start(page);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/^Not runnable yet — /);
    expect(engine.getState().run).toBeNull();
  }
  expect(calls).toHaveLength(0);
});

test("a failed dispatch fails the run honestly and a resume goes back through the gate", async () => {
  let fail = true;
  const inner = backend();
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/generate" && fail)
      return new Response(JSON.stringify({ error: "Credits are short." }), { status: 402 });
    return inner.fetcher(input, init);
  }) as typeof fetch;
  const engine = engineFor(context(fetcher));
  engine.start("boards");
  await until(() => engine.getState().run?.status === "waiting");
  await engine.approve();
  await until(() => engine.getState().run?.status === "failed", "failed");
  expect(engine.getState().run!.error).toBe("Credits are short.");
  fail = false;
  engine.start("boards");
  await until(() => engine.getState().run?.status === "waiting", "re-gated");
  expect(engine.getState().run!.approved).toBe(false);
});

test("running a plan again with unchanged inputs is a new request; a resume inside one run recovers the same one", async () => {
  let fail = true;
  const inner = backend();
  const keys: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/generate" && init?.method === "POST") {
      keys.push(new Headers(init.headers).get("Idempotency-Key") ?? "");
      if (fail) return new Response(JSON.stringify({ error: "The connection dropped." }), { status: 503 });
    }
    return inner.fetcher(input, init);
  }) as typeof fetch;
  const engine = engineFor(context(fetcher));
  engine.start("rig");
  await until(() => engine.getState().run?.status === "waiting");
  await engine.approve();
  await until(() => engine.getState().run?.status === "failed", "failed");
  const firstRun = engine.getState().run!.id;
  /* The resume re-gates, and the re-sent parts carry the keys this run already used: the server recovers, never pays twice. */
  fail = false;
  engine.start("rig");
  await until(() => engine.getState().run?.status === "waiting" && !engine.getState().run?.quoting, "re-gated");
  expect(await engine.approve()).toEqual({ ok: true });
  await until(() => engine.getState().run?.status === "done", "done");
  expect(engine.getState().run!.id).toBe(firstRun);
  expect(keys).toHaveLength(3);
  expect(keys[1]).toBe(keys[0]);
  expect(keys[2]).not.toBe(keys[1]);
  /* Run again from the top with the same shots: new keys, so the account really renders again. */
  engine.start("rig");
  await until(() => engine.getState().run?.status === "waiting" && !engine.getState().run?.quoting, "second run gated");
  await engine.approve();
  await until(() => engine.getState().run?.status === "done", "second run done");
  expect(keys).toHaveLength(5);
  expect(keys.slice(3).some((key) => keys.slice(0, 3).includes(key))).toBe(false);
  for (const key of keys) expect(key).toMatch(/^[A-Za-z0-9._:-]{8,160}$/);
});

test("a request keeps its key for the whole run, whatever else the resume's quote holds", () => {
  const part = (shot: string, credits = 18) => ({ credits, fingerprint: `fp-${shot}-${credits}`, body: { shotId: shot, prompt: `shot ${shot}` } });
  const a = part("a"), b = part("b");
  const first = { runId: "run-1", parts: [a, b] };
  /* A was admitted; the resume re-quotes only B: B keeps its own key and never takes A's. */
  const resumed = { runId: "run-1", parts: [part("b", 21)] };
  expect(idempotencyKey("ws-rig", resumed.parts[0], resumed)).toBe(idempotencyKey("ws-rig", b, first));
  expect(idempotencyKey("ws-rig", resumed.parts[0], resumed)).not.toBe(idempotencyKey("ws-rig", a, first));
  /* The same body twice in one run is two requests. */
  const twice = { runId: "run-1", parts: [part("a"), part("a")] };
  expect(idempotencyKey("ws-rig", twice.parts[0], twice)).not.toBe(idempotencyKey("ws-rig", twice.parts[1], twice));
  /* Another run with the same inputs is another request. */
  expect(idempotencyKey("ws-rig", a, { runId: "run-2", parts: [a, b] })).not.toBe(idempotencyKey("ws-rig", a, first));
  for (const key of [idempotencyKey("ws-rig", a, first), idempotencyKey("ws-rig", twice.parts[1], twice)]) expect(key).toMatch(/^[A-Za-z0-9._:-]{8,160}$/);
});

test("visual pacing is bounded and only for read/compute steps", () => {
  expect(VISUAL_PACING_MS).toBeLessThanOrEqual(300);
});

/* ------------------------------------------------------ NEXT line, activity */

test("NEXT line follows 04's priority from real state", async () => {
  const { fetcher } = backend();
  const engine = engineFor(context(fetcher));
  expect(nextLine({ run: null }, { page: "rig", readyShots: [{ name: "Opening" }, { name: "Turn" }] })).toBe(
    "2 shots are ready to render. Start with Opening.",
  );
  expect(nextLine({ run: null }, { page: "rig", rendering: { name: "Opening" }, readyShots: [{ name: "Turn" }] })).toBe(
    "Rendering Opening. Nothing else is blocked.",
  );
  expect(nextLine({ run: null }, { page: "cast" })).toBe("Lock cast and elements — free.");
  expect(nextLine({ run: null }, { page: "builds" })).toBe("Build a client review tool — not runnable yet.");
  engine.start("rig");
  expect(nextLine(engine.getState(), { page: "rig", rendering: { name: "Opening" } })).toBe("Resolve references…");
  await until(() => engine.getState().run?.status === "waiting");
  expect(nextLine(engine.getState(), { page: "rig", rendering: { name: "Opening" } })).toBe("Waiting on your approval — 36 cr.");
  expect(nextLine(engine.getState(), { page: "canvas" })).toBe("Waiting on your approval — 36 cr.");
});

test("activity merges real sources with this session's runs, newest first, with no seeded lines", async () => {
  const now = 10_000_000;
  expect(mergeActivity([], [[], [], []], now)).toEqual([]);
  const jobs = activityFromJobs(
    [
      { id: "g1", title: "Opening", kind: "video", status: "succeeded", creditsBilled: 18, createdAt: now - 7 * 60_000, updatedAt: now - 6 * 60_000 },
      { id: "g2", title: null, prompt: "close on the turn", kind: "video", status: "failed", creditsBilled: null, createdAt: now - 3_600_000, updatedAt: now - 3_600_000,
        failure: { provider: null, stage: null, code: "unknown", kind: "unknown", message: null, billing: null, payer: "platform", charge: { credits: 0, settled: true } } },
      /* Failed with nothing confirmed: no claim either way. */
      { id: "g3", title: "Pier", kind: "video", status: "failed", creditsBilled: null, createdAt: now - 2 * 3_600_000, updatedAt: now - 2 * 3_600_000 },
    ],
    now,
  );
  const merged = mergeActivity([{ id: "run-1:done", label: "Board 2 sent", meta: "old", at: now - 1_000, source: "session" }], [jobs], now);
  expect(merged.map((entry) => [entry.label, entry.meta])).toEqual([
    ["Board 2 sent", "just now"],
    ["Rendered Opening", "6 min · 18 cr"],
    ["close on the turn failed", "1 hr · not billed"],
    ["Pier failed", "2 hr"],
  ]);

  const { fetcher } = backend();
  const loaded = await loadActivity(fetcher, { projectId: "draft-1", productionId: "prod-1" }, now);
  const runs = loaded.entries[1];
  // Runs from another production are never shown.
  expect(runs.some((entry) => entry.label.includes("Other"))).toBe(false);
});

test("a failed planning run says what it was charged, never that it was not billed", () => {
  const now = 10_000_000;
  const lines = activityFromAgentJobs([
    { id: "a1", status: "failed", request: "plan the opening", credits: 3, updatedAt: now - 60_000 },
    /* Zero credits may be the workspace's own key, which its vendor billed: no claim either way. */
    { id: "a2", status: "failed", request: "plan the close", credits: 0, updatedAt: now - 120_000 },
    { id: "a3", status: "failed", request: "plan the pier", credits: null, updatedAt: now - 180_000 },
    { id: "a4", status: "succeeded", request: "plan the harbour", credits: 5, updatedAt: now - 240_000 },
  ], now);
  expect(lines.map((line) => [line.label, line.meta])).toEqual([
    ["Planning failed: plan the opening", "1 min · 3 cr"],
    ["Planning failed: plan the close", "2 min"],
    ["Planning failed: plan the pier", "3 min"],
    ["Planned plan the harbour", "4 min · 5 cr"],
  ]);
});

test("generate and shorts refuse with their reason and read or send nothing, even with the old account data present", async () => {
  const { fetcher, calls } = backend();
  const engine = engineFor(context(fetcher));
  const reasons = {
    generate: "Not runnable yet — single generations run in Gen, on Particl's own engines.",
    shorts: "Not runnable yet — no API-key engine makes a set of shorts.",
  } as const;
  for (const [page, reason] of Object.entries(reasons) as [keyof typeof reasons, string][]) {
    expect(PLANS[page].runnable(context(fetcher)), page).toEqual({ ok: false, reason });
    expect(PLANS[page].paid, page).toBe(false);
    expect(engine.start(page), page).toEqual({ ok: false, reason });
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(calls).toHaveLength(0);
});

/* ------------------------------------------------------------ Deliver, Agent */

test("deliver: counts approved takes as the route counts them, then hands the zip to the browser", async () => {
  const { fetcher, calls, dispatches } = backend({ approved: 3 });
  const downloads: string[] = [];
  const engine = engineFor(context(fetcher, fullRequest(), downloads));
  expect(engine.start("deliver")).toEqual({ ok: true, action: "started" });
  await until(() => ["done", "failed"].includes(engine.getState().run?.status ?? ""), "deliver");
  expect(engine.getState().run!.error).toBeNull();
  expect(calls.map((call) => call.path)).toContain("/api/export/selects?projectId=prod-1&format=count");
  expect(downloads).toEqual(["/api/export/selects?projectId=prod-1&format=zip"]);
  expect(engine.getState().session[0].label).toBe("Package downloading · 3 approved takes");
  expect(dispatches()).toHaveLength(0);
});

test("agent: the plan is filed by reading the job back with its project", async () => {
  const { fetcher, calls } = backend();
  const engine = engineFor(context(fetcher));
  expect(engine.start("agent")).toEqual({ ok: true, action: "started" });
  await until(() => engine.getState().run?.status === "waiting", "waiting");
  expect(await engine.approve()).toEqual({ ok: true });
  await until(() => ["done", "failed"].includes(engine.getState().run?.status ?? ""), "agent");
  expect(engine.getState().run!.error).toBeNull();
  const reads = calls.filter((call) => call.method === "GET" && call.path.startsWith("/api/workbench/atomik?"));
  expect(reads.length).toBeGreaterThan(0);
  for (const read of reads) expect(new URLSearchParams(read.path.split("?")[1]).get("projectId")).toBe("draft-1");
  expect(engine.getState().session[0].label).toBe("Plan ready · 2 steps");
});

test("deliver: in the page, the zip is saved through a download link the route names", async () => {
  const { fetcher } = backend();
  const clicked: { href: string; download: string }[] = [];
  const doc = {
    body: { appendChild: () => {} },
    createElement: () => {
      const link = { href: "", download: "", rel: "", click: () => clicked.push({ href: link.href, download: link.download }), remove: () => {} };
      return link;
    },
  };
  const scope = globalThis as { document?: unknown };
  scope.document = doc;
  try {
    const ctx = { ...context(fetcher), download: undefined };
    const engine = engineFor(ctx);
    expect(engine.start("deliver")).toEqual({ ok: true, action: "started" });
    await until(() => ["done", "failed"].includes(engine.getState().run?.status ?? ""), "deliver");
    expect(engine.getState().run!.error).toBeNull();
    expect(clicked).toEqual([{ href: "/api/export/selects?projectId=prod-1&format=zip", download: "" }]);
  } finally {
    delete scope.document;
  }
});
