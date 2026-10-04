import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { dimLabels, smallTargets, smallText } from "./phoneFloors";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, upload } from "./helpers/workspaceFixtures";
import { closeSuitesMenu, openSuitesMenu, tapSuiteTab } from "./helpers/suitesMenu";

/**
 * The Suites shell, build step 1 (design/particl-graphite/README.md): one
 * header, a numbered stage strip, Library | stage | Inspector at 1280 and
 * wider and overlays below it, ⌘K, ⌘J, the right-click menu, and the URL as
 * the record of where you are. Page bodies are the existing ones; this spec
 * is about the chrome around them.
 */

const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const WIDE = ["workbench-1440x900", "workbench-1920x1080"];

function fixture(): Project {
  return { ...newProject("Coastal light study"), id: "ws-suites", productionProjectId: "prod-ws", shotMappings: {} };
}

async function open(page: Page, path = "/suites") {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, {
    uploads: [upload({ id: "up_plate", filename: "harbour-plate.webp" })],
    generations: [
      generation({ id: "gen_wide", title: "Wide on the water", prompt: "Wide on the water" }),
      generation({ id: "gen_move", title: "Push in", prompt: "Push in", kind: "video" }),
    ],
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && /hydrat|did not match/i.test(message.text())) errors.push(message.text()); });
  await page.goto(path);
  await expect(page.getByTestId("project-name")).toHaveText("Coastal light study");
  return errors;
}

const param = (page: Page, key: string) => new URL(page.url()).searchParams.get(key);

test("the shell lands on Studio with the README's header, strip and columns", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const wide = WIDE.includes(info.project.name);
  const errors = await open(page);

  const suites = page.getByRole("tablist", { name: "Suites" });
  await openSuitesMenu(page);
  await expect(suites.getByRole("tab")).toHaveText(["Studio", "Gen", "Business", "Viral", "Atomik", "Crew"]);
  await expect(suites.getByRole("tab", { name: "Studio" })).toHaveAttribute("aria-selected", "true");
  await closeSuitesMenu(page);
  await expect(page.getByTestId("workspace-credits")).toContainText(/cr|—/);

  const strip = page.getByRole("navigation", { name: "Pages" });
  await expect(strip.getByRole("button")).toHaveText([/^01\s*Brief$/, /^02\s*Beats$/, /^03\s*Storyboards$/, /^04\s*Environment$/, /^05\s*Cast$/, /^06\s*Astra$/, /^07\s*Rig$/, /^08\s*Takes$/, /^09\s*Edit & Sound$/, /^10\s*Deliver$/]);
  await expect(strip.getByTestId("strip-gap")).toHaveCount(2);
  await expect(strip.getByRole("button", { name: /Brief/ })).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("page-title")).toHaveText("Brief & Script");
  await expect(page.getByTestId("page-hint")).toHaveText("Find the story");

  const body = page.getByTestId("shell-body");
  if (wide) {
    await expect(body).toHaveAttribute("data-columns", "280px minmax(0,1fr) 320px");
    await expect(page.getByTestId("library")).toBeVisible();
    await expect(page.getByTestId("inspector")).toBeVisible();
    await expect(page.getByTestId("toggle-library")).toHaveCount(0);
    expect(Math.round((await page.getByTestId("library").boundingBox())!.width)).toBe(280);
    expect(Math.round((await page.getByTestId("inspector").boundingBox())!.width)).toBe(320);
  } else {
    /* Below 1280 the stage has the row to itself and the panels are overlays. */
    await expect(page.getByTestId("library")).toHaveCount(0);
    await expect(page.getByTestId("inspector")).toHaveCount(0);
    await page.getByTestId("toggle-library").click();
    await expect(page.getByTestId("library")).toBeVisible();
    await page.getByTestId("close-library").click();
    await expect(page.getByTestId("library")).toHaveCount(0);
    await page.getByTestId("toggle-inspector").click();
    await expect(page.getByTestId("inspector")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("inspector")).toHaveCount(0);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "no horizontal page scroll").toBe(true);
  expect(errors).toEqual([]);
});

test("suites remember their page, Gen and Workspace are views, and Back retraces all of it", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const errors = await open(page);
  const suites = page.getByRole("tablist", { name: "Suites" });
  const strip = page.getByRole("navigation", { name: "Pages" });

  await strip.getByRole("button", { name: /Rig/ }).click();
  await expect(page.getByTestId("page-title")).toHaveText("Rig");
  expect([param(page, "page"), param(page, "sp")]).toEqual(["rig", "rig"]);

  await tapSuiteTab(page, "Atomik");
  await expect(page.getByTestId("page-title")).toHaveText("Agent");
  await expect(strip.getByTestId("strip-gap")).toHaveCount(2);
  await strip.getByRole("button", { name: /Budget/ }).click();
  await expect(page.getByTestId("page-title")).toHaveText("Budget");

  /* Studio comes back on Rig, not on Brief. */
  await tapSuiteTab(page, "Studio");
  await expect(page.getByTestId("page-title")).toHaveText("Rig");

  /* Gen opens Make as a panel over the page it is on (README § 3.2): Rig stays, its address gains make=. */
  /* (The header marks Gen as selected only once it calls openMake; that is the header's own PR.) */
  await openSuitesMenu(page);
  await page.getByRole("tablist", { name: "Suites", includeHidden: true }).getByRole("tab", { name: "Gen", includeHidden: true }).click();
  await expect(page.getByTestId("make-panel")).toBeVisible();
  await expect(page.getByTestId("page-title")).toHaveText("Rig");
  expect([param(page, "view"), param(page, "make")]).toEqual([null, "video"]);
  await page.getByTestId("make-close").click();
  await expect(page.getByTestId("make-panel")).toHaveCount(0);
  expect(param(page, "make")).toBeNull();
  await page.goBack();
  await expect(page.getByTestId("make-panel")).toBeVisible();

  await page.getByTestId("workspace-credits").click();
  await expect(page.getByTestId("workspace-view")).toBeVisible();
  expect([param(page, "view"), param(page, "tab")]).toEqual(["workspace", "credits"]);
  await expect(page.getByTestId("workspace-balance")).toBeVisible();

  await page.goBack();
  await expect(page.getByTestId("page-title")).toHaveText("Rig");
  await expect(page.getByTestId("make-panel")).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId("page-title")).toHaveText("Rig");
  await expect(page.getByTestId("make-panel")).toHaveCount(0);

  /* A pasted link opens the same place: History is still Viral's page; an old Object Swap link is Make's quick tool over Studio. */
  await page.goto("/suites?suite=subatomik&page=history&sp=history");
  await expect(page.getByTestId("page-title")).toHaveText("History");
  await openSuitesMenu(page);
  await expect(suites.getByRole("tab", { name: "Viral" })).toHaveAttribute("aria-selected", "true");
  await page.goto("/suites?suite=subatomik&page=swap&sp=swap");
  await expect(page.getByTestId("make-panel")).toHaveAttribute("data-tab", "swap");
  await expect(page.getByTestId("make-title")).toHaveText("Object swap");
  expect([param(page, "suite"), param(page, "make")]).toEqual(["particl", "swap"]);
  expect(errors).toEqual([]);
});

test("⌘K finds a page, runs the top hit on Enter and closes on Escape", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  await open(page);
  await openSuitesMenu(page);
  await page.getByTestId("header-search").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox").or(dialog.getByRole("textbox")).first().fill("deliver");
  await expect(dialog.getByRole("option").first()).toContainText("10 Deliver");
  await expect(dialog.getByRole("option").last()).toContainText("Ask Atomik: deliver");
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("page-title")).toHaveText("Deliver");

  await page.keyboard.press("ControlOrMeta+k");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("assets sit beside every stage, drag as their id, and right-click opens the menu inside the viewport", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const wide = WIDE.includes(info.project.name);
  await open(page, "/suites?suite=particl&page=boards&sp=boards");
  if (!wide) await page.getByTestId("toggle-library").click();
  const library = page.getByTestId("library");
  await library.getByRole("tab", { name: /Assets/ }).click();
  const tiles = library.locator("[data-ctx^='asset:']");
  await expect(tiles).toHaveCount(3);
  await library.getByRole("button", { name: "Video", exact: true }).click();
  await expect(tiles).toHaveCount(1);
  await library.getByRole("button", { name: "All", exact: true }).click();

  /* The drag payload is the asset id, as text/plain (README › Assets). */
  const payload = await tiles.first().evaluate((el) => {
    const data = new DataTransfer();
    el.dispatchEvent(new DragEvent("dragstart", { dataTransfer: data, bubbles: true }));
    return { id: el.getAttribute("data-ctx")!.slice("asset:".length), text: data.getData("text/plain") };
  });
  expect(payload.text).toBe(payload.id);

  await tiles.first().click({ button: "right" });
  const menu = page.getByTestId("context-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveText([/^Copy/, /^Cut/, /^Paste/, /^Duplicate/, /^Use as reference/, /^Open in Inspector/, /^Move to/, /^Recreate/, /^Delete/, /^Undo/]);
  /* What an asset cannot do is present, disabled, and says why (Duplicate); the rest is live (step 1). */
  await expect(menu.getByRole("menuitem", { name: /^Delete/ })).toBeEnabled();
  await expect(menu.getByRole("menuitem", { name: /^Duplicate/ })).toBeDisabled();
  await expect(menu.getByRole("menuitem", { name: /^Duplicate/ })).toHaveAttribute("title", /.+/);
  const box = (await menu.boundingBox())!;
  const view = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(8 - 0.5);
  expect(box.y).toBeGreaterThanOrEqual(8 - 0.5);
  expect(box.x + box.width).toBeLessThanOrEqual(view.width - 8 + 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(view.height - 8 + 0.5);
  await menu.getByRole("menuitem", { name: /^Copy/ }).click();
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId("toast")).toBeVisible();
});

test("⌘J toggles the Inspector on a wide screen", async ({ page }, info) => {
  test.skip(!WIDE.includes(info.project.name), "three columns exist at 1280 and wider");
  await open(page);
  await expect(page.getByTestId("inspector")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+j");
  await expect(page.getByTestId("inspector")).toHaveCount(0);
  await expect(page.getByTestId("shell-body")).toHaveAttribute("data-columns", "280px minmax(0,1fr)");
  await page.keyboard.press("ControlOrMeta+j");
  await expect(page.getByTestId("inspector")).toBeVisible();
});

test("the chrome keeps the phone floors: 12px text, 44px targets, no label under #7C7C84", async ({ page }, info) => {
  test.skip(WIDE.includes(info.project.name), "the three phone viewports");
  await open(page);
  /* The hosted page bodies are the existing ones and are measured by their
     own specs; step 1 owns the chrome around them. */
  const chrome = ".gx-header, .gx-strip, .gx-project, .gx-pagehead";
  expect(await smallText(page, ".gx-legacy"), "text under 12px").toEqual([]);
  expect(await smallTargets(page, chrome), "targets under 44×44").toEqual([]);
  expect(await dimLabels(page, ".gx"), "labels under #7C7C84").toEqual([]);
  await page.getByTestId("toggle-library").click();
  /* Measure the settled panel: mid slide-in, a fractional translate makes a
     44px control read as 43.99. */
  await page.getByTestId("library").evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
  expect(await smallTargets(page, ".gx-library"), "Library targets under 44×44").toEqual([]);
  expect(await smallText(page, ".gx-legacy"), "Library text under 12px").toEqual([]);
});

test("an old Gen link lands on the page it names with Make open on its type, server and client, and no link breaks", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  /* Server: the redirect happens before anything renders, and keeps the rest of the query. */
  const errors = await open(page, "/suites?suite=particl&page=rig&sp=rig&view=gen&mode=images&sheet=1");
  await expect(page.getByTestId("make-panel")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Images" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("page-title")).toHaveText("Rig");
  expect([param(page, "view"), param(page, "mode"), param(page, "sheet"), param(page, "make"), param(page, "page")]).toEqual([null, null, null, "image", "rig"]);

  /* Make's type and tab are its address: a switch rewrites it, Recent included. */
  await page.getByRole("tab", { name: "Audio" }).click();
  await expect.poll(() => param(page, "make")).toBe("audio");
  await page.getByTestId("make-tab-recent").click();
  await expect.poll(() => param(page, "make")).toBe("recent");
  await page.getByTestId("make-tab-make").click();
  await expect.poll(() => param(page, "make")).toBe("audio");
  await expect(page.getByTestId("gen-prompt")).toBeVisible();

  /* Client: an entry with the old address (history, a pasted URL inside the app) reads as Make too. */
  await page.evaluate(() => { history.pushState(null, "", "/suites?view=gen&mode=video"); dispatchEvent(new PopStateEvent("popstate")); });
  await expect(page.getByRole("tab", { name: "Video" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("make-panel")).toBeVisible();
  await expect.poll(() => [param(page, "view"), param(page, "mode"), param(page, "make")]).toEqual([null, null, "video"]);

  /* make=1 is the last type; Esc closes Make. */
  await page.goto("/suites?make=1");
  await expect(page.getByTestId("make-panel")).toBeVisible();
  expect(param(page, "make")).toBe("video");
  await page.getByTestId("make-tab-make").focus();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("make-panel")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
});
