import { test, expect, type Page } from "@playwright/test";
import { filmBoard, openBoard } from "./helpers/boardV12";
import { forbidPaidWork, mockMedia } from "./helpers/workspaceFixtures";

/**
 * "Changed since you opened it" (prototype v15 item 6): a second window saves a rename of a stage this window has also renamed. Nothing is sent over
 * theirs; a slim bar under the header says so and offers Reload (the one filled button) and Keep my version. Desktop only; phones keep today's board.
 */
/* A board whose stage list is already saved (a rename then changes one stage's label in both windows; a list each window made from nothing would merge as made alike). */
const STAGES = ["brief", "script", "cast", "elements", "storyboard", "shots", "cut", "deliver"].map((id) => ({ id }));
const seeded = () => ({ project: { ...filmBoard(), boardStages: STAGES } });
const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const row = (page: Page, id: string) => page.locator(`[data-testid="v12-stage-row"][data-stage="${id}"]`);
const putOk = (page: Page) => page.waitForResponse((r) => r.url().includes("/api/workbench/projects") && r.request().method() === "PUT" && r.ok(), { timeout: 30_000 });

/** This window does not hear of the other save by itself (no room, and its poll is told nothing is newer); the head it is asked for to name who saved says so. */
const quiet = (page: Page) => page.route((url) => url.pathname === "/api/workbench/projects" && url.searchParams.get("head") === "1",
  (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ revision: 1, updatedAt: Date.now() - 120_000, by: "Ana", mine: false }) }));

async function rename(page: Page, stage: string, label: string) {
  await row(page, stage).hover();
  await page.getByRole("button", { name: /^Rename / }).first().click();
  const input = page.getByTestId("v12-stage-rename");
  await input.fill(label);
  const put = putOk(page).catch(() => null);
  await input.press("Enter");
  await expect(row(page, stage)).toContainText(label);
  return put;
}

test.beforeEach(({}, info) => test.skip(!DESKTOP.includes(info.project.name), "desktop sizes"));

test("the same stage renamed in two windows: the second to save is held, named, and chooses", async ({ page, context }, info) => {
  await openBoard(page, "/suites?view=board&stage=storyboard", seeded());
  await expect(page.getByTestId("v12-stage-rail")).toBeVisible({ timeout: 60_000 });
  await quiet(page);
  const other = await context.newPage();
  await forbidPaidWork(other);
  await mockMedia(other);
  await other.goto("/suites?view=board&stage=storyboard");
  await expect(other.getByTestId("v12-stage-rail")).toBeVisible({ timeout: 60_000 });
  await rename(other, "cut", "Theirs");

  await rename(page, "cut", "Mine");
  const bar = page.getByTestId("v12-changed-bar");
  await expect(bar).toBeVisible({ timeout: 30_000 });
  await expect(bar).toContainText(/Ana changed this board \d min ago · your change to a stage name is kept until you choose/);
  await expect(bar).toContainText("is kept until you choose");
  await expect(page.getByTestId("v12-changed-reload")).toBeVisible();
  await expect(row(page, "cut"), "this window's version stays on screen until the choice").toContainText("Mine");
  expect(await noSideways(page)).toBe(true);
  await page.screenshot({ path: `${process.env.SHOTS_DIR ?? "test-results"}/changed-bar-${info.project.name}.png` });
  /* Keep my version: the bar goes, this window's version is saved over theirs. */
  const kept = putOk(page);
  await page.getByTestId("v12-changed-keep").click();
  await expect(bar).toHaveCount(0);
  await kept;
  await expect(row(page, "cut")).toContainText("Mine");
});

test("Reload takes the saved version at that place", async ({ page, context }) => {
  await openBoard(page, "/suites?view=board&stage=storyboard", seeded());
  await expect(page.getByTestId("v12-stage-rail")).toBeVisible({ timeout: 60_000 });
  await quiet(page);
  const other = await context.newPage();
  await forbidPaidWork(other);
  await mockMedia(other);
  await other.goto("/suites?view=board&stage=storyboard");
  await expect(other.getByTestId("v12-stage-rail")).toBeVisible({ timeout: 60_000 });
  await rename(other, "cut", "Theirs");
  await rename(page, "cut", "Mine");
  await expect(page.getByTestId("v12-changed-bar")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("v12-changed-reload").click();
  await expect(page.getByTestId("v12-changed-bar")).toHaveCount(0);
  await expect(row(page, "cut")).toContainText("Theirs");
});

test("leaving the board while a change is held writes nothing over theirs, and the hold is there when the board is opened again", async ({ page, context }) => {
  const { project, scope } = await openBoard(page, "/suites?view=board&stage=storyboard", seeded());
  await expect(page.getByTestId("v12-stage-rail")).toBeVisible({ timeout: 60_000 });
  const headers = { "X-Workbench-Scope": scope };
  const second = await page.request.put("/api/workbench/projects", { headers, data: { project: { ...project, id: `${project.id}-other`, name: "Other board", nodes: [] }, revision: 0 } });
  expect(second.ok(), await second.text()).toBe(true);
  await quiet(page);
  const other = await context.newPage();
  await forbidPaidWork(other);
  await mockMedia(other);
  await other.goto("/suites?view=board&stage=storyboard");
  await expect(other.getByTestId("v12-stage-rail")).toBeVisible({ timeout: 60_000 });
  await rename(other, "cut", "Theirs");
  await rename(page, "cut", "Mine");
  await expect(page.getByTestId("v12-changed-bar")).toBeVisible({ timeout: 30_000 });
  /* Leave for another board. */
  await page.getByTestId("v12-tab-home").click();
  await page.locator('[data-testid="v12-home-board"]', { hasText: "Other board" }).click();
  await expect(page.getByTestId("v12-changed-bar")).toHaveCount(0);
  await page.waitForTimeout(3_000);
  const saved = await (await page.request.get(`/api/workbench/projects?id=${encodeURIComponent(project.id)}`, { headers })).json() as { project: { boardStages?: { id: string; label: string }[] } };
  expect(saved.project.boardStages?.find((s) => s.id === "cut")?.label, "the other save survives").toBe("Theirs");
  /* Back: this window's version and the question are both there. */
  await page.getByTestId("v12-tab-home").click();
  await page.locator('[data-testid="v12-home-board"]', { hasText: "Harbour film" }).click();
  await expect(page.getByTestId("v12-changed-bar")).toBeVisible({ timeout: 30_000 });
  await expect(row(page, "cut")).toContainText("Mine");
});
