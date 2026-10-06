import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";

/**
 * Suites › Workspace › Engines and Settings › Connections, with the Higgsfield
 * sign-in off for Release 1 (lib/higgsfield-consumer/retired.ts › SIGN_IN_OFF).
 * Even where the connection route (mocked here) would answer that a grant is
 * held and jobs are running, there is no connected-account row: nothing to
 * connect, reconnect, set aside or disconnect, and the route is never asked.
 * Nothing here spends.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const fixture = (): Project => ({ ...newProject("Coastal light study"), id: "ws-connected", productionProjectId: "prod-ws", shotMappings: {} });
const minutesAgo = (m: number) => Date.now() - m * 60_000;
const stuck = { id: "11111111-1111-4111-8111-111111111111", draftId: "ws-connected", projectName: "Coastal light study", workflow: "generation", status: "uncertain", createdAt: minutesAgo(40), releasable: true };
const fresh = { id: "22222222-2222-4222-8222-222222222222", draftId: "ws-other", projectName: "Harbour spot", workflow: "marketing-video", status: "accepted", createdAt: minutesAgo(3), releasable: false };
const RETIRED = "The connected account is no longer used. Past results stay in your Library.";

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
  let disconnects = 0, reads = 0;
  await page.route("**/api/higgsfield/consumer/connection", (route) => {
    const method = route.request().method();
    reads++;
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
  return { errors, posts, started, disconnects: () => disconnects, reads: () => reads };
}

test("Engines and Settings › Connections: no connected-account row even while a grant and running jobs would be held; the route is never asked", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, posts, started, disconnects, reads } = await open(page, "/suites?view=workspace&tab=engines");
  /* Engines is Settings › Advanced with the new interface on, or the Workspace tab with it off: either way, no row. */
  await expect(page.getByTestId("settings-view").or(page.getByTestId("workspace-view")).first()).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(page.getByTestId("engine-connected-account")).toHaveCount(0);
  await page.goto("/suites?view=workspace&tab=connections");
  await expect(page.getByTestId("settings-publishing")).toBeVisible();
  await expect(page.getByTestId("settings-earlier-account")).toHaveCount(0);
  await expect(page.getByTestId("engine-connected-account")).toHaveCount(0);
  for (const id of ["connected-account-connect", "connected-account-disconnect", "connected-account-capacity", "connected-account-job"])
    await expect(page.getByTestId(id), id).toHaveCount(0);
  await expect(page.getByText(/Connect Higgsfield|connected account|Sign-in retired/i)).toHaveCount(0);
  expect(reads()).toBe(0);
  expect(posts).toEqual([]);
  expect(disconnects()).toBe(0);
  expect(started).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
