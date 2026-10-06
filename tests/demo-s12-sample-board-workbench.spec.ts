import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { newProject } from "../lib/workbench/studio";
import { signInLocally } from "./helpers/workbenchLocal";
import { forbidPaidWork, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";
import { seedFinishedProduction, watchPaidRequests } from "./helpers/s12-sample";

/*
 * The explore-only sample on the board (lead decisions 12, 38 and 41), on a fixture production in a local ENGINE_MOCK
 * workspace: the sample's board carries the line in a pill top right, its plan card is built from the ledger's recorded
 * prices (43 + 43 + 7 = 93 cr, up to 186 cr of fixes), every paid control on it is disabled, and nothing leaves the
 * page. Another production in the sample workspace carries the line too, without the sample's plan. At each viewport: no sideways scroll, text at least 12 px.
 */
const LINE = "Sample production · nothing here spends credits";
const SHOTS = process.env.S12_SHOTS || "/private/tmp/claude-s12-shots";
const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1280;
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("the sample's board: the pill, the recorded plan, every paid control disabled", async ({ page }, info) => {
  const paid = watchPaidRequests(page);
  const made = await seedFinishedProduction(page);
  const marked = await page.request.post("/api/demo/sample", { headers: made.headers, data: { action: "mark", draftId: made.project.id } });
  expect(marked.status(), await marked.text()).toBe(200);
  const opened = await (await page.request.post("/api/demo/sample", { headers: made.headers, data: { action: "open" } })).json() as { project: { id: string } };
  await page.goto(`/suites?project=${opened.project.id}&view=board`);
  await expect(page.getByTestId("board")).toBeVisible();
  /* The shell settles the address once; the board is drawn again after it, so wait for it before touching anything. */
  await expect.poll(() => page.url(), { message: "the address settles" }).toContain("page=brief");
  await expect(page.getByTestId("board")).toBeVisible();
  const pill = page.getByTestId("board-sample");
  await expect(pill).toHaveText(LINE);
  await expect(page.getByTestId("board")).toHaveAttribute("data-sample", "1");
  /* In the viewport, top right, in the reading floor. */
  const box = (await pill.boundingBox())!;
  const view = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(view.width);
  expect(await pill.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(12);
  expect(await overflow(page)).toBeLessThanOrEqual(0);

  mkdirSync(SHOTS, { recursive: true });
  if (desktop(page)) {
    const plan = page.locator('[data-card-id="plan:sample"]').getByTestId("board-plan");
    await expect(plan).toBeVisible({ timeout: 20_000 });
    await expect(plan).toContainText("Make 3 shots");
    await expect(plan.getByTestId("board-plan-line")).toContainText("93 cr");
    await expect(plan.getByTestId("board-plan-line")).toContainText("186 cr");
    /* Every paid or approving control is disabled and the line is on the card. */
    for (const id of ["board-plan-hold", "board-plan-change", "board-plan-primary"]) await expect(plan.getByTestId(id)).toBeDisabled();
    await expect(plan).toContainText(LINE);
    await plan.getByTestId("board-plan-toggle").click();
    const steps = plan.getByTestId("board-plan-step");
    await expect(steps).toHaveCount(3);
    await expect(steps.nth(0)).toContainText("43 cr");
    await expect(steps.nth(2)).toContainText("7 cr");
    await expect(plan).not.toContainText(/SH\d|quoted|settled/i);
    const small = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-testid="board-plan"] *, [data-testid="board-sample"]')]
      .filter((el) => el.childElementCount === 0 && (el.textContent ?? "").trim() && parseFloat(getComputedStyle(el).fontSize) < 12).map((el) => el.textContent));
    expect(small).toEqual([]);
    await page.getByTestId("board-rail").getByText("Storyboard", { exact: true }).click();
    await page.waitForTimeout(600);
  }
  await page.screenshot({ path: `${SHOTS}/sample-board-${info.project.name.replace("workbench-", "")}.png` });

  expect(paid).toEqual([]);
});

test("another production in the sample workspace spends nothing either (the owner's switch, 6 Oct): the pill, but not the sample's plan", async ({ page }) => {
  await signInLocally(page.request, "Other Film Tester");
  await forbidPaidWork(page);
  await mockMedia(page);
  const other = { ...newProject("Another film"), id: "ws-other-film", productionProjectId: "prod-other-film", shotMappings: {} };
  await mockProjects(page, { current: other });
  await mockLibrary(page, { uploads: [], generations: [] });
  /* The workspace's sample is a different production: its board data is served, and this project is not it. */
  await page.route("**/api/demo/sample", (route) => route.fulfill({ json: { board: {
    sample: { projectId: "prod-the-sample", name: "The sample", markedAt: 1 }, line: LINE,
    plan: { steps: [{ title: "Shot 1", meta: "Seedance 2.5 · 5 s · 1080p", credits: 43, kind: "take" }], unpriced: [], recorded: { settled: 43, quoted: 0 } },
    cast: [], cut: { shots: [], approved: 0, seconds: 0, approvedSeconds: 0, waiting: 0 },
  }, sampleWorkspace: true } }));
  await page.addInitScript(() => { try { localStorage.setItem("last-project", "ws-other-film"); } catch { /* storage off */ } });
  await page.goto("/suites?project=ws-other-film&view=board");
  await expect(page.getByTestId("board")).toBeVisible();
  /* The whole workspace is the sample workspace: this board carries the line too, and its paid controls are off. */
  await expect(page.getByTestId("board")).toHaveAttribute("data-sample", "1");
  await expect(page.getByTestId("board-sample").first()).toHaveText(LINE);
  /* The sample's recorded plan belongs to the sample alone. */
  await expect(page.locator('[data-card-id="plan:sample"]')).toHaveCount(0);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
});
