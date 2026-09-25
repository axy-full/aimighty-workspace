import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";

/**
 * Suites › Workspace › Engines › Connected account: the one place in Suites
 * that connects, reconnects and disconnects the account, where the sign-in
 * callback lands, and where the owner sees (and can set aside) the jobs that
 * hold the workspace's four connected-account slots. Nothing here spends.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const fixture = (): Project => ({ ...newProject("Coastal light study"), id: "ws-connected", productionProjectId: "prod-ws", shotMappings: {} });
const minutesAgo = (m: number) => Date.now() - m * 60_000;
const stuck = { id: "11111111-1111-4111-8111-111111111111", draftId: "ws-connected", projectName: "Coastal light study", workflow: "generation", status: "uncertain", createdAt: minutesAgo(40), releasable: true };
const fresh = { id: "22222222-2222-4222-8222-222222222222", draftId: "ws-other", projectName: "Harbour spot", workflow: "marketing-video", status: "accepted", createdAt: minutesAgo(3), releasable: false };

async function open(page: Page, path: string) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, { uploads: [], generations: [] });
  await page.route("**/api/workspaces/keys", (route) => route.fulfill({ json: { keys: [] } }));
  await page.route("**/api/crew/status", (route) => route.fulfill({ json: { connected: false } }));
  const posts: unknown[] = [];
  await page.route("**/api/higgsfield/consumer/connection", (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as { action?: string; id?: string };
      posts.push(body);
      if (body.action === "set-aside") return route.fulfill({ json: { capacity: { limit: 4, active: 3, mine: [fresh] } } });
      return route.fulfill({ json: { probe: { reachable: true, balance: 1, unit: "credits" } } });
    }
    return route.fulfill({ json: { connected: true, requiresReconnect: false, capacity: { limit: 4, active: 4, mine: [stuck, fresh] } } });
  });
  let connects = 0;
  await page.route("**/api/higgsfield/consumer/connect", (route) => {
    connects++;
    return route.fulfill({ json: { url: "https://clerk.higgsfield.ai/oauth/authorize?client_id=fixture" } });
  });
  await page.route("https://clerk.higgsfield.ai/**", (route) => route.fulfill({ contentType: "text/html", body: "<p>sign-in fixture</p>" }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(path);
  return { errors, posts, connects: () => connects };
}

test("Engines connects the account, shows the owner's slot holders, sets a stuck one aside and warns before a reconnect", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, posts, connects } = await open(page, "/suites?view=workspace&tab=engines#higgsfield=connected");
  const card = page.getByTestId("engine-connected-account");
  await expect(card).toContainText("Connected");
  /* The sign-in callback's outcome is read once, then removed from the address. */
  await expect(page.getByTestId("connected-account-note")).toHaveText("Account connected.");
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("");
  expect(await page.evaluate(() => new URLSearchParams(location.search).get("tab"))).toBe("engines");

  await expect(page.getByTestId("connected-account-capacity")).toContainText("4 of 4 job slots in use");
  const rows = page.getByTestId("connected-account-job");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Generate · Coastal light study");
  await expect(rows.nth(0)).toContainText("unconfirmed");
  await expect(rows.nth(1)).toContainText("Marketing video · Harbour spot");
  /* Only a job past its grace period can be set aside. */
  await expect(rows.nth(1).getByRole("button", { name: "Set aside" })).toHaveCount(0);

  /* Phones: every control is a 44px target, and nothing scrolls sideways. */
  const coarse = (info.project.use.viewport?.width ?? 1440) < 900;
  for (const button of [page.getByTestId("connected-account-connect"), page.getByTestId("connected-account-disconnect"), rows.nth(0).getByRole("button", { name: "Set aside" })]) {
    await expect(button).toBeVisible();
    if (coarse) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

  await rows.nth(0).getByRole("button", { name: "Set aside" }).click();
  await expect(rows).toHaveCount(1);
  await expect(page.getByTestId("connected-account-capacity")).toContainText("3 of 4 job slots in use");
  expect(posts).toEqual([{ action: "set-aside", id: stuck.id }]);

  /* A reconnect while a job runs is confirmed once, and nothing is sent until it is. */
  await page.getByTestId("connected-account-connect").click();
  await expect(page.getByTestId("connected-account-warning")).toHaveText("1 of your jobs is still running. Sign back in with the same account to keep collecting it.");
  await expect(page.getByTestId("connected-account-connect")).toHaveText("Reconnect anyway");
  expect(connects()).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
  await page.getByTestId("connected-account-connect").click();
  await page.waitForURL(/^https:\/\/clerk\.higgsfield\.ai\/oauth\/authorize/);
  expect(connects()).toBe(1);
});
