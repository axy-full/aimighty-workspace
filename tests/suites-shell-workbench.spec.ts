import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { dimLabels, smallTargets, smallText } from "./phoneFloors";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, upload } from "./helpers/workspaceFixtures";

/**
 * The Suites shell, build step 1 (design/particl-suites/README.md): one
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
  await expect(suites.getByRole("tab")).toHaveText(["Studio", "Gen", "Business", "Viral", "Atomik", "Crew"]);
  await expect(suites.getByRole("tab", { name: "Studio" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("workspace-credits")).toContainText(/cr|—/);

  const strip = page.getByRole("navigation", { name: "Pages" });
  await expect(strip.getByRole("button")).toHaveText([/^01\s*Brief$/, /^02\s*Beats$/, /^03\s*Boards$/, /^04\s*Cast$/, /^05\s*Astra$/, /^06\s*Rig$/, /^07\s*Takes$/, /^08\s*Edit$/, /^09\s*Deliver$/]);
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

  await suites.getByRole("tab", { name: "Atomik" }).click();
  await expect(page.getByTestId("page-title")).toHaveText("Agent");
  await expect(strip.getByTestId("strip-gap")).toHaveCount(2);
  await strip.getByRole("button", { name: /Budget/ }).click();
  await expect(page.getByTestId("page-title")).toHaveText("Budget");

  /* Studio comes back on Rig, not on Brief. */
  await suites.getByRole("tab", { name: "Studio" }).click();
  await expect(page.getByTestId("page-title")).toHaveText("Rig");

  await suites.getByRole("tab", { name: "Gen" }).click();
  await expect(page.getByTestId("page-title")).toHaveText("Generate");
  await expect(strip).toHaveCount(0);
  expect(param(page, "view")).toBe("gen");

  await page.getByTestId("workspace-credits").click();
  await expect(page.getByTestId("workspace-view")).toBeVisible();
  expect([param(page, "view"), param(page, "tab")]).toEqual(["workspace", "credits"]);
  await expect(page.getByTestId("workspace-balance")).toBeVisible();

  await page.goBack();
  await expect(page.getByTestId("page-title")).toHaveText("Generate");
  await page.goBack();
  await expect(page.getByTestId("page-title")).toHaveText("Rig");

  /* A pasted link opens the same place. */
  await page.goto("/suites?suite=subatomik&page=swap&sp=swap");
  await expect(page.getByTestId("page-title")).toHaveText("Object Swap");
  await expect(suites.getByRole("tab", { name: "Viral" })).toHaveAttribute("aria-selected", "true");
  expect(errors).toEqual([]);
});

test("⌘K finds a page, runs the top hit on Enter and closes on Escape", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  await open(page);
  await page.getByTestId("header-search").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox").or(dialog.getByRole("textbox")).first().fill("deliver");
  await expect(dialog.getByRole("option").first()).toContainText("09 Deliver");
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
  await expect(menu.getByRole("menuitem")).toHaveText([/^Copy/, /^Cut/, /^Paste/, /^Duplicate/, /^Use as reference/, /^Open in Inspector/, /^Move to/, /^Retry/, /^Delete/, /^Undo/]);
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
