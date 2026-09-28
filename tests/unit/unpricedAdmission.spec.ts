import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import type { AdmissionActor, PreparedAdmission } from "../../lib/admissionTypes";
import type { TenantWorkspace } from "../../lib/tenant";

/**
 * A job the platform's key would pay for is never admitted without a
 * confirmed price, whichever door it comes through (needsConfirmedPrice in
 * lib/generationAdmission.ts). Before, a direct POST /api/generate without a
 * quote fingerprint, for settings no price exists for (Seedance's "adaptive"
 * ratio, which is also what a caller naming no ratio gets), was admitted at
 * an estimate of nothing, and its completion billed credits for whatever the
 * vendor reported.
 *
 * With shared studio credits every workspace's work is the platform's to pay:
 * a key a workspace kept from the old billing mode never funds new work
 * (lib/vendorKeys.ts), so the refusal reaches every workspace. What stays
 * legitimately unpriced keeps its old behaviour: connected-account work, and
 * a job already admitted, replayed or settling.
 *
 * No paid call: ENGINE_MOCK, a queue that only records, a stubbed poll, and
 * the network refused.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-unpriced-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.BLOB_READ_WRITE_TOKEN = "";
process.env.ENGINE_MOCK = "1";

const SEEDANCE = "dreamina-seedance-2-5-260628";
const NO_PRICE = "This model has no confirmed price.";
/** A take no price exists for: the ratio is only known once the engine renders. */
const unpriced = { model: SEEDANCE, prompt: "raw: A lighthouse at dusk", ratio: "adaptive", resolution: "720p", duration: 5, projectId: "project", refine: false };
const priced = { ...unpriced, ratio: "16:9" };

const owner: AdmissionActor = {
  user: { id: "owner", email: "owner@example.invalid", name: "Owner", role: "admin", owner: true, disabled: false, createdAt: 0, lastSeen: null },
};
/** A workspace API token (the OpenAPI actions, MCP, scripts): it renders, under its own monthly ceiling. */
const agent: AdmissionActor = { ...owner, token: { id: "tok_agent", name: "Agent", scope: "render", capUsd: null, capCredits: 500 } };

const stored: string[] = [];
test.afterAll(async () => {
  await Promise.all(stored.map((id) => unlink(path.join(process.cwd(), ".data", "generations", `${id}.mp4`)).catch(() => {})));
});

const nodeRequire = createRequire(path.resolve("package.json"));
function load<T>(file: string, overrides: Record<string, unknown> = {}): T {
  const source = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const target = { exports: {} };
  new Function("require", "module", "exports", source)(
    (name: string) => {
      if (name in overrides) return overrides[name];
      return name.startsWith("@/")
        ? nodeRequire(path.resolve(name.slice(2) + ".ts"))
        : name.startsWith(".")
          ? nodeRequire(path.resolve(path.dirname(file), name + ".ts"))
          : nodeRequire(name);
    },
    target,
    target.exports,
  );
  return target.exports as T;
}

let dispatched: { genId: string; kind: string }[] = [];
const queue = { enqueueRender: async (genId: string, kind: string) => { dispatched.push({ genId, kind }); return true; } };
const noInline = () => { throw new Error("Durable dispatch acknowledged; inline work must not run"); };
type Handler = { POST(req: Request): Promise<Response> };
type Service = typeof import("../../lib/generationAdmission");
type Scope = { gen: Service; generate: Handler; quote: Handler; ws: TenantWorkspace };

/** How a workspace was set up: its credits, keys kept from the old billing mode, a stored own-keys mode, or the studio's own workspace. */
type Funding = { name: string; keys?: Record<string, string>; platformKeys?: boolean; legacy?: boolean; credits?: number };

async function scope(funding: Funding, who: AdmissionActor, fn: (s: Scope) => Promise<void>) {
  const { platformReady, platformDb, rowToWorkspace, grantCredits } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { ready, db } = await import("../../lib/db");
  await platformReady();
  const name = `unpriced-${funding.name}-${randomUUID().slice(0, 8)}`;
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,?,'owner',0,0,20,200)",
    args: [name, name, name, `file:${path.join(dir, name + ".db")}`, funding.platformKeys === false ? 0 : 1],
  });
  if ((funding.credits ?? 10000) > 0) await grantCredits(name, funding.credits ?? 10000, "Test", "owner", "manual");
  const row = (await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [name] })).rows[0];
  const ws: TenantWorkspace = { ...rowToWorkspace(row), keys: funding.keys ?? {}, ...(funding.legacy ? { legacy: true } : {}) };
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Network forbidden in the unpriced admission test"); };
  dispatched = [];
  try {
    await runInTenant(ws, async () => {
      await ready();
      await db().execute("INSERT INTO projects(id,name,created_at) VALUES('project','Project',0)");
      await db().execute("INSERT INTO settings(key,value,updated_at) VALUES('promptWriter','none',0) ON CONFLICT(key) DO UPDATE SET value='none'");
      const gen = load<Service>("lib/generationAdmission.ts", { "@/lib/inngest": queue });
      const auth = { withTenant: (handler: unknown) => handler, requireRender: async () => who };
      await fn({
        gen,
        ws,
        generate: load<Handler>("app/api/generate/route.ts", { "@/lib/auth": auth, "@/lib/generationAdmission": gen, "next/server": { NextResponse: Response, after: noInline } }),
        quote: load<Handler>("app/api/generate/quote/route.ts", { "@/lib/auth": auth, "@/lib/generationAdmission": gen }),
      });
    }, who);
  } finally {
    globalThis.fetch = fetch;
  }
}

function post(body: unknown, key: string, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key, ...headers },
    body: JSON.stringify(body),
  });
}
async function quoteOf(s: Scope, body: unknown) {
  const { workbenchScopeFor } = await import("../../lib/workbench/request-scope");
  return s.quote.POST(new Request("http://localhost/api/generate/quote", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Workbench-Scope": workbenchScopeFor(s.ws.id, owner.user.id) },
    body: JSON.stringify(body),
  }));
}
async function rows() {
  const { db } = await import("../../lib/db");
  return (await db().execute("SELECT * FROM generations ORDER BY id")).rows;
}
async function meters() {
  const { platformDb } = await import("../../lib/platform");
  const { requireTenant } = await import("../../lib/tenant");
  return (await platformDb().execute({ sql: "SELECT * FROM meter_events WHERE workspace_id=?", args: [requireTenant().id] })).rows;
}
async function balance() {
  const { creditState } = await import("../../lib/credits");
  return (await creditState())?.balance ?? null;
}
function value(result: Awaited<ReturnType<Service["prepareGeneration"]>>): PreparedAdmission {
  expect(result, JSON.stringify(result)).toHaveProperty("ok", true);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.value;
}
async function refused(response: Response, door: string) {
  expect(response.status, door).toBe(400);
  expect(await response.json(), door).toEqual({ error: NO_PRICE });
}

test("on the platform's key an unpriced take is refused at every door, before any row, reservation, credit or dispatch", async () =>
  scope({ name: "platform" }, owner, async (s) => {
    const before = await balance();
    expect(before).toBe(10000);
    /* The quote (Gen, the Rig, Atomik, the Make tools, MCP) and pipeline preparation: the same answer as ever. */
    await refused(await quoteOf(s, unpriced), "quote");
    expect(await s.gen.prepareGeneration(unpriced, owner)).toMatchObject({ ok: false, status: 400, body: { error: NO_PRICE } });
    /* Direct posts with no fingerprint, in the shapes the doors that send one send. */
    const doors: [string, Record<string, unknown>][] = [
      ["api-no-fingerprint", unpriced],
      /* The Rig canvas prices a node it cannot price at nothing, and sends that as its ceiling. */
      ["canvas-zero-ceiling", { ...unpriced, maxCredits: 0 }],
      /* A ceiling approved against another figure is still not a price for this one (a Make batch). */
      ["batch-ceiling", { ...unpriced, maxCredits: 40 }],
      /* An API action that names no ratio gets the engine's first, which is "adaptive". */
      ["api-default-ratio", { model: SEEDANCE, prompt: "raw: A lighthouse at dusk" }],
      /* A first frame does not price a ratio either. */
      ["api-first-frame", { ...unpriced, references: [{ genId: "frame", role: "first_frame" }] }],
    ];
    const { db } = await import("../../lib/db");
    await db().execute("INSERT INTO generations(id,kind,model,prompt,params,status,stored_url,created_at,updated_at) VALUES('frame','image','gemini-3.1-flash-image','Frame','{}','succeeded','/api/media/frame',0,0)");
    for (const [door, body] of doors) {
      const response = await s.generate.POST(post(body, `refused-${door}`));
      expect(response.headers.get("Idempotency-Status"), door).toBe("complete");
      await refused(response, door);
    }
    /* The refusal is the request's answer for good: asked again, it replays without admission running. */
    const again = await s.generate.POST(post(unpriced, "refused-api-no-fingerprint"));
    expect(again.headers.get("Idempotency-Replayed")).toBe("true");
    await refused(again, "replay");
    expect((await rows()).map((row) => row.id)).toEqual(["frame"]);
    expect(await meters()).toHaveLength(0);
    expect(dispatched).toHaveLength(0);
    expect(await balance()).toBe(before);
    /* A priced take through the same bare door is admitted exactly as before, reserved at its quote. */
    const quote = value(await s.gen.prepareGeneration(priced, owner)).quote;
    const accepted = await s.generate.POST(post(priced, "priced-no-fingerprint"));
    const body = await accepted.json();
    expect(accepted.status, JSON.stringify(body)).toBe(202);
    expect(body.status).toBe("queued");
    const [meter] = await meters();
    expect(meter).toMatchObject({ id: body.id, status: "running", paid_by_platform: 1 });
    expect(Number(meter.billed_credits)).toBe(quote.estimatedCredits);
    expect(quote.estimatedCredits).toBeGreaterThan(0);
    expect(dispatched).toEqual([{ genId: body.id, kind: "video" }]);
  }));

test("an unpriced take is refused rather than parked, even with no credits to hold it against", async () =>
  scope({ name: "empty", credits: 0 }, owner, async (s) => {
    await refused(await s.generate.POST(post(unpriced, "empty-unpriced")), "held");
    expect(await rows()).toHaveLength(0);
    expect(await meters()).toHaveLength(0);
    /* A priced take still waits for credits, as before. */
    const held = await s.generate.POST(post(priced, "empty-priced"));
    expect(held.status).toBe(202);
    expect(await held.json()).toMatchObject({ status: "held", held: true });
    expect(await meters()).toHaveLength(0);
    expect(dispatched).toHaveLength(0);
  }));

test("an API token's unpriced request is refused and spends nothing; its priced one is admitted under the token", async () =>
  scope({ name: "token" }, agent, async (s) => {
    await refused(await s.generate.POST(post(unpriced, "token-unpriced")), "token");
    expect(await rows()).toHaveLength(0);
    expect(await meters()).toHaveLength(0);
    const accepted = await s.generate.POST(post(priced, "token-priced"));
    expect(accepted.status).toBe(202);
    const { id } = await accepted.json();
    expect((await rows()).map((row) => [row.id, row.token_id])).toEqual([[id, "tok_agent"]]);
    expect(dispatched).toEqual([{ genId: id, kind: "video" }]);
  }));

test("the MCP render tool is refused by its own quote and never sends an unpriced render", async () =>
  scope({ name: "mcp" }, agent, async (s) => {
    const { runTool } = await import("../../lib/mcp");
    const sent: string[] = [];
    /* The tool's HTTP calls, answered in-process by the same routes, as the token. */
    const call = async (pathname: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
      sent.push(pathname);
      const handler = pathname === "/api/generate/quote" ? s.quote : pathname === "/api/generate" ? s.generate : null;
      if (!handler) throw new Error(`Unexpected call to ${pathname}`);
      const response = await handler.POST(new Request(`http://localhost${pathname}`, {
        method: init.method ?? "POST",
        headers: { "Content-Type": "application/json", ...init.headers },
        body: JSON.stringify(init.body),
      }));
      const json = (await response.json()) as Record<string, unknown>;
      if (!response.ok) throw new Error(String(json.error ?? response.status));
      return json;
    };
    const args = { prompt: "A lighthouse at dusk", resolution: "720p", duration: 5 };
    await expect(runTool("render_shot", { ...args, ratio: "adaptive" }, call, "http://localhost", { credits: true })).rejects.toThrow(NO_PRICE);
    expect(sent).toEqual(["/api/generate/quote"]);
    expect(await rows()).toHaveLength(0);
    const started = await runTool("render_shot", { ...args, ratio: "16:9", request_id: "mcp-priced" }, call, "http://localhost", { credits: true });
    expect(started).toMatch(/^Rendering started\./);
    expect(sent).toEqual(["/api/generate/quote", "/api/generate/quote", "/api/generate"]);
    expect(dispatched).toHaveLength(1);
  }));

test("a still engine with no confirmed price is refused on the platform's key, and a workspace key kept from before does not unlock it", async () => {
  const { VENDOR_RATES } = await import("../../lib/vendorRates");
  const still = { model: "gemini-3.1-flash-image", prompt: "raw: A tree", ratio: "16:9", resolution: "1K", projectId: "project" };
  const rates = VENDOR_RATES[still.model];
  const confirmed = rates.imagePricing;
  /* As an engine added before its price is confirmed: no still size has a price. */
  rates.imagePricing = {};
  try {
    const cases: Funding[] = [
      { name: "still-platform" },
      /* An image key kept from the old billing mode: it never funds new work, so the platform would pay. */
      { name: "still-own-key", keys: { gemini: "workspace-own-image-key" } },
    ];
    for (const funding of cases)
      await scope(funding, owner, async (s) => {
        await refused(await s.generate.POST(post(still, `${funding.name}-unpriced`)), funding.name);
        expect(await rows()).toHaveLength(0);
        expect(await meters()).toHaveLength(0);
        expect(dispatched).toHaveLength(0);
      });
  } finally {
    rates.imagePricing = confirmed;
  }
});

test("with shared studio credits no workspace escapes the refusal: not a kept key, a stored own-keys mode or the studio's own workspace", async () => {
  const cases: Funding[] = [
    /* A workspace that brought its own video key before shared credits. */
    { name: "own-video-key", keys: { ark: "workspace-own-video-key" } },
    /* A workspace stored as own-keys-only before shared credits; it is read as managed now. */
    { name: "own-keys-only", keys: { ark: "workspace-own-video-key" }, platformKeys: false },
    /* The studio's own workspace, which pays in credits like every other. */
    { name: "studio", legacy: true },
  ];
  for (const funding of cases)
    await scope(funding, owner, async (s) => {
      const before = await balance();
      await refused(await s.generate.POST(post(unpriced, `${funding.name}-unpriced`)), funding.name);
      expect(await rows(), funding.name).toHaveLength(0);
      expect(await meters(), funding.name).toHaveLength(0);
      expect(dispatched, funding.name).toHaveLength(0);
      expect(await balance(), funding.name).toBe(before);
      /* The quote never stated a price nobody can compute, for any workspace; that is unchanged too. */
      expect(await s.gen.prepareGeneration(unpriced, owner)).toMatchObject({ ok: false, status: 400, body: { error: NO_PRICE } });
    });
});

test("connected-account work never enters generation admission, so the refusal cannot reach it", () => {
  const root = process.cwd();
  const resolve = (from: string, spec: string): string | null => {
    const base = spec.startsWith("@/") ? path.join(root, spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(from), spec) : null;
    if (!base) return null;
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        /* the next spelling */
      }
    }
    return null;
  };
  /* Every connected-account entry point: the consumer routes and Atomik's connected step. */
  const consumer = path.join(root, "app/api/higgsfield/consumer");
  const entries = [
    ...readdirSync(consumer, { recursive: true }).map(String).filter((file) => file.endsWith("route.ts")).map((file) => path.join(consumer, file)),
    path.join(root, "app/api/atomik/steps/[id]/connected/route.ts"),
  ];
  expect(entries.length).toBeGreaterThan(5);
  const reached = new Set<string>();
  const pending = [...entries];
  while (pending.length) {
    const file = pending.pop()!;
    if (reached.has(file)) continue;
    reached.add(file);
    for (const { fileName } of ts.preProcessFile(readFileSync(file, "utf8"), true, true).importedFiles) {
      const next = resolve(file, fileName);
      if (next && !reached.has(next)) pending.push(next);
    }
  }
  const files = [...reached].map((file) => path.relative(root, file));
  expect(files).toContain("lib/jobs.ts"); // the walk does reach deep into lib
  expect(files).not.toContain("lib/generationAdmission.ts");
});

test("a connected-account render stays editable on the platform's key: priced from its measured original, admitted without a fingerprint", async () =>
  scope({ name: "connected-source" }, owner, async (s) => {
    const { db } = await import("../../lib/db");
    const { storeOriginalBytes } = await import("../../lib/storage");
    const bytes = readFileSync("tests/fixtures/astra-source.mp4");
    const source = `gen_connected_${randomUUID().slice(0, 8)}`;
    stored.push(source);
    const original = await storeOriginalBytes("video", source, bytes, "video/mp4");
    /* Stored the way connected-account work stores its originals: its own credits, no ratio, no cost of ours. */
    await db().execute({
      sql: `INSERT INTO generations(id,project_id,model,prompt,params,status,stored_url,cost_usd,created_by,created_at,updated_at,kind,provider,bytes,duration_s,billed_to)
            VALUES(?,'project','connected_video_model','Dunes at noon',?,'succeeded',?,NULL,'owner',0,0,'video','higgsfield',?,4,'higgsfield')`,
      args: [source, JSON.stringify({ duration: 4, consumerJobId: "job_connected", consumerCredits: 12, consumerCreditUnit: "higgsfield_credits" }), original.url, bytes.length],
    });
    const edit = { model: SEEDANCE, task: "edit", prompt: "Edit @Video1: turn the sand rust red", sourceGenId: source, resolution: "720p", duration: 4, ratio: "1:1", refine: false };
    const quote = value(await s.gen.prepareGeneration(edit, owner)).quote;
    expect(quote.estimatedCredits).toBeGreaterThan(0);
    const accepted = await s.generate.POST(post(edit, "connected-source-edit"));
    const body = await accepted.json();
    expect(accepted.status, JSON.stringify(body)).toBe(202);
    const [meter] = await meters();
    expect(meter).toMatchObject({ id: body.id, paid_by_platform: 1 });
    expect(Number(meter.billed_credits)).toBe(quote.estimatedCredits);
    /* The connected-account render itself is untouched: no cost of ours, no meter of its own. */
    expect((await db().execute({ sql: "SELECT status,cost_usd FROM generations WHERE id=?", args: [source] })).rows[0]).toMatchObject({ status: "succeeded", cost_usd: null });
    expect(dispatched).toEqual([{ genId: body.id, kind: "video" }]);
  }));

test("a take admitted before this change replays its job and settles exactly as before: the refusal lives only in admission", async () =>
  scope({ name: "accepted" }, owner, async (s) => {
    const { db } = await import("../../lib/db");
    const { withGenerationRequestData, generationFingerprint, claimBinding, reserveGenerationSpend } = await import("../../lib/generationRequests");
    const id = `gen_accepted_${randomUUID().slice(0, 8)}`;
    stored.push(id);
    /* What admission wrote for this very request before: the claim, the row, a reservation at no estimate. */
    const admitted = await withGenerationRequestData(
      { userId: owner.user.id, key: "accepted-unpriced", fingerprint: generationFingerprint({ method: "POST", path: "/api/generate", body: unpriced }) },
      async (claim) => {
        const bind = await claimBinding(claim, id);
        await db().batch([
          {
            sql: `INSERT INTO generations(id,project_id,model,prompt,params,status,created_by,created_at,updated_at,provider,task,billed_to,ark_task_id)
                  VALUES(?,'project',?,?,?,'queued','owner',?,?,'byteplus','generate','byteplus',?)`,
            args: [id, SEEDANCE, "A lighthouse at dusk", JSON.stringify({ ratio: "adaptive", resolution: "720p", duration: 5 }), Date.now(), Date.now(), `ark_${id}`],
          },
          ...bind,
        ], "write");
        await reserveGenerationSpend({ id, kind: "video", engine: "byteplus", model: SEEDANCE, status: "running", engineCostUsd: 0, projectId: "project", shotId: null, createdBy: owner.user.id });
        return Response.json({ id, status: "queued" }, { status: 202 });
      },
      { atomicBinding: true },
    );
    expect(admitted.status).toBe(202);
    /* Its reply lost, the same request again: its own job, never a refusal and never a second job. */
    const replay = await s.generate.POST(post(unpriced, "accepted-unpriced"));
    expect(replay.status).toBe(202);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect((await replay.json()).id).toBe(id);
    expect(await rows()).toHaveLength(1);
    expect(dispatched).toHaveLength(0);
    /* In flight, it settles through the unchanged completion path (the poll and the cron's recovery). */
    const { engineFor } = await import("../../lib/engines");
    const { fixtureUrl } = await import("../../lib/mock");
    const { getGeneration, syncGeneration } = await import("../../lib/jobs");
    const { effectiveRate } = await import("../../lib/vendorPricing");
    const { costUsd } = await import("../../lib/models");
    const tokens = 108_000;
    const engine = engineFor("byteplus"), poll = engine.poll;
    engine.poll = async () => ({ status: "succeeded" as const, videoUrl: fixtureUrl("clip.mp4"), totalTokens: tokens, error: null, vendorStartedAt: null, vendorEndedAt: null, raw: {} });
    try {
      expect((await syncGeneration((await getGeneration(id))!, { strict: true })).status).toBe("succeeded");
    } finally {
      engine.poll = poll;
    }
    const settled = costUsd(tokens, effectiveRate(SEEDANCE, "720p", false)!);
    expect(Number((await rows())[0].cost_usd)).toBeCloseTo(settled, 10);
    const [meter] = await meters();
    expect(meter).toMatchObject({ id, status: "succeeded", paid_by_platform: 1 });
    expect(Number(meter.engine_cost_usd)).toBeCloseTo(settled, 10);
  }));
