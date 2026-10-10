import { test, expect, type Page } from "@playwright/test";
import { openLibrary } from "./helpers/libraryV12";
import { signInToRedesign } from "./helpers/newInterface";
import { forbidPaidWork } from "./helpers/workspaceFixtures";

/**
 * The Library tray in the new interface (docs/redesign-plan.md, item C4; components/v12/library/LibraryTray.tsx).
 * Desktop with the switch on: the tray from the address, the button and L; search on the server; the library picker;
 * Uploaded/Generated; kinds from the board's cards; the stubs; drag payload; Expand; Esc; no sideways scroll.
 * Phones with the switch on: the phone app, with no tray and no button.
 */
const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const PHONE = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test.describe("desktop, switch on", () => {
  test.beforeEach(({}, info) => test.skip(!DESKTOP.includes(info.project.name), "desktop sizes"));

  test("the tray opens from the address with the board's library: badges, kinds from its cards, masonry", async ({ page }) => {
    const { errors } = await openLibrary(page);
    const tray = page.getByTestId("v12-library");
    await expect(tray).toBeVisible({ timeout: 60_000 });
    const box = await tray.boundingBox();
    expect(Math.round(box!.width)).toBe(360);
    const tiles = page.getByTestId("v12-library-tile");
    await expect(tiles).toHaveCount(7);
    await expect(tray.locator('[data-source="Uploaded"].v12-lib-tile')).toHaveCount(3);
    await expect(tray.locator('[data-source="Generated"].v12-lib-tile')).toHaveCount(4);
    /* Two columns. */
    const xs = new Set(await tiles.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().left))));
    expect(xs.size).toBe(2);
    /* Source filter. */
    await tray.getByRole("radio", { name: "Uploaded" }).click();
    await expect(tiles).toHaveCount(3);
    await tray.getByRole("radio", { name: "Generated" }).click();
    await expect(tiles).toHaveCount(4);
    await tray.getByRole("radio", { name: "All" }).click();
    /* Kinds from the board's cards: one character, one location, one prop; Everything made is every generated item. */
    for (const [kind, n, name] of [["Characters", 1, "Lead actor"], ["Locations", 1, "Harbour at dusk"], ["Props", 1, "Brass lamp"], ["Everything made", 4, null]] as const) {
      await tray.getByRole("button", { name: kind, exact: true }).click();
      await expect(tiles).toHaveCount(n);
      if (name) await expect(tiles.first()).toContainText(name);
    }
    /* Products and Mandatories have no kind in today's code: the chip says so, with nothing invented. */
    await tray.getByRole("button", { name: "Products", exact: true }).click();
    await expect(page.getByTestId("v12-library-stub")).toContainText("Products are not a kind in the Library yet.");
    await expect(page).toHaveURL(/libkind=Products/);
    expect(await noSideways(page)).toBe(true);
    expect(errors).toEqual([]);
  });

  test("search runs on the server, for this board's library; the picker browses another board's library", async ({ page }) => {
    const { reads, project } = await openLibrary(page);
    await expect(page.getByTestId("v12-library-tile")).toHaveCount(7, { timeout: 60_000 });
    await page.getByTestId("v12-library-search").fill("harbour");
    await expect(page.getByTestId("v12-library-tile")).toHaveCount(1);
    expect(reads.filter((r) => r.q === "harbour").map((r) => [r.projectId, r.source]).sort()).toEqual([[project.id, "generations"], [project.id, "uploads"]]);
    await page.getByTestId("v12-library-search").fill("nothing like this");
    await expect(page.getByTestId("v12-library")).toContainText("matches “nothing like this”");
    await page.getByTestId("v12-library-search").fill("");
    await page.getByTestId("v12-library-picker").click();
    await page.getByRole("menuitem", { name: "Spring campaign" }).click();
    await expect(page.getByTestId("v12-library-picker")).toContainText("Spring campaign");
    await expect(page.getByTestId("v12-library-tile")).toHaveCount(1);
    expect(reads.some((r) => r.projectId === "ws-other")).toBe(true);
  });

  test("the button and L open and close it, Esc closes it, and Expand opens today's library wall", async ({ page }) => {
    await openLibrary(page, "/suites?view=board");
    const button = page.getByTestId("v12-library-button");
    await expect(button).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("v12-library")).toHaveCount(0);
    await button.click();
    await expect(page.getByTestId("v12-library")).toBeVisible();
    await expect(page).toHaveURL(/drawer=Library/);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("v12-library")).toHaveCount(0);
    await page.locator("body").click({ position: { x: 700, y: 400 } }).catch(() => {});
    await page.keyboard.press("l");
    await expect(page.getByTestId("v12-library")).toBeVisible();
    /* Typing in the search never toggles it. */
    await page.getByTestId("v12-library-search").fill("l");
    await expect(page.getByTestId("v12-library")).toBeVisible();
    await page.getByTestId("v12-library-search").blur();
    await page.keyboard.press("l");
    await expect(page.getByTestId("v12-library")).toHaveCount(0);
    await button.click();
    await page.getByTestId("v12-library-expand").click();
    await expect(page).toHaveURL(/make=recent/);
  });

  test("a tile dropped on the canvas becomes a card; a search hit past the loaded pages too; another board's tiles do not drag", async ({ page }) => {
    await openLibrary(page);
    const tray = page.getByTestId("v12-library");
    await expect(page.getByTestId("v12-library-tile")).toHaveCount(7, { timeout: 60_000 });
    const nodes = page.locator(".react-flow__node");
    const pane = page.locator(".react-flow__pane");
    const box = (await pane.boundingBox())!;
    const target = { x: box.width - 260, y: box.height - 220 };
    /* The payload every drop target reads. */
    const first = page.getByTestId("v12-library-tile").first();
    const id = await first.getAttribute("data-id");
    const carried = await first.evaluate((el) => {
      const dt = new DataTransfer();
      el.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
      return { id: dt.getData("application/x-particl-id"), text: dt.getData("text/plain") };
    });
    expect(carried).toEqual({ id, text: id });
    /* A loaded tile: dropped on empty canvas, it is a card. */
    const before = await nodes.count();
    await tray.locator('[data-id="upload:uharbour"]').dragTo(pane, { targetPosition: target });
    await expect(nodes).toHaveCount(before + 1);
    /* A search hit the board's loaded Library does not hold: looked up by id, then placed. */
    await page.getByTestId("v12-library-search").fill("archive");
    await expect(page.getByTestId("v12-library-tile")).toHaveCount(1);
    await tray.locator('[data-id="upload:uarchive"]').dragTo(pane, { targetPosition: { x: target.x - 200, y: target.y } });
    await expect(nodes).toHaveCount(before + 2);
    /* Another board's library: browsable, not draggable onto this board. */
    await page.getByTestId("v12-library-search").fill("");
    await page.getByTestId("v12-library-picker").click();
    await page.getByRole("menuitem", { name: "Spring campaign" }).click();
    await expect(page.getByTestId("v12-library-tile")).toHaveCount(1);
    await expect(page.getByTestId("v12-library-tile").first()).toHaveAttribute("draggable", "false");
  });

  test("Esc and × give focus back; the search has it on open; L is ignored while a menu is open", async ({ page }) => {
    await openLibrary(page, "/suites?view=board");
    const button = page.getByTestId("v12-library-button");
    await expect(button).toBeVisible({ timeout: 60_000 });
    await button.click();
    await expect(page.getByTestId("v12-library-search")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("v12-library")).toHaveCount(0);
    await expect(button).toBeFocused();
    await button.click();
    await page.getByTestId("v12-library-close").click();
    await expect(button).toBeFocused();
    await button.click();
    await page.getByTestId("v12-library-picker").click();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.getByRole("menu").press("l");
    await expect(page.getByTestId("v12-library")).toBeVisible();
  });

  test("with no board at all (a new person on Home), the tray says the Library is empty, never Reading", async ({ page }) => {
    await signInToRedesign(page.request);
    await forbidPaidWork(page);
    await page.route("**/api/workbench/projects**", (route) => route.request().method() === "GET"
      ? route.fulfill({ json: { projects: [], productions: [], project: null, revision: 1, shared: null } })
      : route.fulfill({ status: 400, json: { error: "Unexpected projects request in a workspace test." } }));
    await page.goto("/suites?view=home&drawer=Library");
    const tray = page.getByTestId("v12-library");
    await expect(tray).toBeVisible({ timeout: 60_000 });
    await expect(tray.getByText("Nothing in this library yet.")).toBeVisible();
    await expect(tray.getByText("Reading the Library…")).toHaveCount(0);
  });

  test("a held L never reaches the board's list key, and L gives focus back where it was pressed", async ({ page }) => {
    await openLibrary(page, "/suites?view=board");
    const button = page.getByTestId("v12-library-button");
    await expect(button).toBeVisible({ timeout: 60_000 });
    /* The new frame's view switch (Canvas · List · Strip · Rig): the board is on Canvas, and stays there. */
    const view = page.getByTestId("v12-view-switch");
    await expect(view.getByRole("radio", { name: "Canvas" })).toBeChecked({ timeout: 60_000 });
    /* A held key: the first press opens the tray, the repeats do nothing, and the board never switches to List. */
    await page.locator(".react-flow__pane").click({ position: { x: 300, y: 300 } });
    await page.keyboard.down("l");
    await page.evaluate(() => { for (let i = 0; i < 3; i++) window.dispatchEvent(new KeyboardEvent("keydown", { key: "l", repeat: true, bubbles: true, cancelable: true })); });
    await page.keyboard.up("l");
    await expect(page.getByTestId("v12-library")).toBeVisible();
    await expect(view.getByRole("radio", { name: "Canvas" })).toBeChecked();
    await expect(view.getByRole("radio", { name: "List" })).not.toBeChecked();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("v12-library")).toHaveCount(0);
    /* Opened with L from a focused control in the header: closing gives focus back to that control, not the Library button. */
    const from = page.getByTestId("v12-head").locator("button:visible").first();
    await from.focus();
    await expect(from).toBeFocused();
    await page.keyboard.press("l");
    await expect(page.getByTestId("v12-library-search")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(from).toBeFocused();
  });

  test("switch off: L still toggles the board's list, and there is no tray", async ({ page }) => {
    await openLibrary(page, "/suites?view=board", { on: false });
    const toggle = page.getByTestId("board-list-toggle");
    await expect(toggle).toHaveAttribute("aria-selected", "false", { timeout: 60_000 });
    await page.locator(".react-flow__pane").click({ position: { x: 300, y: 300 } });
    await page.keyboard.press("l");
    await expect(toggle).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("v12-library")).toHaveCount(0);
    await expect(page.getByTestId("v12-library-button")).toHaveCount(0);
  });
});

test.describe("phones, switch on", () => {
  test.beforeEach(({}, info) => test.skip(!PHONE.includes(info.project.name), "phone sizes"));

  test("the phone app shows, with no tray and no Library button", async ({ page }) => {
    const { errors } = await openLibrary(page);
    await expect(page.locator("[data-phone]")).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId("v12-library")).toHaveCount(0);
    await expect(page.getByTestId("v12-library-button")).toHaveCount(0);
    expect(await noSideways(page)).toBe(true);
    expect(errors).toEqual([]);
  });
});
