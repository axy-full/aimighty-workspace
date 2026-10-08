import { test, expect } from "@playwright/test";
import { PENDING_STEPS_MS, PENDING_WAIT_MS, sendUntilAnswered, stillAccepting } from "../../lib/pendingReplay";

/**
 * The browser side of an early "still being accepted" (lib/pendingReplay.ts,
 * used by components/atomik/threads/useThreadSends.ts and lib/usePaidAction.ts):
 * the one saved request is sent again — the same call, so the same key and
 * body — after the server's Retry-After, backing off, until its answer is
 * final, and for about six minutes at most; then the last answer stands and
 * the request stays saved for Recover. A clock and sleep stand in for time.
 */

const pending = (retryAfter = "2") => Response.json(
  { error: "This request is still being accepted. Retry with the same Idempotency-Key; it will not submit another generation.", pending: true },
  { status: 409, headers: { "Retry-After": retryAfter } },
);
const final = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Idempotency-Status": "complete" } });

function clock() {
  let at = 1_000_000;
  const slept: number[] = [];
  return { now: () => at, sleep: async (ms: number) => { slept.push(ms); at += ms; }, slept };
}

test("a pending answer is asked again, the same request each time, until its saved reply comes back", async () => {
  const time = clock();
  const answers = [pending(), pending(), pending(), final({ id: "text_1", entries: [] })];
  let sends = 0;
  const result = await sendUntilAnswered(async () => answers[sends++], time);
  expect(sends).toBe(4);
  expect(result.pending).toBe(false);
  expect(result.response.status).toBe(200);
  expect(result.data).toEqual({ id: "text_1", entries: [] });
  /* Backing off, never sooner than the server's Retry-After. */
  expect(time.slept).toEqual(PENDING_STEPS_MS.slice(0, 3));
});

test("the server's Retry-After is honoured when it is longer than the step", async () => {
  const time = clock();
  const answers = [pending("10"), final({ ok: true })];
  let sends = 0;
  await sendUntilAnswered(async () => answers[sends++], time);
  expect(time.slept).toEqual([10_000]);
});

test("after about six minutes still pending, the last answer stands and the request stays for Recover", async () => {
  const time = clock();
  let sends = 0;
  const result = await sendUntilAnswered(async () => { sends++; return pending(); }, time);
  expect(result.pending).toBe(true);
  expect(result.response.status).toBe(409);
  expect(time.slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(PENDING_WAIT_MS);
  expect(time.slept.reduce((a, b) => a + b, 0)).toBeGreaterThan(PENDING_WAIT_MS - 30_000);
  expect(PENDING_WAIT_MS).toBe(6 * 60_000);
  /* Each wait at most 30 s: a turn that ends is seen within half a minute. */
  expect(Math.max(...time.slept)).toBeLessThanOrEqual(30_000);
  expect(sends).toBe(time.slept.length + 1);
});

test("a final answer is never asked again: a saved refusal, a 409 that is complete, an error that is not pending", async () => {
  for (const response of [final({ error: "The thread is archived." }, 409), final({ error: "Not enough credits." }, 402), Response.json({ error: "The request was interrupted." }, { status: 503 }), Response.json({ error: "This Idempotency-Key already names a different request." }, { status: 409 })]) {
    const time = clock();
    let sends = 0;
    const result = await sendUntilAnswered(async () => { sends++; return response.clone(); }, time);
    expect(sends).toBe(1);
    expect(result.pending).toBe(false);
    expect(time.slept).toEqual([]);
  }
});

test("a switch of account or workspace stops the asking; the request stays saved", async () => {
  const time = clock();
  let wanted = true, sends = 0;
  const result = await sendUntilAnswered(async () => { sends++; if (sends === 2) wanted = false; return pending(); }, { ...time, stillWanted: () => wanted });
  expect(sends).toBe(2);
  expect(result.pending).toBe(true);
});

test("only a 409 that says pending and is not complete reads as still being accepted", async () => {
  expect(stillAccepting(pending(), { pending: true })).toBe(true);
  expect(stillAccepting(final({ pending: true }, 409), { pending: true })).toBe(false);
  expect(stillAccepting(Response.json({}, { status: 503 }), { pending: true })).toBe(false);
  expect(stillAccepting(pending(), { error: "x" })).toBe(false);
});
