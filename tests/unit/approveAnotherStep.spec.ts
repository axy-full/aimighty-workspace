import { test, expect } from "@playwright/test";
import { approveItem, declineItem } from "../../lib/control-room/approve";
import type { QueueItem } from "../../lib/control-room/queue";

/**
 * An admin approves another member's over-the-line step from the queue (owner, 13 Oct): the claim (the step itself, never its chat), its live price from the route
 * that will render it, the render at that price, and what became of it recorded on the step. A live price above the one shown renders and charges nothing. The step's
 * person's own steps are not pressed from here (their plan's Continue), and an admin has no Not now on another member's step.
 */
const item = (price = 600): QueueItem => ({
  id: "thread-step:abc", source: "thread", title: "Step of x", where: "Atomik", at: 1, project: { productionId: null, draftId: null, name: null },
  price: { kind: "up-to", credits: price }, needsAdmin: true, canApprove: true, why: null, shortBy: null, note: null, step: null, sample: false,
  approve: { kind: "thread", chatId: null, stepId: "st_1", productionId: null }, decline: null, open: { kind: "none" },
});
const step = { id: "st_1", kind: "video", title: "Step of x", prompt: "A slow push-in.", model: "dreamina-seedance-2-0-260128", params: { ratio: "16:9", resolution: "720p", seconds: 5 }, refs: [], status: "running", requestKey: "atomik-step:ach:st_1" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function fetcher(quote: { estimatedCredits: number }, over: { claim?: Response; render?: Response } = {}) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.endsWith("/claim")) return over.claim ?? reply({ step });
    if (url === "/api/generate/quote") return reply({ estimatedCredits: quote.estimatedCredits, price: quote.estimatedCredits, unit: "cr", fingerprint: "a".repeat(64) });
    if (url === "/api/generate") return over.render ?? reply({ id: "gen_1" });
    return reply({ ok: true });
  };
  return { fn, calls };
}

test("claim, price, render at the quote, record: in that order, and no call names a chat", async () => {
  const f = fetcher({ estimatedCredits: 520 });
  expect(await approveItem(item(), f.fn)).toEqual({ ok: true });
  expect(f.calls.map((c) => [c.method, c.url])).toEqual([["POST", "/api/atomik/steps/st_1/claim"], ["POST", "/api/generate/quote"], ["POST", "/api/generate"], ["POST", "/api/atomik/steps/st_1/settle"]]);
  /* The request names only the step: no project, no shot; the server resolves where it files. */
  expect(f.calls[1].body).toMatchObject({ atomikStepId: "st_1", projectId: null });
  expect(f.calls[2].body).toMatchObject({ maxCredits: 520, quoteFingerprint: "a".repeat(64), prompt: "A slow push-in.", atomikStepId: "st_1", projectId: null });
  /* Nothing of the result is sent back for the step: the server settles it from the render's own record. */
  expect(f.calls[3].body).toBeNull();
  expect(JSON.stringify(f.calls)).not.toMatch(/\/api\/atomik\/ach|chatId/);
});

test("a live price above the one shown renders and charges nothing", async () => {
  const f = fetcher({ estimatedCredits: 700 });
  const out = await approveItem(item(600), f.fn);
  expect(out).toMatchObject({ ok: false, reason: expect.stringContaining("Nothing was charged") });
  /* The claim is handed back: the step is proposed again. */
  expect(f.calls.map((c) => c.url)).toEqual(["/api/atomik/steps/st_1/claim", "/api/generate/quote", "/api/atomik/steps/st_1/release"]);
});

test("a quote that cannot be had hands the claim back too", async () => {
  const calls: string[] = [];
  const fn = async (url: string) => { calls.push(url); return url.endsWith("/claim") ? reply({ step }) : url === "/api/generate/quote" ? reply({ error: "No quote." }, 422) : reply({ released: true }); };
  expect(await approveItem(item(), fn)).toMatchObject({ ok: false });
  expect(calls).toEqual(["/api/atomik/steps/st_1/claim", "/api/generate/quote", "/api/atomik/steps/st_1/release"]);
});

test("a claim that is refused stops there: nothing is priced, rendered or recorded; a failed render is recorded as failed", async () => {
  const gone = fetcher({ estimatedCredits: 1 }, { claim: reply({ error: "That step is gone." }, 404) });
  expect(await approveItem(item(), gone.fn)).toEqual({ ok: false, reason: "That step is gone.", status: 404 });
  expect(gone.calls).toHaveLength(1);
  const failed = fetcher({ estimatedCredits: 10 }, { render: reply({ error: "Not accepted." }, 422) });
  expect(await approveItem(item(), failed.fn)).toMatchObject({ ok: false, reason: "Not accepted." });
  /* Refused before anything started: handed back, then settled from whatever the server recorded. */
  expect(failed.calls.slice(-2).map((c) => c.url)).toEqual(["/api/atomik/steps/st_1/release", "/api/atomik/steps/st_1/settle"]);
});

test("a step of the person's own plan is approved by its Continue, never from here; an admin has no Not now on another's", async () => {
  const own: QueueItem = { ...item(), approve: { kind: "thread", chatId: "ach_1", stepId: "st_1", productionId: null }, open: { kind: "thread", chatId: "ach_1", productionId: null } };
  const f = fetcher({ estimatedCredits: 1 });
  expect(await approveItem(own, f.fn)).toMatchObject({ ok: false });
  expect(f.calls).toEqual([]);
  expect(await declineItem(item(), f.fn)).toMatchObject({ ok: false });
  expect(f.calls).toEqual([]);
});
