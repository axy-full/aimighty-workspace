import { test, expect } from "@playwright/test";
import { completeIn, newlyComplete } from "../../lib/shell/use-library-follows-jobs";

/**
 * The project's Library follows the jobs tray (lib/shell/use-library-follows-jobs.ts): a take of this project that newly
 * completes is a reason to read the Library again; takes already complete when the page opened, other projects' takes and
 * jobs still running are not.
 */
const job = (id: string, stage: string, draftId: string | null) => ({ id, stage, draftId }) as Parameters<typeof completeIn>[0][number];

test("only this project's completed takes count, and a job with no project of its own may be this one's", () => {
  const jobs = [job("a", "complete", "p1"), job("b", "complete", "p2"), job("c", "rendering", "p1"), job("d", "complete", null), job("e", "failed", "p1")];
  expect(completeIn(jobs, "p1")).toEqual(["a", "d"]);
  expect(completeIn(jobs, "p2")).toEqual(["b", "d"]);
});

test("nothing is new on the first read; later, only ids not seen before", () => {
  expect(newlyComplete(["a", "d"], null)).toEqual([]);
  expect(newlyComplete(["a", "d"], new Set(["a", "d"]))).toEqual([]);
  expect(newlyComplete(["a", "d", "f"], new Set(["a", "d"]))).toEqual(["f"]);
});
