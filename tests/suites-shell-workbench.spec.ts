import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, upload } from "./helpers/workspaceFixtures";
import { openSuitesMenu } from "./helpers/suitesMenu";
import { projectName } from "./helpers/projectName";
import { isCompact } from "./helpers/shellMode";

/**
 * The Suites shell's address handling and ⌘K (design/particl-graphite/README.md): old links are sent to the new screens, ⌘K finds a board
 * region, Make's type and tab are its address. The shell's old chrome (the numbered stage strip, the Library and Inspector columns, the
 * suite header with Atomik's pages) these tests used to assert is gone with the old screens (Q15); the new screens have their own specs.
 */

const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];

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
  if (named) await expect(projectName(page)).toHaveText("Coastal light study");
  return errors;
}

const param = (page: Page, key: string) => new URL(page.url()).searchParams.get(key);

test("an old link in the design file's spelling is sent, with a 307, to the app's page; its other params ride along", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.skip(isCompact(info), "the phone app draws no header or desktop Make; the phone screens are covered by demo-s10-phone-* and r1-phone-*");
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
  /* The app's own links to a page that is a board's card are sent to it (one 307). */
  expect((await page.request.get("/suites?suite=moleculr&page=marketing&sp=hooks", { maxRedirects: 0 })).status()).toBe(307);
  expect((await page.request.get("/suites?suite=subatomik&page=history&sp=history", { maxRedirects: 0 })).status()).toBe(307);
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
  test.skip(isCompact(info), "the phone app draws no header or desktop Make; the phone screens are covered by demo-s10-phone-* and r1-phone-*");
  await open(page);
  await openSuitesMenu(page);
  await page.getByTestId("header-search").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox").or(dialog.getByRole("textbox")).first().fill("go to deliver");
  /* The stage pages are the board's regions: Deliver is a place on it, and "go to" names it first (a bare word is a question for Atomik, whose card answers below the list). */
  await expect(dialog.getByRole("option").first()).toContainText("Go to Deliver");
  /* The new interface's hits carry no "Ask Atomik" row (lib/shell/palette.ts): Atomik answers in its own card. */
  await expect(dialog.getByRole("option").filter({ hasText: /Ask Atomik/ })).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".gx")).toHaveAttribute("data-screen", "board");
  await expect.poll(() => [param(page, "view"), param(page, "region")]).toEqual(["board", "deliver"]);

  await page.keyboard.press("ControlOrMeta+k");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("an old Gen link lands on the page it names with Make open on its type, server and client, and no link breaks", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.skip(isCompact(info), "the phone app draws no header or desktop Make; the phone screens are covered by demo-s10-phone-* and r1-phone-*");
  /* Server: the redirect happens before anything renders, and keeps the rest of the query. */
  const errors = await open(page, "/suites?suite=particl&page=rig&sp=rig&view=gen&mode=images&sheet=1", false);
  await expect(page.getByTestId("make-panel")).toBeVisible();
  await expect(page.getByTestId("make-type-image")).toHaveAttribute("aria-checked", "true");
  /* The Rig page is the board: the old address keeps its Make panel over it. */
  await expect(page.locator(".gx")).toHaveAttribute("data-screen", "board");
  expect([param(page, "view"), param(page, "mode"), param(page, "sheet"), param(page, "make")]).toEqual(["board", null, null, "image"]);

  /* Make's type and tab are its address: a switch rewrites it, Recent included. */
  await page.getByTestId("make-type-audio").click();
  await expect.poll(() => param(page, "make")).toBe("audio");
  await page.getByTestId("make-tab-recent").click();
  await expect.poll(() => param(page, "make")).toBe("recent");
  await page.getByTestId("make-tab-make").click();
  await expect.poll(() => param(page, "make")).toBe("audio");
  await expect(page.getByTestId("gen-prompt")).toBeVisible();

  /* Client: an entry with the old address (history, a pasted URL inside the app) reads as Make too. */
  await page.evaluate(() => { history.pushState(null, "", "/suites?view=gen&mode=video"); dispatchEvent(new PopStateEvent("popstate")); });
  await expect(page.getByTestId("make-type-video")).toHaveAttribute("aria-checked", "true");
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
