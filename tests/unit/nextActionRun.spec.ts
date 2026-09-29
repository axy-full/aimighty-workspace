import { test, expect } from "@playwright/test";
import { NextRefusal, QUOTE_UNREAD, nextFailureLine, pressNext, quoteNext } from "../../lib/workspace/next-action-run";
import { claimPendingGeneration, pendingGenerationKey, readPendingGeneration } from "../../lib/workbench/pending-generation";
import { nextActionBody, SEEDANCE_25 } from "../../lib/shell/next-actions";
import type { TakeFailure } from "../../lib/providerOutcome";

/*
 * A priced Next action from its estimate to its job (lib/workspace/next-action-run.ts), against a stub server: the quote is
 * free and read-only; a press settles any earlier press first, quotes the exact request once more, asks again if the estimate
 * moved (nothing sent), and otherwise claims it and sends it once, at the estimate shown, with the quote's fingerprint. A
 * failed take says what happened and what its provider did with the charge. Nothing is billed; no request touches the source.
 */
const SCOPE = "particl-active-ws_unit-u_unit";
const STORAGE_ID = pendingGenerationKey(SCOPE, "ws-next", "next:extend:generation:g_clip");
const BODY = nextActionBody({
  settings: { action: "extend", direction: "forward", prompt: "the ferry clears the harbour", resolution: "720p", duration: 5, audio: true },
  source: { genId: "g_clip" }, productionProjectId: "prod", shotId: "shot_2",
});
const FP = "f".repeat(64);

function memory() {
  const items = new Map<string, string>();
  return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v), removeItem: (k: string) => void items.delete(k) };
}
type Call = { path: string; method: string; key: string | null; body: Record<string, unknown> };
type Answer = { status?: number; json: unknown; headers?: Record<string, string> } | "network";
async function withServer(routes: Record<string, (body: Record<string, unknown>, n: number) => Answer>, run: (calls: Call[]) => Promise<void>) {
  const calls: Call[] = [];
  const seen = new Map<string, number>();
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ path, method: init?.method ?? "GET", key: headers.get("Idempotency-Key"), body });
    const n = (seen.get(path) ?? 0) + 1;
    seen.set(path, n);
    const answer = routes[path]?.(body, n);
    if (!answer) throw new Error(`Unexpected request: ${path}`);
    if (answer === "network") throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(answer.json), { status: answer.status ?? 200, headers: { "Content-Type": "application/json", ...answer.headers } });
  }) as typeof fetch;
  try { await run(calls); } finally { globalThis.fetch = original; }
}
const quoted = (credits: number) => () => ({ json: { estimatedCredits: credits, price: credits, unit: "cr", fingerprint: FP } });
/** Nothing but the quote, the check and the one paid route: never a write to the source take. */
const touchesSource = (calls: Call[]) => calls.some((c) => c.path.includes("g_clip") || c.method === "PATCH" || c.method === "DELETE");

test("the estimate is exactly the request's, and asking is free; a refusal comes back as the server said it, with what it asks for", async () => {
  await withServer({ "/api/generate/quote": quoted(21) }, async (calls) => {
    expect(await quoteNext(SCOPE, BODY)).toEqual({ credits: 21, fingerprint: FP });
    expect(calls).toEqual([{ path: "/api/generate/quote", method: "POST", key: null, body: BODY }]);
  });
  await withServer({ "/api/generate/quote": () => ({ status: 409, json: { error: "v3 is approved. Why render another?", line: "Ana approved v3. The reason is kept with the new take.", needsReason: true, approvedVersion: 3 } }) }, async () => {
    const refused = await quoteNext(SCOPE, BODY).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(NextRefusal);
    expect((refused as NextRefusal).message).toBe("v3 is approved. Why render another?");
    expect((refused as NextRefusal).detail).toEqual({ needsReason: { title: "v3 is approved. Why render another?", line: "Ana approved v3. The reason is kept with the new take." } });
  });
  await withServer({ "/api/generate/quote": () => ({ status: 403, json: { error: "SH010 is past its cap; an admin runs this take.", needsAdmin: true } }) }, async () => {
    const refused = (await quoteNext(SCOPE, BODY).catch((e: unknown) => e)) as NextRefusal;
    expect(refused.detail).toEqual({ needsAdmin: true });
  });
  await withServer({ "/api/generate/quote": () => ({ status: 400, json: { error: "Luma Ray 2 isn't connected for this workspace. Ask the platform to connect it." } }) }, async () => {
    const refused = (await quoteNext(SCOPE, BODY).catch((e: unknown) => e)) as NextRefusal;
    expect(refused).toBeInstanceOf(NextRefusal);
    expect(refused.message).toBe("Luma Ray 2 isn't connected for this workspace. Ask the platform to connect it.");
  });
  /* No answer, a busy server, or a reply that cannot be read: asking again may help, so it is not a refusal. */
  for (const answer of ["network", { status: 503, json: { error: "down" } }, { status: 429, json: { error: "slow down" } }, { json: { estimatedCredits: 1.5, fingerprint: FP } }, { json: { estimatedCredits: 4, fingerprint: "nope" } }] as Answer[])
    await withServer({ "/api/generate/quote": () => answer }, async () => {
      const failed = await quoteNext(SCOPE, BODY).catch((e: unknown) => e);
      expect(failed).toBeInstanceOf(Error);
      expect(failed).not.toBeInstanceOf(NextRefusal);
    });
  await withServer({ "/api/generate/quote": () => ({ json: { estimatedCredits: -1, fingerprint: FP } }) }, async () => {
    expect(((await quoteNext(SCOPE, BODY).catch((e: unknown) => e)) as Error).message).toBe(QUOTE_UNREAD);
  });
});

test("a press at the estimate shown quotes it once more and sends it once: claimed first, with that estimate as its ceiling and the quote's fingerprint", async () => {
  const storage = memory();
  await withServer({
    "/api/generate/quote": quoted(21),
    "/api/generate": () => ({ status: 202, json: { id: "gen_next", status: "queued" } }),
  }, async (calls) => {
    const out = await pressNext({ scope: SCOPE, storageId: STORAGE_ID, body: BODY, shown: 21, label: "Extend", storage });
    expect(out).toEqual({ state: "queued", jobId: "gen_next", credits: 21, status: "queued", followed: false, note: null });
    expect(calls.map((c) => c.path)).toEqual(["/api/generate/quote", "/api/generate"]);
    const sent = calls[1];
    expect(sent.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent.body).toEqual({ ...BODY, maxCredits: 21, quoteFingerprint: FP });
    expect(readPendingGeneration(storage, STORAGE_ID)).toBeNull();
    expect(touchesSource(calls)).toBe(false);
  });
});

test("an estimate that moved since it was shown is asked about again: nothing is sent, and the next press sends at the new one", async () => {
  const storage = memory();
  await withServer({
    "/api/generate/quote": quoted(24),
    "/api/generate": () => ({ status: 202, json: { id: "gen_next", status: "queued" } }),
  }, async (calls) => {
    const moved = await pressNext({ scope: SCOPE, storageId: STORAGE_ID, body: BODY, shown: 21, label: "Extend", storage });
    expect(moved).toEqual({ state: "repriced", credits: 24, note: "The estimate is now about 24 cr. Press Extend again to approve it." });
    expect(calls.map((c) => c.path)).toEqual(["/api/generate/quote"]);
    expect(readPendingGeneration(storage, STORAGE_ID)).toBeNull();
    /* Pressed again, at the estimate now shown. */
    const sent = await pressNext({ scope: SCOPE, storageId: STORAGE_ID, body: BODY, shown: 24, label: "Extend", storage });
    expect(sent).toMatchObject({ state: "queued", jobId: "gen_next", credits: 24 });
    expect(calls.at(-1)!.body).toMatchObject({ maxCredits: 24 });
  });
});

test("an earlier press whose reply was lost is settled first: followed if it landed, never sent again; let go if it never went through", async () => {
  const landed = memory();
  claimPendingGeneration(landed, STORAGE_ID, { key: "earlier-0001", body: JSON.stringify({ ...BODY, maxCredits: 21 }), credits: 21, endpoint: "/api/generate" });
  await withServer({ "/api/generate/check": () => ({ json: { state: "landed", id: "gen_earlier", status: "running" } }) }, async (calls) => {
    const out = await pressNext({ scope: SCOPE, storageId: STORAGE_ID, body: BODY, shown: 21, label: "Extend", storage: landed });
    expect(out).toEqual({ state: "queued", jobId: "gen_earlier", credits: 21, status: "running", followed: true, note: "Your last press of Extend reached the server, and that one is followed. Nothing new was sent." });
    expect(calls.map((c) => c.path)).toEqual(["/api/generate/check"]);
  });

  const absent = memory();
  claimPendingGeneration(absent, STORAGE_ID, { key: "earlier-0002", body: JSON.stringify({ ...BODY, maxCredits: 21 }), credits: 21, endpoint: "/api/generate" });
  await withServer({
    "/api/generate/check": () => ({ json: { state: "absent" } }),
    "/api/generate/quote": quoted(21),
    "/api/generate": () => ({ status: 202, json: { id: "gen_new", status: "queued" } }),
  }, async (calls) => {
    const out = await pressNext({ scope: SCOPE, storageId: STORAGE_ID, body: BODY, shown: 21, label: "Extend", storage: absent });
    expect(out).toMatchObject({ state: "queued", jobId: "gen_new", followed: false, note: "Your last press of Extend never went through, so nothing was charged for it." });
    expect(calls.map((c) => c.path)).toEqual(["/api/generate/check", "/api/generate/quote", "/api/generate"]);
    expect(calls[2].key).not.toBe("earlier-0002");
  });

  /* Still being accepted, or the check got no answer: nothing is quoted or sent, and the claim stays. */
  const pending = memory();
  claimPendingGeneration(pending, STORAGE_ID, { key: "earlier-0003", body: JSON.stringify(BODY), credits: 21, endpoint: "/api/generate" });
  await withServer({ "/api/generate/check": () => ({ json: { state: "pending" } }) }, async (calls) => {
    expect(await pressNext({ scope: SCOPE, storageId: STORAGE_ID, body: BODY, shown: 21, label: "Extend", storage: pending })).toMatchObject({ state: "unknown" });
    expect(calls.map((c) => c.path)).toEqual(["/api/generate/check"]);
    expect(readPendingGeneration(pending, STORAGE_ID)?.key).toBe("earlier-0003");
  });
});

test("a lost reply to the paid request is never sent twice: the next press checks it and follows the job it made", async () => {
  const storage = memory();
  await withServer({
    "/api/generate/quote": quoted(21),
    "/api/generate": () => ({ status: 502, json: { error: "Bad gateway" } }),
  }, async (calls) => {
    const out = await pressNext({ scope: SCOPE, storageId: STORAGE_ID, body: BODY, shown: 21, label: "Extend", storage });
    expect(out.state).toBe("unknown");
    expect(calls.filter((c) => c.path === "/api/generate")).toHaveLength(1);
    expect(readPendingGeneration(storage, STORAGE_ID)).not.toBeNull();
  });
  await withServer({ "/api/generate/check": () => ({ json: { state: "landed", id: "gen_made", status: "queued" } }) }, async (calls) => {
    expect(await pressNext({ scope: SCOPE, storageId: STORAGE_ID, body: BODY, shown: 21, label: "Extend", storage })).toMatchObject({ state: "queued", jobId: "gen_made", followed: true });
    expect(calls.map((c) => c.path)).toEqual(["/api/generate/check"]);
  });
});

test("a refusal sends nothing: at the quote with what it asks for, or at the send in the server's words; a held take waits without a charge", async () => {
  await withServer({ "/api/generate/quote": () => ({ status: 409, json: { error: "v3 is approved. Why render another?", line: "The reason is kept.", needsReason: true } }) }, async (calls) => {
    const out = await pressNext({ scope: SCOPE, storageId: STORAGE_ID, body: BODY, shown: 21, label: "Extend", storage: memory() });
    expect(out).toEqual({ state: "refused", note: "v3 is approved. Why render another?", detail: { needsReason: { title: "v3 is approved. Why render another?", line: "The reason is kept." } } });
    expect(calls.map((c) => c.path)).toEqual(["/api/generate/quote"]);
  });
  await withServer({ "/api/generate/quote": () => "network" }, async (calls) => {
    expect(await pressNext({ scope: SCOPE, storageId: STORAGE_ID, body: BODY, shown: 21, label: "Extend", storage: memory() }))
      .toEqual({ state: "unknown", note: "The price could not be checked. Nothing was sent; try again in a moment." });
    expect(calls.map((c) => c.path)).toEqual(["/api/generate/quote"]);
  });
  const storage = memory();
  await withServer({
    "/api/generate/quote": quoted(21),
    "/api/generate": () => ({ status: 409, json: { error: "The generation estimate changed. Review the updated credit quote before generating." }, headers: { "Idempotency-Status": "complete" } }),
  }, async () => {
    expect(await pressNext({ scope: SCOPE, storageId: STORAGE_ID, body: BODY, shown: 21, label: "Extend", storage }))
      .toEqual({ state: "refused", note: "The generation estimate changed. Review the updated credit quote before generating." });
    /* A final refusal lets the claim go: the next press is a fresh one. */
    expect(readPendingGeneration(storage, STORAGE_ID)).toBeNull();
  });
  await withServer({ "/api/generate/quote": quoted(21), "/api/generate": () => ({ status: 202, json: { id: "gen_held", status: "held" } }) }, async () => {
    expect(await pressNext({ scope: SCOPE, storageId: STORAGE_ID, body: BODY, shown: 21, label: "Extend", storage: memory() }))
      .toMatchObject({ state: "queued", status: "held", note: "It is held until credits or a render slot free up. Nothing is charged until it runs." });
  });
});

test("a failed action says what happened, what its provider did with the charge, and the next step — never a charge it cannot confirm", () => {
  const failure = (over: Partial<TakeFailure>): TakeFailure => ({ provider: "byteplus", stage: "run", code: "OutputVideoSensitiveContentDetected", kind: "content_filter", message: null, billing: null, payer: "platform", ...over });
  /* A credits workspace: Particl's own ledger for the take. */
  expect(nextFailureLine({ status: "failed", error: "x", failure: failure({ charge: { credits: 0, settled: true } }) })).toBe("Refused by the content filter · Not billed · Change the prompt or reference");
  expect(nextFailureLine({ status: "failed", error: "x", failure: failure({ kind: "timeout", charge: { credits: 12, settled: true } }) })).toBe("The engine timed out · 12 cr charged · Render again");
  expect(nextFailureLine({ status: "failed", error: "x", failure: failure({ kind: "provider_error", charge: { credits: 0, settled: false } }) })).toBe("The engine hit an error · Settling · Render again");
  /* A provider's own outcome on the workspace's key, in its words: refunded, charged, or it didn't say. */
  expect(nextFailureLine({ status: "failed", error: "x", failure: failure({ provider: "fal", payer: "own", billing: { state: "unknown", basis: "silent" } }) }))
    .toBe("Refused by the content filter · fal didn't say if it charged · Change the prompt or reference");
  expect(nextFailureLine({ status: "failed", error: "x", failure: failure({ payer: "own", billing: { state: "not_charged", basis: "ark-success-only" } }) }))
    .toBe("Refused by the content filter · BytePlus didn't charge · Change the prompt or reference");
  /* No outcome recorded: its own words, with no charge claimed either way. */
  expect(nextFailureLine({ status: "failed", error: "The render service finished but returned no video.", failure: null })).toBe("The render service finished but returned no video.");
  expect(nextFailureLine({ status: "failed", error: null, failure: null })).toBe("It did not render.");
  expect(nextFailureLine({ status: "failed", error: null, failure: null })).not.toMatch(/not billed|refunded|free/i);
});

test("the request a press sends is the one quoted, for every action: the body is not rebuilt between the estimate and the send", async () => {
  const bodies = [
    nextActionBody({ settings: { action: "animate", prompt: "She turns", ratio: "9:16", resolution: "720p", duration: 5, audio: false }, source: { uploadId: "u_plate" }, productionProjectId: "prod", shotId: "" }),
    nextActionBody({ settings: { action: "upscale", media: "video", fps: 60 }, source: { genId: "g_clip" }, productionProjectId: "prod", shotId: "shot_2", reason: "for delivery" }),
  ];
  for (const body of bodies) {
    await withServer({ "/api/generate/quote": quoted(7), "/api/generate": () => ({ status: 202, json: { id: "gen_x", status: "queued" } }) }, async (calls) => {
      await pressNext({ scope: SCOPE, storageId: STORAGE_ID, body, shown: 7, label: "Go", storage: memory() });
      expect(calls[0].body).toEqual(body);
      const { maxCredits, quoteFingerprint, ...rest } = calls[1].body;
      expect(rest).toEqual(body);
      expect([maxCredits, quoteFingerprint]).toEqual([7, FP]);
    });
  }
  expect(bodies[0]).toMatchObject({ model: SEEDANCE_25, references: [{ uploadId: "u_plate", role: "first_frame" }] });
});
