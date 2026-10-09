import { test, expect, type Page } from "@playwright/test";
import { openLibrary } from "./helpers/libraryV12";

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

  test("a tile drags the one asset payload every drop target reads", async ({ page }) => {
    await openLibrary(page);
    const tile = page.getByTestId("v12-library-tile").first();
    await expect(tile).toBeVisible({ timeout: 60_000 });
    const id = await tile.getAttribute("data-id");
    const carried = await tile.evaluate((el) => {
      const dt = new DataTransfer();
      el.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
      return { id: dt.getData("application/x-particl-id"), text: dt.getData("text/plain") };
    });
    expect(carried).toEqual({ id, text: id });
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
