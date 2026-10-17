import { test, expect } from "@playwright/test";
import { ENHANCE_CLIENT_MS, ENHANCE_FAILED, ENHANCE_IDLE_MS, ENHANCE_LOST, EnhanceKeys, EnhanceRuns, pressEnhance } from "../../lib/shell/enhance-press";

/**
 * The Enhance press on the client (lib/shell/enhance-press.ts), the owner's loader of 16 Oct 2026: the rewrite streams in word by word; success, a slow first
 * word, a stream that goes quiet or is cut off, a provider error, a missing key, Cancel before and during, a double press, and a press that replays its own
 * cancelled one. Whatever goes wrong the person is told the one line and the typed words are theirs again. No network: the fetcher is a stub.
 */
const press = { scope: "s", body: JSON.stringify({ prompt: "a kite" }), credits: 1 };
let n = 0;
const keys = () => new EnhanceKeys(() => `k${++n}`);
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
/** An NDJSON answer whose lines the test releases when it likes. */
function live() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  const response = () => new Response(body, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
  return { response, line: (value: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`)), end: () => controller.close(), fail: (e: unknown) => controller.error(e) };
}
const answer = (words: string[], tail: unknown[] = []) => {
  const stream = live();
  const send = async () => { for (const t of words) { stream.line({ t }); await new Promise((r) => setTimeout(r, 1)); } for (const line of tail) stream.line(line); stream.end(); };
  return { response: stream.response, send };
};
const never = (_url: string, init: RequestInit) => new Promise<Response>((_r, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));

test("the first words wait 10 s, a quiet stream 5 s, and the one failure line is the owner's, exactly", () => {
  expect(ENHANCE_CLIENT_MS).toBe(10_000);
  expect(ENHANCE_IDLE_MS).toBe(5_000);
  expect(ENHANCE_FAILED).toBe("Couldn't enhance this time. Nothing was charged.");
});

test("success: the words arrive one by one as the whole rewrite so far, then the final prompt; the key is let go", async () => {
  const k = keys();
  const seen: string[] = [];
  const a = answer(["A ", "paper ", "kite "], [{ done: true, prompt: "A paper kite ", provider: "claude", writer: "w" }]);
  let sent: Record<string, unknown> = {};
  const out = pressEnhance(async (_u, init) => { sent = JSON.parse(String(init.body)); return a.response(); }, press, k, Date.now, 500, { onWords: (soFar) => seen.push(soFar) });
  void a.send();
  expect(await out).toEqual({ ok: true, prompt: "A paper kite ", provider: "claude" });
  expect(seen).toEqual(["A ", "A paper ", "A paper kite "]);
  expect(sent).toMatchObject({ stream: true, maxCredits: 1, prompt: "a kite" });
  expect(k.take("x", 0), "released: the next press has a fresh key").toBeTruthy();
});

test("a slow first word: given up on at the limit, the one line, and the same press is sent under the same key", async () => {
  const k = keys();
  const sentKeys: string[] = [];
  const slow = (url: string, init: RequestInit) => { sentKeys.push(new Headers(init.headers).get("Idempotency-Key") ?? ""); return never(url, init); };
  const started = Date.now();
  expect(await pressEnhance(slow, press, k, Date.now, { firstMs: 40, idleMs: 40 })).toEqual({ ok: false, error: ENHANCE_FAILED });
  expect(Date.now() - started).toBeLessThan(1_000);
  await pressEnhance(slow, press, k, Date.now, { firstMs: 40, idleMs: 40 });
  expect(sentKeys[1]).toBe(sentKeys[0]);
});

test("a stream that goes quiet after its first words, and one that is cut off, are failed: the words are not kept", async () => {
  const quiet = live();
  const seen: string[] = [];
  const out = pressEnhance(async () => quiet.response(), press, keys(), Date.now, { firstMs: 500, idleMs: 40 }, { onWords: (s) => seen.push(s) });
  quiet.line({ t: "A " });
  expect(await out).toEqual({ ok: false, error: ENHANCE_FAILED });
  expect(seen).toEqual(["A "]);
  const cut = answer(["A ", "paper "]);
  const gone = pressEnhance(async () => cut.response(), press, keys(), Date.now, 500);
  await cut.send();
  expect(await gone, "ended with no last line").toEqual({ ok: false, error: ENHANCE_FAILED });
  const broken = live();
  const dropped = pressEnhance(async () => broken.response(), press, keys(), Date.now, 500);
  broken.line({ t: "A " });
  await new Promise((r) => setTimeout(r, 15));
  broken.fail(new TypeError("network error"));
  expect(await dropped).toEqual({ ok: false, error: ENHANCE_FAILED });
});

test("the server's own error line in a stream, and a JSON refusal of any status, are the one line", async () => {
  const bad = answer(["A "], [{ error: "The answer wasn't delivered.", nothingBilled: true }]);
  const out = pressEnhance(async () => bad.response(), press, keys(), Date.now, 500);
  void bad.send();
  expect(await out).toEqual({ ok: false, error: ENHANCE_FAILED });
  for (const status of [400, 402, 409, 502, 503, 504])
    expect(await pressEnhance(async () => json(status, { error: "whatever the server said", nothingBilled: true }), press, keys(), Date.now, 50), String(status)).toEqual({ ok: false, error: ENHANCE_FAILED });
  expect(await pressEnhance(async () => json(503, { error: "No text writer is set up for this workspace." }), press, keys(), Date.now, 50), "a missing key").toEqual({ ok: false, error: ENHANCE_FAILED });
  expect(await pressEnhance(async () => json(200, { prompt: "", provider: "claude" }), press, keys(), Date.now, 50)).toEqual({ ok: false, error: ENHANCE_FAILED });
});

test("a reply nobody could read is a lost one: the press is collected again by its key, never charged twice", async () => {
  expect(await pressEnhance(async () => new Response("<html>gateway</html>", { status: 504 }), press, keys(), Date.now, 50)).toEqual({ ok: false, error: ENHANCE_LOST });
  expect(await pressEnhance(async () => { throw new TypeError("Failed to fetch"); }, press, keys(), Date.now, 50)).toEqual({ ok: false, error: ENHANCE_LOST });
});

test("Cancel before any word, and during the stream: stopped, nothing said, the request dropped", async () => {
  const before = new AbortController();
  let dropped = false;
  const waiting = (_u: string, init: RequestInit) => new Promise<Response>((_r, reject) => init.signal?.addEventListener("abort", () => { dropped = true; reject(new DOMException("aborted", "AbortError")); }));
  const out = pressEnhance(waiting, press, keys(), Date.now, 5_000, { signal: before.signal });
  setTimeout(() => before.abort(), 20);
  expect(await out).toEqual({ ok: false, error: "", cancelled: true });
  expect(dropped).toBe(true);
  const during = new AbortController();
  const stream = live();
  const mid = pressEnhance(async () => stream.response(), press, keys(), Date.now, 5_000, { signal: during.signal, onWords: () => during.abort() });
  stream.line({ t: "A " });
  expect(await mid).toEqual({ ok: false, error: "", cancelled: true });
});

test("a press that replays its own cancelled or cut-off one (settled at nothing) is made again, once, under a fresh key", async () => {
  const k = keys();
  const sentKeys: string[] = [];
  const a = answer(["Better "], [{ done: true, prompt: "Better ", provider: "claude", writer: "w" }]);
  let calls = 0;
  const fetcher = async (_u: string, init: RequestInit) => {
    sentKeys.push(new Headers(init.headers).get("Idempotency-Key") ?? "");
    if (++calls === 1) return json(499, { error: "Cancelled. Nothing billed.", nothingBilled: true }, { "Idempotency-Status": "complete", "Idempotency-Replayed": "true" });
    void a.send();
    return a.response();
  };
  expect(await pressEnhance(fetcher, press, k, Date.now, 500)).toEqual({ ok: true, prompt: "Better ", provider: "claude" });
  expect(sentKeys).toHaveLength(2);
  expect(sentKeys[1]).not.toBe(sentKeys[0]);
});

test("a double press is one press: the same words on their way share one request and one answer", async () => {
  let requests = 0;
  const a = answer(["Once "], [{ done: true, prompt: "Once ", provider: "claude", writer: "w" }]);
  const runs = new EnhanceRuns(keys(), Date.now, 500);
  const now = () => ({ scope: "s", body: press.body });
  const fetcher = async () => { requests++; return a.response(); };
  const first = runs.run(fetcher, press, now);
  const second = runs.run(fetcher, press, now);
  void a.send();
  expect(await first).toEqual({ ok: true, prompt: "Once ", provider: "claude" });
  expect(await second).toEqual({ ok: true, prompt: "Once ", provider: "claude" });
  expect(requests).toBe(1);
});

test("the runs share the deadline: a press that times out leaves the control free for the next", async () => {
  const runs = new EnhanceRuns(keys(), Date.now, { firstMs: 40, idleMs: 40 });
  const now = () => ({ scope: "s", body: press.body });
  expect(await runs.run(never, press, now)).toEqual({ ok: false, error: ENHANCE_FAILED });
  await expect.poll(() => runs.busy).toBe(false);
  const a = answer(["better "], [{ done: true, prompt: "better ", provider: "claude", writer: "w" }]);
  const out = runs.run(async () => a.response(), press, now);
  void a.send();
  expect(await out).toEqual({ ok: true, prompt: "better ", provider: "claude" });
});

test("Make never reaches the enhancer: the one run in Make's logic is the Enhance press, and the Make press does not touch it", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync("components/graphite/make/use-make.ts", "utf8");
  expect(source.match(/enhancer\.run\(/g), "one run, in pressEnhance").toHaveLength(1);
  expect(source).not.toMatch(/enhancer\.enhance\(/);
  const press = source.slice(source.indexOf("const make = useCallback"), source.indexOf("/* Enhance, pressed by a person"));
  expect(press).toContain("composer.generate()");
  expect(press.replace(/\/\*[\s\S]*?\*\//g, "").replace(/enhancing|ENHANCE_WORKING/g, ""), "the Make press looks at nothing of the enhancer's but whether it is working").not.toMatch(/enhance/i);
  expect(source, "no Auto chain").not.toMatch(/autoNeeds|pending\.current/);
  expect(readFileSync("lib/shell/use-enhancer.ts", "utf8")).not.toMatch(/setAuto|auto:/);
});
