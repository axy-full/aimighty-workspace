import { test, expect } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import type { AdmissionActor } from "../../lib/admissionTypes";

/**
 * Enhance ends within 90 s on any host (docs/long-flows.md › C4): no request
 * stays silent for more than 100 s. The route gives its one text call a 90 s
 * provider timeout; a provider that stalls past it is settled exactly once as
 * `uncertain` at the reserved estimate (held for reconciliation, as Vercel's
 * 120 s cut leaves it today), and the same press sent again never calls the
 * provider a second time.
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
function enhance(submit: Submit): Handler {
  const paidText = nodeRequire(path.resolve("lib/paidText.ts"));
  const signedIn = async () => OWNER;
  return load<{ POST: Handler }>("app/api/prompt/enhance/route.ts", {
    "@/lib/auth": { ...nodeRequire(path.resolve("lib/auth.ts")), withTenant: (h: unknown) => h, requireRender: signedIn },
    "@/lib/catalog": { catalog: async () => [MODEL] },
    "@/lib/gateway": { gatewayReachable: () => true },
    "@/lib/paidText": { ...paidText, runPaidText: (input: unknown, o: Record<string, unknown> = {}) => paidText.runPaidText(input, { ...o, model: MODEL, submit }) },
    "next/server": { NextResponse: Response, after: () => { throw new Error("Nothing is continued after the response here"); } },
  }).POST;
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

test("the route gives its text call a 90 s provider timeout", () => {
  const route = readFileSync("app/api/prompt/enhance/route.ts", "utf8");
  expect(route).toMatch(/runPaidText\(\{ \.\.\.input, maxCredits: [^}]*timeoutMs: 90_000 \}/);
  /* Under the route's own limit, so the timeout answers before the host cuts the request. */
  expect(Number(/export const maxDuration = (\d+)/.exec(route)?.[1])).toBeGreaterThan(90);
});

test("a provider that stalls past 90 s is settled once as uncertain at the estimate, and the same press is not sent again", async () => {
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
    expect(timeouts).toEqual([90_000]);

    const { db } = await import("../../lib/db");
    const jobs = (await db().execute("SELECT status,estimate_usd,cost_usd FROM paid_text_jobs")).rows;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("uncertain");
    expect(Number(jobs[0].cost_usd)).toBe(Number(jobs[0].estimate_usd));
    expect(Number(jobs[0].estimate_usd)).toBeGreaterThan(0);

    const { platformDb } = await import("../../lib/platform");
    const meters = async () => (await platformDb().execute({ sql: "SELECT status,engine_cost_usd,billed_credits FROM meter_events WHERE workspace_id=?", args: ["ws_enhance_stall"] })).rows;
    const settled = await meters();
    expect(settled).toHaveLength(1);
    expect(settled[0].status).toBe("failed");
    expect(Number(settled[0].engine_cost_usd)).toBe(Number(jobs[0].estimate_usd));
    /* The 1 cr estimate is what stays held for reconciliation. */
    expect(Number(settled[0].billed_credits)).toBe(1);

    /* The same press again (a retry of the lost reply): answered from its claim, never a second call or charge. */
    const again = await route(press("enhance-stall-1"));
    expect(again.status).toBe(502);
    expect(await again.json()).toEqual(body);
    expect(timeouts).toEqual([90_000]);
    expect((await db().execute("SELECT COUNT(*) AS n FROM paid_text_jobs")).rows[0].n).toBe(1);
    expect(await meters()).toEqual(settled);
  });
});
