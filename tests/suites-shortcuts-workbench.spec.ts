import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";

/**
 * The selection keys (⌫, ⌘D, ⌘R) act where the selection is shown, and leave
 * every other press to the browser. Safari, and Firefox on macOS, do not focus
 * a clicked button, so after a click on a Library tile the key arrives at
 * <body>; this suite is Chromium, so the test puts focus back on <body> the
 * way those browsers leave it. Where the last press landed then decides.
 */
const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const fixture = (): Project => ({ ...newProject("Coastal light study"), id: "ws-keys", productionProjectId: "prod-ws", shotMappings: {} });

async function open(page: Page) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, { uploads: [], generations: [generation({ id: "gen_wide", title: "Wide on the water", prompt: "Wide on the water" })] });
  const trashed: unknown[] = [];
  await page.route(/\/api\/jobs\/gen_wide(\?.*)?$/, (route) => {
    if (route.request().method() === "PATCH") { trashed.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } }); }
    return route.fulfill({ json: { generation: generation({ id: "gen_wide", title: "Wide on the water", prompt: "Wide on the water" }) } });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/suites?suite=particl&page=boards&sp=boards");
  await expect(page.getByTestId("project-name")).toHaveText("Coastal light study");
  await page.getByTestId("library").getByRole("tab", { name: /Assets/ }).click();
  /* Record, after the shell's own handler, whether it took each key from the browser. */
  await page.evaluate(() => {
    const w = window as unknown as { taken: string[] };
    w.taken = [];
    window.addEventListener("keydown", (e) => { if (e.defaultPrevented) w.taken.push(e.key); });
  });
  return { trashed, errors };
}

const onPage = (page: Page) => page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); return document.activeElement?.tagName; });
const taken = (page: Page) => page.evaluate(() => (window as unknown as { taken: string[] }).taken.slice());
const mod = process.platform === "darwin" ? "Meta" : "Control";

test("⌫ and ⌘D act on a tile clicked in the Library even when the browser leaves focus on the page; a press elsewhere hands them back", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "the selection keys are a desktop keyboard's");
  const { trashed, errors } = await open(page);
  const tile = page.getByTestId("library").locator(".gx-asset-thumb[data-ctx='asset:generation:gen_wide']");

  /* Safari: the click selects the asset but focus stays on <body>. */
  await tile.click();
  expect(await onPage(page)).toBe("BODY");
  await page.keyboard.press(`${mod}+d`);
  await expect(page.getByTestId("toast")).toHaveText("A generation has one copy. Recreate makes a new take from the same recipe.");
  await page.keyboard.press("Backspace");
  await expect.poll(() => trashed).toEqual([{ trashed: true }]);
  /* The undo entry is pushed once the trash lands; its toast says so. */
  await expect(page.getByTestId("toast")).toHaveText(/^Deleted Wide on the water · ⌘Z to undo/);
  await page.keyboard.press(`${mod}+z`);
  await expect.poll(() => trashed).toEqual([{ trashed: true }, { trashed: false }]);
  await expect(page.getByTestId("toast")).toHaveText("Wide on the water restored");

  /* A press in the Inspector's plain text (Chrome drops focus to <body> there too) still means the selection. */
  await tile.click();
  await page.getByTestId("inspector").locator(".gx-panel-title").click();
  expect(await onPage(page)).toBe("BODY");
  await page.keyboard.press("Backspace");
  await expect.poll(() => trashed).toHaveLength(3);
  await expect(page.getByTestId("toast")).toHaveText(/^Deleted Wide on the water · ⌘Z to undo/);
  await page.keyboard.press(`${mod}+z`);
  await expect.poll(() => trashed).toHaveLength(4);

  /* Selected, then a press on the page title: the keys are the browser's again, and nothing is trashed. */
  await tile.click();
  const before = (await taken(page)).length;
  await page.getByTestId("page-title").click();
  expect(await onPage(page)).toBe("BODY");
  await page.keyboard.press("Backspace");
  await page.keyboard.press(`${mod}+d`);
  expect((await taken(page)).length).toBe(before);
  expect(trashed).toHaveLength(4);

  /* Chrome's own way: the tile keeps focus, and ⌫ acts from it. */
  await tile.click();
  await tile.focus();
  await page.keyboard.press("Backspace");
  await expect.poll(() => trashed).toHaveLength(5);
  expect(errors).toEqual([]);
});
