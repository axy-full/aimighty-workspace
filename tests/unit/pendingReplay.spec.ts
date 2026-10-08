import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { PENDING_STEPS_MS, PENDING_WAIT_MS, UNCONFIRMED, sendError, sendSavedRequest, sendUntilAnswered, stillAccepting } from "../../lib/pendingReplay";

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

test("only a caller that opts in waits: any other paid send is sent once, and a pending answer shows at once with Recover, as before", async () => {
  /* Not opted in (an upscale, a fix, a cast identity, a Seedance edit): one send, no wait, the server's own words. */
  const once = clock();
  let sends = 0;
  const sent = await sendSavedRequest(async () => { sends++; return pending(); }, once);
  expect(sends).toBe(1);
  expect(once.slept).toEqual([]);
  expect(sent.pending).toBe(true);
  expect(sendError(sent, false)).toMatch(/^This request is still being accepted/);
  /* Opted in (a planning turn, a Memory read): asked again until the wait runs out, then the Recover line. */
  const waited = clock();
  let asks = 0;
  const long = await sendSavedRequest(async () => { asks++; return pending(); }, { ...waited, waitWhilePending: true });
  expect(asks).toBeGreaterThan(5);
  expect(long.pending).toBe(true);
  expect(sendError(long, true)).toBe(UNCONFIRMED);
  expect(UNCONFIRMED).toBe("The response could not be confirmed. Recover the saved request.");
  /* Answered for good either way: no error for a success, the server's words for a refusal. */
  expect(sendError(await sendSavedRequest(async () => final({ id: "x" })), false)).toBeNull();
  expect(sendError(await sendSavedRequest(async () => final({ error: "Not enough credits." }, 402), { waitWhilePending: true }), true)).toBe("Not enough credits.");
});

test("the callers that wait are the long routes that answer early; every other paid send keeps sending once", () => {
  const source = (file: string) => readFileSync(file, "utf8");
  /* A planning turn, new and legacy recovery path, and a Memory read. */
  const provider = source("components/atomik/AtomikProvider.tsx");
  expect(provider).toMatch(/paid\.run\(recovering!\.url, requestBody, \{ waitWhilePending: true \}\)/);
  expect(provider).toMatch(/sends\.run\(id, `\/api\/atomik\/\$\{encodeURIComponent\(id\)\}`, requestBody, recovering\?\.key, \{ waitWhilePending: true \}\)/);
  expect(source("components/graphite/atomik/MemoryView.tsx")).toMatch(/paid\.run<ReadReply>\(READ_URL, input, \{ keepPending: true, waitWhilePending: true \}\)/);
  for (const file of ["components/graphite/make/UpscaleTool.tsx", "components/graphite/phone/use-fix.ts", "components/graphite/production/CastIdentities.tsx", "components/make/SeedanceEdit.tsx"])
    expect(source(file), file).not.toMatch(/waitWhilePending/);
  /* The hooks wait only when asked. */
  expect(source("lib/usePaidAction.ts")).toMatch(/sendSavedRequest\([\s\S]*waitWhilePending: options\?\.waitWhilePending/);
  expect(source("components/atomik/threads/useThreadSends.ts")).toMatch(/sendSavedRequest\([\s\S]*waitWhilePending: options\.waitWhilePending/);
});
