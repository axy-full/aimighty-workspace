import { test, expect } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import type { AdmissionActor } from "../../lib/admissionTypes";

/**
 * Enhance ends within 90 s on any host (docs/long-flows.md › C4): no request
 * stays silent for more than 100 s. The budget runs from the route's entry:
 * the provider gets what is left of it, and with under 20 s left the press is
 * refused before anything is reserved. A provider that stalls past it is
 * settled exactly once as `uncertain`, its 1 cr estimate billed, and the same
 * press sent again never calls the provider a second time.
 */
const dir = mkdtempSync(path.join(tmpdir(), "enhance-timeout-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET = "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
delete process.env.PLATFORM_ALLOWANCE_USD;

const OWNER: AdmissionActor = { user: { id: "owner", email: "owner@example.invalid", name: "owner", role: "admin", owner: true, disabled: false, createdAt: 0, lastSeen: null } };
const WRITER = "anthropic/claude-haiku-4.5";
const MODEL = { id: WRITER, name: "Writer", owner: "anthropic", type: "language", description: "", contextWindow: 100000, maxTokens: 5000, pricing: { input: "0.000001", output: "0.000002" } };

const nodeRequire = createRequire(path.resolve("package.json"));
function resolveSource(from: string, name: string): string {
  const base = name.startsWith("@/") ? path.resolve(name.slice(2)) : path.resolve(path.dirname(from), name);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), base]) if (existsSync(candidate)) return candidate;
  return base;
}
/** The route with its session, the catalogue and the provider boundary replaced; paid text, the claim, the meter real. */
function load<T>(file: string, overrides: Record<string, unknown>): T {
  const source = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const target = { exports: {} };
  new Function("require", "module", "exports", source)(
    (name: string) => (name in overrides ? overrides[name] : name.startsWith("@/") || name.startsWith(".") ? nodeRequire(resolveSource(file, name)) : nodeRequire(name)),
    target, target.exports,
  );
  return target.exports as T;
}

type Submit = (request: { timeoutMs?: number }) => Promise<{ ok: boolean; status: number; text: string }>;
type Handler = (req: Request) => Promise<Response>;
/** Time moved on by a slow catalogue read: Date.now runs this far ahead while a test lasts. */
let skew = 0;
const realNow = Date.now;
test.beforeEach(() => { skew = 0; Date.now = () => realNow() + skew; });
test.afterEach(() => { Date.now = realNow; });

function enhance(submit: Submit, catalogueTakes = 0): Handler {
  const paidText = nodeRequire(path.resolve("lib/paidText.ts"));
  const signedIn = async () => OWNER;
  return load<{ POST: Handler }>("app/api/prompt/enhance/route.ts", {
    "@/lib/auth": { ...nodeRequire(path.resolve("lib/auth.ts")), withTenant: (h: unknown) => h, requireRender: signedIn },
    /* The route's one catalogue read; the model it prices from is handed on, so paid text never reads it again. */
    "@/lib/catalog": { catalog: async () => { skew += catalogueTakes; return [MODEL]; } },
    "@/lib/gateway": { gatewayReachable: () => true },
    "@/lib/paidText": { ...paidText, runPaidText: (input: unknown, o: Record<string, unknown> = {}) => paidText.runPaidText(input, { ...o, submit }) },
    "next/server": { NextResponse: Response, after: () => { throw new Error("Nothing is continued after the response here"); } },
  }).POST;
}

async function traces(ws: string) {
  const { db } = await import("../../lib/db");
  const { platformDb } = await import("../../lib/platform");
  const rows = async (run: () => Promise<{ rows: unknown[] }>) => { try { return (await run()).rows; } catch (e) { if (/no such table/i.test(String(e))) return []; throw e; } };
  return {
    jobs: await rows(() => db().execute("SELECT status,estimate_usd,cost_usd FROM paid_text_jobs")) as Record<string, unknown>[],
    meters: await rows(() => platformDb().execute({ sql: "SELECT status,engine_cost_usd,billed_credits FROM meter_events WHERE workspace_id=?", args: [ws] })) as Record<string, unknown>[],
    reservations: (await rows(() => platformDb().execute({ sql: "SELECT * FROM generation_reservations WHERE workspace_id=?", args: [ws] }))).length,
  };
}

async function inWorkspace(ws: string, fn: () => Promise<void>) {
  const { platformReady, platformDb, rowToWorkspace, grantCredits } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { ready } = await import("../../lib/db");
  await platformReady();
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,uses_platform_keys,owner_id,created_at,updated_at,concurrency,renders_per_hour) VALUES(?,?,?,?,1,'owner',0,0,20,200)",
    args: [ws, ws, ws, `file:${path.join(dir, ws + ".db")}`],
  });
  await grantCredits(ws, 1000, "Test", "owner", "manual");
  const row = rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [ws] })).rows[0]);
  await runInTenant(row, async () => { await ready(); await fn(); }, OWNER);
}

function press(key: string): Request {
  return new Request("http://localhost/api/prompt/enhance", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({ prompt: "a tree in rain", mode: "video", provider: "claude", maxCredits: 5 }),
  });
}

test("the route's whole answer is budgeted at 90 s from entry, under its own limit", () => {
  const route = readFileSync("app/api/prompt/enhance/route.ts", "utf8");
  expect(route).toContain("const ENHANCE_BUDGET_MS = 90_000;");
  expect(route).toMatch(/runPaidText\(\{ \.\.\.input, maxCredits: [^}]*deadline \}, \{ model,/);
  /* Under the route's own limit, so the timeout answers before the host cuts the request. */
  expect(Number(/export const maxDuration = (\d+)/.exec(route)?.[1])).toBeGreaterThan(90);
});

test("a provider that stalls past the budget is settled once as uncertain, the 1 cr estimate billed, and the same press is not sent again", async () => {
  await inWorkspace("ws_enhance_stall", async () => {
    const timeouts: (number | undefined)[] = [];
    /* A stalled provider: the call's own AbortSignal.timeout fires (lib/gateway.ts gatewayPost) — here at once. */
    const stalled: Submit = async (request) => {
      timeouts.push(request.timeoutMs);
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };
    const route = enhance(stalled);
    const first = await route(press("enhance-stall-1"));
    const body = await first.json();
    expect(first.status).toBe(502);
    expect(body.error).toBe("The text request was interrupted after submission. Its credits remain reserved; this request will not be sent again.");
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toBeLessThanOrEqual(90_000);
    expect(timeouts[0]).toBeGreaterThan(60_000);

    const settled = await traces("ws_enhance_stall");
    expect(settled.jobs).toHaveLength(1);
    expect(settled.jobs[0].status).toBe("uncertain");
    expect(Number(settled.jobs[0].cost_usd)).toBe(Number(settled.jobs[0].estimate_usd));
    expect(Number(settled.jobs[0].estimate_usd)).toBeGreaterThan(0);
    expect(settled.meters).toHaveLength(1);
    expect(settled.meters[0].status).toBe("failed");
    expect(Number(settled.meters[0].engine_cost_usd)).toBe(Number(settled.jobs[0].estimate_usd));
    /* The 1 cr estimate is billed; nothing later reconciles an uncertain text job. */
    expect(Number(settled.meters[0].billed_credits)).toBe(1);

    /* The same press again (a retry of the lost reply): answered from its claim, never a second call or charge. */
    const again = await route(press("enhance-stall-1"));
    expect(again.status).toBe(502);
    expect(await again.json()).toEqual(body);
    expect(timeouts).toHaveLength(1);
    expect(await traces("ws_enhance_stall")).toEqual(settled);
  });
});

test("time spent before the provider call comes off its timeout: a slow catalogue leaves the provider the rest of the 90 s", async () => {
  await inWorkspace("ws_enhance_slow_catalogue", async () => {
    const timeouts: (number | undefined)[] = [];
    const answers: Submit = async (request) => {
      timeouts.push(request.timeoutMs);
      return { ok: true, status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ prompt: "A lone tree in steady rain, slow push-in, grey dusk light." }) } }], usage: { cost: 0.0004 } }) };
    };
    const out = await enhance(answers, 40_000)(press("enhance-slow-catalogue"));
    expect(out.status, JSON.stringify(await out.clone().json())).toBe(200);
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toBeLessThanOrEqual(50_000);
    expect(timeouts[0]).toBeGreaterThan(30_000);
  });
});

test("with under 20 s of the budget left before the provider call, the press is refused with nothing written, reserved, metered or sent", async () => {
  await inWorkspace("ws_enhance_late", async () => {
    let sent = 0;
    const never: Submit = async () => { sent++; throw new Error("The provider must not be called"); };
    const out = await enhance(never, 75_000)(press("enhance-late"));
    expect(out.status).toBe(503);
    expect((await out.json()).error).toBe("The text provider is slow to answer right now. Nothing was charged; try again in a moment.");
    expect(sent).toBe(0);
    expect(await traces("ws_enhance_late")).toEqual({ jobs: [], meters: [], reservations: 0 });
  });
});
