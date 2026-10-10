import { test, expect, type Page } from "@playwright/test";
import { openShotsBoard } from "./helpers/shotsV12";

/**
 * The Shots stage grid and the board's bar in the new interface (redesign P2-b; docs/redesign/inventory.md § 6.6, § 5.8,
 * § 6.8; FIX § 13.2). Desktop with the switch on: shots 4 across (Atomik's panel closed) with one 24 px gap for rows and
 * columns, every shot card one size whatever its state, so no row leaves ~100 px of empty canvas; the bar with Attach,
 * @, the selection and armed-tool chips, and Ask priced as today's board ask is, sent with that figure as its limit.
 * Switch off: today's board. Phones with the switch on: today's phone board, no bar.
 */
const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const PHONE = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const shots = (page: Page) => page.locator('.bd-node[data-card-kind="take"]');
const boxes = (page: Page) => shots(page).evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; }));
const overlap = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Atomik's docked panel closed, as the prototype's Shots view is drawn; the grid follows the canvas's new width. */
async function closeDock(page: Page) {
  const collapse = page.getByTestId("agent-collapse");
  if (await collapse.isVisible().catch(() => false)) await collapse.click();
  await expect(page.getByTestId("board-agent-panel")).toHaveCount(0);
}

test.describe("desktop, switch on", () => {
  test.beforeEach(({}, info) => test.skip(!DESKTOP.includes(info.project.name), "desktop sizes"));

  test("Shots: 4 across, one 24 px gap for rows and columns, one card size for finished, rendering and empty shots", async ({ page }) => {
    const { errors } = await openShotsBoard(page);
    await expect(shots(page)).toHaveCount(8, { timeout: 90_000 });
    await closeDock(page);
    await expect.poll(async () => new Set((await boxes(page)).map((b) => b.x)).size).toBe(4);
    const b = await boxes(page);
    /* Mixed states on the same rows. */
    const states = await shots(page).evaluateAll((els) => els.map((el) => el.querySelector("[data-status]")?.getAttribute("data-status")));
    expect(new Set(states)).toEqual(new Set(["review", "rendering", "empty"]));
    /* One size. */
    expect(new Set(b.map((x) => x.w))).toEqual(new Set([260]));
    expect(new Set(b.map((x) => x.h)).size).toBe(1);
    /* Columns 24 apart; rows 24 apart: the next row starts right under the tallest card of the one above. */
    const xs = [...new Set(b.map((x) => x.x))].sort((p, q) => p - q);
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1] - 260).toBe(24);
    const ys = [...new Set(b.map((x) => x.y))].sort((p, q) => p - q);
    expect(ys).toHaveLength(2);
    expect(ys[1] - ys[0] - b[0].h).toBe(24);
    expect(await noSideways(page)).toBe(true);
    expect(errors).toEqual([]);
  });

  test("with Atomik's panel open the canvas is narrower and the grid takes 3 across, still one gap", async ({ page }) => {
    await openShotsBoard(page);
    await expect(shots(page)).toHaveCount(8, { timeout: 90_000 });
    if (!(await page.getByTestId("board-agent-panel").isVisible().catch(() => false))) await page.getByTestId("agent-rail").click();
    await expect(page.getByTestId("board-agent-panel")).toBeVisible();
    const across = page.viewportSize()!.width >= 1900 ? 4 : 3;
    await expect.poll(async () => new Set((await boxes(page)).map((b) => b.x)).size).toBe(across);
    const b = await boxes(page);
    const ys = [...new Set(b.map((x) => x.y))].sort((p, q) => p - q);
    for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1] - b[0].h).toBe(24);
  });

  test("the bar: Attach, @, the selection and tool chips, and Ask at today's ask price, sent with it as the limit", async ({ page }) => {
    const { errors } = await openShotsBoard(page);
    await expect(shots(page)).toHaveCount(8, { timeout: 90_000 });
    await closeDock(page);
    const bar = page.getByTestId("v12-board-bar");
    await expect(bar).toBeVisible();
    const input = page.getByTestId("v12-board-bar-inner-input");
    await expect(input).toHaveAttribute("placeholder", "Ask for a change, add a shot, or paste client feedback");
    /* Clear of the bottom-left controls and the right toolbar. */
    const at = (await bar.boundingBox())!;
    for (const id of ["v12-view-switch", "v12-board-tools", "v12-library-button"]) {
      const other = await page.getByTestId(id).boundingBox();
      if (other) expect(overlap(at, other), `bar over ${id}`).toBe(false);
    }
    expect(at.width).toBeGreaterThanOrEqual(300);
    expect(at.width).toBeLessThanOrEqual(720);

    /* Ask's price is the board ask's, from the quote layer: "up to N cr" (or a dash while it cannot be read), never a written figure. */
    const price = page.getByTestId("v12-board-bar-price");
    await expect(price).toHaveAttribute("data-price-state", /ready|error/, { timeout: 30_000 });
    const priceText = (await price.innerText()).trim();
    expect(priceText).toMatch(/^(up to \d[\d,]* cr|—)$/);

    /* The selection: a chip with the card, × clears it; the words then say which card they are about. */
    await shots(page).first().click();
    const chip = page.getByTestId("v12-board-bar-selection");
    await expect(chip).toBeVisible();
    const crumb = (await chip.innerText()).replace("×", "").trim();
    await expect(input).toHaveAttribute("placeholder", `Ask for a change to ${crumb}`);
    await chip.getByRole("button", { name: "Clear the selection · Esc" }).click();
    await expect(chip).toHaveCount(0);
    await expect(shots(page).first()).not.toHaveAttribute("data-selected", "true");

    /* An armed Note: its chip, and × puts the tool down. */
    await page.locator(".bd-flow").click({ position: { x: 10, y: 10 }, force: true }).catch(() => {});
    await page.keyboard.press("n");
    const tool = page.getByTestId("v12-board-bar-tool");
    await expect(tool).toContainText("Note · click the canvas");
    await tool.getByRole("button", { name: "Cancel" }).click();
    await expect(tool).toHaveCount(0);
    await expect(page.getByTestId("board")).toHaveAttribute("data-tool", "select");

    /* @ lists this board's Library; picking one writes its name into the words. */
    await input.click();
    await input.fill("Warmer light on @");
    const list = page.getByTestId("v12-board-bar-inner-mentions");
    await expect(list).toBeVisible();
    const first = (await list.getByTestId("v12-board-bar-inner-mention").first().innerText()).split("\n")[0].trim();
    await list.getByTestId("v12-board-bar-inner-mention").first().click();
    await expect(input).toHaveValue(`Warmer light on @${first} `);

    /* Ask: sent as today's ask (agent.plan), with the figure on the button as its limit. The route answers a refusal here, so nothing runs. */
    if (priceText.startsWith("up to")) {
      await shots(page).nth(1).click();
      const sentCrumb = (await page.getByTestId("v12-board-bar-selection").innerText()).replace("×", "").trim();
      let body: Record<string, unknown> | null = null;
      await page.route("**/api/workbench/team-canvas", async (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        body = route.request().postDataJSON() as Record<string, unknown>;
        return route.fulfill({ status: 409, json: { error: "Stopped by the test before anything ran." } });
      });
      await page.getByTestId("v12-board-bar-ask").click();
      await expect(page.getByTestId("v12-board-bar-inner-note")).toContainText("Stopped by the test");
      expect(body).not.toBeNull();
      expect(body!.action).toBe("agent.plan");
      expect(body!.limit).toBe(Number(priceText.replace(/[^\d]/g, "")));
      expect(String(body!.goal)).toContain(`About ${sentCrumb}: Warmer light on @${first}`);
    }

    /* Attach: today's upload into this board's Library; a picture lands on the canvas. */
    const before = await page.locator(".bd-node").count();
    await page.getByTestId("v12-board-bar-inner-attach-input").setInputFiles("public/campaign/hero.webp");
    await expect.poll(() => page.locator(".bd-node").count(), { timeout: 30_000 }).toBeGreaterThan(before);
    expect(await noSideways(page)).toBe(true);
    expect(errors).toEqual([]);
  });

  test("switch off: today's board, with no bar and today's shot cards", async ({ page }) => {
    await openShotsBoard(page, "/suites?view=board", { on: false });
    await expect(shots(page)).toHaveCount(8, { timeout: 90_000 });
    await expect(page.getByTestId("v12-board-bar")).toHaveCount(0);
    expect(new Set((await boxes(page)).map((b) => b.w)).has(260)).toBe(false);
  });
});

test.describe("phones, switch on", () => {
  test.beforeEach(({}, info) => test.skip(!PHONE.includes(info.project.name), "phone sizes"));

  test("today's phone board: no bar of the new frame, no sideways scroll", async ({ page }) => {
    const { errors } = await openShotsBoard(page, "/suites?view=board");
    await expect(page.locator("[data-phone], [data-testid='phone-app']").first()).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId("v12-board-bar")).toHaveCount(0);
    expect(await noSideways(page)).toBe(true);
    expect(errors).toEqual([]);
  });
});
