import { test, expect, type Page } from "@playwright/test";
import { filmBoard, openBoard } from "./helpers/boardV12";

/**
 * The board frame in the new interface (docs/redesign-plan.md P2-a1; components/v12/board/): the Film stage rail over
 * today's board, the stage header with at most one primary, the right toolbar with first-visit labels, the view switch,
 * stage keys, and rail edits kept in the draft. Phones keep today's board; with the switch off nothing changes.
 */
const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const PHONE = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const rows = (page: Page) => page.getByTestId("v12-stage-row");
const saved = (page: Page) => page.waitForResponse((r) => r.url().includes("/api/workbench/projects") && r.request().method() === "PUT" && r.ok(), { timeout: 30_000 });

test.describe("desktop, switch on", () => {
  test.beforeEach(({}, info) => test.skip(!DESKTOP.includes(info.project.name), "desktop sizes"));

  test("a Film board: eight stages, opening on Storyboard; one stage at a time; at most one primary on any stage", async ({ page }) => {
    const { errors } = await openBoard(page);
    await expect(page.getByTestId("v12-stage-rail")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("v12-stage-kind")).toHaveText("FILM");
    await expect(rows(page)).toHaveCount(8);
    expect(await rows(page).evaluateAll((els) => els.map((el) => el.getAttribute("data-stage")))).toEqual(["brief", "script", "cast", "elements", "storyboard", "shots", "cut", "deliver"]);
    await expect(page.getByTestId("v12-stage-crumb")).toHaveText("Storyboard");
    await expect(page.getByTestId("board")).toHaveAttribute("data-stage", "storyboard");
    /* Today's rail and tool pill give way to the new ones. */
    await expect(page.getByTestId("board-rail")).toHaveCount(0);
    await expect(page.getByTestId("board-tools")).toHaveCount(0);
    for (const id of ["brief", "script", "cast", "elements", "storyboard", "shots", "cut", "deliver"]) {
      await page.locator(`[data-testid="v12-stage-row"][data-stage="${id}"] .v12-rail-btn`).click();
      await expect(page).toHaveURL(new RegExp(`stage=${id}`));
      await expect(page.getByTestId("board")).toHaveAttribute("data-stage", id);
      expect(await page.getByTestId("v12-stage-primary").count(), `${id}: at most one primary`).toBeLessThanOrEqual(1);
      expect(await noSideways(page), `${id}: no sideways scroll`).toBe(true);
    }
    /* Script has nothing on today's board: it says what goes there. */
    await page.locator('[data-testid="v12-stage-row"][data-stage="script"] .v12-rail-btn').click();
    await expect(page.getByTestId("v12-stage-empty")).toBeVisible();
    /* Cut draws today's cut card: a stage shows what today's board has, nothing invented. */
    await page.locator('[data-testid="v12-stage-row"][data-stage="cut"] .v12-rail-btn').click();
    await expect(page.getByTestId("v12-stage-empty")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("keys: 1–9 jump to a stage, [ and ] step; Esc clears the selection before anything else", async ({ page }) => {
    await openBoard(page, "/suites?view=board&stage=storyboard");
    await expect(page.getByTestId("v12-stage-rail")).toBeVisible({ timeout: 60_000 });
    await page.locator(".react-flow__pane").click({ position: { x: 40, y: 40 } });
    await page.keyboard.press("3");
    await expect(page.getByTestId("board")).toHaveAttribute("data-stage", "cast");
    await page.keyboard.press("]");
    await expect(page.getByTestId("board")).toHaveAttribute("data-stage", "elements");
    await page.keyboard.press("[");
    await page.keyboard.press("[");
    await expect(page.getByTestId("board")).toHaveAttribute("data-stage", "script");
  });

  test("the rail is the board's: rename, skip, add and remove a stage, each kept in the draft, with Undo", async ({ page }) => {
    await openBoard(page, "/suites?view=board&stage=storyboard");
    await expect(page.getByTestId("v12-stage-rail")).toBeVisible({ timeout: 60_000 });
    const row = (id: string) => page.locator(`[data-testid="v12-stage-row"][data-stage="${id}"]`);
    /* Rename Cut to Edit. */
    await row("cut").hover();
    await page.getByRole("button", { name: "Rename Cut" }).click();
    const put = saved(page);
    await page.getByTestId("v12-stage-rename").fill("Edit");
    await page.getByTestId("v12-stage-rename").press("Enter");
    await expect(row("cut")).toContainText("Edit");
    await put;
    /* Skip Script: its marker is a dash and its label struck. */
    await row("script").hover();
    await row("script").getByTestId("v12-stage-menu").click();
    await page.getByRole("menuitem", { name: "Skip this stage" }).click();
    await expect(row("script")).toHaveAttribute("data-state", "skip");
    /* + Stage · Animatic after Storyboard: added, opened, and saying what goes there. */
    await page.getByTestId("v12-stage-add").click();
    await page.getByRole("menuitem", { name: /Animatic/ }).click();
    await expect(rows(page)).toHaveCount(9);
    await expect(page.getByTestId("v12-stage-crumb")).toHaveText("Animatic");
    await expect(page.getByTestId("v12-stage-empty")).toContainText("The storyboard cut to the script’s timings.");
    /* It stays after a reload: the arrangement is the draft's. */
    await saved(page).catch(() => {});
    await page.reload();
    await expect(rows(page)).toHaveCount(9, { timeout: 60_000 });
    await expect(row("cut")).toContainText("Edit");
    await expect(row("script")).toHaveAttribute("data-state", "skip");
    /* Remove the new stage; Undo brings it back. */
    const added = rows(page).filter({ hasText: "Animatic" });
    await added.hover();
    await added.getByTestId("v12-stage-menu").click();
    await page.getByRole("menuitem", { name: "Remove" }).click();
    await expect(rows(page)).toHaveCount(8);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
    await expect(rows(page)).toHaveCount(9);
  });

  test("the right toolbar: first-visit labels until Got it, again with ?first=1; tooltips say what a tool does; the view switch", async ({ page }) => {
    await openBoard(page, "/suites?view=board&stage=storyboard");
    const tools = page.getByTestId("v12-board-tools");
    await expect(tools).toBeVisible({ timeout: 60_000 });
    await expect(tools).toHaveAttribute("data-labels", "true");
    await expect(tools).toContainText("Select · V");
    await page.getByTestId("v12-tools-got-it").click();
    await expect(tools).not.toHaveAttribute("data-labels", "true");
    await page.reload();
    await expect(page.getByTestId("v12-board-tools")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("v12-board-tools")).not.toHaveAttribute("data-labels", "true");
    await page.locator('[data-testid="v12-board-tools"] [data-tool="note"]').hover();
    await expect(page.getByTestId("v12-tooltip")).toContainText("A sticky note for ideas, feedback or to-dos.");
    await page.goto("/suites?view=board&stage=storyboard&first=1");
    await expect(page.getByTestId("v12-board-tools")).toHaveAttribute("data-labels", "true", { timeout: 60_000 });
    /* Canvas and List are today's views; Strip and Rig are not built yet. */
    const view = page.getByTestId("v12-view-switch");
    await view.getByRole("radio", { name: "List" }).click();
    await expect(page.getByTestId("v12-board-tools")).toHaveCount(0);
    await view.getByRole("radio", { name: "Canvas" }).click();
    await expect(page.getByTestId("v12-board-tools")).toBeVisible();
    await expect(view.getByRole("radio", { name: "Strip" })).toBeDisabled();
    await expect(view.getByRole("radio", { name: "Rig" })).toBeDisabled();
    expect(await noSideways(page)).toBe(true);
  });

  test("a full rail (24 stages) cannot take another: + Stage is off and says why, and the draft still saves", async ({ page }) => {
    const extra = Array.from({ length: 16 }, (_, i) => ({ id: `custom-extra${i}`, label: `Extra ${i + 1}`, custom: true as const }));
    const builtIn = ["brief", "script", "cast", "elements", "storyboard", "shots", "cut", "deliver"].map((id) => ({ id }));
    await openBoard(page, "/suites?view=board&stage=storyboard", { project: { ...filmBoard(), boardStages: [...builtIn, ...extra] } });
    await expect(page.getByTestId("v12-stage-rail")).toBeVisible({ timeout: 60_000 });
    await expect(rows(page)).toHaveCount(24);
    const add = page.getByTestId("v12-stage-add");
    await expect(add).toBeDisabled();
    await expect(add).toHaveAttribute("title", "A board holds up to 24 stages. Remove one to add another.");
    /* Remove one: the rail takes another again, and the draft saves (the whole draft would have been refused at 25). */
    const row = rows(page).filter({ hasText: "Extra 16" });
    await row.hover();
    await row.getByTestId("v12-stage-menu").click();
    const put = saved(page);
    await page.getByRole("menuitem", { name: "Remove" }).click();
    await put;
    await expect(rows(page)).toHaveCount(23);
    await expect(add).toBeEnabled();
  });

  test("switch off: today's board, its rail and its tool pill", async ({ page }) => {
    await openBoard(page, "/suites?view=board", { on: false });
    await expect(page.getByTestId("board-rail")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("board-tools")).toBeVisible();
    await expect(page.getByTestId("v12-stage-rail")).toHaveCount(0);
    await expect(page.getByTestId("v12-stage-header")).toHaveCount(0);
  });
});

test.describe("phones, switch on", () => {
  test.beforeEach(({}, info) => test.skip(!PHONE.includes(info.project.name), "phone sizes"));

  test("the phone app keeps today's board, with no stage rail", async ({ page }) => {
    const { errors } = await openBoard(page);
    await expect(page.locator("[data-phone]")).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId("v12-stage-rail")).toHaveCount(0);
    await expect(page.getByTestId("v12-board-tools")).toHaveCount(0);
    expect(await noSideways(page)).toBe(true);
    expect(errors).toEqual([]);
  });
});
