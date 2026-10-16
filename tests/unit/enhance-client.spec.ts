import { test, expect } from "@playwright/test";
import { ENHANCE_CLIENT_MS, ENHANCE_FALLBACK, EnhanceKeys, EnhanceRuns, pressEnhance } from "../../lib/shell/enhance-press";

/**
 * The Enhance press on the client (lib/shell/enhance-press.ts), the owner's 16 Oct 2026 list: success, a slow provider (the client gives up and
 * says the one line), a provider error, a missing key. Whatever goes wrong, the person is told one line and the typed words are untouched. No
 * network: the fetcher is a stub.
 */
const press = { scope: "s", body: JSON.stringify({ prompt: "a kite" }), credits: 1 };
const reply = (status: number, json: unknown, complete = true) => new Response(JSON.stringify(json), { status, headers: complete ? { "Idempotency-Status": "complete" } : {} });
let n = 0;
const keys = () => new EnhanceKeys(() => `k${++n}`);

test("the client waits 8 s at most", () => {
  expect(ENHANCE_CLIENT_MS).toBe(8_000);
  expect(ENHANCE_FALLBACK).toBe("Couldn't enhance; used your prompt as written");
});

test("success: the enhanced words, the writer and the signal that lets the press be abandoned", async () => {
  let signal: AbortSignal | null | undefined;
  const out = await pressEnhance(async (_url, init) => { signal = init.signal; return reply(200, { prompt: "A paper kite, low sun", provider: "claude" }); }, press, keys(), Date.now, 50);
  expect(out).toEqual({ ok: true, prompt: "A paper kite, low sun", provider: "claude" });
  expect(signal, "the request can be given up on").toBeInstanceOf(AbortSignal);
});

test("a slow provider: given up on at the deadline, the one line, and the same press collects its answer when pressed again", async () => {
  const k = keys();
  const sentKeys: string[] = [];
  const never = (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    sentKeys.push(new Headers(init.headers).get("Idempotency-Key") ?? "");
    init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
  const started = Date.now();
  const out = await pressEnhance(never, press, k, Date.now, 40);
  expect(out).toEqual({ ok: false, error: ENHANCE_FALLBACK });
  expect(Date.now() - started, "returns at the deadline, not later").toBeLessThan(1_000);
  /* Pressed again, the same key is sent: the server answers from its saved claim, never a second charge. */
  await pressEnhance(never, press, k, Date.now, 40);
  expect(sentKeys).toHaveLength(2);
  expect(sentKeys[1]).toBe(sentKeys[0]);
});

test("a reply that stalls while its body is read is given up on too", async () => {
  const stalled = async (_url: string, init: RequestInit) => {
    const body = new ReadableStream({ start(controller) { init.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError"))); } });
    return new Response(body, { status: 200 });
  };
  expect(await pressEnhance(stalled, press, keys(), Date.now, 40)).toEqual({ ok: false, error: ENHANCE_FALLBACK });
});

test("a provider error: the one line, whatever the server said", async () => {
  const out = await pressEnhance(async () => reply(502, { error: "The writer answered, but not with a prompt." }), press, keys(), Date.now, 50);
  expect(out).toEqual({ ok: false, error: ENHANCE_FALLBACK });
});

test("a missing key (a fast 503): the one line, at once", async () => {
  const started = Date.now();
  const out = await pressEnhance(async () => reply(503, { error: "No text writer is set up for this workspace." }), press, keys(), Date.now, 50);
  expect(out).toEqual({ ok: false, error: ENHANCE_FALLBACK });
  expect(Date.now() - started).toBeLessThan(500);
});

test("a reply with no words in it is an error, not a success", async () => {
  expect(await pressEnhance(async () => reply(200, { prompt: "", provider: "claude" }), press, keys(), Date.now, 50)).toEqual({ ok: false, error: ENHANCE_FALLBACK });
  expect(await pressEnhance(async () => reply(200, null), press, keys(), Date.now, 50)).toEqual({ ok: false, error: ENHANCE_FALLBACK });
});

test("the runs share the deadline: a press that times out leaves the control free for the next", async () => {
  const runs = new EnhanceRuns(keys(), Date.now, 40);
  const now = () => ({ scope: "s", body: press.body });
  const never = (_url: string, init: RequestInit) => new Promise<Response>((_r, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  expect(await runs.run(never, press, now)).toEqual({ ok: false, error: ENHANCE_FALLBACK });
  await expect.poll(() => runs.busy).toBe(false);
  expect(await runs.run(async () => reply(200, { prompt: "better", provider: "claude" }), press, now)).toEqual({ ok: true, prompt: "better", provider: "claude" });
});

test("Make never reaches the enhancer: the one run in Make's logic is the Enhance press, and the Make press does not touch it", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync("components/graphite/make/use-make.ts", "utf8");
  expect(source.match(/enhancer\.run\(/g), "one run, in pressEnhance").toHaveLength(1);
  expect(source).not.toMatch(/enhancer\.enhance\(/);
  const press = source.slice(source.indexOf("const make = useCallback"), source.indexOf("/* Enhance, pressed by a person"));
  expect(press).toContain("composer.generate()");
  expect(press, "the Make press does not look at the enhancer").not.toMatch(/enhancer|enhance/i);
  expect(source, "no Auto chain").not.toMatch(/autoNeeds|pending\.current/);
  expect(readFileSync("lib/shell/use-enhancer.ts", "utf8")).not.toMatch(/setAuto|auto:/);
});
