import { test, expect } from "@playwright/test";
import { DELIVERY_QUESTION, RESOLUTIONS, asksResolution, resolutionOf, withResolution } from "../../lib/v12/board/brief-question";
import { withMode, stepSetup } from "../../lib/v12/board/board-data";
import { projectSchema } from "../../lib/workbench/studio-schema";
import { newProject } from "../../lib/workbench/studio";

/** The Brief's one Agent question (lib/v12/board/brief-question.ts): it only records the choice in the board's Agent setup. */
test("the question and its two answers", () => {
  expect(DELIVERY_QUESTION).toBe("Deliver at 1080p or 4K?");
  expect(RESOLUTIONS.map((r) => r.label)).toEqual(["1080p", "4K"]);
});

test("nothing is answered until the person answers: no default", () => {
  expect(resolutionOf(newProject("x"))).toBeNull();
});

test("an answer is kept in Agent's setup for the Brief, by itself, and is the person's to change", () => {
  const p = withResolution(newProject("x"), "4k");
  expect(resolutionOf(p)).toBe("4k");
  expect(stepSetup(p.boardSetup, "agent", "brief")).toEqual({ resolution: "4k" });
  expect(stepSetup(p.boardSetup, "director", "brief")).toEqual({});
  expect(resolutionOf(withResolution(p, "1080p"))).toBe("1080p");
  /* A value that is not an answer changes nothing. */
  expect(withResolution(p, "8k" as never)).toBe(p);
  expect(projectSchema.safeParse(p).success).toBe(true);
});

test("it is asked in Agent mode, which is where a person starts, and not in Director's", () => {
  const p = newProject("x");
  expect(asksResolution(p, "u1")).toBe(true);
  expect(asksResolution(p, null)).toBe(true);
  expect(asksResolution({ ...p, boardMode: withMode(p.boardMode, "u1", "director") }, "u1")).toBe(false);
  /* A colleague's choice of mode is theirs alone. */
  expect(asksResolution({ ...p, boardMode: withMode(p.boardMode, "u1", "director") }, "u2")).toBe(true);
});
