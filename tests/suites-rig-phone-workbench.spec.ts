import { test, expect } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { forbidPaidWork, mockLibrary } from "./helpers/workspaceFixtures";







test("with no project open the Rig asks for one instead of loading forever", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one desktop");
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await page.route("**/api/workbench/projects**", (route) => route.fulfill({ json: { projects: [], productions: [], project: null, revision: 0, shared: null } }));
  await mockLibrary(page, { uploads: [], generations: [] });
  await page.goto("/workspace?suite=particl&page=rig");
  await expect(page.getByTestId("rig-list")).toContainText("Open or create a project to see its shots.");
  await expect(page.getByTestId("rig-list")).not.toContainText("Loading shots");
});

test("a shared link to a draft this person cannot open asks for a project instead of loading forever", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one desktop");
  await signInLocally(page.request);
  await forbidPaidWork(page);
  /* A new teammate with no projects of their own: the named draft is not theirs, so the route answers project: null. */
  const asked: string[] = [];
  await page.route("**/api/workbench/projects**", (route) => {
    asked.push(new URL(route.request().url()).searchParams.get("id") ?? "");
    return route.fulfill({ json: { projects: [], productions: [], project: null, revision: 0, shared: null } });
  });
  await mockLibrary(page, { uploads: [], generations: [] });
  await page.goto("/workspace?project=someone-elses-draft&suite=particl&page=rig");
  await expect.poll(() => asked.includes("someone-elses-draft")).toBe(true);
  await expect(page.getByTestId("rig-list")).toContainText("Open or create a project to see its shots.");
  await expect(page.getByTestId("rig-list")).not.toContainText("Loading shots");
});
