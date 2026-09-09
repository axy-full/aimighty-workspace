import { test, expect } from "@playwright/test";
import { ceilingProblem } from "../../lib/refLimits";

const img = { role: "reference_image" };
const first = { role: "first_frame" };
const last = { role: "last_frame" };
const vid = { role: "reference_video" };
const kling = { maxReferenceImages: 2, label: "Kling 3.0" };
const seedance = { maxReferenceImages: 9, label: "Seedance 2.0" };
const none = { maxReferenceImages: 0, label: "Topaz Upscale" };

test("what the person attached alone is fine", () => {
  expect(ceilingProblem([img, img], kling)).toBeNull();
});

test("the cast's stills count against the ceiling too", () => {
  /* THE BUG: references were checked when they arrived from the browser,
     before expandCast pushes a still per cited name. Two attached images on
     a two-image model plus "@Mara rides @Mule" left with four and nothing
     said so. */
  const problem = ceilingProblem([img, img, img, img], kling, ["Mara", "Mule"]);
  expect(problem).toContain("at most 2");
  expect(problem).toContain("(4 attached)");
});

test("the message names the cast, so it accuses the right thing", () => {
  /* Without this the error tells someone they attached four files when they
     attached two. */
  expect(ceilingProblem([img, img, img], kling, ["Mara"])).toContain("@Mara");
  expect(ceilingProblem([img, img, img], kling, ["Mara"])).toContain("attach their stills too");
});

test("with nothing cited the message does not mention the cast", () => {
  const problem = ceilingProblem([img, img, img], kling);
  expect(problem).toContain("at most 2");
  expect(problem).not.toContain("Cited cast");
});

test("a model that takes no reference images refuses the first one", () => {
  /* maxReferenceImages: 0 is real — a cited cast member alone would have
     pushed an image onto an engine that accepts none. */
  expect(ceilingProblem([img], none, ["Mara"])).toContain("at most 0");
  expect(ceilingProblem([], none)).toBeNull();
});

test("frames and references still cannot be mixed once the cast has added one", () => {
  /* A cited name turns a clean first-frame render into a mixed one, which
     ModelArk treats as a different mode entirely. */
  expect(ceilingProblem([first, img], seedance, ["Mara"])).toContain("can't be mixed");
  expect(ceilingProblem([first, last], seedance)).toBeNull();
});

test("videos are not counted here, because the cast never adds one", () => {
  expect(ceilingProblem([vid, vid, vid], none)).toBeNull();
});

test("exactly at the ceiling is not over it", () => {
  expect(ceilingProblem([img, img], kling, ["Mara"])).toBeNull();
});
