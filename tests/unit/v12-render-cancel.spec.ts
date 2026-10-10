import { test, expect } from "@playwright/test";
import {
  CANCEL_FINISHED, CANCEL_SENT, CANCEL_STARTED, CANCEL_STOPPED, CANCEL_UNSURE, DISCARD_FAILED, cancelFailure, discardedOutcome, mayCancelTake, providerQueueOutcome,
} from "../../lib/v12/renderCancel";
import { CANCELLED_FREE_TOAST, renderState, type RenderTake } from "../../lib/v12/renderState";

/**
 * What a Cancel press says (lib/v12/renderCancel.ts; review of #633): the words match what is billed. A held take is discarded:
 * cancelled, nothing billed. A provider's `requested` is a cancel sent, never a take cancelled; its credits come back only when the
 * engine confirms, so a failed ask never says nothing was billed.
 */
test("a held take is cancelled for good, and nothing is billed", () => {
  expect(discardedOutcome()).toEqual({ text: CANCELLED_FREE_TOAST, cancelled: true, pending: false });
  expect(CANCELLED_FREE_TOAST).toBe("Cancelled · nothing billed · the frame stays");
});

test("the provider's answers, each in its own true words", () => {
  expect(providerQueueOutcome("requested")).toEqual({ text: "Cancel sent · nothing billed once the engine confirms", cancelled: false, pending: true });
  expect(CANCEL_SENT).not.toMatch(/^Cancelled/);
  expect(providerQueueOutcome("cancelled")).toEqual({ text: CANCELLED_FREE_TOAST, cancelled: true, pending: false });
  expect(providerQueueOutcome("running")).toEqual({ text: CANCEL_STARTED, cancelled: false, pending: false });
  expect(providerQueueOutcome("succeeded")).toEqual({ text: CANCEL_FINISHED, cancelled: false, pending: false });
  expect(providerQueueOutcome("failed")).toEqual({ text: CANCEL_STOPPED, cancelled: false, pending: false });
  for (const odd of [undefined, null, "", "queued", 7]) expect(providerQueueOutcome(odd)).toEqual({ text: CANCEL_UNSURE, cancelled: false, pending: false });
  /* An already-cancelled take is never told "it had already started". */
  expect(providerQueueOutcome("cancelled").text).not.toMatch(/already started/);
});

test("a refused or lost cancel to the provider never says nothing was billed: the hold may stand", () => {
  expect(cancelFailure("provider-queue", null).text).toBe(CANCEL_UNSURE);
  expect(cancelFailure("provider-queue", "").text).not.toMatch(/nothing was billed/i);
  expect(CANCEL_UNSURE).not.toMatch(/nothing was billed|nothing billed/i);
  expect(cancelFailure("provider-queue", "Only this take’s creator or a workspace administrator can cancel it.").text).toBe("Only this take’s creator or a workspace administrator can cancel it.");
  /* A held take that could not be discarded is still held: nothing was reserved or sent, which is true. */
  expect(cancelFailure("discard", null).text).toBe(DISCARD_FAILED);
});

test("Cancel is drawn for the take's author and for an admin or the owner, and for no one else", () => {
  expect(mayCancelTake({ role: "member", userId: "u1" }, "u1")).toBe(true);
  expect(mayCancelTake({ role: "member", userId: "u1" }, "u2")).toBe(false);
  expect(mayCancelTake({ role: "admin", userId: "u1" }, "u2")).toBe(true);
  expect(mayCancelTake({ role: "owner", userId: "u1" }, "u2")).toBe(true);
  expect(mayCancelTake({ role: null, userId: null }, null)).toBe(false);
  expect(mayCancelTake({ role: "member", userId: null }, null)).toBe(false);
  /* The model offers nothing to someone it refuses. */
  const take: RenderTake = { id: "t", status: "held", kind: "video", model: "m", createdAt: 0, held: { why: "slots" }, mayCancel: mayCancelTake({ role: "member", userId: "u1" }, "u2") };
  expect(renderState(take, 1_000).cancel).toMatchObject({ cancellable: false });
});

test("the money line says it once, in the workspace's own unit, from the take's own figure", () => {
  const base: RenderTake = { id: "t", status: "running", kind: "video", model: "fal-ai/kling-video/v3/standard", createdAt: 0, atProvider: true };
  expect(renderState({ ...base, price: { amount: 7, unit: "cr" } }, 30_000).money?.text).toBe("7 cr held · charged only when it’s ready");
  expect(renderState({ ...base, price: { amount: 0.84, unit: "usd" } }, 30_000).money?.text).toMatch(/^\$0\.84\d* held · charged only when it’s ready$/);
  expect(renderState(base, 30_000).money?.text).toBe("Charged only when it’s ready");
});
