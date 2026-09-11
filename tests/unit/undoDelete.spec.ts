import { test, expect } from "@playwright/test";
import { scheduleDelete, cancelDelete } from "../../lib/undoDelete";

/** Delete with Undo (docs/change-request-1.md §10): the request waits; Undo cancels it. */
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a scheduled delete runs once its grace is up, and not before", async () => {
  let ran = 0;
  scheduleDelete("a", () => { ran++; }, 40);
  await tick(10);
  expect(ran).toBe(0);
  await tick(60);
  expect(ran).toBe(1);
  expect(cancelDelete("a"), "nothing left to undo once it ran").toBe(false);
});

test("Undo cancels it; scheduling the same id again replaces the earlier timer", async () => {
  let ran = 0;
  scheduleDelete("b", () => { ran++; }, 40);
  expect(cancelDelete("b")).toBe(true);
  await tick(60);
  expect(ran).toBe(0);
  scheduleDelete("c", () => { ran += 10; }, 40);
  scheduleDelete("c", () => { ran += 1; }, 40);
  await tick(80);
  expect(ran, "only the later timer fires").toBe(1);
});
