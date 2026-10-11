import { test, expect, type Page } from "@playwright/test";
import { openShotsBoard } from "./helpers/shotsV12";
import { openBoard, filmBoard } from "./helpers/boardV12";

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
const frames = (page: Page) => page.locator('.bd-node[data-card-kind="frame"]');
const overlap = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Atomik's docked panel closed, as the prototype's Shots view is drawn; the grid follows the canvas's new width. */
async function closeDock(page: Page) {
  /* Today's dock opens itself on Atomik's questions, a moment after the board loads (more than once): fold it until it has stayed folded for 2 s. */
  const collapse = page.getByTestId("agent-collapse");
  await collapse.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
  let quiet = 0;
  await expect.poll(async () => {
    if (await collapse.isVisible().catch(() => false)) { await collapse.click({ timeout: 2_000 }).catch(() => {}); quiet = 0; return false; }
    quiet = (await page.getByTestId("board-agent-panel").count()) === 0 ? quiet + 1 : 0;
    return quiet >= 8;
  }, { timeout: 30_000, intervals: [250] }).toBe(true);
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
    /* Today's dock opens itself a moment after the board loads: open it if it has not, and let it settle. */
    await expect.poll(async () => {
      if (!(await page.getByTestId("board-agent-panel").isVisible().catch(() => false)) && (await page.getByTestId("agent-rail").isVisible().catch(() => false))) await page.getByTestId("agent-rail").click({ timeout: 2_000 }).catch(() => {});
      return page.getByTestId("board-agent-panel").isVisible().catch(() => false);
    }, { timeout: 20_000 }).toBe(true);
    await page.waitForTimeout(500);
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

    /* Attach: today's upload into this board's Library (the board's toast says so). A free card is on no stage of the rail (lib/v12/board/stages.ts), so none shows here. */
    await page.getByTestId("v12-board-bar-inner-attach-input").setInputFiles("public/campaign/hero.webp");
    await expect(page.getByText(/1 file added to the Library/)).toBeVisible({ timeout: 30_000 });
    expect(await noSideways(page)).toBe(true);
    expect(errors).toEqual([]);
  });

  test("Shots: a finished card shows Approve · Reject only; Approve and Reject (with its reason) work on the card; selecting opens no Inspector", async ({ page }) => {
    const { errors } = await openShotsBoard(page);
    await expect(shots(page)).toHaveCount(8, { timeout: 90_000 });
    await closeDock(page);
    const review = shots(page).filter({ has: page.locator('[data-status="review"]') });
    await expect(review).toHaveCount(3);
    await expect(page.getByTestId("take-grid-actions")).toHaveCount(3);
    for (const card of await review.all()) {
      await expect(card.getByRole("button")).toHaveCount(2);
      await expect(card.getByTestId("take-approve")).toHaveText("Approve");
      await expect(card.getByTestId("take-reject")).toHaveText("Reject");
    }
    /* Selecting a card opens no Inspector over the bar. */
    await shots(page).first().click();
    await expect(page.getByTestId("board-inspector")).toHaveCount(0);
    await expect(page.getByTestId("v12-board-bar")).toBeVisible();
    /* Approve: the take's review trail, free; the card then says Approved. */
    const first = shots(page).first();
    await first.getByTestId("take-approve").click();
    await expect(first.getByTestId("take-approve")).toHaveText("Approved", { timeout: 30_000 });
    /* Reject asks why, over the card, which keeps its size. */
    const second = shots(page).nth(1);
    const before = await second.boundingBox();
    await second.getByTestId("take-reject").click();
    await expect(second.getByTestId("take-reject-panel")).toBeVisible();
    expect(await second.boundingBox()).toEqual(before);
    await second.getByTestId("take-reject-chip").first().click();
    await second.getByTestId("take-reject-confirm").click();
    await expect(second.getByTestId("take-rejected")).toContainText("Rejected", { timeout: 30_000 });
    expect(errors).toEqual([]);
  });

  test("Storyboard: 4 across, one 24 px gap, one frame size; a selected frame shows one row with Details, which opens the Inspector", async ({ page }) => {
    const { errors } = await openBoard(page, "/suites?view=board&stage=storyboard");
    await expect(frames(page)).toHaveCount(8, { timeout: 90_000 });
    await closeDock(page);
    await expect.poll(async () => new Set((await frames(page).evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().x))))).size).toBe(4);
    const b = await frames(page).evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; }));
    expect(new Set(b.map((x) => x.w))).toEqual(new Set([260]));
    expect(new Set(b.map((x) => x.h)).size).toBe(1);
    const xs = [...new Set(b.map((x) => x.x))].sort((p, q) => p - q);
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1] - 260).toBe(24);
    const ys = [...new Set(b.map((x) => x.y))].sort((p, q) => p - q);
    expect(ys).toHaveLength(2);
    expect(ys[1] - ys[0] - b[0].h).toBe(24);
    /* The group has no frame and no title: the stage header says them. */
    await expect(page.getByTestId("board-group").first()).toHaveAttribute("data-grid", "true");
    expect(await page.getByTestId("board-group").first().evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("0px");
    /* Calm until selected; then one row: its action and Details. */
    await expect(page.getByTestId("frame-grid-actions")).toHaveCount(0);
    await frames(page).first().click();
    await expect(page.getByTestId("board-inspector")).toHaveCount(0);
    const row = page.getByTestId("frame-grid-actions");
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId("frame-details")).toBeVisible();
    expect(await frames(page).first().boundingBox()).toMatchObject({ width: 260, height: b[0].h });
    await row.getByTestId("frame-details").click();
    await expect(page.getByTestId("board-inspector")).toBeVisible();
    expect(await noSideways(page)).toBe(true);
    expect(errors).toEqual([]);
  });

  test("Elements: 4 across, one 24 px gap, one card size; the last row clears the bar, the Library button and the view switch at the end of the scroll", async ({ page }) => {
    const film = filmBoard();
    const props = ["Lantern", "Rope coil", "Tin cup", "Oar", "Net", "Crate", "Buoy"].map((title, i) => ({ id: `node-prop00${i + 2}`, title, type: "element" as const, x: 0, y: 0, width: 254, linked: [], refKind: "element" as const }));
    const { errors } = await openBoard(page, "/suites?view=board&stage=elements", { project: { ...film, nodes: [...film.nodes, ...props] } });
    const cards = page.locator('.bd-node[data-card-kind="cast"]');
    await expect(cards).toHaveCount(9, { timeout: 90_000 });
    await closeDock(page);
    const read = () => cards.evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; }));
    await expect.poll(async () => new Set((await read()).map((b) => b.x)).size).toBe(4);
    const b = await read();
    expect(new Set(b.map((x) => x.w))).toEqual(new Set([260]));
    expect(new Set(b.map((x) => x.h)).size).toBe(1);
    const xs = [...new Set(b.map((x) => x.x))].sort((p, q) => p - q);
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1] - 260).toBe(24);
    const ys = [...new Set(b.map((x) => x.y))].sort((p, q) => p - q);
    expect(ys).toHaveLength(3);
    for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1] - b[0].h).toBe(24);
    /* Scrolled to the end, the last row sits above the bar and the bottom-left controls, with 24 px clear. */
    await page.mouse.move(600, 400);
    await page.mouse.wheel(0, 3000);
    const top = (id: string) => page.getByTestId(id).evaluate((el) => el.getBoundingClientRect().top);
    await expect.poll(async () => {
      const last = Math.max(...(await read()).map((x) => x.y + x.h));
      const limit = Math.min(await top("v12-board-bar"), await top("v12-view-switch"), await top("v12-library-button"));
      return limit - last;
    }, { timeout: 10_000 }).toBeGreaterThanOrEqual(23);
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
