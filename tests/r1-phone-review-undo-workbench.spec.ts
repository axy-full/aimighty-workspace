import { test, expect, type Page } from "@playwright/test";
import { signInWithNewInterface } from "./helpers/newInterface";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";

/**
 * Phone review: judging the LAST take waiting keeps its approval toast, with Undo, for the toast's whole time
 * (the end-of-review line used to replace it after ~260 ms). Undo puts the take back into the review. Approving is free.
 */
const PORTRAIT = ["workbench-360x640", "workbench-390x844"];
const project = (): Project => ({ ...newProject("Harbour at dusk"), id: "ws-phone", productionProjectId: "prod-ws", shotMappings: {}, brief: "A fox crosses a frozen harbour at dusk" } as Project);
const take = (id: string, shot: string, at: number) => generation({ id, title: shot, prompt: shot, shotId: `shot_${id}`, shotCode: shot, version: 1, createdAt: at, params: { ratio: "16:9" }, creditsBilled: 3 });

async function open(page: Page, ids: string[]) {
  const reviews: { id: string; state: string }[] = [];
  const paid: string[] = [];
  await signInWithNewInterface(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: project() });
  await mockLibrary(page, { uploads: [], generations: ids.map((id, i) => take(id, `SH0${i + 1}`, 1_000 * (i + 1))) });
  await page.route("**/api/control-room/approvals", (route) => route.fulfill({ json: { items: [], decided: [], inCredits: true } }));
  await page.route(/\/api\/jobs\?view=tray/, (route) => route.fulfill({ json: { jobs: [], pollAfterSeconds: 60 } }));
  await page.route(/\/api\/jobs\/[A-Za-z0-9_-]+$/, async (route) => {
    const request = route.request();
    if (request.method() !== "PATCH") return route.fallback();
    const state = String((request.postDataJSON() as { reviewState?: unknown }).reviewState ?? "");
    reviews.push({ id: new URL(request.url()).pathname.split("/")[3], state });
    return route.fulfill({ json: { review: { reviewState: state } } });
  });
  page.on("request", (r) => { if (r.method() !== "GET" && /\/api\/(generate|workbench\/team-canvas|pipelines|atomik)/.test(r.url())) paid.push(r.url()); });
  await page.goto("/suites?screen=review");
  await expect(page.getByTestId("phone-review")).toBeVisible({ timeout: 60_000 });
  return { reviews, paid };
}

test("phone review: the only take waiting is approved, its Undo stays up for 3 s and puts it back", async ({ page }, info) => {
  test.skip(!PORTRAIT.includes(info.project.name), "portrait phones");
  const seen = await open(page, ["gen_only"]);
  await expect(page.getByTestId("phone-review-title")).toHaveText("Shot 1 · v1");
  await page.getByTestId("phone-approve").click();
  const toast = page.getByTestId("toast");
  await expect(toast).toContainText("approved · nothing spent");
  const undo = page.getByTestId("toast-undo");
  await expect(undo).toBeVisible();
  await page.waitForTimeout(3_000);
  await expect(toast).toContainText("approved · nothing spent");
  await expect(undo).toBeVisible();
  await undo.click();
  await expect(page.getByTestId("phone-review-title")).toHaveText("Shot 1 · v1");
  expect(seen.reviews).toEqual([{ id: "gen_only", state: "approved" }, { id: "gen_only", state: "" }]);
  /* Back in the review, and it does not leave afterwards. */
  await page.waitForTimeout(6_500);
  await expect(page.getByTestId("phone-review")).toBeVisible();
  await expect(page.getByTestId("phone-review-title")).toHaveText("Shot 1 · v1");
  expect(seen.paid).toEqual([]);
});

test("phone review: with two takes, approving the last still keeps Undo, and Undo restores it", async ({ page }, info) => {
  test.skip(!PORTRAIT.includes(info.project.name), "portrait phones");
  const seen = await open(page, ["gen_one", "gen_two"]);
  await page.getByTestId("phone-approve").click();
  await expect(page.getByTestId("phone-review-title")).toHaveText("Shot 2 · v1");
  await page.getByTestId("phone-approve").click();
  await expect(page.getByTestId("toast")).toContainText("Shot 2 · v1 approved · nothing spent");
  await page.waitForTimeout(3_000);
  await expect(page.getByTestId("toast")).toContainText("Shot 2 · v1 approved · nothing spent");
  await page.getByTestId("toast-undo").click();
  await expect(page.getByTestId("phone-review-title")).toHaveText("Shot 2 · v1");
  expect(seen.reviews.at(-1)).toEqual({ id: "gen_two", state: "" });
  expect(seen.paid).toEqual([]);
});

test("phone review: left alone after the last take, the review ends once the Undo time has run out", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-390x844", "one size is enough");
  await open(page, ["gen_only"]);
  await page.getByTestId("phone-approve").click();
  await expect(page.getByTestId("toast-undo")).toBeVisible();
  await expect(page.getByTestId("phone-home")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("toast")).toContainText("Every take here is judged");
});
