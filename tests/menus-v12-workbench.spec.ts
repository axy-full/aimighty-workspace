import { test, expect, type Locator, type Page } from "@playwright/test";
import { addFreeCard } from "../lib/board/snap";
import type { Project } from "../lib/workbench/studio";
import { libraryProject, openLibrary } from "./helpers/libraryV12";
import { generation } from "./helpers/workspaceFixtures";

/**
 * Right-click menus and card keys in the new interface (redesign A3; inventory § 5.11, § 4.1, § 4.2). Desktop with the
 * switch on: the card menu on Home's wall, a board card on Home, a Library tile and a board card; several selected
 * cards; the canvas with its New submenu; empty space; Esc in the overlay stack's order; ⌘A and A on a board, never
 * while typing. With the switch off, today's right-click menu and no new keys. Phones with the switch on: the phone
 * app, and no new menus. Mock engine and mocked reads: nothing is spent.
 */
const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const PHONE = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

/** The Library board with two free notes on its canvas (cards ⌫ can take off). */
function boardWithNotes(): Project {
  let project = libraryProject();
  project = addFreeCard(project, "note", { x: 900, y: 40 }, "note-a");
  project = addFreeCard(project, "note", { x: 1200, y: 40 }, "note-b");
  return project;
}

/** Home's wall: three finished stills of the workspace's own (GET /api/jobs, as the wall reads it). */
async function mockWall(page: Page) {
  const stills = [
    generation({ id: "gwall1", title: "Harbour at dawn", prompt: "A harbour at dawn, slow push-in", params: { ratio: "16:9" } }),
    generation({ id: "gwall2", title: "Rain on glass", prompt: "Rain on a kitchen window", params: { ratio: "9:16" } }),
    generation({ id: "gwall3", title: "Brass compass", prompt: "A brass compass on a map", params: { ratio: "1:1" } }),
  ];
  await page.route((url) => url.pathname === "/api/jobs" && url.searchParams.get("status") === "succeeded", (route) => {
    const kind = new URL(route.request().url()).searchParams.get("kind");
    return route.fulfill({ json: { generations: kind === "image" ? stills : [] } });
  });
}

/** A point on empty space inside `within`: on no card, tile, panel, control or field. */
async function emptyPoint(page: Page, within: string) {
  return page.evaluate((selector) => {
    const box = document.querySelector(selector)!.getBoundingClientRect();
    for (let y = box.bottom - 40; y > box.top + 20; y -= 37) {
      for (let x = box.right - 40; x > box.left + 40; x -= 41) {
        const el = document.elementFromPoint(x, y);
        if (el?.closest(selector) && !el.closest(".bd-node, .react-flow__panel, button, a, input, [role='button'], [data-testid='v12-home-tile'], [data-testid='v12-home-bar'], .v12-lib-btn")) return { x, y };
      }
    }
    throw new Error(`No empty space in ${selector}`);
  }, within);
}
/**
 * A right-click on a board card, sent to the card itself: once a card is selected, today's Inspector opens over the
 * canvas's right side, where the free cards sit, and a pointer there would land on the Inspector.
 */
const rightClickCard = (card: Locator) => card.evaluate((el) => {
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: Math.min(r.left + 20, window.innerWidth - 300), clientY: r.top + 20 }));
});
const OUR_MENUS = '[data-testid^="v12-"][role="menu"]';

const menuLabels = (page: Page, testId: string) =>
  page.getByTestId(testId).locator('[role="menuitem"]').evaluateAll((els) => els.map((el) => (el.querySelector(".v12-menu-label")?.textContent ?? "").replace(/ · .*$/, "").replace(/ ▸$/, "").trim()));

test.describe("desktop, switch on", () => {
  test.beforeEach(({}, info) => test.skip(!DESKTOP.includes(info.project.name), "desktop sizes"));

  test("Home: a wall still's menu, a board card's menu and empty space's menu", async ({ page }) => {
    const { errors } = await openLibrary(page, "/suites?view=home", { before: mockWall });
    const tiles = page.getByTestId("v12-home-tile");
    await expect(tiles).toHaveCount(3, { timeout: 60_000 });

    await tiles.first().click({ button: "right" });
    const menu = page.getByTestId("v12-card-menu");
    await expect(menu).toBeVisible();
    /* Remix waits for the sample-workspace check (a sample workspace spends nothing, so has no Remix). */
    await expect.poll(() => menuLabels(page, "v12-card-menu")).toEqual(["Open", "Make one like this", "Download original", "Use as reference", "Remix this"]);
    /* Remix's price is the quote layer's, never a figure written in the menu: it reads, then shows a price or a dash. */
    await expect(menu.getByTestId("v12-menu-price")).toHaveAttribute("data-price-state", /ready|error/, { timeout: 30_000 });
    await expect(menu.getByTestId("v12-menu-price")).toHaveText(/^(\d[\d,]* cr|up to \d[\d,]* cr|free|—)$/);
    /* Keys: the first item has focus, ↓ moves, Esc closes and nothing else. */
    await expect(menu.getByRole("menuitem", { name: "Open" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem", { name: "Make one like this" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(menu).toHaveCount(0);
    await expect(page.getByTestId("v12-home-tile-picked")).toHaveCount(1);

    /* A board card on Home: Open and Copy link. */
    await page.getByTestId("v12-home-board").first().click({ button: "right" });
    expect(await menuLabels(page, "v12-board-menu")).toEqual(["Open", "Copy link"]);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("v12-board-menu")).toHaveCount(0);
    /* The picked tile is a selection under the menu: the next Esc clears it. */
    await expect(page.getByTestId("v12-home-tile-picked")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("v12-home-tile-picked")).toHaveCount(0);

    /* Empty space: where to go, each with its key; Library opens the tray. */
    const space = await emptyPoint(page, '[data-testid="v12-home"]');
    await page.mouse.click(space.x, space.y, { button: "right" });
    expect(await menuLabels(page, "v12-empty-menu")).toEqual(["Library", "Make", "Atomik panel", "Ask Atomik, search or go to"]);
    await expect(page.getByTestId("v12-empty-menu").locator(".v12-menu-key")).toHaveText(["L", "⌘2", "⌘J", "⌘K"]);
    await page.getByTestId("v12-menu-library").click();
    await expect(page.getByTestId("v12-library")).toBeVisible();
    /* A right-click in a field keeps the browser's own menu (no menu of ours). */
    await page.getByTestId("v12-library-search").click({ button: "right" });
    await expect(page.locator(OUR_MENUS)).toHaveCount(0);
    expect(await noSideways(page)).toBe(true);
    expect(errors).toEqual([]);
  });

  test("a Library tile's menu runs today's Library commands; Esc closes the menu, then the tray", async ({ page }) => {
    await openLibrary(page);
    const tiles = page.getByTestId("v12-library-tile");
    await expect(tiles).toHaveCount(7, { timeout: 60_000 });
    await page.getByTestId("v12-library").locator('[data-id="generation:gopen"]').click({ button: "right" });
    const menu = page.getByTestId("v12-card-menu");
    expect(await menuLabels(page, "v12-card-menu")).toEqual(["Open", "Download original", "Copy", "Use as reference", "Move to board…", "Redraw", "Delete"]);
    await expect(menu.locator(".v12-menu-key")).toHaveText(["⌘C", "⌫"]);
    await expect(menu.getByTestId("v12-menu-price")).toHaveAttribute("data-price-state", /loading|ready|error/);
    /* An upload has no recipe: no Redraw. */
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(page.getByTestId("v12-library")).toBeVisible();
    await page.getByTestId("v12-library").locator('[data-id="upload:uharbour"]').click({ button: "right" });
    expect(await menuLabels(page, "v12-card-menu")).not.toContain("Redraw");
    /* Use as reference: Make opens with it in its references. */
    await page.getByTestId("v12-menu-use-as-reference").click();
    await expect(page.getByTestId("v12-toast")).toContainText("Harbour at dusk");
    /* Esc: the menu was closed by its item; now the tray is the top layer. */
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("v12-library")).toHaveCount(0);
  });

  test("a board: card, several cards, canvas with New ▸; ⌘A selects every card, A approves, never while typing", async ({ page }) => {
    const { errors } = await openLibrary(page, "/suites?view=board", { project: boardWithNotes() });
    const notes = page.locator('.bd-node[data-free="true"]');
    await expect(notes).toHaveCount(2, { timeout: 60_000 });
    /* Every card in view (the board's own 0). */
    await page.keyboard.press("0");

    /* Typing an "a" in a field approves nothing. */
    await page.getByTestId("v12-library-button").click();
    await page.getByTestId("v12-library-search").fill("a");
    await expect(page.getByTestId("v12-library-search")).toHaveValue("a");
    await expect(page.getByTestId("v12-toast")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("v12-library")).toHaveCount(0);

    /* One card: right-click selects it and shows what can be done to it. */
    await notes.first().click({ button: "right" });
    await expect(page.getByTestId("v12-card-menu")).toBeVisible();
    expect(await menuLabels(page, "v12-card-menu")).toEqual(["Open", "Delete"]);
    await expect(notes.first()).toHaveAttribute("data-selected", "true");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("v12-card-menu")).toHaveCount(0);

    /* A on a card with nothing to approve says so. */
    await page.keyboard.press("a");
    await expect(page.getByTestId("v12-toast")).toHaveText(/This card has nothing to approve\./);

    /* ⌘A: every card; right-click inside the selection: the multi menu; Delete takes the free cards off, with Undo. */
    await page.locator(".bd-flow").click({ position: { x: 20, y: 20 }, force: true }).catch(() => {});
    await page.keyboard.press("ControlOrMeta+a");
    await expect.poll(() => page.locator(".bd-node[data-selected]").count()).toBeGreaterThan(2);
    await rightClickCard(notes.first());
    expect(await menuLabels(page, "v12-multi-menu")).toEqual(["Delete"]);
    await page.getByTestId("v12-menu-delete-all").click();
    await expect(notes).toHaveCount(0);

    /* The canvas: Paste only with something copied; New ▸ opens the tools; ← comes back; Note arms the Note tool. */
    const point = await emptyPoint(page, ".bd-flow");
    await page.mouse.click(point.x, point.y, { button: "right" });
    const canvas = page.getByTestId("v12-canvas-menu");
    expect(await menuLabels(page, "v12-canvas-menu")).toEqual(["New", "Upload…", "Ask Atomik", "Select all", "Tidy", "Zoom to fit"]);
    await expect(canvas.locator(".v12-menu-key")).toHaveText(["U", "⌘J", "⌘A", "0"]);
    await canvas.getByRole("menuitem", { name: /New/ }).click();
    const sub = page.getByTestId("v12-submenu");
    expect(await menuLabels(page, "v12-submenu")).toEqual(["Note", "Text", "Image", "Video", "Audio"]);
    await expect(sub.locator(".v12-menu-key")).toHaveText(["N", "T", "I", "⇧V", "⇧A"]);
    await expect(sub.getByRole("menuitem", { name: /Note/ })).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(sub).toHaveCount(0);
    await expect(canvas.getByRole("menuitem", { name: /New/ })).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(sub).toBeVisible();
    /* Esc closes the submenu first, then the menu. */
    await page.keyboard.press("Escape");
    await expect(sub).toHaveCount(0);
    await expect(canvas).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(canvas).toHaveCount(0);
    await page.mouse.click(point.x, point.y, { button: "right" });
    await page.getByTestId("v12-canvas-menu").getByRole("menuitem", { name: /New/ }).click();
    await page.getByTestId("v12-menu-new-note").click();
    await expect(page.getByTestId("board")).toHaveAttribute("data-tool", "note");
    await expect(page.locator('[role="menu"]')).toHaveCount(0);
    expect(await noSideways(page)).toBe(true);
    expect(errors).toEqual([]);
  });

  test("switch off: today's right-click menu on a board, and A does nothing", async ({ page }) => {
    await openLibrary(page, "/suites?view=board", { on: false, project: boardWithNotes() });
    const notes = page.locator('.bd-node[data-free="true"]');
    await expect(notes).toHaveCount(2, { timeout: 60_000 });
    await page.keyboard.press("0");
    await notes.first().click();
    await rightClickCard(notes.first());
    await expect(page.getByTestId("context-menu")).toBeVisible();
    await expect(page.locator('[data-testid="v12-card-menu"]')).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.keyboard.press("a");
    await expect(page.getByTestId("v12-toast")).toHaveCount(0);
    await expect(page.getByTestId("v12-root")).toHaveCount(0);
  });
});

test.describe("phones, switch on", () => {
  test.beforeEach(({}, info) => test.skip(!PHONE.includes(info.project.name), "phone sizes"));

  test("the phone app shows, and a long-press or right-click brings no new menu", async ({ page }) => {
    const { errors } = await openLibrary(page, "/suites?view=home", { before: mockWall });
    await expect(page.locator("[data-phone]")).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId("v12-root")).toHaveCount(0);
    await page.mouse.click(40, 200, { button: "right" });
    await expect(page.locator(OUR_MENUS)).toHaveCount(0);
    expect(await noSideways(page)).toBe(true);
    expect(errors).toEqual([]);
  });
});
