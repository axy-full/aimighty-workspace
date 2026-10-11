import { test, expect } from "@playwright/test";
import { SAVE_FAILED, SaveFailedError, describeError, isSavedProject, saveMessage, saveThenContinue } from "../../lib/workbench/save-then-continue";

test("the action goes on only after the save lands, in that order", async () => {
  const order: string[] = [];
  const result = await saveThenContinue(
    async () => { order.push("save"); return true; },
    async () => { order.push("continue"); return 42; },
  );
  expect(result).toBe(42);
  expect(order).toEqual(["save", "continue"]);
});

test("a save that says no stops the action with the save line, never going on", async () => {
  let ran = false;
  await expect(saveThenContinue(async () => false, () => { ran = true; })).rejects.toThrow(SAVE_FAILED);
  await expect(saveThenContinue(async () => false, () => { ran = true; })).rejects.toBeInstanceOf(SaveFailedError);
  expect(ran).toBe(false);
});

test("a save that throws is a failed save, not a crash and not a green light", async () => {
  let ran = false;
  await expect(saveThenContinue(async () => { throw new Error("connection dropped"); }, () => { ran = true; })).rejects.toThrow(SAVE_FAILED);
  expect(ran).toBe(false);
});

test("only a true answer counts as saved", async () => {
  let ran = 0;
  for (const answer of [undefined, null, 0, "", "yes"]) {
    await expect(saveThenContinue((async () => answer) as unknown as () => Promise<boolean>, () => { ran++; })).rejects.toThrow(SAVE_FAILED);
  }
  expect(ran).toBe(0);
});

test("an error from the action itself is its own, not the save line", async () => {
  await expect(saveThenContinue(async () => true, () => { throw new Error("The estimate is not available."); })).rejects.toThrow("The estimate is not available.");
});

test("the save line is the same everywhere, with Try again", () => {
  expect(SAVE_FAILED).toBe("Couldn't save · Try again");
});

test("a project is saved once its production is linked", () => {
  expect(isSavedProject(undefined)).toBe(false);
  expect(isSavedProject({})).toBe(false);
  expect(isSavedProject({ productionProjectId: "" })).toBe(false);
  expect(isSavedProject({ productionProjectId: "prj_1" })).toBe(true);
});

test("the server's save-first refusals read as the save line; other messages are kept", () => {
  for (const said of [
    "Save this project before asking Atomik to work on it.",
    "Save the project before reading its brand website.",
    "Save this project before requesting a quote.",
    "Save your project first.",
    "Save the current project before naming this cut.",
  ]) expect(saveMessage(said)).toBe(SAVE_FAILED);
  for (const kept of ["The estimate is above your limit.", "Your workspace is out of credits.", "Saved runs are shown below; new paid requests remain paused."]) expect(saveMessage(kept)).toBe(kept);
  expect(describeError(new Error("Save this project before asking Atomik to work on it."), "x")).toBe(SAVE_FAILED);
  expect(describeError("odd", "The estimate could not be loaded.")).toBe("The estimate could not be loaded.");
});
