import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";

/**
 * Suites › Workspace › Engines › Higgsfield account, since the sign-in was
 * retired (lib/higgsfield-consumer/retired.ts). Nothing connects or
 * reconnects here. While Particl still holds the owner's grant the row says
 * the sign-in is retired, lists the jobs still holding the workspace's four
 * slots (a stuck one can be set aside) and offers Disconnect, which is asked
 * for twice while a job still runs. With no grant and nothing running the row
 * is not there. A sign-in started before the retirement comes back here and
 * says so. Nothing here spends.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const fixture = (): Project => ({ ...newProject("Coastal light study"), id: "ws-connected", productionProjectId: "prod-ws", shotMappings: {} });
const minutesAgo = (m: number) => Date.now() - m * 60_000;
const stuck = { id: "11111111-1111-4111-8111-111111111111", draftId: "ws-connected", projectName: "Coastal light study", workflow: "generation", status: "uncertain", createdAt: minutesAgo(40), releasable: true };
const fresh = { id: "22222222-2222-4222-8222-222222222222", draftId: "ws-other", projectName: "Harbour spot", workflow: "marketing-video", status: "accepted", createdAt: minutesAgo(3), releasable: false };
const RETIRED = "Particl no longer signs in to Higgsfield. Past results stay in your Library.";

async function open(page: Page, path: string, connection: Record<string, unknown> = { connected: true, requiresReconnect: false, capacity: { limit: 4, active: 4, mine: [stuck, fresh] } }) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, { uploads: [], generations: [] });
  await page.route("**/api/workspaces/keys", (route) => route.fulfill({ json: { keys: [] } }));
  await page.route("**/api/crew/status", (route) => route.fulfill({ json: { connected: false } }));
  const posts: unknown[] = [];
  let state = { ...connection };
  let disconnects = 0;
  await page.route("**/api/higgsfield/consumer/connection", (route) => {
    const method = route.request().method();
    if (method === "POST") {
      const body = route.request().postDataJSON() as { action?: string; id?: string };
      posts.push(body);
      if (body.action === "set-aside") return route.fulfill({ json: { capacity: { limit: 4, active: 3, mine: [fresh] } } });
      return route.fulfill({ status: 410, json: { code: "retired", error: RETIRED } });
    }
    if (method === "DELETE") {
      disconnects++;
      state = { connected: false, requiresReconnect: false, capacity: { limit: 4, active: 1, mine: [fresh] } };
      return route.fulfill({ json: { connected: false, requiresReconnect: false } });
    }
    return route.fulfill({ json: state });
  });
  const started: string[] = [];
  await page.route("**/api/higgsfield/consumer/connect", (route) => { started.push(route.request().url()); return route.fulfill({ status: 410, json: { code: "retired", error: RETIRED } }); });
  await page.route("https://clerk.higgsfield.ai/**", (route) => { started.push(route.request().url()); return route.fulfill({ contentType: "text/html", body: "<p>sign-in fixture</p>" }); });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(path);
  return { errors, posts, started, disconnects: () => disconnects };
}

test("Engines: a grant still held says the sign-in is retired, lists the running jobs, sets a stuck one aside and disconnects — asked twice while a job runs; nothing connects", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, posts, started, disconnects } = await open(page, "/suites?view=workspace&tab=engines");
  const card = page.getByTestId("engine-connected-account");
  await expect(card).toContainText("Higgsfield account");
  await expect(card).toContainText("Sign-in retired");
  await expect(page.getByTestId("connected-account-retired")).toHaveText(`${RETIRED} Jobs already running are still collected; disconnect once none are left.`);
  /* No way to connect or reconnect, and no developer-API check. */
  await expect(card.getByRole("button", { name: /Connect|Reconnect/ })).toHaveCount(0);
  await expect(page.getByTestId("connected-account-connect")).toHaveCount(0);
  await expect(page.getByTestId("engine-developer-api")).toHaveCount(0);

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
  for (const button of [page.getByTestId("connected-account-disconnect"), rows.nth(0).getByRole("button", { name: "Set aside" })]) {
    await expect(button).toBeVisible();
    if (coarse) expect(Math.round((await button.boundingBox())!.height * 100) / 100).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

  await rows.nth(0).getByRole("button", { name: "Set aside" }).click();
  await expect(rows).toHaveCount(1);
  await expect(page.getByTestId("connected-account-capacity")).toContainText("3 of 4 job slots in use");
  expect(posts).toEqual([{ action: "set-aside", id: stuck.id }]);

  /* A disconnect while a job runs is confirmed once, and nothing is sent until it is. */
  await page.getByTestId("connected-account-disconnect").click();
  await expect(page.getByTestId("connected-account-warning")).toHaveText("1 of your jobs is still running and can’t be collected after a disconnect.");
  await expect(page.getByTestId("connected-account-disconnect")).toHaveText("Disconnect anyway");
  expect(disconnects()).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.getByTestId("connected-account-disconnect").click();
  await expect(page.getByTestId("connected-account-note")).toHaveText("Account disconnected. Particl no longer holds access to it.");
  expect(disconnects()).toBe(1);
  /* The grant is gone: no Disconnect, and the job still listed can still be seen. */
  await expect(page.getByTestId("connected-account-disconnect")).toHaveCount(0);
  await expect(page.getByTestId("connected-account-retired")).toHaveText(RETIRED);
  expect(started).toEqual([]);
  expect(errors).toEqual([]);
});

test("Engines: with no grant and nothing running the row is not there; a sign-in that returns says the sign-in is retired; a failed read says so with Try again", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  const idle = { connected: false, requiresReconnect: false, capacity: { limit: 4, active: 0, mine: [] } };
  const first = await open(page, "/suites?view=workspace&tab=engines", idle);
  await expect(page.getByTestId("ws-engines")).toBeVisible();
  await expect(page.getByTestId("engine-connected-account")).toHaveCount(0);
  await expect(page.getByTestId("engine-developer-api")).toHaveCount(0);

  /* The callback of a sign-in started before the retirement lands here with `?higgsfield=retired`. */
  await page.goto("/suites?view=workspace&tab=engines&higgsfield=retired");
  await expect(page.getByTestId("engine-connected-account")).toBeVisible();
  await expect(page.getByTestId("connected-account-retired")).toHaveText(RETIRED);
  await expect(page.getByTestId("connected-account-disconnect")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => new URLSearchParams(location.search).get("higgsfield"))).toBeNull();

  /* A status read that fails is said with Try again, which reads once more. */
  let reads = 0;
  await page.unroute("**/api/higgsfield/consumer/connection");
  await page.route("**/api/higgsfield/consumer/connection", (route) => {
    reads++;
    return reads === 1 ? route.fulfill({ status: 503, json: { error: "The connected account is temporarily unavailable." } }) : route.fulfill({ json: { connected: true, requiresReconnect: true, capacity: { limit: 4, active: 0, mine: [] } } });
  });
  await page.goto("/suites?view=workspace&tab=engines");
  await expect(page.getByTestId("engine-connected-account")).toContainText("The connected account is temporarily unavailable.");
  await page.getByTestId("connected-account-retry").click();
  /* A grant that needs signing in again is still Particl's to revoke. */
  await expect(page.getByTestId("connected-account-disconnect")).toBeVisible();
  expect(reads).toBe(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(first.started).toEqual([]);
  expect(first.errors).toEqual([]);
});
