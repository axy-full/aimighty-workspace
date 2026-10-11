import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const dir = mkdtempSync(path.join(tmpdir(), "particl-cancel-review-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

import { cancelQueuedVideo, QueuedCancelError, type QueuedCancelDeps, type QueuedRow } from "../../lib/queuedCancel";
import { REVIEW_REASON, replyOf, type CancelTrail } from "../../lib/cancelReview";
import { FalHttpError } from "../../lib/fal";
import { namesCancellation } from "../../lib/falVideo";
import { resultSaysCancelled } from "../../lib/engines/fal";

/**
 * The owner's three decisions on #639 (queued cancel), as the code reads them:
 *  (a) a fal job is free only on an explicit cancel signal: a 404 or 410 is not one;
 *  (b) a running job stopped after fal's 202 is free if fal returns no video, charged if fal answers with an error;
 *  (c) a cancel PUT that timed out, followed by a 404 with no cancelRequestedAt, stays charged, and is filed for the owner to review.
 */

test("(a) only fal's own word that the request was cancelled is a cancel signal: a 404, a 410, a refusal or a timeout is not", () => {
  expect(namesCancellation(new FalHttpError(400, "The render service returned 400: Request was cancelled.", { detail: "Request was cancelled." }))).toBe(true);
  expect(namesCancellation(new FalHttpError(400, "x", { detail: [{ type: "request_cancelled", msg: "canceled by user" }] }))).toBe(true);
  for (const error of [
    new FalHttpError(404, "The render service returned 404: not found.", null),
    new FalHttpError(410, "The render service returned 410: gone.", null),
    new FalHttpError(500, "The render service returned 500.", null),
    new FalHttpError(422, "The render service returned 422: refused.", { detail: [{ type: "content_policy_violation" }] }),
    Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }),
  ]) expect(namesCancellation(error), String((error as Error).message)).toBe(false);
});

test("(b) which finished results are read as a cancellation: only one with no video that says so (the charge itself is in falCancelBilling.spec.ts)", () => {
  expect(resultSaysCancelled({ detail: "Request was cancelled." }, null)).toBe(true);
  expect(resultSaysCancelled({ error: "The model failed to produce a video." }, null)).toBe(false);
  expect(resultSaysCancelled({}, null)).toBe(false);
  expect(resultSaysCancelled(null, null)).toBe(false);
  /* A video that came back is a finished render, whatever else the body says. */
  expect(resultSaysCancelled({ video: { url: "https://v.example/x.mp4" }, note: "cancelled earlier" }, "https://v.example/x.mp4")).toBe(false);
});

const FAL: QueuedRow = { id: "g-trail", status: "queued", provider: "fal", kind: "video", model: "fal-ai/kling-video/v3/standard", createdBy: "u1", arkTaskId: null, params: { falRequestId: "req-1", falModel: "fal-ai/kling-video/v3" } };
function world(opts: { put: "timeout" | "ok"; read: "404" | "queued" }) {
  const calls: string[] = [];
  const trails: CancelTrail[] = [];
  let polls = 0;
  const deps: QueuedCancelDeps = {
    exclusive: (_id, run) => run(),
    load: async () => ({ ...FAL }),
    actor: () => ({ id: "u1", role: "member" }),
    poll: async () => { calls.push("poll"); polls += 1; if (polls > 1 && opts.read === "404") throw new FalHttpError(404, "The render service returned 404: not found. https://queue.fal.run/x?key=abcdef0123456789abcdef0123456789abcdef01", null); return "queued"; },
    cancel: async () => { calls.push("cancel"); if (opts.put === "timeout") throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }); },
    claim: async () => true, unclaim: async () => { calls.push("unclaim"); },
    markAsked: async () => { calls.push("markAsked"); },
    trail: async (_id, trail) => { calls.push("trail"); trails.push(structuredClone(trail)); },
    settle: async () => ({ status: "queued" }),
  };
  return { deps, calls, trails };
}

test("(c) a cancel PUT that timed out and a read that finds nothing: nothing is marked as cancel-asked (so it stays charged), and what fal said is kept with the take", async () => {
  const w = world({ put: "timeout", read: "404" });
  const error = await cancelQueuedVideo("g-trail", w.deps).then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(QueuedCancelError);
  expect((error as QueuedCancelError).status).toBe(503);
  expect(w.calls).not.toContain("markAsked");
  expect(w.calls).not.toContain("settle");
  /* Written before the PUT (so a crash still leaves the mark), and again with both answers. */
  expect(w.trails).toHaveLength(2);
  expect(w.trails[0]).toMatchObject({ put: null, after: null });
  const last = w.trails[1];
  expect(last.put).toMatchObject({ kind: "timeout", status: null });
  expect(last.after).toMatchObject({ kind: "http", status: 404 });
  /* Sanitised: no link, no credential-shaped run. */
  expect(JSON.stringify(last)).not.toMatch(/https?:|abcdef0123456789/);
});

test("replyOf keeps a status, a kind and bounded redacted words, and nothing else", () => {
  const reply = replyOf(new FalHttpError(500, "boom with token=sekrit and https://x.example/a?sig=1", { detail: "Authorization: Bearer abcdef0123456789abcdef0123456789" }), 7);
  expect(reply).toMatchObject({ at: 7, kind: "http", status: 500 });
  expect(reply.text).not.toMatch(/sekrit|https?:|abcdef0123456789/);
  expect(replyOf("not an error", 1)).toMatchObject({ kind: "other", status: null });
});

test("(c) the charged case is filed on the platform desk with the job id, the time and fal's answers; filing never throws", async () => {
  const { platformDb, platformReady } = await import("../../lib/platform");
  const { fileCancelReview } = await import("../../lib/cancelReview");
  await platformReady();
  await platformDb().execute("DELETE FROM reports");
  const trail: CancelTrail = { at: 1_000, put: replyOf(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }), 1_001), after: replyOf(new FalHttpError(404, "not found", null), 1_002) };
  const lines: string[] = [];
  const kept = await fileCancelReview({ jobId: "g-trail", workspaceId: "ws_1", provider: "fal", trail, cancelAccepted: false, gone: replyOf(new FalHttpError(404, "The render service returned 404: not found.", null), 2_000) }, { clock: () => 3_000, log: (l) => lines.push(l) });
  expect(kept).toBe(true);
  const rows = (await platformDb().execute("SELECT url, reason, details, workspace_id, created_at, handled_at FROM reports")).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ url: "/api/generations/g-trail/cancel", reason: REVIEW_REASON, workspace_id: "ws_1", created_at: 3_000, handled_at: null });
  const details = JSON.parse(String(rows[0].details));
  expect(details).toMatchObject({ jobId: "g-trail", provider: "fal", cancelAccepted: false, cancelAsked: { kind: "timeout", at: 1_001 }, afterCancel: { status: 404 }, gone: { status: 404, at: 2_000 } });
  expect(String(rows[0].details)).not.toMatch(/prompt|Bearer|https?:/i);
  expect(JSON.parse(lines[0])).toMatchObject({ event: "queued_cancel.charged_review", jobId: "g-trail", putStatus: null, goneStatus: 404 });
  /* Filed again for the same job (an overlapping poll, a retried write): still one row, and the first note stays. */
  expect(await fileCancelReview({ jobId: "g-trail", workspaceId: "ws_1", provider: "fal", trail, cancelAccepted: false, gone: replyOf(new FalHttpError(404, "later", null), 9_000) }, { clock: () => 9_500, log: () => undefined })).toBe(true);
  const again = (await platformDb().execute("SELECT id, created_at FROM reports")).rows;
  expect(again).toHaveLength(1);
  expect(again[0]).toMatchObject({ id: "rp_cancel_g-trail", created_at: 3_000 });
  /* A platform database that cannot answer does not break the poll that filed it. */
  const down = await fileCancelReview({ jobId: "g-trail", workspaceId: null, provider: "fal", trail, cancelAccepted: false, gone: replyOf(new FalHttpError(404, "x", null)) }, { platform: async () => { throw new Error("down"); }, log: () => undefined });
  expect(down).toBe(false);
});

test("(c) filing is bounded: a platform database that never answers is waited for a moment, then left", async () => {
  const { fileCancelReview } = await import("../../lib/cancelReview");
  const trail: CancelTrail = { at: 1, put: null, after: null };
  const started = Date.now();
  const kept = await fileCancelReview({ jobId: "g-slow", workspaceId: null, provider: "fal", trail, cancelAccepted: false, gone: replyOf(new FalHttpError(404, "x", null)) },
    { platform: () => new Promise(() => undefined), log: () => undefined, timeoutMs: 50 });
  expect(kept).toBe(false);
  expect(Date.now() - started).toBeLessThan(2_000);
  /* A log line that throws does not stop it either. */
  expect(await fileCancelReview({ jobId: "g-log", workspaceId: null, provider: "fal", trail, cancelAccepted: false, gone: replyOf(new FalHttpError(404, "x", null)) },
    { platform: async () => ({ execute: async () => undefined }), log: () => { throw new Error("log down"); } })).toBe(true);
});
