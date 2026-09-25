import { test, expect, type Locator, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { smallTargets, smallText } from "./phoneFloors";
import { DESKTOP, PHONE, forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, upload } from "./helpers/workspaceFixtures";

/**
 * Error boundaries per panel (components/Boundary.tsx inside
 * components/graphite/SuitesShell.tsx), the Suites error page
 * (app/suites/error.tsx) and the 404 (app/not-found.tsx).
 *
 * Before: any throw in a stage body unmounted the whole /suites shell into
 * the generic root error page, and the 404 offered legacy destinations. Now a
 * panel that throws shows its own fault card inside its own frame and the rest
 * of the shell keeps working; a throw in the chrome lands on a page that keeps
 * the header; a link to nothing offers Studio, Takes and ⌘K search.
 *
 * Failures are injected with the development-only crash probes
 * (lib/shell/fault.ts › probeArmed): `window.__particlCrash = ["library"]`
 * makes the boundary named "library" throw on its next render. Nothing is
 * generated; paid routes fail the test.
 */

const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];

const fixture = (): Project => ({ ...newProject("Coastal light study"), id: "ws-faults", productionProjectId: "prod-ws", shotMappings: {} });

async function arm(page: Page, names: string[]) {
  await page.evaluate((list) => { (window as unknown as { __particlCrash?: string[] }).__particlCrash = list; }, names);
}

async function open(page: Page, path = "/suites", armed: string[] = []) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, {
    uploads: [upload({ id: "up_plate", filename: "harbour-plate.webp" })],
    generations: [
      generation({ id: "gen_wide", title: "Wide on the water", prompt: "Wide on the water" }),
      generation({ id: "gen_close", title: "Close on the rope", prompt: "Close on the rope" }),
    ],
  });
  /* Armed before the first render, so the boundary throws as the shell mounts. */
  if (armed.length) await page.addInitScript((list) => { (window as unknown as { __particlCrash?: string[] }).__particlCrash = list; }, armed);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(path);
  return errors;
}

async function noHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "no horizontal page scroll").toBe(true);
}

/* The 12px floor: the whole page on a phone; on a desktop the header's ⌘K keycap is the live shell's own 11px, so the page body is measured. */
async function floorText(page: Page, project: string) {
  return PHONE.includes(project) ? smallText(page) : smallText(page, ".gx-header");
}

async function refIsReadable(ref: Locator) {
  await expect(ref).toHaveText(/ref P-[0-9A-Z]{7}/);
  expect(Number.parseFloat(await ref.evaluate((el) => getComputedStyle(el).fontSize)), "the ref sits on the 12px floor").toBeGreaterThanOrEqual(12);
}

test("a stage that throws keeps the shell: its own card, the strip still moves, and Try again brings it back", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const errors = await open(page, "/suites", ["stage:brief"]);
  await expect(page.getByTestId("project-name")).toHaveText("Coastal light study");

  const fault = page.locator('[data-testid="panel-fault"][data-fault="stage:brief"]');
  await expect(fault).toBeVisible();
  await expect(fault).toContainText("Brief & Script stopped");
  await expect(fault.getByTestId("fault-retry")).toBeVisible();
  await expect(fault.getByTestId("fault-copy")).toHaveText("Copy details");
  await refIsReadable(fault.getByTestId("fault-ref"));

  /* The chrome is untouched: header, page title, strip. */
  await expect(page.getByRole("tablist", { name: "Suites" })).toBeVisible();
  await expect(page.getByTestId("page-title")).toHaveText("Brief & Script");
  const strip = page.getByRole("navigation", { name: "Pages" });
  if (PHONE.includes(info.project.name)) {
    expect(await smallText(page), "text under 12px").toEqual([]);
    expect(await smallTargets(page, '[data-testid="panel-fault"]'), "fault targets under 44×44").toEqual([]);
  }
  await noHorizontalScroll(page);

  /* Moving on is a fresh go; the next stage renders. */
  await strip.getByRole("button", { name: /Beats/ }).click();
  await expect(page.getByTestId("page-title")).toHaveText("Beats & Shots");
  await expect(page.getByTestId("panel-fault")).toHaveCount(0);

  /* Back on the broken stage, Try again while it still throws counts the attempt and offers Reload. */
  await strip.getByRole("button", { name: /Brief/ }).click();
  await expect(fault).toBeVisible();
  await fault.getByTestId("fault-retry").click();
  await expect(fault).toHaveAttribute("data-attempts", "1");
  await expect(fault.getByTestId("fault-reload")).toBeVisible();

  /* Fixed underneath: Try again renders the stage. */
  await arm(page, []);
  await fault.getByTestId("fault-retry").click();
  await expect(page.getByTestId("panel-fault")).toHaveCount(0);
  await expect(page.getByTestId("page-title")).toHaveText("Brief & Script");
  expect(errors, "a caught throw never reaches the window").toEqual([]);
});

test("desktop: the Library and the Inspector fail inside their own columns and the grid does not move", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "the three-column shell");
  const errors = await open(page, "/suites", ["library", "inspector"]);
  await expect(page.getByTestId("project-name")).toHaveText("Coastal light study");

  const body = page.getByTestId("shell-body");
  await expect(body).toHaveAttribute("data-columns", "280px minmax(0,1fr) 320px");
  const library = page.getByTestId("library");
  const inspector = page.getByTestId("inspector");
  await expect(library).toHaveAttribute("data-faulted", "true");
  await expect(inspector).toHaveAttribute("data-faulted", "true");
  expect(Math.round((await library.boundingBox())!.width)).toBe(280);
  expect(Math.round((await inspector.boundingBox())!.width)).toBe(320);
  await expect(library.getByTestId("panel-fault")).toContainText("The Library stopped");
  await expect(inspector.getByTestId("panel-fault")).toContainText("The Inspector stopped");
  await refIsReadable(library.getByTestId("fault-ref"));

  /* The stage between them works. */
  await expect(page.getByTestId("page-title")).toHaveText("Brief & Script");
  await expect(page.locator('[data-testid="content"] [data-testid="panel-fault"]')).toHaveCount(0);

  /* Copy details puts the ref on the clipboard. */
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await library.getByTestId("fault-copy").click();
  await expect(library.getByTestId("fault-copy")).toHaveText("Copied");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toMatch(/^Particl · The Library stopped\nref P-[0-9A-Z]{7}\nmessage Crash probe: library\nwhere \/suites/);

  /* Fixed underneath: Try again restores the Library; hiding and showing the Inspector gives it a fresh go. */
  await arm(page, []);
  await library.getByTestId("fault-retry").click();
  await expect(library).not.toHaveAttribute("data-faulted", "true");
  await expect(library.getByRole("tablist", { name: "Library view" })).toBeVisible();
  await inspector.getByTestId("close-inspector").click();
  await expect(page.getByTestId("inspector")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+j");
  await expect(page.getByTestId("inspector")).toBeVisible();
  await expect(page.getByTestId("inspector")).not.toHaveAttribute("data-faulted", "true");
  expect(errors).toEqual([]);
});

test("phones: a Library overlay that throws still closes, and its card meets the floors", async ({ page }, info) => {
  test.skip(!PHONE.includes(info.project.name), "the overlay panels");
  const errors = await open(page, "/suites", ["library"]);
  await expect(page.getByTestId("project-name")).toHaveText("Coastal light study");
  await page.getByTestId("toggle-library").click();
  const library = page.getByTestId("library");
  await expect(library).toHaveAttribute("data-faulted", "true");
  await expect(library.getByTestId("panel-fault")).toContainText("The Library stopped");
  expect(await smallText(page), "text under 12px").toEqual([]);
  expect(await smallTargets(page, '[data-testid="library"]'), "targets under 44×44").toEqual([]);
  const box = (await library.boundingBox())!;
  expect(box.x + box.width, "the overlay stays on screen").toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1);
  await library.getByTestId("close-library").click();
  await expect(page.getByTestId("library")).toHaveCount(0);
  await expect(page.getByTestId("page-title")).toHaveText("Brief & Script");
  await noHorizontalScroll(page);
  expect(errors).toEqual([]);
});

test("Gen: one bad take costs its tile, a failing results grid keeps the composer and its prompt", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const errors = await open(page, "/suites?view=gen");
  await expect(page.getByTestId("gen-view")).toBeVisible();
  await expect(page.getByTestId("project-name")).toHaveText("Coastal light study");
  const results = page.getByRole("region", { name: "Results" });
  await expect(results.getByText("Wide on the water")).toBeVisible();
  await page.getByTestId("gen-prompt").fill("a fox crossing a frozen harbour");

  /* One take throws: its tile keeps its place, the others render. */
  await arm(page, ["take:generation:gen_wide"]);
  await results.getByRole("button", { name: "Images", exact: true }).click();
  const tile = results.getByTestId("take-fault");
  await expect(tile).toHaveCount(1);
  await expect(tile).toContainText("Wide on the water");
  await expect(results.getByText("Close on the rope")).toBeVisible();

  /* The whole grid throws: the card replaces the grid, the composer and the prompt stay. */
  await arm(page, ["gen-results"]);
  await results.getByRole("button", { name: "All", exact: true }).click();
  const fault = page.locator('[data-testid="panel-fault"][data-fault="gen-results"]');
  await expect(fault).toContainText("Results stopped");
  await expect(page.getByTestId("gen-prompt")).toHaveValue("a fox crossing a frozen harbour");
  await expect(page.getByTestId("gen-generate")).toBeVisible();
  if (PHONE.includes(info.project.name)) expect(await smallTargets(page, '[data-fault="gen-results"]'), "targets under 44×44").toEqual([]);

  await arm(page, []);
  await fault.getByTestId("fault-retry").click();
  await expect(fault).toHaveCount(0);
  await expect(results.getByText("Wide on the water")).toBeVisible();
  await expect(results.getByTestId("take-fault")).toHaveCount(0);
  await noHorizontalScroll(page);
  expect(errors).toEqual([]);
});

test("the shell's own chrome throws: the Suites error page keeps the header, Try again and Back to Studio", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  await open(page, "/suites", ["shell"]);
  const screen = page.getByTestId("suites-error");
  await expect(screen).toBeVisible();
  await expect(screen.getByRole("heading", { name: "This screen stopped" })).toBeVisible();
  const suites = screen.getByRole("navigation", { name: "Suites" });
  await expect(suites.getByRole("link")).toHaveText(["Studio", "Gen", "Business", "Viral", "Atomik", "Crew"]);
  await expect(suites.getByRole("link", { name: "Business" })).toHaveAttribute("href", "/suites?suite=moleculr");
  await expect(screen.getByTestId("fault-studio")).toHaveAttribute("href", "/suites");
  await expect(screen.getByTestId("header-search")).toHaveAttribute("href", "/suites?find=1");
  await refIsReadable(screen.getByTestId("fault-ref"));
  expect(await floorText(page, info.project.name), "text under 12px").toEqual([]);
  if (PHONE.includes(info.project.name)) expect(await smallTargets(page, '[data-testid="suites-error"] main'), "targets under 44×44").toEqual([]);
  await noHorizontalScroll(page);

  /* Fixed underneath: Try again re-renders the shell in place. */
  await arm(page, []);
  await screen.getByTestId("fault-retry").click();
  await expect(page.getByTestId("project-name")).toHaveText("Coastal light study");
  await expect(page.getByTestId("suites-error")).toHaveCount(0);
});

test("a link to nothing: the 404 keeps the header and offers Studio, Takes and ⌘K search", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  await open(page, "/suites");
  await expect(page.getByTestId("project-name")).toHaveText("Coastal light study");

  const response = await page.goto("/productions/no-such-thing-here");
  expect(response?.status()).toBe(404);
  const screen = page.getByTestId("not-found");
  await expect(screen.getByRole("heading", { name: "Nothing here" })).toBeVisible();
  await expect(screen.getByTestId("missing-studio")).toHaveAttribute("href", "/suites");
  await expect(screen.getByTestId("missing-takes")).toHaveAttribute("href", "/suites?page=takes&sp=takes");
  await expect(screen.getByTestId("missing-search")).toHaveAttribute("href", "/suites?find=1");
  await expect(screen.getByText(/Go to Video|All takes/)).toHaveCount(0);
  expect(await floorText(page, info.project.name), "text under 12px").toEqual([]);
  if (PHONE.includes(info.project.name)) expect(await smallTargets(page, '[data-testid="not-found"] main'), "targets under 44×44").toEqual([]);
  await noHorizontalScroll(page);

  /* Search lands in the shell with ⌘K open, once: the URL drops the request. */
  await screen.getByTestId("missing-search").click();
  await expect(page.getByRole("dialog", { name: "Search" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Search" })).toBeFocused();
  await expect.poll(() => new URL(page.url()).searchParams.get("find")).toBeNull();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Search" })).toHaveCount(0);

  /* Open Takes lands on Takes. */
  await page.goto("/no-such-page");
  await page.getByTestId("missing-takes").click();
  await expect(page.getByTestId("page-title")).toHaveText("Takes");

  /* ⌘K on the 404 itself goes to search too (a keyboard is a desktop thing). */
  if (DESKTOP.includes(info.project.name)) {
    await page.goto("/no-such-page");
    await expect(page.locator('[data-testid="not-found"] header[data-keys="on"]')).toBeVisible();
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByRole("dialog", { name: "Search" })).toBeVisible();
  }
});
