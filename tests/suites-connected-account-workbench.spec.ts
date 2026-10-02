import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";

/**
 * Suites › Workspace › Engines, after the Higgsfield sign-in was removed
 * (CLAUDE.md ground rule 10). The retired account row (its running jobs, Set
 * aside and Disconnect) went with the account's server code: Engines lists
 * Particl's engines and API keys only, reads no account route and starts no
 * sign-in, for the owner too. A sign-in link from before the retirement opens
 * the same page. Nothing here spends.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const fixture = (): Project => ({ ...newProject("Coastal light study"), id: "ws-connected", productionProjectId: "prod-ws", shotMappings: {} });

async function open(page: Page, path: string) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, { uploads: [], generations: [] });
  await page.route("**/api/workspaces/keys", (route) => route.fulfill({ json: { keys: [] } }));
  await page.route("**/api/crew/status", (route) => route.fulfill({ json: { connected: false } }));
  /* Every request to the account's old routes or its sign-in host is recorded: none may be made. */
  const asked: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/higgsfield/consumer/") || url.hostname.endsWith("higgsfield.ai")) asked.push(`${request.method()} ${url.hostname}${url.pathname}`);
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(path);
  return { errors, asked };
}

test("Engines has no Higgsfield account row: no running jobs, Set aside or Disconnect, nothing read from the account, and it fits", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, asked } = await open(page, "/suites?view=workspace&tab=engines");
  await expect(page.getByTestId("ws-engines")).toBeVisible();
  for (const id of ["engine-connected-account", "connected-account-retired", "connected-account-capacity", "connected-account-disconnect", "connected-account-connect", "engine-developer-api"])
    await expect(page.getByTestId(id), id).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^(Connect|Reconnect) (the )?(Higgsfield )?account|Disconnect|Set aside/ })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  /* Give a late read the chance to show itself before saying none was made. */
  await page.waitForTimeout(500);
  expect(asked).toEqual([]);
  expect(errors).toEqual([]);
});

test("a sign-in link from before the retirement opens Engines as it is now: no account row, no request, and the link's mark is dropped", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  const { errors, asked } = await open(page, "/suites?view=workspace&tab=engines&higgsfield=retired");
  await expect(page.getByTestId("ws-engines")).toBeVisible();
  await expect(page.getByTestId("engine-connected-account")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => new URLSearchParams(location.search).get("higgsfield"))).toBeNull();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(asked).toEqual([]);
  expect(errors).toEqual([]);
});
