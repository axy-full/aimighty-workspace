import { test, expect, type Page } from "@playwright/test";
import { addFreeCard } from "../../lib/board/snap";
import { captureBeside, closePrototypeServer } from "../helpers/redesignShots";
import { libraryProject, openLibrary } from "../helpers/libraryV12";

/*
 * Right-click menus (redesign A3) beside the prototype's. The prototype has no URL for a menu (inventory § 2: reached
 * only by right-clicking), so its page is opened at the board (`?view=board&frame=3`) and right-clicked there:
 *  - menus: a card's menu (a Library file on a board here; a storyboard card there);
 *  - menus-canvas: the canvas menu.
 * Neutral data of the test workspace's own; mocked reads, nothing spent.
 */
test.afterAll(closePrototypeServer);

/** Right-clicks the prototype's first board card. */
async function protoCardMenu(proto: Page) {
  const card = proto.locator("#canvas img").first();
  await card.waitFor({ state: "visible", timeout: 15_000 });
  await card.click({ button: "right", force: true });
}

/** Right-clicks empty canvas in the prototype. */
async function protoCanvasMenu(proto: Page) {
  const at = await proto.evaluate(() => {
    const canvas = document.getElementById("canvas")!.getBoundingClientRect();
    for (let y = canvas.top + canvas.height * 0.3; y < canvas.bottom - 300; y += 31) {
      for (let x = canvas.left + canvas.width * 0.35; x < canvas.right - 300; x += 37) {
        /* The canvas itself or its card layer, never a card on it. */
        const el = document.elementFromPoint(x, y) as HTMLElement | null;
        const canvasEl = document.getElementById("canvas");
        if (el && (el === canvasEl || el.parentElement === canvasEl)) return { x, y };
      }
    }
    return { x: canvas.left + canvas.width / 2, y: canvas.bottom - 160 };
  });
  await proto.mouse.click(at.x, at.y, { button: "right" });
}

test("a card's menu beside the prototype's", async ({ page }) => {
  test.setTimeout(180_000);
  await openLibrary(page);
  await expect(page.getByTestId("v12-library-tile")).toHaveCount(7, { timeout: 90_000 });
  await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLImageElement>('[data-testid="v12-library"] img')).every((img) => img.complete), null, { timeout: 30_000 });
  const tile = page.getByTestId("v12-library").locator('[data-id="generation:gopen"]');
  const box = (await tile.boundingBox())!;
  await tile.click({ button: "right", position: { x: box.width * 0.7, y: box.height * 0.4 } });
  const menu = page.getByTestId("v12-card-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByTestId("v12-menu-price")).toHaveAttribute("data-price-state", /ready|error/, { timeout: 30_000 });
  await captureBeside(page, "menus", "?view=board&frame=3", protoCardMenu);
});

test("the canvas menu beside the prototype's", async ({ page }) => {
  test.setTimeout(180_000);
  let project = libraryProject();
  project = addFreeCard(project, "note", { x: 900, y: 40 }, "note-a");
  await openLibrary(page, "/suites?view=board", { project });
  await expect(page.locator('.bd-node[data-free="true"]')).toHaveCount(1, { timeout: 90_000 });
  await page.keyboard.press("0");
  await page.waitForTimeout(800);
  const flow = (await page.locator(".bd-flow").boundingBox())!;
  const at = await page.evaluate(({ left, top, width, height }) => {
    for (let y = top + height - 160; y > top + 40; y -= 31) {
      for (let x = left + width - 320; x > left + 40; x -= 37) {
        const el = document.elementFromPoint(x, y);
        if (el?.closest(".bd-flow") && !el.closest(".bd-node, .react-flow__panel, button, a, [role='button']")) return { x, y };
      }
    }
    throw new Error("no empty canvas");
  }, { left: flow.x, top: flow.y, width: flow.width, height: flow.height });
  await page.mouse.click(at.x, at.y, { button: "right" });
  await expect(page.getByTestId("v12-canvas-menu")).toBeVisible();
  await page.mouse.move(at.x + 400, at.y);
  await captureBeside(page, "menus-canvas", "?view=board&frame=3", protoCanvasMenu);
});
