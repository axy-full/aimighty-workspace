import { test, expect } from "@playwright/test";
import { candidateAttempt, isSelectedCandidate } from "../../lib/pipeline/review";

/* /pipelines' "Choose a keyframe" stage showed "✓ Selected take N" on every
   candidate before anything was chosen: no selection and no finished take
   are two undefineds, and they compared equal. */
test("a candidate is selected only when its finished take is the stage's choice", () => {
  const attempts = [
    { stageId: "key", unit: 0, state: "succeeded", generationId: "gen_a" },
    { stageId: "key", unit: 1, state: "running", generationId: null },
    { stageId: "key", unit: 0, state: "failed", generationId: "gen_old" },
  ];
  const first = candidateAttempt(attempts, { stageId: "key", unit: 0 });
  const second = candidateAttempt(attempts, { stageId: "key", unit: 1 });
  expect(first?.generationId).toBe("gen_a");
  expect(second).toBeUndefined();

  // Nothing chosen yet: nobody is Selected, finished or not.
  expect(isSelectedCandidate([], "review", first)).toBe(false);
  expect(isSelectedCandidate([], "review", second)).toBe(false);
  // A choice on this stage marks its take and no other.
  const chosen = [{ stageId: "review", generationId: "gen_a" }];
  expect(isSelectedCandidate(chosen, "review", first)).toBe(true);
  expect(isSelectedCandidate(chosen, "review", second)).toBe(false);
  // Another stage's choice is not this one's.
  expect(isSelectedCandidate([{ stageId: "other", generationId: "gen_a" }], "review", first)).toBe(false);
});
