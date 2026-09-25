import { test, expect } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, mockMedia } from "./helpers/workspaceFixtures";

/**
 * A failed read is said, with Retry — never "No project" (which sent people
 * to make duplicates) or "Reading this project…" forever. The project list
 * and the project's library both answer 500 once, then recover on Retry.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const fixture = (): Project => ({ ...newProject("Coastal light study"), id: "ws-errors", productionProjectId: "prod-errors", shotMappings: {} });

test("the project list and the library say they failed and recover on Retry", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  const project = fixture();
  let projectsFail = true;
  let libraryFail = true;
  await page.route("**/api/workbench/projects**", (route) => {
    if (route.request().method() !== "GET") return route.fulfill({ status: 400, json: { error: "Unexpected write in a read test." } });
    if (projectsFail) return route.fulfill({ status: 500, json: { error: "Projects are unavailable right now." } });
    return route.fulfill({ json: { projects: [{ id: project.id, name: project.name, revision: 1, updatedAt: "2026-09-18T10:00:00Z" }], productions: [], project, revision: 1, shared: null } });
  });
  await page.route("**/api/workbench/library**", (route) => {
    if (libraryFail) return route.fulfill({ status: 500, json: { error: "The library is unavailable right now." } });
    const source = new URL(route.request().url()).searchParams.get("source") === "uploads" ? "uploads" : "generations";
    return route.fulfill({ json: source === "uploads" ? { uploads: [], nextCursor: null } : { generations: [], nextPageCursor: null } });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/suites?suite=studio&page=brief&sp=brief");
  await expect(page.getByTestId("project-name")).toHaveText("Projects didn’t load");
  await expect(page.getByTestId("projects-error")).toContainText("Projects are unavailable right now.");
  await expect(page.getByTestId("brief-no-project")).toHaveCount(0);
  projectsFail = false;
  await page.getByTestId("projects-retry").click();
  await expect(page.getByTestId("project-name")).toHaveText(project.name);
  await expect(page.getByTestId("projects-error")).toHaveCount(0);

  /* The library answered 500 for this project: said in the Library, with Retry. */
  if (!(await page.getByTestId("library").isVisible())) await page.getByTestId("toggle-library").click();
  await page.getByTestId("library").getByRole("tab", { name: /Assets/ }).click();
  await expect(page.getByTestId("library-error")).toContainText("The library is unavailable right now.");
  libraryFail = false;
  await page.getByTestId("library-error").getByRole("button", { name: "Retry" }).click();
  await expect(page.getByTestId("library-error")).toHaveCount(0);
  await expect(page.getByTestId("library")).toContainText("Nothing made or uploaded in this project yet.");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("Crew says the project list failed, with Retry, instead of 'No project'", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  const project = fixture();
  let projectsFail = true;
  await page.route("**/api/workbench/projects**", (route) => {
    if (route.request().method() !== "GET") return route.fulfill({ status: 400, json: { error: "Unexpected write in a read test." } });
    if (projectsFail) return route.fulfill({ status: 500, json: { error: "Projects are unavailable right now." } });
    return route.fulfill({ json: { projects: [{ id: project.id, name: project.name, revision: 1, updatedAt: "2026-09-18T10:00:00Z" }], productions: [], project, revision: 1, shared: null } });
  });
  await page.route("**/api/workbench/library**", (route) => {
    const source = new URL(route.request().url()).searchParams.get("source") === "uploads" ? "uploads" : "generations";
    return route.fulfill({ json: source === "uploads" ? { uploads: [], nextCursor: null } : { generations: [], nextPageCursor: null } });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/suites?view=crew");
  await expect(page.getByTestId("crew-view")).toBeVisible();
  const alert = page.getByTestId("crew-projects-error");
  await expect(alert).toContainText("Projects are unavailable right now.");
  await expect(page.getByTestId("crew-view")).not.toContainText("No project");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  projectsFail = false;
  await alert.getByRole("button", { name: "Retry" }).click();
  await expect(alert).toHaveCount(0);
  await expect(page.getByTestId("crew-view")).toContainText(project.name);
  expect(errors).toEqual([]);
});
