import { test, expect, type Page } from "@playwright/test";
import { signInWithNewInterface } from "./helpers/newInterface";
import { newProject, type Project } from "../lib/workbench/studio";
import type { QueueItem } from "../lib/control-room/queue";
import type { ActivityReply, ActivityRun } from "../lib/control-room/activity";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";
import { dimLabels, lastRowClearsPinned, smallTargets, smallText } from "./phoneFloors";
import { CHECK_LINE, SAMPLE_LINE } from "../lib/demo/sample";

/**
 * Stream 10, PR 4: the Record on the phone (design/particl-graphite/README.md § 3.6, frame E1), behind the
 * new-interface switch: spend against the budget, the brief, what each of Atomik's runs was quoted and settled at,
 * and the decisions still open. It reads the activity and approvals of the control room (served here) and the
 * production's own cap. It changes and spends nothing; the 80% pause is not built, so the bar says nothing pauses.
 */
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const PORTRAIT = ["workbench-360x640", "workbench-390x844"];
const SHOTS = process.env.S10_SHOTS;
const shot = async (page: Page, project: string, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${project.replace("workbench-", "")}-${name}.png` }); };

const project = (): Project => ({
  ...newProject("Harbour at dusk"), id: "ws-rec", productionProjectId: "prod-rec", shotMappings: {},
  brief: "A fox crosses a frozen harbour at dusk. Low light, long shadows; the camera holds while it moves.", aspect: "16:9", fps: 24,
} as Project);
const NOW = Date.now();
const ref = { productionId: "prod-rec", draftId: "ws-rec", name: "Harbour at dusk" };
const paid = (id: string, title: string, credits: number, state: "done" | "waiting") => ({
  id, kind: "paid" as const, title, priced: { kind: "exact" as const, credits }, settled: state === "done" ? { kind: "settled" as const, credits } : { kind: "settling" as const },
  state, by: state === "done" ? "Sam" : null, byYou: state === "done", auto: false, at: NOW - 3_600_000,
});
const RUNS: ActivityRun[] = [
  { id: "board:r1", source: "board", n: 1, title: "Make 2 shots", project: ref, startedAt: NOW - 7_200_000, state: "done", reason: null,
    steps: [paid("s1", "Opening", 43, "done"), paid("s2", "Close", 7, "done")], settled: 50, settling: false, request: "", open: { kind: "board", productionId: "prod-rec", draftId: "ws-rec" } },
  { id: "board:r2", source: "board", n: 2, title: "Plan the next takes", project: ref, startedAt: NOW - 600_000, state: "needs-you", reason: null,
    steps: [paid("s3", "The turn", 43, "waiting")], settled: 0, settling: false, request: "", open: { kind: "board", productionId: "prod-rec", draftId: "ws-rec" } },
];
const ACTIVITY: ActivityReply = { inCredits: true, productionId: "prod-rec", projects: [{ project: ref, settled: 50 }], runs: RUNS };
const PLAN_ITEM: QueueItem = {
  id: "board-plan:r2", source: "board-plan", where: "Board", title: "Plan the next takes", at: NOW - 600_000, project: ref, price: { kind: "exact", credits: 66 },
  needsAdmin: false, canApprove: true, why: null, shortBy: null, note: null, step: null, sample: false,
  approve: { kind: "board-approve", productionId: "prod-rec", runId: "rar_aaaaaaaaaaaaaaaaaaaaaaaa", fingerprint: "a".repeat(64) }, decline: null,
  open: { kind: "board", productionId: "prod-rec", draftId: "ws-rec" },
};

async function open(page: Page, cap: number | null, path = "/suites?screen=record") {
  const seen: { paid: string[]; errors: string[] } = { paid: [], errors: [] };
  await signInWithNewInterface(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: project() });
  await mockLibrary(page, { uploads: [], generations: [generation({ id: "gen_r1", title: "The approach", prompt: "The approach", shotId: "shot_a", shotCode: "SH02", version: 2, createdAt: 1_000 })] });
  await page.route("**/api/control-room/approvals", (route) => route.fulfill({ json: { items: [PLAN_ITEM], decided: [], inCredits: true } }));
  await page.route(/\/api\/control-room\/activity/, (route) => route.fulfill({ json: ACTIVITY }));
  await page.route(/\/api\/productions$/, (route) => route.fulfill({ json: { productions: [{ id: "p1", projects: [{ id: "prod-rec", capCredits: cap, spentCredits: 64 }] }] } }));
  await page.route(/\/api\/jobs\?view=tray/, (route) => route.fulfill({ json: { jobs: [], pollAfterSeconds: 60 } }));
  page.on("request", (request) => { if (request.method() !== "GET" && /\/api\/(generate|workbench\/team-canvas|pipelines|atomik|jobs)/.test(request.url())) seen.paid.push(request.method() + " " + request.url()); });
  page.on("pageerror", (error) => seen.errors.push(error.message));
  await page.goto(path);
  await expect(page.getByTestId("phone-record")).toBeVisible();
  return seen;
}

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
async function floors(page: Page, where: string) {
  expect(await smallText(page), `${where}: text under 12px`).toEqual([]);
  expect(await smallTargets(page, ".ph-app"), `${where}: targets under 44×44`).toEqual([]);
  expect(await dimLabels(page, ".ph-app"), `${where}: labels under the floor`).toEqual([]);
  expect(await noOverflow(page), `${where}: sideways overflow`).toBe(true);
}

test("Record: the budget, the brief, the runs quoted and settled, and the open decisions", async ({ page }, info) => {
  test.skip(!PHONES.includes(info.project.name), "phone widths");
  const seen = await open(page, 200);
  await expect(page.getByTestId("phone-title")).toHaveText("Harbour at dusk");
  const spend = page.getByTestId("phone-record-spend");
  await expect(spend).toContainText("64 cr");
  await expect(spend).toContainText("of 200 cr");
  await expect(spend).toContainText("80% of the budget is 160 cr. Nothing pauses there.");
  await expect(page.getByTestId("phone-record-brief")).toContainText("A fox crosses a frozen harbour");
  await expect(page.getByTestId("phone-record-spec")).toHaveText("16:9 · 24 fps");
  const rows = page.getByTestId("phone-record-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Make 2 shots");
  await expect(rows.nth(0)).toContainText("Approved by you");
  await expect(rows.nth(0)).toContainText("50 cr settled");
  await expect(rows.nth(0)).toContainText("quoted 50 cr");
  await expect(rows.nth(1)).toContainText("Waiting for you · Run 02");
  await expect(rows.nth(1)).toContainText("waiting");
  await expect(rows.nth(1)).toContainText("quoted 43 cr");
  await expect(page.getByTestId("phone-record-decision")).toContainText("Plan the next takes · 66 cr");
  await expect(page.getByTestId("phone-record-review")).toContainText("Shot 2 · v2");
  /* The Record is the Record tab's, with the tabs under it. */
  await expect(page.getByTestId("phone-tab-record")).toHaveAttribute("aria-current", "page");
  await floors(page, "Record");
  await shot(page, info.project.name, "record");
  expect(await lastRowClearsPinned(page), "Record: the last row clears the tabs").toEqual([]);
  await shot(page, info.project.name, "record-scrolled");
  expect(seen.paid).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test("Record: no budget set says so and draws no bar; Open goes to the plan, Review to the review", async ({ page }, info) => {
  test.skip(!PORTRAIT.includes(info.project.name), "portrait phones");
  await open(page, null);
  await expect(page.getByTestId("phone-record-spend")).toContainText("No budget set");
  await expect(page.getByRole("progressbar", { name: "Spend against the budget" })).toHaveCount(0);
  await page.getByTestId("phone-record-open").click();
  await expect(page).toHaveURL(/screen=plan/);
  await expect(page.getByTestId("phone-title")).toHaveText("Plan approval");
  await page.goBack();
  await page.getByTestId("phone-record-review").getByRole("button", { name: "Review" }).click();
  await expect(page).toHaveURL(/screen=review/);
});

test("the board's address opens that project's Record on a phone, and a project card opens it too", async ({ page }, info) => {
  test.skip(!PORTRAIT.includes(info.project.name), "portrait phones");
  await open(page, 200, "/suites?view=board&project=ws-rec");
  await expect(page.getByTestId("phone-tab-record")).toHaveAttribute("aria-current", "page");
  await page.getByTestId("phone-tab-home").click();
  await page.getByTestId("phone-project").first().click();
  await expect(page.getByTestId("phone-record")).toBeVisible();
});

test("device=phone frames the Record at 390 px on a desktop, with no overflow", async ({ page }, info) => {
  test.skip(PHONES.includes(info.project.name), "desktop widths");
  await open(page, 200, "/suites?device=phone&screen=record");
  const frame = (await page.getByTestId("phone-app").boundingBox())!;
  expect(Math.round(frame.width)).toBe(390);
  await floors(page, "Framed Record");
  await shot(page, info.project.name, "framed-record");
});

/** The sample workspace spends nothing, and a workspace whose check failed is held back the same way (it says so in its own words). */
for (const [mode, line] of [["sample", SAMPLE_LINE], ["failed", CHECK_LINE]] as const) {
  test(`Record in ${mode === "sample" ? "the sample workspace" : "a workspace that could not be checked"}: the decision is shown with no price and no way into a priced Approve`, async ({ page }, info) => {
    test.skip(!PORTRAIT.includes(info.project.name), "portrait phones");
    await page.route("**/api/demo/sample", (route) => route.request().method() !== "GET" ? route.fallback()
      : mode === "failed" ? route.fulfill({ status: 500, json: { error: "unavailable" } }) : route.fulfill({ json: { board: null, sampleWorkspace: true } }));
    const seen = await open(page, 200);
    const decision = page.getByTestId("phone-record-decision");
    await expect(decision).toContainText("Plan the next takes");
    await expect(decision).toContainText(line);
    await expect(decision).not.toContainText(/\d+ cr/);
    await expect(page.getByTestId("phone-record-open")).toHaveCount(0);
    await expect(decision.getByTestId("sample-check-retry")).toHaveCount(mode === "failed" ? 1 : 0);
    expect(seen.paid).toEqual([]);
  });
}
