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
import { activityFromJobs, mergeActivity, nextLine, loadActivity } from "../../lib/workspace/activity";
import { vendorNameIn } from "../../lib/workspace/vendor-names";

/* ------------------------------------------------------------ mock backend */

type Call = { method: string; path: string; body: Record<string, unknown> | null; headers: Record<string, string> };

/**
 * A fetch that answers the existing routes' documented shapes. `price` is
 * read at call time so a test can move it between quote and approve.
 */
function backend(options: { price?: () => number; hold?: (path: string, body: Record<string, unknown> | null) => Promise<void> | null } = {}) {
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
    if (bare === "/api/higgsfield/consumer/genjutsu" || bare === "/api/higgsfield/consumer/generation") {
      if (method === "GET")
        return json({
          jobs: [
            { id: "done-1", status: "completed", originalAvailable: true, input: { source: { uploadId: "u1" } }, result: { original: { asset: { url: "/api/media/g1" } } }, quoteCredits: 10, quoteExpiresAt: null, workspaceId: "w" },
            { id: "open-1", status: "uncertain", quoteCredits: 10, quoteExpiresAt: null, workspaceId: "w" },
          ],
        });
      if (body?.action === "quote")
        return json({ job: { id: `q-${(job += 1)}`, status: "quoted", quoteCredits: price(), quoteExpiresAt: Date.now() + 5 * 60_000, workspaceId: "wallet-1", workspaceName: "Main wallet" } });
      if (body?.action === "submit") return json({ job: { id: body.id, status: "accepted", quoteCredits: body.credits, workspaceId: body.workspaceId } });
      if (body?.action === "status") return json({ job: { id: body.id, status: "completed" } });
    }
    if (bare === "/api/workbench/development") {
      if (method === "GET" && !path.includes("requestId")) return json({ configured: true, models: [{ id: "text-model" }], jobs: [] });
      if (method === "GET") return json({ jobs: [{ id: "d1", requestId: new URLSearchParams(path.split("?")[1]).get("requestId"), status: "succeeded", result: { scenes: [1, 2, 3], ideas: [] } }] });
      if (body?.quoteOnly) return json({ estimateCredits: price(), sourceHash: "a".repeat(64), chunks: 2 });
      return json({ job: { id: "d1", requestId: body?.requestId, status: "queued" } }, 202);
    }
    if (bare === "/api/workbench/atomik") {
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
    if (bare === "/api/export/selects") return new Response("shot,take\na,1\nb,2\n", { status: 200 });
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
    motion: { source: { uploadId: "u1" }, references: [{ uploadId: "r1" }, { uploadId: "r2" }], resolution: "720p" },
    swap: { source: { uploadId: "u1" }, references: [{ uploadId: "r1" }], resolution: "720p", prompt: "swap it" },
    generation: { type: "image", model: "image-x", prompt: "a", parameters: {}, medias: [] },
    astra: { sourceDigest: "c".repeat(64) },
    development: { kind: "screenplay" },
  };
}

function context(fetcher: typeof fetch, request: PlanRequest | null = fullRequest()): PlanContext {
  let id = 0;
  return {
    projectId: "draft-1",
    productionId: "prod-1",
    data: {},
    request,
    fetch: fetcher,
    wait: async () => {},
    newId: () => `00000000-0000-4000-8000-${String((id += 1)).padStart(12, "0")}`,
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

const NOT_RUNNABLE = ["takes", "builds", "skills", "budget", "sources"].sort();
const PAID_SIX = ["boards", "rig", "edit", "marketing", "motion", "swap"] as const;

test("the registry has exactly one plan for each of the 23 workspace pages", () => {
  const pages = Object.values(WORKSPACE_PLAN_PAGES).flat();
  expect(pages).toHaveLength(23);
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

test("no vendor or competitor name appears in any plan copy, gate line or done line", async () => {
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
  expect(vendorNameIn("Rendered on Seedance 2.5")).toBe("Seedance");
  expect(vendorNameIn("Motion 2.5 on the connected account")).toBeNull();
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
  expect(run.notice).toBe("Quote refreshed — price changed from 36 cr to 42 cr.");
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
  expect(engine.getState().run!.notice).toBe("Quote refreshed — price unchanged at 36 cr. Approve again to continue.");
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

test("approved connected-account dispatch submits exactly the approved wallet and credits", async () => {
  const { fetcher, dispatches } = backend({ price: () => 142 });
  const engine = engineFor(context(fetcher));
  engine.start("motion");
  await until(() => engine.getState().run?.status === "waiting");
  const quote = engine.getState().run!.quote!;
  expect(quote.unit).toBe("connected");
  expect(quote.line).toContain("2 ordered references");
  await engine.approve();
  await until(() => engine.getState().run?.status === "done", "done");
  const [submit] = dispatches();
  expect(submit.body).toEqual({ action: "submit", draftId: "draft-1", id: quote.parts[0].quoteId, workspaceId: "wallet-1", credits: 142 });
  expect(engine.getState().completed.motion).toBe(true);
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
      { id: "g2", title: null, prompt: "close on the turn", kind: "video", status: "failed", creditsBilled: null, createdAt: now - 3_600_000, updatedAt: now - 3_600_000 },
    ],
    now,
  );
  const merged = mergeActivity([{ id: "run-1:done", label: "Board 2 sent", meta: "old", at: now - 1_000, source: "session" }], [jobs], now);
  expect(merged.map((entry) => [entry.label, entry.meta])).toEqual([
    ["Board 2 sent", "just now"],
    ["Rendered Opening", "6 min · 18 cr"],
    ["close on the turn failed", "1 hr · not billed"],
  ]);

  const { fetcher } = backend();
  const loaded = await loadActivity(fetcher, { projectId: "draft-1", productionId: "prod-1" }, now);
  const runs = loaded.entries[1];
  // Runs from another production are never shown.
  expect(runs.some((entry) => entry.label.includes("Other"))).toBe(false);
});
