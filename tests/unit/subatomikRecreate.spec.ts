import { test, expect } from "@playwright/test";
import { recreationProblem, recreationSettings } from "../../components/suites/subatomik-recreate";
import { GENJUTSU_MODELS } from "../../lib/genjutsuTypes";
import type { Generation } from "../../lib/jobs";

function take(params: Record<string, unknown> = {}): Generation {
  return { id: "retained-take", model: GENJUTSU_MODELS["object-swap"], prompt: "Final provider prompt", params: {
    sourceUploadId: "original-video", resolution: "720p", rawPrompt: "Keep the movement; replace the object.",
    references: [{ uploadId: "original-video", role: "reference_video", kind: "video" }, { genId: "first-image", role: "reference_image", kind: "image" }, { uploadId: "second-image", role: "reference_image", kind: "image" }], ...params,
  } } as unknown as Generation;
}
test("Recreate restores explicit original identities and reference order, using the user's original prompt", () => {
  expect(recreationSettings(take())).toEqual({ variant: "object-swap", source: "upload:original-video", references: ["generation:first-image", "upload:second-image"], prompt: "Keep the movement; replace the object.", resolution: "720p" });
  expect(recreationSettings(take({ references: [], rawPrompt: "" })).prompt).toBe("");
});
test("Recreate rejects incomplete, ambiguous or conflicting retained settings instead of guessing", () => {
  for (const params of [{ references: undefined }, { resolution: undefined }, { sourceGenId: "different-video" }, { references: [{ uploadId: "x", genId: "y", role: "reference_image", kind: "image" }] }, { references: [{ uploadId: "x", role: "reference_image", kind: "video" }] }, { references: [{ uploadId: "another-video", role: "reference_video", kind: "video" }] }]) {
    expect(recreationProblem(take(params))).toBeTruthy();
  }
  expect(recreationProblem({ ...take(), sourceGenId: "conflicting-source" })).toBeTruthy();
});
test("Recreate rejects duplicated references and provider controls unsupported by the active API", () => {
  const ref = { uploadId: "same", role: "reference_image", kind: "image" };
  expect(recreationProblem(take({ references: [ref, ref] }))).toBeTruthy();
  expect(recreationProblem(take({ resolution: "1080p" }))).toBeTruthy();
  expect(recreationProblem(take({ rawPrompt: "x".repeat(5001) }))).toBeTruthy();
});
