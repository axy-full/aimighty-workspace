import { test, expect } from "@playwright/test";
import { THREAD_CONTINUE, approveItem, declineItem } from "../../lib/control-room/approve";
import type { QueueItem } from "../../lib/control-room/queue";

/**
 * No one approves another member's step from the queue any more (owner, 21 Oct 2026: "the admin approval rule is retired; every member
 * approves their own spend with their own tap on the quote"). Until then an admin claimed, priced and rendered a member's over-the-line step
 * from here (owner, 13 Oct); now a plan's step is approved only by its own person's Continue, at its live price, and a press here sends
 * nothing: no claim, no quote, no render, no record.
 */
const item = (price = 600): QueueItem => ({
  id: "thread:ach_1", source: "thread", title: "Step of x", where: "Atomik", at: 1, project: { productionId: null, draftId: null, name: null },
  price: { kind: "up-to", credits: price }, canApprove: true, why: null, shortBy: null, note: null, step: { n: 1, of: 2 }, sample: false,
  approve: { kind: "thread", chatId: "ach_1", stepId: "st_1", productionId: null }, decline: { kind: "thread-stop", stepId: "st_1" },
  open: { kind: "thread", chatId: "ach_1", productionId: null },
});
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function fetcher() {
  const calls: { url: string; method: string }[] = [];
  const fn = async (url: string, init?: RequestInit) => { calls.push({ url, method: init?.method ?? "GET" }); return reply({ ok: true }); };
  return { fn, calls };
}

test("a plan's step is never approved from the queue: no claim, no quote, no render, no record", async () => {
  const f = fetcher();
  expect(await approveItem(item(), f.fn)).toEqual({ ok: false, reason: THREAD_CONTINUE, status: null });
  expect(f.calls).toEqual([]);
});

test("its own person's Not now turns it down through the step's own route, and charges nothing", async () => {
  const f = fetcher();
  expect(await declineItem(item(), f.fn)).toEqual({ ok: true });
  expect(f.calls).toEqual([{ url: "/api/atomik/steps/st_1", method: "PATCH" }]);
});
