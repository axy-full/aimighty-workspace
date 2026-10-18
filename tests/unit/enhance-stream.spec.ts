import { test, expect } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import type { AdmissionActor } from "../../lib/admissionTypes";

/**
 * The enhancer's stream (the owner, 16 Oct 2026): the answer goes to the box word by word and the workspace is charged when the last word is out.
 * A press cancelled before any word, a stream cut off midway, a double press, and a refused answer are never billed twice or at all; the key replays
 * what the press ended as. Mocks only: the provider is a stub, nothing leaves the process.
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
let skew = 0;

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



type Line = { t?: string; done?: boolean; prompt?: string; error?: string; nothingBilled?: boolean };
async function readLines(response: Response, stopAfterWords = Infinity): Promise<{ lines: Line[]; cut: boolean }> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const lines: Line[] = [];
  let buffer = "";
  let words = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return { lines, cut: false };
    buffer += decoder.decode(value, { stream: true });
    let at: number;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = JSON.parse(buffer.slice(0, at)) as Line;
      buffer = buffer.slice(at + 1);
      lines.push(line);
      if (line.t !== undefined && ++words >= stopAfterWords) { await reader.cancel(); return { lines, cut: true }; }
    }
  }
}
const answers = (text: string): Submit => async () => ({ ok: true, status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ prompt: text }) } }], usage: { cost: 0.0004 } }) });
const LONG = "A lone tree in steady rain, slow push-in, grey dusk light, tack sharp, low wind through the branches.";
const stream = (key: string, signal?: AbortSignal) => new Request("http://localhost/api/prompt/enhance", {
  method: "POST", signal,
  headers: { "Content-Type": "application/json", "Idempotency-Key": key },
  body: JSON.stringify({ prompt: "a tree in rain", mode: "video", provider: "claude", maxCredits: 5, stream: true }),
});
async function settled(ws: string, until: (j: string) => boolean) {
  for (let i = 0; i < 200; i++) {
    const t = await traces(ws);
    if (t.jobs[0] && until(String(t.jobs[0].status))) return t;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("the job never settled");
}
async function lineOf(ws: string) {
  const { platformDb } = await import("../../lib/platform");
  return (await platformDb().execute({ sql: "SELECT provider_outcome FROM meter_events WHERE workspace_id=?", args: [ws] })).rows[0];
}

test("the answer streams word by word, and the workspace is charged when the last word is out, once; the key replays the final answer", async () => {
  await inWorkspace("ws_stream_ok", async () => {
    const route = enhance(answers(LONG));
    const response = await route(stream("stream-ok-1"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/application\/x-ndjson/);
    expect(response.headers.get("X-Claim-Deferred"), "an internal header never leaves").toBeNull();
    /* Nothing is charged while the stream is still on its way: the job is held, running. */
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(JSON.parse(new TextDecoder().decode(first.value!).split("\n")[0]).t).toBe("A ");
    const mid = await traces("ws_stream_ok");
    expect(mid.jobs[0].status).toBe("running");
    expect(mid.meters.map((m) => m.status), "the line is still a running hold, not a charge").toEqual(["running"]);
    expect(await balanceOf("ws_stream_ok"), "the estimate is held while the stream runs").toBe(999);
    /* The reader goes away with the answer half delivered: the hold is given back, nothing is charged. */
    await reader.cancel().catch(() => {});
    const gone = await settled("ws_stream_ok", (status) => status !== "running");
    expect(gone.jobs[0].status).toBe("failed");
    expect(Number(gone.meters[0].billed_credits)).toBe(0);
    expect(await balanceOf("ws_stream_ok")).toBe(1000);
  });
  await inWorkspace("ws_stream_full", async () => {
    let calls = 0;
    const route = enhance(async (r) => { calls++; return answers(LONG)(r); });
    const { lines, cut } = await readLines(await route(stream("stream-full-1")));
    expect(cut).toBe(false);
    const words = lines.filter((l) => l.t !== undefined).map((l) => l.t);
    expect(words.join("")).toBe(LONG);
    expect(words.length).toBeGreaterThan(10);
    expect(lines.at(-1)).toMatchObject({ done: true, prompt: LONG, provider: "claude" });
    const done = await traces("ws_stream_full");
    expect(done.jobs[0].status).toBe("succeeded");
    expect(done.meters).toHaveLength(1);
    expect(Number(done.meters[0].billed_credits)).toBe(1);
    expect(await balanceOf("ws_stream_full")).toBe(999);
    /* The same press again: the saved answer, never a second call or charge. */
    const again = await route(stream("stream-full-1"));
    expect(again.headers.get("Idempotency-Status")).toBe("complete");
    expect(await again.json()).toEqual({ prompt: LONG, provider: "claude", writer: WRITER });
    expect(calls).toBe(1);
    expect(await balanceOf("ws_stream_full")).toBe(999);
  });
});

test("a stream cut off midway is failed and free: abandoned, never charged, the platform's line says billing unknown, and the key replays that", async () => {
  await inWorkspace("ws_stream_cut", async () => {
    let calls = 0;
    const route = enhance(async (r) => { calls++; return answers(LONG)(r); });
    const { lines, cut } = await readLines(await route(stream("stream-cut-1")), 3);
    expect(cut).toBe(true);
    expect(lines.filter((l) => l.t !== undefined)).toHaveLength(3);
    const t = await settled("ws_stream_cut", (status) => status !== "running");
    expect(t.jobs[0].status).toBe("failed");
    expect(Number(t.jobs[0].cost_usd)).toBe(0);
    expect(t.meters).toHaveLength(1);
    expect(Number(t.meters[0].billed_credits)).toBe(0);
    expect(Number(t.meters[0].engine_cost_usd)).toBe(0);
    expect(await balanceOf("ws_stream_cut")).toBe(1000);
    expect(JSON.parse(String((await lineOf("ws_stream_cut")).provider_outcome))).toMatchObject({ code: "not_delivered", billing: { state: "unknown" } });
    /* Pressed again with the same key: the free ending, not a charge, not a second call. */
    for (let i = 0; i < 100; i++) {
      const again = await route(stream("stream-cut-1"));
      if (again.status === 499) { expect(await again.json()).toEqual({ error: "Cancelled. Nothing billed.", nothingBilled: true }); break; }
      if (i === 99) throw new Error("the claim never replayed the free ending");
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(calls).toBe(1);
    expect(await balanceOf("ws_stream_cut")).toBe(1000);
  });
});

/* Back inside a workspace that inWorkspace already made, to look at what it holds or press again. */
async function inScopeOf(ws: string, fn: () => Promise<void>) {
  const { platformDb, rowToWorkspace } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const row = rowToWorkspace((await platformDb().execute({ sql: "SELECT * FROM workspaces WHERE id=?", args: [ws] })).rows[0]);
  await runInTenant(row, fn, OWNER);
}

test("a Cancel or a dropped connection after the route has returned (outside the workspace's scope, as on the server) is still settled free, and the key replays it", async () => {
  for (const how of ["cancel", "abort"] as const) {
    const ws = `ws_stream_unscoped_${how}`;
    const key = `stream-unscoped-${how}`;
    const gone = new AbortController();
    let route: Handler = async () => { throw new Error("no route"); };
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    await inWorkspace(ws, async () => {
      route = enhance(answers(LONG));
      const response = await route(stream(key, gone.signal));
      expect(response.status).toBe(200);
      reader = response.body!.getReader();
      expect(JSON.parse(new TextDecoder().decode((await reader.read()).value!).split("\n")[0]).t).toBe("A ");
    });
    /* The handler has returned and its scope with it: the reader goes from here, where no workspace is in scope. */
    const { currentTenant } = await import("../../lib/tenant");
    expect(currentTenant(), how).toBeNull();
    if (how === "cancel") await reader!.cancel();
    else gone.abort();
    await inScopeOf(ws, async () => {
      /* The claim is ended last, once the job is settled: wait for it, then look. */
      const { db } = await import("../../lib/db");
      let claim: Record<string, unknown> | undefined;
      for (let i = 0; i < 200; i++) {
        claim = (await db().execute({ sql: "SELECT response_status,response_json FROM generation_requests WHERE request_key=?", args: [key] })).rows[0] as Record<string, unknown> | undefined;
        if (claim?.response_status != null) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(Number(claim?.response_status), `${how}: the claim is ended`).toBe(499);
      expect(JSON.parse(String(claim?.response_json)), how).toEqual({ error: "Cancelled. Nothing billed.", nothingBilled: true });
      const t = await traces(ws);
      expect(t.jobs.map((j) => j.status), how).toEqual(["failed"]);
      expect(Number(t.jobs[0].cost_usd), how).toBe(0);
      /* A reservation row stays as the line's record; what holds credits is its meter line still running. */
      const { platformDb } = await import("../../lib/platform");
      const held = await platformDb().execute({ sql: "SELECT m.status FROM generation_reservations r JOIN meter_events m ON m.id=r.id AND m.workspace_id=r.workspace_id WHERE r.workspace_id=? AND m.status='running'", args: [ws] });
      expect(held.rows, `${how}: nothing is left held`).toHaveLength(0);
      expect(t.meters.map((m) => m.status), how).toEqual(["failed"]);
      expect(Number(t.meters[0].billed_credits), how).toBe(0);
      expect(await balanceOf(ws), how).toBe(1000);
      /* The same press again: the free ending, never "still being accepted". */
      const again = await route(stream(key));
      expect(again.status, how).toBe(499);
      expect(await again.json(), how).toEqual({ error: "Cancelled. Nothing billed.", nothingBilled: true });
      expect(await balanceOf(ws), how).toBe(1000);
    });
    if (how === "abort") await reader!.cancel().catch(() => {});
  }
});

test("a press cancelled before the writer answers is dropped at the provider and never billed", async () => {
  await inWorkspace("ws_stream_cancel", async () => {
    const controller = new AbortController();
    const waiting: Submit = (request) => new Promise((_resolve, reject) => {
      request.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      setTimeout(() => controller.abort(), 30);
    });
    const response = await enhance(waiting)(stream("stream-cancel-1", controller.signal));
    expect(response.status).toBe(499);
    expect(await response.json()).toEqual({ error: "Cancelled. Nothing billed.", nothingBilled: true });
    const t = await traces("ws_stream_cancel");
    expect(t.jobs[0].status).toBe("failed");
    expect(Number(t.meters[0].billed_credits)).toBe(0);
    expect(await balanceOf("ws_stream_cancel")).toBe(1000);
    expect(JSON.parse(String((await lineOf("ws_stream_cancel")).provider_outcome))).toMatchObject({ code: "no_answer", billing: { state: "unknown" } });
  });
});

test("a double press charges once: the same key while the first is on its way is told it is still being accepted, and only one provider call is made", async () => {
  await inWorkspace("ws_stream_double", async () => {
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const route = enhance(async (r) => { calls++; await gate; return answers(LONG)(r); });
    const first = route(stream("stream-double-1"));
    await new Promise((r) => setTimeout(r, 100));
    const second = await route(stream("stream-double-1"));
    expect(second.status).toBe(409);
    expect((await second.json()).pending).toBe(true);
    release();
    const { lines } = await readLines(await first);
    expect(lines.at(-1)).toMatchObject({ done: true });
    expect(calls).toBe(1);
    const t = await traces("ws_stream_double");
    expect(t.jobs).toHaveLength(1);
    expect(Number(t.meters[0].billed_credits)).toBe(1);
    expect(await balanceOf("ws_stream_double")).toBe(999);
  });
});

test("a refused press is never billed: an answer that is not a prompt, one that drops a citation, and one with nothing in it settle at zero", async () => {
  const cases: [string, Submit, number, string][] = [
    ["not a prompt", async () => ({ ok: true, status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ prompt: "" }) } }], usage: { cost: 0.0004 } }) }), 502, "a tree in rain"],
    ["no text", async () => ({ ok: true, status: 200, text: JSON.stringify({ choices: [{ message: { content: "" } }], usage: { cost: 0.0004 } }) }), 502, "a tree in rain"],
    /* The typed words cite @Image1; the rewrite leaves it out. */
    ["dropped citation", answers("A lone tree in steady rain, slow push-in."), 502, "@Image1 a tree in rain"],
  ];
  for (const [name, submit, status, prompt] of cases) {
    const ws = `ws_refused_${name.replace(/\W/g, "_")}`;
    await inWorkspace(ws, async () => {
      for (const streamed of [false, true]) {
        const slug = name.replace(/\W/g, "-");
        const request = new Request("http://localhost/api/prompt/enhance", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": `refused-${streamed}-${slug}` },
          body: JSON.stringify({ prompt, mode: "video", provider: "claude", maxCredits: 5, ...(streamed ? { stream: true } : {}) }),
        });
        const out = await enhance(submit)(request);
        expect(out.status, name).toBe(status);
        const said = await out.json();
        expect(said.nothingBilled, name).toBe(true);
        if (name === "dropped citation") expect(said.error).toMatch(/@Image1/);
      }
      const t = await traces(ws);
      expect(t.meters.every((m) => Number(m.billed_credits) === 0), name).toBe(true);
      expect(t.meters.every((m) => Number(m.engine_cost_usd) === 0), name).toBe(true);
      expect(await balanceOf(ws), `${name}: the whole grant is still there`).toBe(1000);
    });
  }
});

/* The stream's phases on their own (lib/enhanceStream.ts), with the settlement and the claim as stubs: what is charged and what the key replays never disagree. */
async function phases(o: { finishGate?: Promise<void>; finishFails?: Error; signal?: AbortSignal } = {}) {
  const { enhanceStream } = await import("../../lib/enhanceStream");
  const calls: string[] = [];
  const claims: { status: number; body: Record<string, unknown> }[] = [];
  let finishing = false;
  const body = enhanceStream({
    answer: { prompt: "A lone tree in steady rain.", provider: "claude", writer: WRITER },
    finish: async () => { finishing = true; calls.push("finish"); await o.finishGate; if (o.finishFails) throw o.finishFails; calls.push("charged"); },
    abandon: async () => { calls.push("abandon"); },
    complete: async (status, json) => { claims.push({ status, body: JSON.parse(json) }); },
    signal: o.signal,
    gapMs: 0,
  });
  return { reader: body.getReader(), calls, claims, finishing: () => finishing };
}
const until = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5)); expect(ok()).toBe(true); };

test("the stream's phases: a reader gone while words go out abandons (free) and finish is never called; the claim says Nothing billed", async () => {
  const p = await phases();
  await p.reader.read();
  await p.reader.cancel();
  await until(() => p.claims.length > 0);
  expect(p.calls).toEqual(["abandon"]);
  expect(p.claims).toEqual([{ status: 499, body: { error: "Cancelled. Nothing billed.", nothingBilled: true } }]);
  /* The request's own signal ending (a dropped connection) is the same. */
  const gone = new AbortController();
  const q = await phases({ signal: gone.signal });
  await q.reader.read();
  gone.abort();
  await until(() => q.claims.length > 0);
  expect(q.calls).toEqual(["abandon"]);
  expect(q.claims.map((c) => c.status)).toEqual([499]);
});

test("the stream's phases: a reader gone while the charge is being made changes nothing; the charge stands once and the key replays the answer, never Nothing billed", async () => {
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const gone = new AbortController();
  const p = await phases({ finishGate: gate, signal: gone.signal });
  /* Every word is out (unread, queued) and the charge is being made. */
  await until(() => p.finishing());
  /* Mid-settlement: Cancel, and the connection drops too. */
  void p.reader.cancel().catch(() => {});
  gone.abort();
  open();
  await until(() => p.claims.length > 0);
  await new Promise((r) => setTimeout(r, 30));
  expect(p.calls).toEqual(["finish", "charged"]);
  expect(p.claims).toEqual([{ status: 200, body: { prompt: "A lone tree in steady rain.", provider: "claude", writer: WRITER } }]);
});

test("the stream's phases: a finish refused by paid text is said as Nothing billed; any other failure claims nothing about the bill", async () => {
  const { PaidTextError } = await import("../../lib/paidText");
  const refused = await phases({ finishFails: new PaidTextError("The text provider answered too late; this request had already ended.") });
  const lines: string[] = [];
  for (;;) { const { value, done } = await refused.reader.read(); if (done) break; lines.push(...new TextDecoder().decode(value).split("\n").filter(Boolean)); }
  expect(JSON.parse(lines.at(-1)!)).toMatchObject({ nothingBilled: true });
  expect(refused.claims).toEqual([{ status: 502, body: { error: "The text provider answered too late; this request had already ended.", nothingBilled: true } }]);
  const broken = await phases({ finishFails: new Error("database is locked") });
  for (;;) { const { done } = await broken.reader.read(); if (done) break; }
  expect(broken.claims).toEqual([{ status: 502, body: { error: "The answer couldn't be delivered." } }]);
});
