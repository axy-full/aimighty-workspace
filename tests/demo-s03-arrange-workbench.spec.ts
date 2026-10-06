import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { SHOTS, desktop, node, seedBoard } from "./helpers/s03-board";

/*
 * Stream 3 · arranging the board (plan § 2): Tidy lays out only the free cards, in one step with Undo; a shot or a
 * reference dragged to a new place in its frame reorders the draft (shot order is draft order); a lasso of free cards
 * moves together and lands on the 24 px dots; ⌫ takes free cards off, with Undo. Nothing paid is sent.
 */
const MORE = [
  node("node-note0002", "note", "Note", { text: "Second note.", x: 507, y: 333 }),
  node("node-note0003", "note", "Note", { text: "Third note.", x: 1611, y: 45 }),
  node("node-text0001", "note", "Schedule", { mode: "section", width: 260, x: 805, y: 801 }),
];
const FREE = ["node-note0001", "node-note0002", "node-note0003", "node-text0001"];

/** A card's place on the board, from the canvas's own transform (React Flow keeps it on the node). */
const placeOf = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`).evaluate((el) => {
  const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec((el as HTMLElement).style.transform);
  return { x: Number(m?.[1]), y: Number(m?.[2]) };
});
const shot = (page: Page, name: string) => { mkdirSync(SHOTS, { recursive: true }); return page.screenshot({ path: `${SHOTS}/${name}-${page.viewportSize()!.width}x${page.viewportSize()!.height}.png` }); };
const undo = (page: Page) => page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");

test("Tidy lays the free cards out in order on the dots and touches nothing else, and Undo puts them back", async ({ page }) => {
  test.skip(!desktop(page), "the canvas is desktop only");
  const { project, paid } = await seedBoard(page, MORE);
  await page.goto(`/suites?project=${project.id}&view=board`);
  await expect(page.locator('[data-card-id="group:shots"]')).toBeVisible();
  const before = Object.fromEntries(await Promise.all([...FREE, "node-shot0001", "node-cast0001"].map(async (id) => [id, await placeOf(page, id)])));
  expect(before["node-note0001"]).toEqual({ x: 96, y: 72 });

  await page.getByTestId("board-cluster").hover();
  await page.getByTestId("board-tidy").click();
  await expect(page.getByText(/^Tidied · 4 cards moved · free$/)).toBeVisible();
  const after = Object.fromEntries(await Promise.all([...FREE, "node-shot0001", "node-cast0001"].map(async (id) => [id, await placeOf(page, id)])));
  /* On the dots, right of the band area, in canvas order along rows, none on another. */
  for (const id of FREE) {
    expect(after[id].x % 24, id).toBe(0);
    expect(after[id].y % 24, id).toBe(0);
    expect(after[id].x, id).toBeGreaterThanOrEqual(0);
  }
  const rows = FREE.map((id) => after[id]);
  expect(rows[0].y).toBeLessThanOrEqual(rows[1].y);
  expect(rows[0].x).toBeLessThan(rows[1].x);
  expect(new Set(rows.map((r) => `${r.x},${r.y}`)).size).toBe(4);
  /* Arranged cards did not move. */
  expect(after["node-shot0001"]).toEqual(before["node-shot0001"]);
  expect(after["node-cast0001"]).toEqual(before["node-cast0001"]);
  /* The block is right of the bands; the board goes to it when it is not in view. */
  await expect(page.locator('[data-card-id="node-note0001"]')).toBeInViewport();
  await page.waitForTimeout(500);
  await shot(page, "board-tidied");

  /* Tidying again has nothing to do. */
  await page.getByTestId("board-tidy").click();
  await expect(page.getByText(/^Nothing to tidy/)).toBeVisible();

  /* ⌘Z: every card back where it was. */
  await undo(page);
  await expect.poll(() => placeOf(page, "node-note0002")).toEqual(before["node-note0002"]);
  expect(await placeOf(page, "node-note0001")).toEqual(before["node-note0001"]);
  expect(await placeOf(page, "node-text0001")).toEqual(before["node-text0001"]);
  expect(paid).toEqual([]);
});

test("a shot dragged to a new place in Shots reorders the draft; ⌘Z puts the order back", async ({ page }) => {
  test.skip(!desktop(page), "the canvas is desktop only");
  const { project, paid } = await seedBoard(page);
  await page.goto(`/suites?project=${project.id}&view=board`);
  await expect(page.locator('[data-card-id="group:shots"]')).toBeVisible();
  await page.getByTestId("board-rail").getByRole("button", { name: /^Shots/ }).click();
  const first = page.locator('[data-card-id="node-shot0001"]'), second = page.locator('[data-card-id="node-shot0002"]');
  await expect(second).toBeInViewport();
  await page.waitForTimeout(500);
  /* A shot card names its place in the draft: "Shot 1 · <its framing>" (Stream 5's take card, gx-take-name). */
  const eyebrow = (id: string) => page.locator(`[data-card-id="${id}"] .gx-take-name`);
  await expect(eyebrow("node-shot0001")).toHaveText("Shot 1 · Opening wide");
  const a = (await first.boundingBox())!, b = (await second.boundingBox())!;
  expect(b.x).toBeGreaterThan(a.x);

  /* Press on the second shot, drag it over the left half of the first: a line shows where it will land. */
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 - 60, b.y + b.height / 2, { steps: 6 });
  await page.mouse.move(a.x + a.width * 0.2, a.y + a.height / 2, { steps: 10 });
  await expect(page.getByTestId("board-slot")).toBeVisible();
  await shot(page, "board-reorder-drag");
  await page.mouse.up();

  /* The draft's order changed: the second shot is Shot 1, and sits first. */
  await expect(page.getByTestId("board-slot")).toHaveCount(0);
  await expect(eyebrow("node-shot0002")).toHaveText("Shot 1 · The first stall");
  await expect(eyebrow("node-shot0001")).toHaveText("Shot 2 · Opening wide");
  await expect.poll(async () => (await second.boundingBox())!.x).toBeLessThan((await first.boundingBox())!.x);

  await undo(page);
  await expect(eyebrow("node-shot0001")).toHaveText("Shot 1 · Opening wide");
  await expect(eyebrow("node-shot0002")).toHaveText("Shot 2 · The first stall");

  /* A press that does not move, or a small wobble, is a click: the order stays and the card is selected. */
  const c = (await second.boundingBox())!;
  await page.mouse.click(c.x + c.width / 2, c.y + c.height / 2);
  await expect(second).toHaveAttribute("data-selected", "true");
  await expect(eyebrow("node-shot0001")).toHaveText("Shot 1 · Opening wide");
  expect(paid).toEqual([]);
});

test("a lasso of free cards moves together onto the dots, and ⌫ takes them off with Undo", async ({ page }) => {
  test.skip(!desktop(page), "the canvas is desktop only");
  const { project } = await seedBoard(page, MORE);
  await page.goto(`/suites?project=${project.id}&view=board`);
  await expect(page.locator('[data-card-id="group:shots"]')).toBeVisible();
  await page.getByTestId("board-cluster").hover();
  await page.getByTestId("board-zoom").click();
  /* Fit everything so all the free cards are on screen to press. */
  await page.keyboard.press("0");
  await page.waitForTimeout(600);
  const one = page.locator('[data-card-id="node-note0002"]'), two = page.locator('[data-card-id="node-note0003"]');
  const was = { one: await placeOf(page, "node-note0002"), two: await placeOf(page, "node-note0003") };
  /* The Inspector opens over the right edge on the first press and floats over the canvas (by design), so the
     right-hand card is pressed first and the Shift-click lands on the left-hand one, which it does not cover. */
  await two.click();
  await one.click({ modifiers: ["Shift"] });
  await expect(page.locator(".bd-node[data-selected]")).toHaveCount(2);
  const box = (await one.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 40, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await placeOf(page, "node-note0002")).x).not.toBe(was.one.x);
  const now = { one: await placeOf(page, "node-note0002"), two: await placeOf(page, "node-note0003") };
  expect(now.one.x - was.one.x).toBe(now.two.x - was.two.x);
  expect(now.one.y - was.one.y).toBe(now.two.y - was.two.y);
  for (const p of [now.one, now.two]) { expect(p.x % 24).toBe(0); expect(p.y % 24).toBe(0); }

  /* ⌫ on the selection: both go, the toast says how to bring them back. */
  await page.keyboard.press("Backspace");
  await expect(page.getByText(/2 cards taken off the board/)).toBeVisible();
  await expect(one).toHaveCount(0);
  await expect(two).toHaveCount(0);
  await undo(page);
  await expect(one).toHaveCount(1);
  await expect(two).toHaveCount(1);
});
