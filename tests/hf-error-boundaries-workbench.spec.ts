import { test, expect, type Locator, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { smallTargets, smallText } from "./phoneFloors";
import { DESKTOP, PHONE, forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, upload } from "./helpers/workspaceFixtures";
import { closeSuitesMenu, goViaSearch, openSuitesMenu } from "./helpers/suitesMenu";

/**
 * Error boundaries per panel (components/Boundary.tsx — Next's catchError —
 * inside components/graphite/SuitesShell.tsx), the Suites error page
 * (app/suites/error.tsx) and the 404 (app/not-found.tsx).
 *
 * Before: any throw in a stage body unmounted the whole /suites shell into
 * the generic root error page, and the 404 offered legacy destinations. Now a
 * panel that throws shows its own fault card inside its own frame and the rest
 * of the shell keeps working; a throw in the chrome lands on a page that keeps
 * the header; a link to nothing offers Studio, Shots and ⌘K search — or, to a
 * visitor, the front page.
 *
 * Failures are injected with the development-only crash probes
 * (lib/shell/fault.ts › probeArmed): `window.__particlCrash = ["library"]`
 * makes the boundary named "library" throw on its next render; an entry can
 * also name the error (`{ name, message, errorName }`). Nothing is generated;
 * paid routes fail the test.
 */

const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];

type Armed = string | { name: string; message?: string; errorName?: string };

const fixture = (): Project => ({ ...newProject("Coastal light study"), id: "ws-faults", productionProjectId: "prod-ws", shotMappings: {} });

async function arm(page: Page, list: Armed[]) {
  await page.evaluate((armed) => { (window as unknown as { __particlCrash?: unknown[] }).__particlCrash = armed; }, list);
}

async function open(page: Page, path = "/suites", armed: Armed[] = []) {
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
  if (armed.length) await page.addInitScript((list) => { (window as unknown as { __particlCrash?: unknown[] }).__particlCrash = list; }, armed);
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

/* Entrance animations scale and fade a card in; measure targets once they have finished. */
async function settled(page: Page) {
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
    .map((animation) => animation.finished.catch(() => undefined))));
}

/* The ref is what a person quotes: 12px or more, and no dimmer than #7C7C84 even composited over black. */
async function refIsReadable(ref: Locator) {
  await expect(ref).toHaveText(/ref P-[0-9A-Z]{7}/);
  const { size, lum } = await ref.evaluate((el) => {
    const [r, g, b, a = 1] = (getComputedStyle(el).color.match(/[\d.]+/g) ?? []).map(Number);
    return { size: Number.parseFloat(getComputedStyle(el).fontSize), lum: a * (0.2126 * r + 0.7152 * g + 0.0722 * b) };
  });
  expect(size, "the ref sits on the 12px floor").toBeGreaterThanOrEqual(12);
  expect(lum, "the ref is no dimmer than #7C7C84").toBeGreaterThanOrEqual(0.2126 * 0x7c + 0.7152 * 0x7c + 0.0722 * 0x84 - 0.5);
}

/* The one next step is on screen and nothing (the phone's tab bar, a pinned dock) sits over it. */
async function reachable(page: Page, target: Locator) {
  await target.scrollIntoViewIfNeeded().catch(() => undefined);
  const hit = await target.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const top = document.elementFromPoint(x, y);
    return { inView: box.top >= 0 && box.bottom <= innerHeight + 0.5, onTop: Boolean(top && (top === el || el.contains(top))) };
  });
  expect(hit, "the next step is on screen and uncovered").toEqual({ inView: true, onTop: true });
}

/*
 * A step that must happen within one page load. On a cold webpack dev server (the handoff's local scripts)
 * each route compiles on first use and Fast Refresh can then reload the page under the step, resetting the
 * Try again count. That reload is the dev server's, not the app's: the step runs again on the reloaded page.
 * A failure within one page load still fails, and Turbopack (CI) showed no such reload on a cold server.
 */
async function withinOneLoad(page: Page, step: () => Promise<void>) {
  const loadedAt = () => page.evaluate(() => performance.timeOrigin).catch(() => -1);
  for (let attempt = 1; ; attempt++) {
    const loaded = await loadedAt();
    try {
      await step();
    } catch (error) {
      if (attempt < 3 && (await loadedAt()) !== loaded) continue;
      throw error;
    }
    if ((await loadedAt()) === loaded) return;
    if (attempt >= 3) throw new Error("the dev server kept reloading the page under the step");
  }
}

test("a stage that throws keeps the shell: its own card, the strip still moves, and Try again is Next's retry", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const errors = await open(page, "/suites?suite=atomik&page=agent&sp=agent", ["stage:agent"]);
  await expect(page.getByTestId("project-name")).toHaveText("Coastal light study");

  const fault = page.locator('[data-testid="panel-fault"][data-fault="stage:agent"]');
  await expect(fault).toBeVisible();
  await expect(fault).toContainText("Agent stopped");
  await expect(fault).toContainText("Takes in progress keep generating.");
  await expect(fault.getByTestId("fault-copy")).toHaveText("Copy details");
  await refIsReadable(fault.getByTestId("fault-ref"));

  /* The chrome is untouched: header, page title, strip. */
  await openSuitesMenu(page);
  await expect(page.getByRole("tablist", { name: "Suites" })).toBeVisible();
  await closeSuitesMenu(page);
  await expect(page.getByTestId("page-title")).toHaveText("Agent");
  const strip = page.getByRole("navigation", { name: "Pages" });
  await settled(page);
  /* Try again is above the fold at every size — at 360×640 and 844×390 too, where the stage under the page head is short. */
  await reachable(page, fault.getByTestId("fault-retry"));
  if (PHONE.includes(info.project.name)) {
    expect(await smallText(page), "text under 12px").toEqual([]);
    expect(await smallTargets(page, '[data-testid="panel-fault"]'), "fault targets under 44×44").toEqual([]);
  }
  await noHorizontalScroll(page);

  /* Moving on is a fresh go; the next stage renders. */
  await strip.getByRole("button", { name: /Runs/ }).click();
  await expect(page.getByTestId("page-title")).toHaveText("Runs");
  await expect(page.getByTestId("panel-fault")).toHaveCount(0);

  /* Back on the broken stage, Try again fetches the route again (Next's retry): while the refresh is on its way
     the button says so and ignores presses; when it fails again the attempt is counted, Reload is offered and
     focus is on the new Try again. */
  await strip.getByRole("button", { name: /Agent/ }).click();
  await withinOneLoad(page, async () => {
    await expect(fault).toBeVisible();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const refreshes: string[] = [];
    const refresh = (url: URL) => url.pathname === "/suites" && url.searchParams.has("_rsc");
    await page.route(refresh, async (route) => {
      /* The dev server's own refresh after a compile is not a Try again: let it through. */
      if (route.request().headers()["next-hmr-refresh"]) return route.continue();
      refreshes.push(route.request().url());
      await held;
      await route.continue().catch(() => { /* the page was reloaded under it */ });
    });
    try {
      const retry = fault.getByTestId("fault-retry");
      await retry.click();
      await expect(retry).toHaveText("Trying…");
      await expect(retry).toHaveAttribute("aria-disabled", "true");
      /* A second press while it is on its way is ignored (forced: Playwright waits out aria-disabled itself). */
      await retry.click({ force: true });
      expect(refreshes, "one Try again, one refresh of the route").toHaveLength(1);
      release();
      await expect(fault).toHaveAttribute("data-attempts", "1");
      await expect(fault.getByTestId("fault-reload")).toBeVisible();
      await expect(fault.getByTestId("fault-retry")).toBeFocused();
    } finally {
      release();
      await page.unroute(refresh);
    }
  });

  /* Fixed underneath: Try again renders the stage. */
  await withinOneLoad(page, async () => {
    await arm(page, []);
    await fault.getByTestId("fault-retry").click();
    await expect(page.getByTestId("panel-fault")).toHaveCount(0);
    await expect(page.getByTestId("page-title")).toHaveText("Agent");
  });
  expect(errors, "a caught throw never reaches the window").toEqual([]);
});

test("a stale build asks for Reload, and a long message stays inside its card", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const long = "TypeError: Cannot read properties of undefined (reading 'shots') while laying out beat 14 of the second act, where the note carries an_unbroken_identifier_that_never_wraps_on_its_own_and_keeps_going";
  const errors = await open(page, "/suites?suite=atomik&page=agent&sp=agent", [{ name: "stage:agent", errorName: "ChunkLoadError", message: "Loading chunk 812 failed." }]);
  const fault = page.locator('[data-testid="panel-fault"][data-fault="stage:agent"]');
  await expect(fault).toContainText("Particl was updated. Reload to carry on.");
  await expect(fault.getByTestId("fault-reload")).toBeVisible();
  await expect(fault.getByTestId("fault-retry")).toHaveCount(0);

  await arm(page, [{ name: "stage:runs", message: long }]);
  await page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: /Runs/ }).click();
  const beats = page.locator('[data-testid="panel-fault"][data-fault="stage:runs"]');
  await expect(beats.getByTestId("fault-ref")).toContainText("…");
  await settled(page);
  const card = (await beats.boundingBox())!;
  const ref = (await beats.getByTestId("fault-ref").boundingBox())!;
  expect(ref.x + ref.width, "the message wraps inside the card").toBeLessThanOrEqual(card.x + card.width + 1);
  await reachable(page, beats.getByTestId("fault-retry"));
  await noHorizontalScroll(page);
  expect(errors).toEqual([]);
});

test("desktop: the Library and the Inspector fail inside their own columns and the grid does not move", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "the three-column shell");
  const errors = await open(page, "/suites?suite=atomik&page=agent&sp=agent", ["library", "inspector"]);
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
  await expect(page.getByTestId("page-title")).toHaveText("Agent");
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
  const errors = await open(page, "/suites?suite=atomik&page=agent&sp=agent", ["library", "inspector"]);
  await expect(page.getByTestId("project-name")).toHaveText("Coastal light study");
  await page.getByTestId("toggle-library").click();
  const library = page.getByTestId("library");
  await expect(library).toHaveAttribute("data-faulted", "true");
  await expect(library.getByTestId("panel-fault")).toContainText("The Library stopped");
  await settled(page);
  expect(await smallText(page), "text under 12px").toEqual([]);
  expect(await smallTargets(page, '[data-testid="library"]'), "targets under 44×44").toEqual([]);
  const box = (await library.boundingBox())!;
  expect(box.x + box.width, "the overlay stays on screen").toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1);
  await reachable(page, library.getByTestId("fault-retry"));
  await library.getByTestId("close-library").click();
  await expect(page.getByTestId("library")).toHaveCount(0);

  /* The Inspector overlay the same way. */
  await page.getByTestId("toggle-inspector").click();
  const inspector = page.getByTestId("inspector");
  await expect(inspector.getByTestId("panel-fault")).toContainText("The Inspector stopped");
  await settled(page);
  expect(await smallTargets(page, '[data-testid="inspector"]'), "targets under 44×44").toEqual([]);
  await inspector.getByTestId("close-inspector").click();
  await expect(page.getByTestId("inspector")).toHaveCount(0);
  await expect(page.getByTestId("page-title")).toHaveText("Agent");
  await noHorizontalScroll(page);
  expect(errors).toEqual([]);
});

test("Gen: one bad take costs its tile, a failing results grid keeps the composer and its prompt", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const errors = await open(page, "/suites?make=video");
  await expect(page.getByTestId("gen-view")).toBeVisible();
  await expect(page.getByTestId("project-name")).toHaveText("Coastal light study");
  const prompt = page.getByTestId("gen-prompt");
  await prompt.fill("a fox crossing a frozen harbour");
  /* Make's results are its Recent tab; the composer keeps its words across the switch. */
  const recent = () => page.getByTestId("make-tab-recent").click();
  const compose = () => page.getByTestId("make-tab-make").click();
  await recent();
  const results = page.getByRole("region", { name: "Results" });
  await expect(results.getByText("Wide on the water")).toBeVisible();

  /* One take throws: its tile keeps its place, the others render. */
  await arm(page, ["take:generation:gen_wide"]);
  await results.getByRole("button", { name: "Images", exact: true }).click();
  const tile = results.getByTestId("take-fault");
  await expect(tile).toHaveCount(1);
  await expect(tile).toContainText("Wide on the water");
  await expect(results.getByText("Close on the rope")).toBeVisible();
  await refIsReadable(tile.locator(".gx-asset-meta"));

  /* Its Try again brings it back once fixed; failing again later does not cost the prompt its focus or its words. */
  await arm(page, []);
  await tile.getByRole("button", { name: /Wide on the water could not be shown/ }).click();
  await expect(results.getByTestId("take-fault")).toHaveCount(0);
  await compose();
  await prompt.focus();
  /* The tab's words are drawn again: the caret goes back to their end, where a person carries on typing. */
  await prompt.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length));
  await arm(page, ["take:generation:gen_wide"]);
  await prompt.pressSequentially(" at dawn");
  await expect(prompt, "a panel failing on its own never steals the keyboard").toBeFocused();
  await expect(prompt).toHaveValue("a fox crossing a frozen harbour at dawn");
  await recent();
  await expect(results.getByTestId("take-fault")).toHaveCount(1);

  /* The whole grid throws: the card replaces the grid, the composer and the prompt stay. */
  await arm(page, ["gen-results"]);
  await results.getByRole("button", { name: "All", exact: true }).click();
  const fault = page.locator('[data-testid="panel-fault"][data-fault="gen-results"]');
  await expect(fault).toContainText("Results stopped");
  await settled(page);
  if (PHONE.includes(info.project.name)) expect(await smallTargets(page, '[data-fault="gen-results"]'), "targets under 44×44").toEqual([]);
  await arm(page, []);
  await fault.getByTestId("fault-retry").click();
  await expect(fault).toHaveCount(0);
  await arm(page, ["gen-results"]);
  await results.getByRole("button", { name: "Images", exact: true }).click();
  await expect(fault).toContainText("Results stopped");
  await compose();
  await expect(prompt).toHaveValue("a fox crossing a frozen harbour at dawn");
  await expect(page.getByTestId("gen-generate")).toBeVisible();

  /* Fixed, Recent opens on a fresh grid (its wall is new each time the tab is). */
  await arm(page, []);
  await recent();
  await expect(fault).toHaveCount(0);
  await expect(results.getByText("Wide on the water")).toBeVisible();
  await expect(results.getByTestId("take-fault")).toHaveCount(0);
  await noHorizontalScroll(page);
  expect(errors).toEqual([]);
});

test("search and a whole view fail on their own: the sheet takes focus and still closes, Workspace and Crew come back", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const errors = await open(page, "/suites?suite=atomik&page=agent&sp=agent", ["palette", "composer"]);
  await expect(page.getByTestId("project-name")).toHaveText("Coastal light study");
  /* The composer is closed, so its failure shows nothing and costs nothing. */
  await expect(page.locator('[data-fault="composer"]')).toHaveCount(0);

  /* Search throws as it opens: its card is the dialog, it takes focus, and Close (or Esc) still works. */
  await openSuitesMenu(page);
  await page.getByTestId("header-search").click();
  const sheet = page.getByRole("dialog", { name: "Search" });
  await expect(sheet.getByTestId("panel-fault")).toContainText("Search stopped");
  await expect(sheet).toHaveAttribute("aria-modal", "true");
  await expect(sheet.getByTestId("fault-retry")).toBeFocused();
  await settled(page);
  if (PHONE.includes(info.project.name)) expect(await smallTargets(page, '[data-fault="palette"]'), "targets under 44×44").toEqual([]);
  const dialog = (await sheet.boundingBox())!;
  expect(dialog.y + dialog.height, "the card fits above the fold").toBeLessThanOrEqual((page.viewportSize()?.height ?? 0) + 1);
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId("palette-veil")).toHaveCount(0);
  await openSuitesMenu(page);
  await page.getByTestId("header-search").click();
  await expect(sheet.getByTestId("panel-fault")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);

  /* Fixed underneath: opening search again is a fresh go. */
  await arm(page, []);
  await openSuitesMenu(page);
  await page.getByTestId("header-search").click();
  await expect(page.getByRole("textbox", { name: "Search" })).toBeVisible();
  await page.keyboard.press("Escape");

  /* A whole view that throws keeps the header, so every suite is one tap away. (The later init script wins on load.) */
  await page.addInitScript(() => { (window as unknown as { __particlCrash?: string[] }).__particlCrash = ["workspace", "crew"]; });
  await page.goto("/suites?view=workspace");
  const fault = page.locator('[data-testid="panel-fault"][data-fault="workspace"]');
  await expect(fault).toContainText("Workspace stopped");
  await openSuitesMenu(page);
  await expect(page.getByRole("tablist", { name: "Suites" })).toBeVisible();
  await closeSuitesMenu(page);
  await reachable(page, fault.getByTestId("fault-retry"));
  await noHorizontalScroll(page);

  /* Crew is walled off the same way, and its room strip stays. Crew is reached from ⌘K (header option B). */
  await goViaSearch(page, "crew room", /Crew room/);
  const crew = page.locator('[data-testid="panel-fault"][data-fault="crew"]');
  await expect(crew).toContainText("Crew stopped");
  await reachable(page, crew.getByTestId("fault-retry"));
  await arm(page, []);
  await crew.getByTestId("fault-retry").click();
  await expect(crew).toHaveCount(0);

  /* The avatar opens Settings; Team is Workspace's People until Settings ships (D1). */
  await page.getByTestId("workspace-avatar").click();
  await page.getByTestId("settings-team").click();
  await expect(page.getByTestId("workspace-view")).toBeVisible();
  await expect(page.locator('[data-fault="workspace"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("Atomik: the gate row and the plan sheet fail on their own, and the sheet still closes", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const errors = await open(page, "/suites?suite=atomik&page=agent&sp=agent", ["atomik-gate", "atomik-sheet", "strip"]);
  await expect(page.getByTestId("project-name")).toHaveText("Coastal light study");

  /* The gate row and the run strip fail in their own rows; the stage between them works. */
  const gate = page.locator('[data-testid="panel-fault"][data-fault="atomik-gate"]');
  await expect(gate).toContainText("The Atomik gate stopped");
  await expect(page.locator('[data-fault="strip"]')).toContainText("The run strip stopped");
  await expect(page.getByTestId("page-title")).toHaveText("Agent");
  await settled(page);
  await reachable(page, gate.getByTestId("fault-retry"));
  if (PHONE.includes(info.project.name)) expect(await smallTargets(page, '[data-fault="atomik-gate"]'), "targets under 44×44").toEqual([]);

  /* The plan sheet throws as it opens: its card is the dialog, and Esc closes it. Nothing is priced or run. */
  if (!DESKTOP.includes(info.project.name)) await page.getByTestId("toggle-inspector").click();
  await page.getByRole("button", { name: "Run with Atomik" }).click();
  const sheet = page.getByRole("dialog", { name: "Atomik" });
  await expect(sheet.getByTestId("panel-fault")).toContainText("Atomik stopped");
  await expect(sheet.getByTestId("fault-retry")).toBeFocused();
  await settled(page);
  if (PHONE.includes(info.project.name)) expect(await smallTargets(page, '[data-fault="atomik-sheet"]'), "targets under 44×44").toEqual([]);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  /* On a phone the Inspector overlay is still open over the page: Esc again closes it. */
  if (!DESKTOP.includes(info.project.name)) {
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("inspector")).toHaveCount(0);
  }

  /* Fixed underneath: the gate's Try again brings the row back to what it would say. */
  await arm(page, []);
  await gate.getByTestId("fault-retry").click();
  await expect(gate).toHaveCount(0);
  await noHorizontalScroll(page);
  expect(errors).toEqual([]);
});

test("the shell's own chrome throws: the Suites error page keeps the header, Try again and Back to Studio", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  await open(page, "/suites", ["shell"]);
  const screen = page.getByTestId("suites-error");
  await expect(screen).toBeVisible();
  await expect(screen.getByRole("heading", { name: "This screen stopped" })).toBeVisible();
  await expect(screen).toContainText("Your work is safe. Takes in progress keep generating.");
  const suites = screen.getByRole("navigation", { name: "Suites" });
  await expect(suites.getByRole("link")).toHaveText(["Home", "Project", "Make", "Atomik"]);
  await expect(suites.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/suites?suite=particl&page=brief&sp=stages");
  await expect(suites.getByRole("link", { name: "Make" })).toHaveAttribute("href", "/suites?make=video");
  await expect(screen.getByTestId("fault-studio")).toHaveAttribute("href", "/suites");
  await expect(screen.getByTestId("header-search")).toHaveAttribute("href", "/suites?find=1");
  await refIsReadable(screen.getByTestId("fault-ref"));
  expect(await floorText(page, info.project.name), "text under 12px").toEqual([]);
  await settled(page);
  await reachable(page, screen.getByTestId("fault-retry"));
  if (PHONE.includes(info.project.name)) expect(await smallTargets(page, '[data-testid="suites-error"]'), "targets under 44×44").toEqual([]);
  await noHorizontalScroll(page);

  /* Fixed underneath: Try again (Next's retry) re-renders the shell in place. */
  await arm(page, []);
  await screen.getByTestId("fault-retry").click();
  await expect(page.getByTestId("project-name")).toHaveText("Coastal light study");
  await expect(page.getByTestId("suites-error")).toHaveCount(0);
});

test("a link to nothing: the 404 keeps the header and offers Studio, Shots and ⌘K search", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  await open(page, "/suites");
  await expect(page.getByTestId("project-name")).toHaveText("Coastal light study");

  const me = page.waitForResponse((reply) => new URL(reply.url()).pathname === "/api/me");
  const response = await page.goto("/productions/no-such-thing-here");
  expect(response?.status()).toBe(404);
  const screen = page.getByTestId("not-found");
  await expect(screen.getByRole("heading", { name: "Nothing here" })).toBeVisible();
  /* The 404 is static; signed in, /api/me answers and the member page stays. */
  expect((await me).status()).toBe(200);
  await expect(screen).toHaveAttribute("data-member", "true");
  await expect(screen.getByTestId("missing-studio")).toHaveAttribute("href", "/suites");
  await expect(screen.getByTestId("missing-shots")).toHaveAttribute("href", "/suites?view=board&region=shots");
  await expect(screen.getByTestId("missing-search")).toHaveAttribute("href", "/suites?find=1");
  await expect(screen.getByText(/Go to Video|All takes/)).toHaveCount(0);
  expect(await floorText(page, info.project.name), "text under 12px").toEqual([]);
  await settled(page);
  await reachable(page, screen.getByTestId("missing-studio"));
  if (PHONE.includes(info.project.name)) expect(await smallTargets(page, '[data-testid="not-found"]'), "targets under 44×44").toEqual([]);
  await noHorizontalScroll(page);

  /* Search lands in the shell with ⌘K open, once: the URL drops the request. */
  await screen.getByTestId("missing-search").click();
  await expect(page.getByRole("dialog", { name: "Search" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Search" })).toBeFocused();
  await expect.poll(() => new URL(page.url()).searchParams.get("find")).toBeNull();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Search" })).toHaveCount(0);

  /* Open Shots lands on the board's Shots region. */
  await page.goto("/no-such-page");
  await page.getByTestId("missing-shots").click();
  await expect(page.locator(".gx")).toHaveAttribute("data-screen", "board");
  await expect.poll(() => { const q = new URL(page.url()).searchParams; return [q.get("view"), q.get("region")]; }).toEqual(["board", "shots"]);

  /* ⌘K on the 404 itself goes to search too (a keyboard is a desktop thing). */
  if (DESKTOP.includes(info.project.name)) {
    await page.goto("/no-such-page");
    await expect(page.locator('[data-testid="not-found"] header[data-keys="on"]')).toBeVisible();
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByRole("dialog", { name: "Search" })).toBeVisible();
  }
});

test("a visitor on a dead link gets the front page and Sign in, not the suites", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  /* Never signed in: this page's context has no session cookie. */
  expect((await page.context().cookies()).length).toBe(0);
  const response = await page.goto("/pricng");
  expect(response?.status()).toBe(404);
  const screen = page.getByTestId("not-found");
  await expect(screen.getByRole("heading", { name: "Nothing here" })).toBeVisible();
  /* The 404 is static; the browser asks /api/me, and its 401 turns it into the visitor page. */
  await expect(screen).toHaveAttribute("data-member", "false");
  await expect(screen.getByTestId("missing-home")).toHaveAttribute("href", "/");
  await expect(screen.getByTestId("header-sign-in")).toHaveAttribute("href", "/login");
  /* No suite links, no Search, no Studio: each would only send a visitor to sign in. */
  await expect(screen.getByRole("navigation", { name: "Suites" })).toHaveCount(0);
  await expect(screen.getByText(/Back to Studio|Open Takes|Search/)).toHaveCount(0);
  await expect(screen.getByRole("link", { name: "Sign in" })).toHaveCount(1);
  expect(await floorText(page, info.project.name), "text under 12px").toEqual([]);
  await settled(page);
  await reachable(page, screen.getByTestId("missing-home"));
  if (PHONE.includes(info.project.name)) expect(await smallTargets(page, '[data-testid="not-found"]'), "targets under 44×44").toEqual([]);
  await noHorizontalScroll(page);
});
