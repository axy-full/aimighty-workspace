import { test, expect } from "@playwright/test";
import { failureKind, failureCopy, queueCounts, estimateForRow, inTraining } from "../../lib/jobState";

/** Job state (brief 1.5): a failed take says why, in the four words the brief names, and offers the one action that fits. */
test("a failure is read off the row's own words, and each kind has its action", () => {
  expect(failureKind('{"code":"SensitiveContentDetected","message":"The request was refused by the content policy"}')).toBe("refused");
  expect(failureKind("The render never came back from fal.ai. Render again.")).toBe("vendor");
  expect(failureKind("Could not reach ModelArk: fetch failed")).toBe("vendor");
  expect(failureKind("This production is at its cap; a producer can unlock it.")).toBe("cap");
  expect(failureKind("Held: this needs 40 credits and 3 are left. Top up to release it.")).toBe("balance");
  expect(failureKind(null, { held: { why: "slots" } })).toBe("slots");
  expect(failureKind(null, { held: { why: "credits" } })).toBe("balance");
  expect(failureKind("")).toBe("unknown");
  expect(failureCopy("refused").action).toBe("edit");
  expect(failureCopy("cap").action).toBe("unlock");
  expect(failureCopy("balance").action).toBe("topup");
  expect(failureCopy("vendor").action).toBe("retry");
});

test("the queue counts rendering, queued for a slot, held for credits, and failed", () => {
  const rows = [
    { status: "running" }, { status: "queued" }, { status: "held", params: { held: { why: "slots" } } },
    { status: "held", params: { held: { why: "credits" } } }, { status: "failed" }, { status: "cancelled" }, { status: "succeeded" },
  ];
  expect(queueCounts(rows)).toEqual({ rendering: 2, queued: 1, held: 1, failed: 2 });
  expect(estimateForRow({ status: "held", params: { held: { estUsd: 2.5 } } })).toBe(2.5);
  expect(estimateForRow({ status: "running", kind: "video", model: "dreamina-seedance-2-5-260628", params: { resolution: "1080p", ratio: "16:9", duration: 5 } })).toBeGreaterThan(0);
});

test("identities being trained are in flight too, and nothing else is", () => {
  const rows = [
    { id: "a", status: "training" }, { id: "b", status: "ready" },
    { id: "c", status: "draft" }, { id: "d", status: "failed" }, { id: "e", status: "training" },
  ];
  expect(inTraining(rows).map((r) => r.id)).toEqual(["a", "e"]);
  expect(inTraining([])).toEqual([]);
});
