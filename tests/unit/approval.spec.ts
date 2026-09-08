import { test, expect } from "@playwright/test";
import { cleanReason, reasonNeeded, lockAsk, trailLine, MIN_REASON, MAX_REASON } from "../../lib/approval";

/** The approval trail and the lock (brief 2.1): a shot with an approved take takes another only with a reason, kept on the record. */
test("a reason is required past an approved take, and only a real one counts", () => {
  expect(reasonNeeded({ hasApprovedTake: false, reason: null })).toBe(false);
  expect(reasonNeeded({ hasApprovedTake: true, reason: undefined })).toBe(true);
  expect(reasonNeeded({ hasApprovedTake: true, reason: "  " })).toBe(true);
  expect(reasonNeeded({ hasApprovedTake: true, reason: "ok" })).toBe(true); // under the floor
  expect(reasonNeeded({ hasApprovedTake: true, reason: "client wants the pan slower" })).toBe(false);
  expect(cleanReason("  the   pan   slower  ")).toBe("the pan slower");
  expect(cleanReason("x".repeat(MAX_REASON + 50))?.length).toBe(MAX_REASON);
  expect(cleanReason("x".repeat(MIN_REASON - 1))).toBeNull();
  expect(cleanReason(42)).toBeNull();
});

test("the question names the take being rendered past, and the trail reads as one line", () => {
  const ask = lockAsk(3, "Mara");
  expect(ask.title).toContain("v3");
  expect(ask.line).toContain("Mara approved v3");
  expect(lockAsk(null, null).title).toContain("a take");
  const ago = () => "2h ago";
  expect(trailLine({ pickedBy: "Ana", pickedAt: 1, approvedBy: "Sam", approvedAt: 2 }, ago)).toBe("Picked by Ana 2h ago · approved by Sam 2h ago");
  expect(trailLine({ pickedBy: "Ana", pickedAt: null, approvedBy: null, approvedAt: null }, ago)).toBe("Picked by Ana");
  expect(trailLine({ pickedBy: null, pickedAt: null, approvedBy: null, approvedAt: null }, ago)).toBe("");
});
