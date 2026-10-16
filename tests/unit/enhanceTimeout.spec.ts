import { test, expect } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import type { AdmissionActor } from "../../lib/admissionTypes";

/**
 * Enhance ends within 8 s on any host (the owner's note of 16 Oct 2026; the browser waits 10 s so an answer at the deadline still arrives, lib/shell/enhance-press.ts): the
 * deadline runs from the route's entry, the provider gets what is left of it, and with under 3 s left the press is refused before anything is
 * reserved. Whatever goes wrong for the enhancer (no answer by then, an error status, an unreadable or unusable reply, a cancelled press) is settled once as
 * failed at zero ("Nothing billed", released) with a billing-unknown outcome on its ledger line: the owner's rule of 16 Oct 2026, for the enhancer alone
 * (`freeOnFailure`, lib/paidText.ts). Every other text job keeps the shared rule (a cut-off call or a 5xx is `uncertain`, its estimate billed until the
 * cron's pass returns it). The same press sent again never calls the provider a second time.
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

type Submit = (request: { timeoutMs?: number; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text: string }>;
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

async function balanceOf(ws: string) {
  const { billingStateFor } = await import("../../lib/billingLedger");
  return (await billingStateFor(ws)).credits.balance;
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

test("the route's whole answer is budgeted at 8 s from entry, with the provider's unanswered call free", () => {
  const route = readFileSync("app/api/prompt/enhance/route.ts", "utf8");
  expect(route).toContain("const deadline = Date.now() + ENHANCE_DEADLINE_MS;");
  expect(route).toMatch(/runPaidText\(\{ \.\.\.input, maxCredits: [^}]*deadline, minProviderMs: ENHANCE_MIN_PROVIDER_MS, freeOnFailure: true, signal: req\.signal, holdSettlement: stream \}, \{ model,/);
  expect(readFileSync("lib/paidText.ts", "utf8")).toContain("export const ENHANCE_DEADLINE_MS = 8_000;");
  /* Under the route's own limit, so the timeout answers before the host cuts the request. */
  expect(Number(/export const maxDuration = (\d+)/.exec(route)?.[1])).toBeGreaterThan(8);
});

test("a writer that never answers: failed at zero, Nothing billed, the reservation released, and the same press is not sent again", async () => {
  await inWorkspace("ws_enhance_stall", async () => {
    const timeouts: (number | undefined)[] = [];
    /* A stalled provider: the call's own AbortSignal.timeout fires (lib/textDirect.ts) — here at once. */
    const stalled: Submit = async (request) => {
      timeouts.push(request.timeoutMs);
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };
    const route = enhance(stalled);
    const first = await route(press("enhance-stall-1"));
    const body = await first.json();
    expect(first.status).toBe(504);
    expect(body.error).toBe("The writer didn't answer in time. Nothing billed.");
    expect(body.nothingBilled, "the browser is told in a field, not prose").toBe(true);
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toBeLessThanOrEqual(8_000);
    expect(timeouts[0]).toBeGreaterThan(4_000);

    const settled = await traces("ws_enhance_stall");
    expect(settled.jobs).toHaveLength(1);
    expect(settled.jobs[0].status).toBe("failed");
    expect(Number(settled.jobs[0].cost_usd)).toBe(0);
    expect(Number(settled.jobs[0].estimate_usd)).toBeGreaterThan(0);
    expect(settled.meters).toHaveLength(1);
    expect(settled.meters[0].status).toBe("failed");
    expect(Number(settled.meters[0].engine_cost_usd)).toBe(0);
    expect(Number(settled.meters[0].billed_credits)).toBe(0);
    expect(await balanceOf("ws_enhance_stall"), "the whole 1,000 cr grant is still there").toBe(1000);
    /* The ledger line says what is known: no answer, billing unknown, for the platform admin desk to reconcile against the provider's invoice. */
    const { platformDb } = await import("../../lib/platform");
    const line = (await platformDb().execute({ sql: "SELECT provider_outcome FROM meter_events WHERE workspace_id=?", args: ["ws_enhance_stall"] })).rows[0];
    const outcome = JSON.parse(String(line.provider_outcome));
    expect(outcome).toMatchObject({ provider: "gateway", stage: "run", code: "no_answer", billing: { state: "unknown", basis: "no-answer" } });
    const { db } = await import("../../lib/db");
    expect(Number((await db().execute("SELECT cost_usd FROM atomik_spend")).rows[0].cost_usd), "the platform's own spend row is zeroed with it").toBe(0);

    /* The same press again (a retry of the lost reply): answered from its claim, never a second call or charge. */
    const again = await route(press("enhance-stall-1"));
    expect(again.status).toBe(504);
    expect(await again.json()).toEqual(body);
    expect(timeouts).toHaveLength(1);
    expect(await traces("ws_enhance_stall")).toEqual(settled);
  });
});

test("the shared rule is unchanged for any other text job: a cut-off call is uncertain and bills its estimate until the cron's pass returns it", async () => {
  await inWorkspace("ws_text_stall", async () => {
    const { runPaidText } = await import("../../lib/paidText");
    const stalled: Submit = async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); };
    const error = await runPaidText({ id: "text-stall", model: WRITER, messages: [{ role: "user", content: "a tree in rain" }], maxTokens: 400, kind: "plan", mock: "prompt", createdBy: "owner" }, { model: MODEL as never, submit: stalled }).then(() => null, (e: unknown) => e as Error & { status?: number });
    expect(error?.message).toMatch(/^The text request was interrupted after submission\./);
    const settled = await traces("ws_text_stall");
    expect(settled.jobs[0].status).toBe("uncertain");
    expect(Number(settled.jobs[0].cost_usd)).toBe(Number(settled.jobs[0].estimate_usd));
    expect(Number(settled.meters[0].billed_credits)).toBe(1);
  });
});

test("every failure of the enhancer is free: an error status, a refusal, an unreadable reply; each leaves a billing-unknown outcome and the whole balance", async () => {
  const cases: [string, Submit, number, RegExp][] = [
    ["5xx", async () => ({ ok: false, status: 503, text: "" }), 502, /^The writer couldn't answer this time\. Nothing billed\.$/],
    ["declined", async () => ({ ok: false, status: 400, text: "" }), 502, /^The text provider declined this request \(400\)\. No generation credits were charged\.$/],
    ["unreadable", async () => ({ ok: true, status: 200, text: "<html>gateway error</html>" }), 502, /^The writer's reply couldn't be read\. Nothing billed\.$/],
  ];
  for (const [name, submit, status, message] of cases) {
    const ws = `ws_enhance_free_${name}`;
    await inWorkspace(ws, async () => {
      const out = await enhance(submit)(press(`enhance-free-${name}`));
      const answer = await out.json();
      expect(out.status, name).toBe(status);
      expect(answer.error, name).toMatch(message);
      expect(answer.nothingBilled, name).toBe(true);
      expect(answer.heldCredits, name).toBeUndefined();
      const settled = await traces(ws);
      expect(settled.jobs[0].status, name).toBe("failed");
      expect(Number(settled.jobs[0].cost_usd), name).toBe(0);
      expect(Number(settled.meters[0].billed_credits), name).toBe(0);
      expect(Number(settled.meters[0].engine_cost_usd), name).toBe(0);
      expect(await balanceOf(ws), name).toBe(1000);
      const { platformDb } = await import("../../lib/platform");
      const line = (await platformDb().execute({ sql: "SELECT provider_outcome FROM meter_events WHERE workspace_id=?", args: [ws] })).rows[0];
      expect(JSON.parse(String(line.provider_outcome)), name).toMatchObject({ stage: "run", billing: { state: "unknown" } });
    });
  }
});

test("every other text job still bills an error status as uncertain (the shared rule)", async () => {
  await inWorkspace("ws_text_5xx", async () => {
    const { runPaidText } = await import("../../lib/paidText");
    const error = await runPaidText({ id: "text-5xx", model: WRITER, messages: [{ role: "user", content: "a tree in rain" }], maxTokens: 400, kind: "plan", mock: "prompt", createdBy: "owner" }, { model: MODEL as never, submit: async () => ({ ok: false, status: 503, text: "" }) }).then(() => null, (e: unknown) => e as Error & { billing?: unknown });
    expect(error?.message).toMatch(/^The text provider returned an uncertain result\./);
    expect(error?.billing).toEqual({ heldCredits: 1 });
    const settled = await traces("ws_text_5xx");
    expect(settled.jobs[0].status).toBe("uncertain");
    expect(Number(settled.meters[0].billed_credits)).toBe(1);
  });
});

test("time spent before the provider call comes off its timeout: a slow catalogue leaves the provider the rest of the 8 s", async () => {
  await inWorkspace("ws_enhance_slow_catalogue", async () => {
    const timeouts: (number | undefined)[] = [];
    const answers: Submit = async (request) => {
      timeouts.push(request.timeoutMs);
      return { ok: true, status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ prompt: "A lone tree in steady rain, slow push-in, grey dusk light." }) } }], usage: { cost: 0.0004 } }) };
    };
    const out = await enhance(answers, 2_500)(press("enhance-slow-catalogue"));
    expect(out.status, JSON.stringify(await out.clone().json())).toBe(200);
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toBeLessThanOrEqual(5_500);
    expect(timeouts[0]).toBeGreaterThan(4_000);
  });
});

test("with under 3 s of the deadline left before the provider call, the press is refused with nothing written, reserved, metered or sent", async () => {
  await inWorkspace("ws_enhance_late", async () => {
    let sent = 0;
    const never: Submit = async () => { sent++; throw new Error("The provider must not be called"); };
    const out = await enhance(never, 6_000)(press("enhance-late"));
    expect(out.status).toBe(503);
    const slow = await out.json();
    expect(slow.error).toBe("The text provider is slow to answer right now. Nothing was charged; try again in a moment.");
    expect(slow.nothingBilled).toBe(true);
    expect(sent).toBe(0);
    expect(await traces("ws_enhance_late")).toEqual({ jobs: [], meters: [], reservations: 0 });
  });
});

test("the writer is asked to think lightly, with a small fixed room, and the quote and the run say the same", async () => {
  await inWorkspace("ws_enhance_quick", async () => {
    const bodies: Record<string, unknown>[] = [];
    const answers: Submit = async (request) => {
      bodies.push(JSON.parse(request.body ?? "{}"));
      return { ok: true, status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ prompt: "A lone tree in steady rain, slow push-in." }) } }], usage: { cost: 0.0004 } }) };
    };
    const route = enhance(answers);
    const quote = await route(new Request("http://localhost/api/prompt/enhance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "a tree in rain", mode: "video", provider: "claude", quoteOnly: true }) }));
    expect(quote.status).toBe(200);
    const out = await route(press("enhance-quick"));
    expect(out.status).toBe(200);
    expect(bodies).toHaveLength(1);
    /* Haiku 4.5 offers no named effort (a toggle and a budget): it is asked as it always was; the Claude 5.5 writers and gpt-5-mini are in the next tests. */
    expect(bodies[0].max_tokens).toBeLessThanOrEqual(400 + 1_024);
  });
});
