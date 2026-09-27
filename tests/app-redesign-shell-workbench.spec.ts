import { test, expect, type Page } from "@playwright/test";
import { newProject } from "../lib/workbench/studio";
import { signInLocally } from "./helpers/workbenchLocal";
import { forbidPaidWork, mockProjects, mockLibrary, mockMedia, upload } from "./helpers/workspaceFixtures";
test.setTimeout(45_000);

import { smallTargets } from "./phoneFloors";

async function setup(page: Page) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await page.route("**/api/workbench/development**", (route) => route.fulfill({ json: { models: [], jobs: [] } }));
  const project = { ...newProject("Coastal light study"), id: "redesign-project", productionProjectId: "prod-ws", shotMappings: {} };
  await mockProjects(page, { current: project, list: [{ id: project.id, name: project.name }, { id: "long", name: "A very long project name with international locations and a full production schedule to check wrapping" }] });
  await mockLibrary(page, { uploads: [upload({ id: "original", filename: "original-still.webp" })], generations: [] });
  const writes: unknown[] = [];
  await page.route("**/api/workbench/atomik**", async (route) => {
    if (route.request().method() !== "GET") writes.push(route.request().postDataJSON());
    return route.fulfill({ json: { configured: false, models: [], jobs: [] } });
  });
  await page.route("**/api/jobs?**", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get("mine") !== "1" || !params.get("status")) return route.fulfill({ json: { generations: [], nextPageCursor: null } });
    expect(params.get("sync")).toBe("0");
    expect(params.has("projectId")).toBe(false);
    const status = params.get("status");
    // The pill must include the second page, even though the current project has no generations.
    const second = params.has("cursor");
    return route.fulfill({ json: { generations: [{ id: `${status}-${second ? "2" : "1"}`, status }], nextPageCursor: status === "running" && !second ? "older" : null } });
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return { writes, errors };
}

async function fits(page: Page, selector: string) {
  await page.locator(selector).evaluateAll((nodes) => Promise.all(nodes.flatMap((el) => el.getAnimations({ subtree: true }).filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished))));
  const failures = await page.locator(selector).evaluateAll((nodes) => nodes.flatMap((node) => {
    const el = node as HTMLElement, box = el.getBoundingClientRect();
    if (!box.width || !box.height) return [];
    const why = [];
    if (el.matches('[role="dialog"], dialog, .gx-panel--overlay, .gx-ctx') && (box.top < -1 || box.bottom > innerHeight + 1)) why.push(`${el.className} outside viewport vertically ${box.top}:${box.bottom}`);
    if (box.left < -1 || box.right > innerWidth + 1) why.push(`${el.className} outside viewport ${box.left}:${box.right}`);
    if (el.scrollWidth > el.clientWidth + 1) why.push(`${el.className} overflows internally ${el.scrollWidth}:${el.clientWidth}`);
    return why;
  }));
  expect(failures).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test("Gen landing, live personal jobs, all shell panels and long names fit every viewport", async ({ page }, info) => {
  const { writes, errors } = await setup(page);
  await page.goto("/suites");
  await expect(page.getByTestId("page-title")).toHaveText("Generate");
  await expect(page.getByTestId("running-jobs")).toHaveText("3 rendering · 1 held");
  await expect(page.getByRole("navigation", { name: "Suites" }).getByRole("button")).toHaveText(["Gen", "Studio", "Business", "Viral", "Atomik", "Workspace"]);
  await fits(page, ".rd-topbar, .rd-frame, .rd-rail, .rd-canvas, .rd-dock, .rd-tools, .gx-stage");
  if (page.viewportSize()!.width < 900) expect(await smallTargets(page, ".rd-topbar, .rd-rail, .rd-tools, .rd-dock")).toEqual([]);
  else {
    expect(Math.round((await page.locator(".rd-rail").boundingBox())!.width)).toBe(76);
    expect(Math.round((await page.getByTestId("inspector").boundingBox())!.width)).toBe(300);
    expect(Math.round((await page.locator(".rd-topbar").boundingBox())!.height)).toBe(52);
  }
  await page.screenshot({ path: info.outputPath("shell-gen.png") });
  await page.getByTestId("project-switcher").click();
  await expect(page.getByRole("dialog", { name: "Projects" })).toBeVisible();
  await fits(page, ".rd-dialog, .rd-dialog-inner, .rd-project-option");
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByTestId("project-switcher")).toBeFocused();
  await page.getByTestId("all-assets").click();
  await expect(page.getByTestId("library")).toBeVisible();
  await page.getByTestId("library").evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished)));
  await fits(page, ".gx-library");
  await page.getByTestId("library").locator("[data-ctx^='asset:']").first().click({ button: "right" });
  await expect(page.getByTestId("context-menu")).toBeVisible();
  await fits(page, ".gx-ctx");
  await page.getByTestId("context-menu").getByRole("menuitem", { name: /^Copy/ }).click();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByRole("dialog", { name: "Search", exact: true })).toBeVisible();
  await fits(page, ".gx-palette, .gx-palette-list");
  await page.getByRole("dialog", { name: "Search", exact: true }).getByRole("textbox").fill("inspect");
  await page.keyboard.press("Escape");
  await page.getByTestId("close-library").click();
  await page.getByTestId("open-crew").click();
  await expect(page.getByRole("dialog", { name: "Crew", exact: true })).toBeVisible();
  await fits(page, ".rd-dialog, .rd-crew-grid, .rd-crew-card");
  await page.screenshot({ path: info.outputPath("shell-crew.png") });
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await page.getByTestId("header-search").click();
  await page.getByRole("dialog", { name: "Search", exact: true }).getByRole("textbox").fill("find a project with a long name");
  await fits(page, ".gx-palette, .gx-palette-list");
  await expect(page.getByRole("option").last()).toContainText("Ask Atomik");
  await page.keyboard.press("Escape");
  if (page.viewportSize()!.width < 1280) await page.locator(".rd-tools").getByRole("button", { name: "Inspector", exact: true }).click();
  await expect(page.getByTestId("provenance")).toBeVisible();
  await fits(page, ".gx-inspector, .rd-provenance");
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
});

test("Studio strips wrap, a dock plan opens without running, and Crew prefills the existing planner", async ({ page }, info) => {
  const { writes } = await setup(page);
  await page.goto("/suites?suite=particl&page=brief&sp=brief");
  const pages = page.getByRole("navigation", { name: "Pages" });
  await expect(pages.getByRole("button")).toHaveCount(8);
  await fits(page, ".gx-strip, .rd-dock, .gx-pagehead");
  await page.getByTestId("dock-plan").click();
  await expect(page.getByTestId("atomik-panel")).toBeVisible();
  await fits(page, ".gx-atomik");
  expect(writes).toEqual([]);
  await page.getByTestId("atomik-close").click();
  await page.getByTestId("open-crew").click();
  await page.getByRole("dialog").getByRole("button", { name: /Director/ }).click();
  await expect(page.getByTestId("page-title")).toHaveText("Agent");
  expect(writes).toEqual([]);
  await page.screenshot({ path: info.outputPath("shell-agent.png") });
});

test("the classic interface remains reachable behind its flag", async ({ page }) => {
  await setup(page);
  await page.goto("/suites?ui=classic");
  await expect(page.getByRole("tablist", { name: "Suites" })).toBeVisible();
  await expect(page.locator("[data-redesign]")).toHaveCount(0);
  await page.getByRole("tab", { name: "Gen", exact: true }).click();
  await expect(page).toHaveURL(/ui=classic/);
});


test("every suite keeps its content inside the shell and its dock above the screen edge", async ({ page }) => {
  await setup(page);
  await page.goto("/suites");
  const rail = page.getByRole("navigation", { name: "Suites" });
  for (const suite of ["Business", "Viral", "Atomik", "Workspace", "Studio", "Gen"]) {
    await rail.getByRole("button", { name: suite, exact: true }).click();
    await expect(rail.getByRole("button", { name: suite, exact: true })).toHaveAttribute("aria-current", "page");
    await fits(page, ".rd-topbar, .rd-rail, .rd-tools, .rd-canvas, .gx-pagehead, .gx-strip, .gx-stage, .gx-workspace, .gx-workspace .gx-seg, .rd-dock");
    const dock = await page.getByTestId("atomik-dock").count() ? await page.getByTestId("atomik-dock").boundingBox() : null;
    if (dock) expect(dock.y + dock.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  }
});
