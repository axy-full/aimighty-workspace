import { test, expect } from "@playwright/test";
import {
  ENHANCE_CLIENT_MS, ENHANCE_COLLECT_TRIES, ENHANCE_COULDNT, ENHANCE_FAILED, ENHANCE_IDLE_MS, ENHANCE_LOST, ENHANCE_PENDING, EnhanceKeys, EnhanceRuns, enhanceHeldLine, pressEnhance,
} from "../../lib/shell/enhance-press";

/**
 * The Enhance press on the client (lib/shell/enhance-press.ts), the owner's loader of 16 Oct 2026: the rewrite streams in word by word; success, a slow first
 * word, a stream that goes quiet or is cut off, a provider error, a missing key, Cancel before and during, a double press, and a press that replays its own
 * cancelled one. The no-charge sentence is said only when the server said it (or its saved ending, collected under the same key, did). No network: the
 * fetcher is a stub.
 */
const press = { scope: "s", body: JSON.stringify({ prompt: "a kite" }), credits: 1 };
let n = 0;
const keys = () => new EnhanceKeys(() => `k${++n}`);
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
/** The server's saved ending for a key, as a replay reads it. */
const replay = (status: number, body: unknown) => json(status, body, { "Idempotency-Status": "complete", "Idempotency-Replayed": "true" });
const FREE_CUT = { error: "Cancelled. Nothing billed.", nothingBilled: true };
const STILL = () => json(409, { error: "This request is still being accepted.", pending: true }, { "Idempotency-Replayed": "true" });
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
/** A fetcher that answers each call in turn, recording the keys sent. */
function inTurn(...replies: ((url: string, init: RequestInit) => Promise<Response> | Response)[]) {
  const sent: string[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    sent.push(new Headers(init.headers).get("Idempotency-Key") ?? "");
    const next = replies[Math.min(sent.length - 1, replies.length - 1)];
    return next(url, init);
  };
  return { fetcher, sent };
}
const words = (seen: string[] = []) => ({ onWords: (soFar: string) => seen.push(soFar) });
const fast = { firstMs: 60, idleMs: 40, collectMs: 60, collectGapMs: 5 };

test("the first words wait 10 s, a quiet stream 5 s; the failure lines are the owner's, exactly", () => {
  expect(ENHANCE_CLIENT_MS).toBe(10_000);
  expect(ENHANCE_IDLE_MS).toBe(5_000);
  expect(ENHANCE_COULDNT).toBe("Couldn't enhance this time.");
  expect(ENHANCE_FAILED).toBe("Couldn't enhance this time. Nothing was charged.");
  expect(enhanceHeldLine(1)).toBe("Couldn't enhance this time. 1 cr held for now; it comes back to your balance automatically, usually within a few hours.");
});

test("success: the words arrive one by one as the whole rewrite so far, then the final prompt; the key is let go", async () => {
  const k = keys();
  const seen: string[] = [];
  const a = answer(["A ", "paper ", "kite "], [{ done: true, prompt: "A paper kite ", provider: "claude", writer: "w" }]);
  let sent: Record<string, unknown> = {};
  const out = pressEnhance(async (_u, init) => { sent = JSON.parse(String(init.body)); return a.response(); }, press, k, Date.now, 500, words(seen));
  void a.send();
  expect(await out).toEqual({ ok: true, prompt: "A paper kite ", provider: "claude" });
  expect(seen).toEqual(["A ", "A paper ", "A paper kite "]);
  expect(sent).toMatchObject({ stream: true, maxCredits: 1, prompt: "a kite" });
  expect(k.take("x", 0), "released: the next press has a fresh key").toBeTruthy();
});

test("Nothing was charged is said only on the server's word: a refusal that says nothingBilled, one that says nothing, one that holds an estimate", async () => {
  for (const status of [400, 402, 409, 502, 503, 504])
    expect(await pressEnhance(async () => json(status, { error: "whatever the server said", nothingBilled: true }), press, keys(), Date.now, 50), String(status)).toEqual({ ok: false, error: ENHANCE_FAILED });
  /* No word on the bill from the server: the plain line, never a claim it did not make. */
  expect(await pressEnhance(async () => json(503, { error: "No text writer is set up for this workspace." }), press, keys(), Date.now, 50), "a missing key said plainly").toEqual({ ok: false, error: ENHANCE_COULDNT });
  expect(await pressEnhance(async () => json(200, { prompt: "", provider: "claude" }), press, keys(), Date.now, 50)).toEqual({ ok: false, error: ENHANCE_COULDNT });
  /* A charge the server holds for now: its own figure. A held figure of zero says nothing it cannot back. */
  expect(await pressEnhance(async () => json(502, { error: "uncertain", heldCredits: 1 }), press, keys(), Date.now, 50)).toEqual({ ok: false, error: enhanceHeldLine(1) });
  expect(await pressEnhance(async () => json(502, { error: "uncertain", heldCredits: 0 }), press, keys(), Date.now, 50)).toEqual({ ok: false, error: ENHANCE_COULDNT });
  /* The same in a stream's error line. */
  for (const [tail, line] of [[{ error: "The answer wasn't delivered.", nothingBilled: true }, ENHANCE_FAILED], [{ error: "The answer couldn't be delivered." }, ENHANCE_COULDNT]] as const) {
    const bad = answer(["A "], [tail]);
    const out = pressEnhance(async () => bad.response(), press, keys(), Date.now, 500, words());
    void bad.send();
    expect(await out).toEqual({ ok: false, error: line });
  }
});

test("a stream cut off midway, one that goes quiet, and one that ends without its last line: asked again under the same key, and the server's free ending is said", async () => {
  for (const how of ["cut", "quiet", "ended"] as const) {
    const k = keys();
    const stream = live();
    const seen: string[] = [];
    const { fetcher, sent } = inTurn(() => stream.response(), () => replay(499, FREE_CUT));
    const out = pressEnhance(fetcher, press, k, Date.now, fast, words(seen));
    stream.line({ t: "A " });
    await new Promise((r) => setTimeout(r, 10));
    if (how === "cut") stream.fail(new TypeError("network error"));
    if (how === "ended") stream.end();
    expect(await out, how).toEqual({ ok: false, error: ENHANCE_FAILED });
    expect(seen, how).toEqual(["A "]);
    expect(sent, `${how}: one press and one collect, under one key`).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
    expect(k.take("other", 0), `${how}: the free ending let the key go`).toBeTruthy();
  }
});

test("a stream whose last line was lost after the charge stood is collected: the words it paid for land, once, and nothing says it was free", async () => {
  const stream = live();
  const { fetcher, sent } = inTurn(() => stream.response(), () => replay(200, { prompt: "A paper kite at dusk", provider: "claude", writer: "w" }));
  const out = pressEnhance(fetcher, press, keys(), Date.now, fast, words());
  stream.line({ t: "A paper kite " });
  stream.line({ t: "at dusk" });
  stream.end();
  expect(await out).toEqual({ ok: true, prompt: "A paper kite at dusk", provider: "claude" });
  expect(sent).toHaveLength(2);
  expect(sent[1]).toBe(sent[0]);
});

test("a claim still being settled is asked again a few times; still unsettled, it is said as still being answered, and the key is kept", async () => {
  const stream = live();
  const { fetcher, sent } = inTurn(() => stream.response(), STILL, STILL, () => replay(499, FREE_CUT));
  const out = pressEnhance(fetcher, press, keys(), Date.now, fast, words());
  stream.line({ t: "A " });
  stream.end();
  expect(await out).toEqual({ ok: false, error: ENHANCE_FAILED });
  expect(sent).toHaveLength(4);
  const k = keys();
  const late = live();
  const slow = inTurn(() => late.response(), STILL);
  const stuck = pressEnhance(slow.fetcher, press, k, Date.now, fast, words());
  late.end();
  expect(await stuck).toEqual({ ok: false, error: ENHANCE_PENDING });
  expect(slow.sent).toHaveLength(1 + ENHANCE_COLLECT_TRIES);
  expect(new Set(slow.sent).size).toBe(1);
});

test("no first word in time: the streamed press is asked again under its key; the server's saved deadline ending is free, and a collect that also hangs is a lost reply", async () => {
  const k = keys();
  const timed = inTurn(never, () => replay(504, { error: "The writer didn't answer in time. Nothing billed.", nothingBilled: true }));
  const started = Date.now();
  expect(await pressEnhance(timed.fetcher, press, k, Date.now, fast, words())).toEqual({ ok: false, error: ENHANCE_FAILED });
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(timed.sent[1]).toBe(timed.sent[0]);
  const hung = inTurn(never);
  const k2 = keys();
  expect(await pressEnhance(hung.fetcher, press, k2, Date.now, fast, words())).toEqual({ ok: false, error: ENHANCE_LOST });
  /* Pressed again: the same press, under the same key, so the server answers from its claim and never charges twice. */
  await pressEnhance(hung.fetcher, press, k2, Date.now, fast, words());
  expect(new Set(hung.sent).size).toBe(1);
});

test("a press that asks for the whole answer is never asked again on its own: a slow or lost reply is a lost one, collected by the next press under the same key", async () => {
  const k = keys();
  const slow = inTurn(never);
  expect(await pressEnhance(slow.fetcher, press, k, Date.now, fast)).toEqual({ ok: false, error: ENHANCE_LOST });
  expect(slow.sent).toHaveLength(1);
  await pressEnhance(slow.fetcher, press, k, Date.now, fast);
  expect(slow.sent[1]).toBe(slow.sent[0]);
  expect(await pressEnhance(async () => new Response("<html>gateway</html>", { status: 504 }), press, keys(), Date.now, 50)).toEqual({ ok: false, error: ENHANCE_LOST });
  expect(await pressEnhance(async () => { throw new TypeError("Failed to fetch"); }, press, keys(), Date.now, 50)).toEqual({ ok: false, error: ENHANCE_LOST });
});

test("Cancel before any word, and during the stream: stopped, nothing said, the request dropped, never asked again", async () => {
  const before = new AbortController();
  let dropped = false;
  let calls = 0;
  const waiting = (_u: string, init: RequestInit) => { calls++; return new Promise<Response>((_r, reject) => init.signal?.addEventListener("abort", () => { dropped = true; reject(new DOMException("aborted", "AbortError")); })); };
  const out = pressEnhance(waiting, press, keys(), Date.now, 5_000, { signal: before.signal, onWords: () => {} });
  setTimeout(() => before.abort(), 20);
  expect(await out).toEqual({ ok: false, error: "", cancelled: true });
  expect(dropped).toBe(true);
  expect(calls, "a cancelled press is not collected").toBe(1);
  const during = new AbortController();
  const stream = live();
  let streamed = 0;
  const mid = pressEnhance(async () => { streamed++; return stream.response(); }, press, keys(), Date.now, 5_000, { signal: during.signal, onWords: () => during.abort() });
  stream.line({ t: "A " });
  expect(await mid).toEqual({ ok: false, error: "", cancelled: true });
  expect(streamed).toBe(1);
});

test("a press that replays its own cancelled or cut-off one (settled at nothing) is made again, once, under a fresh key", async () => {
  const k = keys();
  const a = answer(["Better "], [{ done: true, prompt: "Better ", provider: "claude", writer: "w" }]);
  const { fetcher, sent } = inTurn(() => replay(499, FREE_CUT), () => { void a.send(); return a.response(); });
  expect(await pressEnhance(fetcher, press, k, Date.now, 500, words())).toEqual({ ok: true, prompt: "Better ", provider: "claude" });
  expect(sent).toHaveLength(2);
  expect(sent[1]).not.toBe(sent[0]);
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
  expect(await runs.run(never, press, now)).toEqual({ ok: false, error: ENHANCE_LOST });
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
  /* Its one look at the enhancer: it does not send while a pressed Enhance is writing the box (a half-written prompt is never made). */
  expect(press).toContain("if (recipeWait || spendOff || enhancing) return;");
  expect(press.replace(/\/\*[\s\S]*?\*\//g, "").replace(/enhancing|ENHANCE_WORKING/g, ""), "the Make press looks at nothing of the enhancer's but whether it is working").not.toMatch(/enhance/i);
  expect(source, "no Auto chain").not.toMatch(/autoNeeds|pending\.current/);
  expect(readFileSync("lib/shell/use-enhancer.ts", "utf8")).not.toMatch(/setAuto|auto:/);
});
