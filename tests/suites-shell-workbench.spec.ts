import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { dimLabels, smallTargets, smallText } from "./phoneFloors";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, upload } from "./helpers/workspaceFixtures";
import { closeSuitesMenu, goViaSearch, openSuitesMenu, tapSuiteTab } from "./helpers/suitesMenu";

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

async function open(page: Page, path = "/suites", named = true) {
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
  /* The board has no project head (its header carries the project): an address that opens it names no project here. */
  if (named) await expect(page.getByTestId("project-name")).toHaveText("Coastal light study");
  return errors;
}

const param = (page: Page, key: string) => new URL(page.url()).searchParams.get(key);

test("the shell lands on Studio's overview with the README's header and columns; the stage pages are the board's regions", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const wide = WIDE.includes(info.project.name);
  const errors = await open(page);

  /* Header option B: Home · the open project (its name) · Make · Atomik. On a desktop the Studio overview is Home's, on a phone the project's. */
  const suites = page.getByRole("tablist", { name: "Suites" });
  await openSuitesMenu(page);
  await expect(suites.getByRole("tab")).toHaveText(["Home", "Coastal light study", "Make", "Atomik"]);
  await expect(suites.getByRole("tab", { name: wide ? "Home" : "Coastal light study" })).toHaveAttribute("aria-selected", "true");
  await expect(suites.getByRole("tab", { name: "Make" })).toHaveAttribute("aria-keyshortcuts", "Alt+M");
  await closeSuitesMenu(page);
  await expect(page.getByTestId("workspace-credits")).toContainText(/cr|—/);

  /* The ten stage pages are deleted: there is no strip of stage tabs, and the overview's title is the project. */
  await expect(page.locator(".gx-strip")).toHaveCount(0);
  await expect(page.getByTestId("studio-home")).toBeVisible();
  await expect(page.getByTestId("page-title")).toHaveText("Coastal light study");

  const body = page.getByTestId("shell-body");
  if (wide) {
    /* Library | overview; the Inspector opens for a take picked here, never for a stage spec. */
    await expect(body).toHaveAttribute("data-columns", "280px minmax(0,1fr)");
    await expect(page.getByTestId("library")).toBeVisible();
    await expect(page.getByTestId("inspector")).toHaveCount(0);
    await expect(page.getByTestId("toggle-library")).toHaveCount(0);
    expect(Math.round((await page.getByTestId("library").boundingBox())!.width)).toBe(280);
  } else {
    /* Below 1280 the overview has the row to itself and the panels are overlays. */
    await expect(page.getByTestId("library")).toHaveCount(0);
    await expect(page.getByTestId("inspector")).toHaveCount(0);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "no horizontal page scroll").toBe(true);
  expect(errors).toEqual([]);
});

test("suites remember their page, the project is the board, Make (Gen) and Workspace are views, and Back retraces all of it", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const errors = await open(page);
  const suites = page.getByRole("tablist", { name: "Suites" });
  const strip = page.getByRole("navigation", { name: "Pages" });
  const board = page.locator(".gx");

  await tapSuiteTab(page, "Atomik");
  await expect(page.getByTestId("page-title")).toHaveText("Agent");
  await expect(strip.getByTestId("strip-gap")).toHaveCount(2);
  await strip.getByRole("button", { name: /Budget/ }).click();
  await expect(page.getByTestId("page-title")).toHaveText("Budget");

  /* The project is the board (the Studio stage pages are deleted: each is a region of it). */
  await tapSuiteTab(page, "Coastal light study");
  await expect(board).toHaveAttribute("data-screen", "board");
  expect(param(page, "view")).toBe("board");

  /* Make opens as a panel over the page it is on (README § 3.2): the board stays, its address gains make=, and the header lights Make. */
  await tapSuiteTab(page, "Make");
  await expect(page.getByTestId("make-panel")).toBeVisible();
  await expect(board).toHaveAttribute("data-screen", "board");
  expect([param(page, "view"), param(page, "make")]).toEqual(["board", "video"]);
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
  await expect(board).toHaveAttribute("data-screen", "board");
  await expect(page.getByTestId("make-panel")).toBeVisible();
  await page.goBack();
  await expect(board).toHaveAttribute("data-screen", "board");
  await expect(page.getByTestId("make-panel")).toHaveCount(0);

  /* A pasted link opens the same place: Viral's History is the Social board's History drawer, the project's, so the project is
     lit; an old Object Swap link is Make's quick tool over Studio. */
  /* The server answers with a 307 to the board; the navigation that was asked for is replaced by it. */
  await page.goto("/suites?suite=subatomik&page=history&sp=history").catch(() => undefined);
  await expect(board).toHaveAttribute("data-screen", "board-social", { timeout: 60_000 });
  await expect(page.getByTestId("suite-mark")).toHaveText("SOCIAL");
  await openSuitesMenu(page);
  await expect(suites.locator('[data-suite-tab="project"]')).toHaveAttribute("aria-selected", "true");
  await page.goto("/suites?suite=subatomik&page=swap&sp=swap");
  await expect(page.getByTestId("make-panel")).toHaveAttribute("data-tab", "swap");
  await expect(page.getByTestId("make-title")).toHaveText("Object swap");
  expect(param(page, "make")).toBe("swap");
  expect(errors).toEqual([]);
});

test("header B: Home is the Studio overview, Atomik its suite, ⌥M opens Make; the old suites are a ⌘K away", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const wide = WIDE.includes(info.project.name);
  const errors = await open(page);
  const suites = page.getByRole("tablist", { name: "Suites" });

  /* Home: the Studio overview on a desktop (Home of its own is U1), Home's "Where to?" on a phone. */
  await tapSuiteTab(page, "Home");
  await expect(page.getByTestId("suite-mark")).toHaveText("HOME");
  expect(param(page, "sp")).toBe(wide ? "stages" : "home");
  await openSuitesMenu(page);
  await expect(suites.getByRole("tab", { name: "Coastal light study" })).toHaveAttribute("aria-selected", "false");
  await closeSuitesMenu(page);

  /* The project: the board (the Studio stage pages are deleted). */
  await tapSuiteTab(page, "Coastal light study");
  await expect(page.locator(".gx")).toHaveAttribute("data-screen", "board");

  /* Atomik: today's Atomik suite under its own mark. */
  await tapSuiteTab(page, "Atomik");
  await expect(page.getByTestId("suite-mark")).toHaveText("AGENT");
  expect(param(page, "suite")).toBe("atomik");

  /* ⌥M opens Make (README § 6) as a panel over the page on screen, and lights Make; ⌥M again closes it. */
  await page.keyboard.press("Alt+KeyM");
  await expect(page.getByTestId("make-panel")).toBeVisible();
  expect([param(page, "view"), param(page, "make"), param(page, "suite")]).toEqual([null, "video", "atomik"]);
  await openSuitesMenu(page);
  await expect(page.getByRole("tablist", { name: "Suites", includeHidden: true }).getByRole("tab", { name: "Make", includeHidden: true })).toHaveAttribute("aria-selected", "true");
  await closeSuitesMenu(page);
  await page.keyboard.press("Alt+KeyM");
  await expect(page.getByTestId("make-panel")).toHaveCount(0);
  expect(param(page, "make")).toBeNull();

  /* Business, Viral and Crew left the header; ⌘K still reaches each of them. */
  await goViaSearch(page, "business", /Moleculr Business Suite/);
  /* Business is the Ads board for everyone (its pages are the board's cards). */
  await expect(page.locator(".gx")).toHaveAttribute("data-screen", "board-ads");
  await expect(page.getByTestId("suite-mark")).toHaveText("ADS");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "no horizontal page scroll").toBe(true);
  expect(errors).toEqual([]);
});

test("the avatar opens Settings: who you are, then Team · Plan & credits · Spending rules · Connections · Advanced · Sign out", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const errors = await open(page);
  const avatar = page.getByTestId("workspace-avatar");
  const menu = page.getByRole("menu", { name: "Settings" });
  await avatar.click();
  await expect(avatar).toHaveAttribute("aria-expanded", "true");
  await expect(menu.getByRole("menuitem")).toHaveText(["Team", "Plan & credits", "Spending rules", "Connections", "Advanced", "Sign out"]);
  await expect(menu.getByRole("menuitem", { name: "Team" })).toBeFocused();
  await expect(menu).toBeInViewport({ ratio: 1 });
  /* Escape closes it, back onto the avatar, and goes nowhere. */
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(avatar).toBeFocused();
  expect(param(page, "view")).toBeNull();

  /* Until Settings ships (D1), each item opens the page that holds it today. */
  for (const [item, check] of [
    ["Team", async () => expect([param(page, "view"), param(page, "tab")]).toEqual(["workspace", "people"])],
    ["Plan & credits", async () => expect([param(page, "view"), param(page, "tab")]).toEqual(["workspace", "credits"])],
    ["Spending rules", async () => { await expect(page.getByTestId("page-title")).toHaveText("Budget"); expect(param(page, "sp")).toBe("budget"); }],
    ["Connections", async () => { await expect(page.getByTestId("page-title")).toHaveText("Tools & connections"); expect(param(page, "sp")).toBe("skills"); }],
    ["Advanced", async () => expect([param(page, "view"), param(page, "tab")]).toEqual(["workspace", "engines"])],
  ] as const) {
    await avatar.click();
    await menu.getByRole("menuitem", { name: item }).click();
    await expect(menu).toHaveCount(0);
    await expect(async () => { await check(); }).toPass({ timeout: 15_000 });
  }
  await expect(page.getByTestId("suite-mark")).toHaveText("SETTINGS");
  expect(errors).toEqual([]);
});

test("an old link in the design file's spelling is sent, with a 307, to the app's page; its other params ride along", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const errors = await open(page);
  const sent = await page.request.get("/suites?suite=business&page=hooks&project=ws-suites", { maxRedirects: 0 });
  expect(sent.status()).toBe(307);
  expect(new URL(sent.headers()["location"], "http://x").search).toBe("?suite=moleculr&page=marketing&project=ws-suites&sp=hooks");
  await page.goto("/suites?suite=business&page=hooks&project=ws-suites");
  /* The Business Hooks page is the Ads board's Hooks card, for everyone (the spelling became the app's, then the board's). */
  await expect(page.locator(".gx")).toHaveAttribute("data-screen", "board-ads");
  expect([param(page, "view"), param(page, "kind"), param(page, "card"), param(page, "project")]).toEqual(["board", "ads", "hooks", "ws-suites"]);
  await page.goto("/suites?suite=atomik&page=memory&palette=1&lib=0");
  await expect(page.getByTestId("page-title")).toHaveText("Memory");
  await expect(page.getByRole("dialog", { name: "Search" })).toBeVisible();
  for (const gone of ["palette", "lib", "find"]) expect(param(page, gone), gone).toBeNull();
  /* The app's own links to a page that is a board's card are sent to it (one 307); one to a page that is still a page is served where it is. */
  expect((await page.request.get("/suites?suite=moleculr&page=marketing&sp=hooks", { maxRedirects: 0 })).status()).toBe(307);
  expect((await page.request.get("/suites?suite=subatomik&page=history&sp=history", { maxRedirects: 0 })).status()).toBe(307);
  expect((await page.request.get("/suites?suite=atomik&page=agent&sp=agent", { maxRedirects: 0 })).status()).toBe(200);
  /* An old Gen or Viral tool link in the design file's spelling reaches Make in the same one 307: never a chain. */
  for (const [from, to] of [["/suites?view=make&mode=images&project=ws-suites", "?project=ws-suites&make=image"], ["/suites?suite=viral&page=motion&project=ws-suites", "?project=ws-suites&make=motion"]]) {
    const once = await page.request.get(from, { maxRedirects: 0 });
    expect(once.status(), from).toBe(307);
    expect(new URL(once.headers()["location"], "http://x").search, from).toBe(to);
  }
  expect(errors).toEqual([]);
});

test("⌘K finds a board region, runs the top hit on Enter and closes on Escape", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  await open(page);
  await openSuitesMenu(page);
  await page.getByTestId("header-search").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox").or(dialog.getByRole("textbox")).first().fill("deliver");
  /* The stage pages are the board's regions: Deliver is a place on it. */
  await expect(dialog.getByRole("option").first()).toContainText("Deliver");
  await expect(dialog.getByRole("option").last()).toContainText("Ask Atomik: deliver");
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".gx")).toHaveAttribute("data-screen", "board");
  await expect.poll(() => [param(page, "view"), param(page, "region")]).toEqual(["board", "deliver"]);

  await page.keyboard.press("ControlOrMeta+k");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("assets sit beside every page, drag as their id, and right-click opens the menu inside the viewport", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const wide = WIDE.includes(info.project.name);
  await open(page, "/suites?suite=atomik&page=agent&sp=agent");
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
  await open(page, "/suites?suite=atomik&page=agent&sp=agent");
  await expect(page.getByTestId("inspector")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+j");
  await expect(page.getByTestId("inspector")).toHaveCount(0);
  await expect(page.getByTestId("shell-body")).toHaveAttribute("data-columns", "280px minmax(0,1fr)");
  await page.keyboard.press("ControlOrMeta+j");
  await expect(page.getByTestId("inspector")).toBeVisible();
});

test("the chrome keeps the phone floors: 12px text, 44px targets, no label under #7C7C84", async ({ page }, info) => {
  test.skip(WIDE.includes(info.project.name), "the three phone viewports");
  await open(page, "/suites?suite=atomik&page=agent&sp=agent");
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
  const errors = await open(page, "/suites?suite=particl&page=rig&sp=rig&view=gen&mode=images&sheet=1", false);
  await expect(page.getByTestId("make-panel")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Images" })).toHaveAttribute("aria-selected", "true");
  /* The Rig page is the board: the old address keeps its Make panel over it. */
  await expect(page.locator(".gx")).toHaveAttribute("data-screen", "board");
  expect([param(page, "view"), param(page, "mode"), param(page, "sheet"), param(page, "make")]).toEqual(["board", null, null, "image"]);

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
  await expect.poll(() => [param(page, "mode"), param(page, "make")]).toEqual([null, "video"]);

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
