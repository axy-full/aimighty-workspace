import { test, expect } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import type { AdmissionActor } from "../../lib/admissionTypes";
import {
  ENHANCE_ABANDONED, ENHANCE_KEY_ABANDON_MS, ENHANCE_LOST, ENHANCE_PENDING, EnhanceKeys, EnhanceRuns, enhanceSignature, pressEnhance,
} from "../../lib/shell/enhance-press";

/**
 * Enhance is sent under a key held for the exact press (docs/long-flows.md › C4,
 * lib/shell/enhance-press.ts). Pressed again after a lost reply, the same key
 * collects the saved answer: one provider call, one charge. A change of words,
 * settings, price, account or workspace, or an answer read, lets the key go.
 */
const dir = mkdtempSync(path.join(tmpdir(), "enhance-key-"));
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

type Submit = () => Promise<{ ok: boolean; status: number; text: string }>;
type Handler = (req: Request) => Promise<Response>;

function enhance(submit: Submit): Handler {
  const paidText = nodeRequire(path.resolve("lib/paidText.ts"));
  const signedIn = async () => OWNER;
  return load<{ POST: Handler }>("app/api/prompt/enhance/route.ts", {
    "@/lib/auth": { ...nodeRequire(path.resolve("lib/auth.ts")), withTenant: (h: unknown) => h, requireRender: signedIn },
    "@/lib/catalog": { catalog: async () => [MODEL] },
    "@/lib/gateway": { gatewayReachable: () => true },
    "@/lib/paidText": { ...paidText, runPaidText: (input: unknown, o: Record<string, unknown> = {}) => paidText.runPaidText(input, { ...o, submit }) },
    "next/server": { NextResponse: Response, after: () => { throw new Error("Nothing is continued after the response here"); } },
  }).POST;
}

/** A provider that answers, counting its calls. */
function provider() {
  const calls = { n: 0 };
  const submit: Submit = async () => {
    calls.n++;
    return { ok: true, status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ prompt: `A lone tree in steady rain, take ${calls.n}.` }) } }], usage: { cost: 0.0004 } }) };
  };
  return { calls, submit };
}

type Sent = { key: string; body: Record<string, unknown> };
/** The browser's fetch onto the route. `lose` drops the reply after the route answered (the server saved it). */
function browser(route: Handler) {
  const sent: Sent[] = [];
  let lose: "throw" | "504" | null = null;
  const fetcher = async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    sent.push({ key: String(headers.get("Idempotency-Key")), body: JSON.parse(String(init.body)) });
    const response = await route(new Request(`http://localhost${url}`, init));
    const how = lose;
    lose = null;
    if (how === "throw") throw new TypeError("Failed to fetch");
    if (how === "504") return new Response("An error occurred with your deployment", { status: 504 });
    return response;
  };
  return { fetcher, sent, loseNext: (how: "throw" | "504") => { lose = how; } };
}

async function charges(ws: string) {
  const { platformDb } = await import("../../lib/platform");
  return (await platformDb().execute({ sql: "SELECT status,billed_credits FROM meter_events WHERE workspace_id=?", args: [ws] })).rows;
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

const SCOPE = "particl-active-ws-owner";
const body = (prompt: string, extra: Record<string, unknown> = {}) => JSON.stringify({ prompt, mode: "video", provider: "claude", anchored: false, editing: false, ...extra });

test("the same press after a lost reply collects the saved answer: one provider call, one charge", async () => {
  await inWorkspace("ws_enhance_lost", async () => {
    const { calls, submit } = provider();
    const { fetcher, sent, loseNext } = browser(enhance(submit));
    const keys = new EnhanceKeys();
    const press = { scope: SCOPE, body: body("a tree in rain"), credits: 5 };

    loseNext("throw");
    expect(await pressEnhance(fetcher, press, keys)).toEqual({ ok: false, error: ENHANCE_LOST });
    expect(calls.n).toBe(1);
    expect(await charges("ws_enhance_lost")).toHaveLength(1);

    /* The host cut the reply this time (a 504 page, nothing saved by us in it): still the same press. */
    loseNext("504");
    expect((await pressEnhance(fetcher, press, keys)).ok).toBe(false);

    const again = await pressEnhance(fetcher, press, keys);
    expect(again).toEqual({ ok: true, prompt: "A lone tree in steady rain, take 1.", provider: "claude" });
    expect(new Set(sent.map((s) => s.key)).size).toBe(1);
    expect(calls.n).toBe(1);
    const once = await charges("ws_enhance_lost");
    expect(once).toHaveLength(1);
    expect(once[0].status).toBe("succeeded");
    expect(Number(once[0].billed_credits)).toBe(1);

    /* The answer was read: pressing again is a new enhancement, under a fresh key, and a new charge. */
    const next = await pressEnhance(fetcher, press, keys);
    expect(next).toEqual({ ok: true, prompt: "A lone tree in steady rain, take 2.", provider: "claude" });
    expect(sent.at(-1)!.key).not.toBe(sent[0].key);
    expect(calls.n).toBe(2);
    expect(await charges("ws_enhance_lost")).toHaveLength(2);
  });
});

test("changed words after a lost reply are a new press: a new key and a new charge", async () => {
  await inWorkspace("ws_enhance_changed", async () => {
    const { calls, submit } = provider();
    const { fetcher, sent, loseNext } = browser(enhance(submit));
    const keys = new EnhanceKeys();

    loseNext("throw");
    await pressEnhance(fetcher, { scope: SCOPE, body: body("a tree in rain"), credits: 5 }, keys);
    const changed = await pressEnhance(fetcher, { scope: SCOPE, body: body("a tree in snow"), credits: 5 }, keys);
    expect(changed.ok).toBe(true);
    expect(sent[1].key).not.toBe(sent[0].key);
    expect(sent[1].body.prompt).toBe("a tree in snow");
    expect(calls.n).toBe(2);
    expect(await charges("ws_enhance_changed")).toHaveLength(2);
  });
});

test("a saved refusal lets the key go, so the next press is not answered with the old refusal", async () => {
  await inWorkspace("ws_enhance_refused", async () => {
    let declined = true;
    const { calls, submit: answers } = provider();
    const submit: Submit = async () => declined ? { ok: false, status: 400, text: "{}" } : answers();
    const { fetcher, sent } = browser(enhance(submit));
    const keys = new EnhanceKeys();
    const press = { scope: SCOPE, body: body("a tree in rain"), credits: 5 };

    const refused = await pressEnhance(fetcher, press, keys);
    expect(refused).toEqual({ ok: false, error: "The text provider declined this request (400). No generation credits were charged." });
    declined = false;
    const retried = await pressEnhance(fetcher, press, keys);
    expect(retried.ok).toBe(true);
    expect(sent[1].key).not.toBe(sent[0].key);
    expect(calls.n).toBe(1);
  });
});

test("a key is held for one account, workspace, request and price: any change mints another", () => {
  let n = 0;
  const keys = new EnhanceKeys(() => `enhance-k${++n}`);
  const a = enhanceSignature(SCOPE, body("a tree in rain"), 5);
  expect(keys.take(a, 0)).toBe("enhance-k1");
  expect(keys.take(a, 1)).toBe("enhance-k1");
  for (const other of [
    enhanceSignature("particl-active-ws-other", body("a tree in rain"), 5),
    enhanceSignature("particl-active-ws2-owner", body("a tree in rain"), 5),
    enhanceSignature(SCOPE, body("a tree in rain", { mode: "image" }), 5),
    enhanceSignature(SCOPE, body("a tree in rain", { model: "kling" }), 5),
    enhanceSignature(SCOPE, body("a tree in rain"), 6),
  ]) {
    const before = n;
    keys.take(other, 2);
    expect(n).toBe(before + 1);
  }
  /* Back to the first press after another was held: a fresh key, never one held for someone else. */
  expect(keys.take(a, 3)).toBe(`enhance-k${n}`);
  expect(new EnhanceKeys().take(a, 0)).toMatch(/^enhance-[0-9a-f-]{36}$/);
});

test("a press still being accepted keeps its key; one that never finished is let go after the abandon window", async () => {
  const keys = new EnhanceKeys();
  const pending = async () => Response.json({ error: "This request is still being accepted.", pending: true }, { status: 409, headers: { "Idempotency-Replayed": "true" } });
  const press = { scope: SCOPE, body: body("a tree in rain"), credits: 5 };
  const signature = enhanceSignature(press.scope, press.body, press.credits);
  const key = keys.take(signature, 0);
  expect(await pressEnhance(pending, press, keys, () => 60_000)).toEqual({ ok: false, error: ENHANCE_PENDING });
  expect(keys.take(signature, 60_000)).toBe(key);
  expect(await pressEnhance(pending, press, keys, () => ENHANCE_KEY_ABANDON_MS)).toEqual({ ok: false, error: ENHANCE_ABANDONED });
  expect(keys.take(signature, ENHANCE_KEY_ABANDON_MS)).not.toBe(key);
});

test("the Enhance button sends through the held key, not a fresh key per press", () => {
  const hook = readFileSync("lib/shell/use-enhancer.ts", "utf8");
  expect(hook).toContain("presses.run(scoped, { scope: approved.scope, body: approved.key, credits }, () => ({ scope: live.current.scope, body: live.current.key }))");
  expect(hook).toContain('if ("stale" in pressed) return null;');
  expect(hook).toContain("const shown = result && result.body === key ? result : null;");
  expect(hook).not.toContain("randomUUID");
  expect(hook).not.toContain("Idempotency-Key");
});

/** A provider that holds its answer for words containing `hold` until released, and answers anything else at once. */
function heldProvider(hold: string) {
  const calls: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const submit = async (request: { body: string }) => {
    const words = JSON.parse(request.body).messages.at(-1).content as string;
    calls.push(words);
    if (words.includes(hold)) await gate;
    return { ok: true, status: 200, text: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ prompt: `Enhanced: ${words}.` }) } }], usage: { cost: 0.0004 } }) };
  };
  return { calls, submit: submit as unknown as Submit, release: () => release() };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 25));
  expect(check()).toBe(true);
}

test("the same press while one is on its way shares its answer: one send, one charge", async () => {
  await inWorkspace("ws_enhance_shared", async () => {
    const provider = heldProvider("rain");
    const { fetcher, sent } = browser(enhance(provider.submit));
    const runs = new EnhanceRuns(new EnhanceKeys());
    const press = { scope: SCOPE, body: body("a tree in rain"), credits: 5 };
    const now = () => ({ scope: SCOPE, body: press.body });

    const first = runs.run(fetcher, press, now);
    await until(() => provider.calls.length === 1);
    expect(runs.busy).toBe(true);
    const second = runs.run(fetcher, press, now);
    provider.release();
    const answers = await Promise.all([first, second]);
    expect(answers[0]).toEqual({ ok: true, prompt: "Enhanced: a tree in rain.", provider: "claude" });
    expect(answers[1]).toEqual(answers[0]);
    expect(sent).toHaveLength(1);
    expect(provider.calls).toHaveLength(1);
    expect(await charges("ws_enhance_shared")).toHaveLength(1);
    expect(runs.busy).toBe(false);
  });
});

test("words replaced while a press is on its way: the new words get their own press and answer, the old answer is never handed back", async () => {
  await inWorkspace("ws_enhance_replaced", async () => {
    const provider = heldProvider("rain");
    const { fetcher, sent } = browser(enhance(provider.submit));
    const runs = new EnhanceRuns(new EnhanceKeys());
    const a = { scope: SCOPE, body: body("a tree in rain"), credits: 5 };
    const b = { scope: SCOPE, body: body("a tree in snow"), credits: 5 };
    /* What the composer holds: A, then (while A is on its way) the person's new words B. */
    let holding = a.body;
    const now = () => ({ scope: SCOPE, body: holding });

    const first = runs.run(fetcher, a, now);
    await until(() => provider.calls.length === 1);
    holding = b.body;
    /* Auto's Make on the new words: not A's answer, a press of its own. */
    const second = await runs.run(fetcher, b, now);
    expect(second).toEqual({ ok: true, prompt: "Enhanced: a tree in snow.", provider: "claude" });
    expect(sent.map((s) => s.body.prompt)).toEqual(["a tree in rain", "a tree in snow"]);
    expect(sent[1].key).not.toBe(sent[0].key);

    provider.release();
    /* A's answer arrives for words no longer there: dropped, never applied over B. */
    expect(await first).toEqual({ ok: false, stale: true });
    expect(runs.busy).toBe(false);

    /* The same after the account or workspace changed underneath a press. */
    const c = { scope: SCOPE, body: body("a tree in fog"), credits: 5 };
    holding = c.body;
    const moved = await runs.run(fetcher, c, () => ({ scope: "particl-active-ws2-owner", body: c.body }));
    expect(moved).toEqual({ ok: false, stale: true });
  });
});
