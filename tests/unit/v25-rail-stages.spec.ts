import { test, expect } from "@playwright/test";
import { OPTIONAL_STEPS, iconOf, railStepsOf } from "../../components/v12/board/rail-stages";
import { RAIL_ICONS } from "../../components/v12/board/rail-icons";
import { applyStageEdit, stagesOf } from "../../lib/v12/board/stages";

/* v25 PR 7, the rail's items from the Opus review of #750: the steps are the board's stages (lib/v12/board/stages.ts), with their renames, their order, skipped and removed. */
const read = { status: (id: string) => `status of ${id}`, done: (id: string) => id === "brief" };
const ids = (steps: { id: string }[]) => steps.map((s) => s.id);

test("the Film rail is the eleven stages in order, each with its icon, status and tick; Treatment and Pitch are optional", () => {
  const steps = railStepsOf(stagesOf("film", null), read);
  expect(ids(steps)).toEqual(["treatment", "pitch", "brief", "script", "cast", "locations", "elements", "storyboard", "shots", "edit", "deliver"]);
  expect(steps.map((s) => s.label)).toEqual(["Treatment", "Pitch", "Brief", "Script", "Cast", "Locations", "Elements", "Storyboard", "Shots", "Edit", "Deliver"]);
  expect(steps.find((s) => s.id === "brief")).toMatchObject({ done: true, status: "status of brief", optional: false });
  expect(steps.find((s) => s.id === "pitch")).toMatchObject({ done: false, optional: true });
  expect([...OPTIONAL_STEPS].sort()).toEqual(["pitch", "treatment"]);
  /* Every step has a drawn icon; Treatment, which the prototype has none for, takes the Script's; the shared fallback is only for a step a person added. */
  for (const s of steps) expect(s.icon, s.id).toBe(iconOf(s.id));
  expect(iconOf("treatment")).toBe(RAIL_ICONS.script);
  expect(iconOf("a-custom-step")).toBe(RAIL_ICONS.elements);
});

test("a rename, a skip and a reorder the person made show on the rail, and a skipped step is muted and not done", () => {
  let saved = stagesOf("film", null);
  saved = stagesOf("film", applyStageEdit(saved, { type: "rename", id: "shots", label: "Takes" }, () => "x").saved);
  saved = stagesOf("film", applyStageEdit(saved, { type: "skip", id: "pitch", skipped: true }, () => "x").saved);
  saved = stagesOf("film", applyStageEdit(saved, { type: "move", id: "deliver", index: 0 }, () => "x").saved);
  const steps = railStepsOf(saved, { status: () => "Done", done: () => true });
  expect(steps[0].id).toBe("deliver");
  expect(steps.find((s) => s.id === "shots")?.label).toBe("Takes");
  expect(steps.find((s) => s.id === "pitch")).toMatchObject({ skipped: true, done: false, status: "Skipped" });
  expect(steps.find((s) => s.id === "brief")?.done).toBe(true);
});

test("a removed step is gone from the rail and stays gone through the next edit and a step added later", () => {
  let saved = stagesOf("film", null);
  const removed = applyStageEdit(saved, { type: "remove", id: "locations" }, () => "x").saved;
  saved = stagesOf("film", removed);
  expect(ids(railStepsOf(saved, read))).not.toContain("locations");
  /* The saved list keeps it flagged, so a rail read again (or after another edit) does not bring it back. */
  expect(removed.find((s) => s.id === "locations")).toMatchObject({ removed: true });
  const again = stagesOf("film", applyStageEdit(saved, { type: "rename", id: "cast", label: "People" }, () => "x").saved);
  expect(ids(railStepsOf(again, read))).not.toContain("locations");
  expect(railStepsOf(again, read).find((s) => s.id === "cast")?.label).toBe("People");
  /* A step a person adds takes the shared icon and is not optional. */
  const added = applyStageEdit(again, { type: "add", after: "shots", label: "Recce" }, () => "custom1");
  const withAdded = railStepsOf(stagesOf("film", added.saved), read);
  expect(added.go).toMatch(/custom1/);
  expect(withAdded.find((s) => s.id === added.go)).toMatchObject({ label: "Recce", icon: RAIL_ICONS.elements, optional: false });
  expect(ids(withAdded).indexOf(added.go!)).toBe(ids(withAdded).indexOf("shots") + 1);
});
