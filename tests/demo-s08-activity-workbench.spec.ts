import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { signInWithNewInterface } from "./helpers/newInterface";
import { smallTargets } from "./phoneFloors";

/**
 * Control room › Activity (Atomik frame h) with the new interface on: what
 * each project settled, the runs with their state and settled figure, the
 * filter, and a run's steps priced → settled in the Inspector, with Auto's
 * renders marked. Read only: nothing here approves or spends.
 */

const PAGE = "/suites?suite=atomik&page=runs";
const SHOTS = join(tmpdir(), "claude-s08-shots");
const SHOT_SIZES = ["workbench-1440x900", "workbench-390x844"];

/**
 * The viewports where the shell mounts the phone app (lib/shell/use-compact.ts: narrower than 768 px, or a touch screen no taller than
 * 500 px, so 844x390 is a phone). The phone draws Home (with its Needs you queue), the Record, plan approval, review, Make and Atomik's
 * sheet, and Settings as a page; it has no screen for the control room's Activity, Memory or Skills, and `?suite=atomik&page=…` for those
 * opens Home. Whether it should is the owner's question (SOW § 2.8 lists none), so those tests are fixme there, not skipped as done.
 */
const COMPACT = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const isCompact = (info: { project: { name: string } }) => COMPACT.includes(info.project.name);
const NO_PHONE_SCREEN = "owner decision pending: phone screens for Activity/Memory/Skills";

async function shoot(page: Page, project: string, name: string) {
  if (!SHOT_SIZES.includes(project)) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}-${project.replace("workbench-", "")}.png`, fullPage: true });
}

async function floors(page: Page, phone: boolean) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "horizontal overflow").toBeLessThanOrEqual(0);
  const small = await page.evaluate(() => {
    const out: string[] = [];
    const root = document.querySelector(".cr");
    if (!root) return ["no .cr"];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.textContent ?? "").trim();
      const el = node.parentElement;
      if (!text || !el || !el.getClientRects().length) continue;
      const size = Number.parseFloat(getComputedStyle(el).fontSize);
      if (size < 12) out.push(`${size}px “${text.slice(0, 30)}”`);
    }
    return out;
  });
  expect(small, "text under 12 px").toEqual([]);
  if (phone) expect(await smallTargets(page, ".cr"), "targets under 44×44").toEqual([]);
}

test("the real read answers for this person's own fresh workspace", async ({ page }, info) => {
  test.fixme(isCompact(info), NO_PHONE_SCREEN);
  await signInWithNewInterface(page.request);
  const reply = await page.request.get("/api/control-room/activity");
  expect(reply.ok()).toBeTruthy();
  const body = await reply.json();
  expect(body).toMatchObject({ productionId: null, projects: [], runs: [] });
  await page.goto(PAGE);
  await expect(page.getByTestId("page-title")).toHaveText("Activity");
  await expect(page.getByTestId("runs-empty")).toBeVisible();
});

const project = { productionId: "prod_fx", draftId: null, name: "Project one" };
const t = Date.now() - 3_600_000;
const step = (over: Record<string, unknown>) => ({ id: `s${Math.random()}`, kind: "paid", title: "Step", priced: null, settled: { kind: "unknown" }, state: "done", by: null, byYou: false, auto: false, at: t, ...over });
const FIXTURE = {
  inCredits: true, productionId: null,
  projects: [{ project, settled: 69 }, { project: { productionId: "prod_two", draftId: null, name: "Project two" }, settled: 56 }],
  runs: [
    { id: "thread:ach_wait", source: "thread", n: 5, title: "Plan three hero takes", project, startedAt: t + 5, state: "needs-you", reason: null, settled: 0, settling: false, request: "Plan three hero takes",
      open: { kind: "thread", chatId: "ach_wait", productionId: "prod_fx" }, steps: [step({ title: "Keyframes", priced: { kind: "up-to", credits: 9 }, state: "waiting" })] },
    { id: "board:rar_done", source: "board", n: 4, title: "Hero takes on the board", project, startedAt: t + 4, state: "done", reason: null, settled: 66, settling: false, request: "Hero takes",
      open: { kind: "board", productionId: "prod_fx", draftId: null }, steps: [
        step({ kind: "thinking", title: "Atomik's thinking", settled: { kind: "settled", credits: 2 } }),
        step({ title: "The opening", priced: { kind: "exact", credits: 43 }, settled: { kind: "settled", credits: 43 }, by: "Teammate" }),
        step({ title: "Draft two", priced: { kind: "exact", credits: 7 }, settled: { kind: "settled", credits: 7 }, auto: true }),
      ] },
    { id: "thread:ach_fly", source: "thread", n: 3, title: "Plate renders", project, startedAt: t + 3, state: "running", reason: null, settled: 3, settling: true, request: "Plates",
      open: { kind: "thread", chatId: "ach_fly", productionId: "prod_fx" }, steps: [step({ title: "Plate one", priced: { kind: "up-to", credits: 9 }, settled: { kind: "settling" }, state: "running", byYou: true })] },
    { id: "thread:ach_no", source: "thread", n: 2, title: "Continuity check", project, startedAt: t + 2, state: "stopped", reason: null, settled: 0, settling: false, request: "Continuity",
      open: { kind: "thread", chatId: "ach_no", productionId: "prod_fx" }, steps: [step({ title: "Check", state: "turned down", settled: { kind: "nothing" } })] },
  ],
};

test("projects, runs, the filter and a run's steps read as the ledger has them", async ({ page }, info) => {
  test.fixme(isCompact(info), NO_PHONE_SCREEN);
  test.setTimeout(180_000);
  await signInWithNewInterface(page.request);
  await page.route("**/api/control-room/activity**", (route) => route.fulfill({ json: FIXTURE }));
  const posts: string[] = [];
  page.on("request", (r) => { if (r.method() !== "GET" && /\/api\/(jobs|workbench|atomik|generate)/.test(r.url())) posts.push(r.url()); });
  await page.goto(PAGE);
  await expect(page.getByTestId("project-tile")).toHaveCount(2);
  await expect(page.getByTestId("project-tile").first()).toContainText("69 cr settled");
  const stats = page.getByTestId("run-stats");
  await expect(stats).toContainText("Running");
  await expect(stats).not.toContainText(/held/i);
  const rows = page.getByTestId("run-row");
  await expect(rows).toHaveCount(4);
  await expect(page.locator('[data-run="board:rar_done"]')).toContainText("66 cr settled");
  await expect(page.locator('[data-run="thread:ach_fly"]')).toContainText("3 cr settled · settling");
  await expect(page.locator('[data-run="thread:ach_no"]')).toContainText("nothing billed");
  await expect(page.locator('[data-run="thread:ach_wait"]').getByTestId("run-approvals")).toHaveText("Approvals ›");
  /* Nothing settled and nothing confirmed: no figure, never a guessed "nothing billed". */
  await expect(page.locator('[data-run="thread:ach_wait"]')).not.toContainText("nothing billed");
  await floors(page, info.project.use.isMobile === true);
  await shoot(page, info.project.name, "activity");

  /* The filter. */
  await page.getByTestId("runs-filter").getByRole("button", { name: "Needs you" }).click();
  await expect(rows).toHaveCount(1);
  await page.getByTestId("runs-filter").getByRole("button", { name: "Done" }).click();
  await expect(rows).toHaveCount(2);
  await page.getByTestId("runs-filter").getByRole("button", { name: "All" }).click();

  /* A run's steps: priced → settled, Auto marked, the thinking billed as its own line. */
  await page.locator('[data-run="board:rar_done"]').click();
  const inspector = page.getByTestId("run-inspector");
  await expect(inspector).toBeVisible();
  const steps = inspector.getByTestId("run-step");
  await expect(steps).toHaveCount(3);
  await expect(steps.nth(0)).toContainText("Atomik's thinking");
  await expect(steps.nth(1)).toContainText("approved by Teammate");
  await expect(steps.nth(1)).toContainText("43 cr → 43 cr settled");
  await expect(steps.nth(2)).toContainText("spent without asking");
  await floors(page, info.project.use.isMobile === true);
  await shoot(page, info.project.name, "activity-run-open");
  expect(posts).toEqual([]);
});
