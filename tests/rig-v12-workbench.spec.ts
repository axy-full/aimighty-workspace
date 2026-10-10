import { test, expect, type Page, type Locator } from "@playwright/test";
import { openRigBoard, type ShotRow } from "./helpers/rigV12";

/**
 * The Rig, the board's fourth view in the new interface (redesign P5; docs/redesign/inventory.md § 9): inputs from the Library,
 * the work (the shots), outputs (Takes, The cut, Masters). No lines until you point at something; the price of a change is the
 * server's quote of redrawing what an input feeds; dragging an input onto a shot adds it as a reference, a connection can be
 * taken out, a shot's steps open on a double-click, and the first-time hint has a row of its own, never over a node.
 * Desktop with the switch on; phones keep today's phone app (no Rig there).
 */
const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const PHONE = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const MADE: ShotRow[] = Array.from({ length: 8 }, () => ({ status: "succeeded", ageS: 3600 }));
const RIG = "/suites?view=board&stage=shots&v=rig";
const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const input = (page: Page, name: string) => page.getByTestId("v12-rig-input").filter({ hasText: name });
const shot = (page: Page, n: number) => page.getByTestId("v12-rig-shot").nth(n - 1);
const rect = (loc: Locator) => loc.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, r: r.right, b: r.bottom }; });
const meets = (a: { x: number; y: number; r: number; b: number }, b: { x: number; y: number; r: number; b: number }) => a.x < b.r && b.x < a.r && a.y < b.b && b.y < a.b;

async function closeDock(page: Page) {
  const collapse = page.getByTestId("agent-collapse");
  await collapse.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
  let quiet = 0;
  await expect.poll(async () => {
    if (await collapse.isVisible().catch(() => false)) { await collapse.click({ timeout: 2_000 }).catch(() => {}); quiet = 0; return false; }
    quiet = (await page.getByTestId("board-agent-panel").count()) === 0 ? quiet + 1 : 0;
    return quiet >= 8;
  }, { timeout: 30_000, intervals: [250] }).toBe(true);
}
async function open(page: Page, path = RIG) {
  const board = await openRigBoard(page, path, { rows: MADE, rig: true });
  await expect(page.getByTestId("v12-rig")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("v12-rig-shot")).toHaveCount(8);
  await closeDock(page);
  return board;
}

test.describe("desktop, switch on", () => {
  test.beforeEach(({}, info) => test.skip(!DESKTOP.includes(info.project.name), "desktop sizes"));

  test("the view: inputs, the work and outputs in their words, no lines by default, and everything in reach without leaving the stage", async ({ page }) => {
    const { errors } = await open(page);
    await expect(page.getByRole("heading", { name: "Inputs · from the Library" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "The work · 8 shots" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Outputs" })).toBeVisible();
    for (const g of ["Cast", "Elements", "Look"]) await expect(page.getByRole("button", { name: new RegExp(g) }).first()).toBeVisible();
    /* Inputs read how many shots they feed; the shots show their inputs as small avatars; nothing is drawn between them. */
    await expect(input(page, "Skipper")).toContainText("Character · 4 shots");
    await expect(input(page, "The quay")).toContainText("Place · 4 shots");
    await expect(input(page, "Brass bell")).toContainText("Prop · 2 shots");
    await expect(page.getByTestId("v12-rig-edge")).toHaveCount(0);
    await expect(shot(page, 2).getByTestId("v12-rig-avatar")).toHaveCount(3);
    await expect(shot(page, 6).getByTestId("v12-rig-avatar")).toHaveCount(0);
    /* A shot's name wraps to two lines at most. */
    const name = shot(page, 1).locator(".v12-rig-name");
    expect(await name.evaluate((el) => getComputedStyle(el).webkitLineClamp)).toBe("2");
    /* Outputs: three nodes. */
    await expect(page.getByTestId("v12-rig-output")).toHaveText([/Takes\s*8 shots · 8 takes/, /The cut/, /Masters/]);
    /* The Rig fits this stage, or scrolls inside its own canvas: the page never scrolls sideways, every node is inside the canvas's bounds. */
    expect(await noSideways(page)).toBe(true);
    const frame = await rect(page.getByTestId("v12-rig"));
    for (const n of await page.getByTestId("v12-rig-output").all()) { const r = await rect(n); expect(r.b).toBeLessThanOrEqual(frame.b + 1); }
    /* The canvas keeps clear of the bar: its scroll area ends above it. */
    const bar = await rect(page.getByTestId("v12-board-bar"));
    expect((await rect(page.getByTestId("v12-rig-scroll"))).b).toBeLessThanOrEqual(bar.y);
    expect(errors).toEqual([]);
  });

  test("the hint has a row of its own and never covers a node; Got it is kept", async ({ page }) => {
    await open(page);
    const hint = page.getByTestId("v12-rig-hint");
    await expect(hint).toHaveText(/Click anything to see what it feeds\./);
    /* What a person sees of a node is the part inside the canvas's scrolling area. */
    const seen = async (n: Locator) => { const r = await rect(n), s = await rect(page.getByTestId("v12-rig-scroll")); return { x: Math.max(r.x, s.x), y: Math.max(r.y, s.y), r: Math.min(r.r, s.r), b: Math.min(r.b, s.b) }; };
    const empty = (r: { x: number; y: number; r: number; b: number }) => r.r <= r.x || r.b <= r.y;
    const h = await rect(hint);
    expect((await rect(page.getByTestId("v12-rig-scroll"))).b, "the canvas ends where the hint begins").toBeLessThanOrEqual(h.y + 1);
    for (const n of await page.locator(".v12-rig-node").all()) { const v = await seen(n); expect(empty(v) || !meets(h, v), "the hint is over a node").toBe(true); }
    /* Scrolled to the end, still clear of every node. */
    await page.getByTestId("v12-rig-scroll").evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const h2 = await rect(hint);
    for (const n of await page.locator(".v12-rig-node").all()) { const v = await seen(n); expect(empty(v) || !meets(h2, v), "the hint is over a node after scrolling").toBe(true); }
    /* It is not over the bar either. */
    expect(meets(h2, await rect(page.getByTestId("v12-board-bar")))).toBe(false);
    await page.getByTestId("v12-rig-got-it").click();
    await expect(hint).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("v12-rig")).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId("v12-rig-hint")).toHaveCount(0);
  });

  test("pointing at an input draws only its connections and dims the rest; a shot lights its inputs; the price of a change is the server's", async ({ page }) => {
    await open(page);
    await input(page, "Skipper").click();
    await expect(page.getByTestId("v12-rig-edge")).toHaveCount(4);
    await expect(page.locator('.v12-rig-shot[data-dim]')).toHaveCount(4);
    await expect(page.locator('.v12-rig-input[data-dim]')).toHaveCount(3);
    /* The change: its shots, its engine, its price (a quote, never written here), and the ask goes to Atomik, not out. */
    const impact = page.getByTestId("v12-rig-impact");
    await expect(impact).toContainText("Change Skipper");
    await expect(impact).toContainText("4 shots will redraw");
    await expect(impact).toContainText("Locked frames stay.");
    const price = page.getByTestId("v12-rig-price");
    await expect(price).toHaveAttribute("data-price-state", "ready", { timeout: 60_000 });
    await expect(price).toHaveText(/^(up to )?\d[\d,.]* cr$/);
    await page.getByTestId("v12-rig-ask").click();
    await expect(page.getByTestId("board-agent-panel")).toBeVisible();
    /* Esc clears the selection (and nothing else). */
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("v12-rig-edge")).toHaveCount(0);
    await expect(page.getByTestId("v12-rig")).toBeVisible();
    await shot(page, 3).click();
    await expect(page.getByTestId("v12-rig-edge")).toHaveCount(2);
    await expect(page.locator('.v12-rig-input[data-dim]')).toHaveCount(2);
    await expect(page.getByTestId("v12-rig-note")).toContainText("Shot 3");
  });

  test("a double-click opens a shot's steps with each engine and what it cost; Esc closes them first; groups fold", async ({ page }) => {
    await open(page);
    await shot(page, 1).dblclick();
    const steps = shot(page, 1).getByTestId("v12-rig-steps");
    await expect(steps).toBeVisible();
    await expect(steps.getByTestId("v12-rig-step").first()).toContainText(/Still · /);
    await expect(steps).toContainText("Esc collapses");
    await page.keyboard.press("Escape");
    await expect(steps).toHaveCount(0);
    /* A group's chip folds its nodes. */
    await page.getByTestId("v12-rig-group-elements").click();
    await expect(input(page, "The quay")).toHaveCount(0);
    await expect(input(page, "Skipper")).toHaveCount(1);
    await page.getByTestId("v12-rig-group-elements").click();
    await expect(input(page, "The quay")).toHaveCount(1);
  });

  test("dragging an input onto a shot adds it as a reference, with Undo; a connection is taken out with Delete, with Undo", async ({ page }) => {
    await open(page);
    await expect(shot(page, 1).getByTestId("v12-rig-avatar")).toHaveCount(2);
    await input(page, "Deckhand").dragTo(shot(page, 1));
    await expect(page.getByTestId("v12-toast")).toContainText("Deckhand is a reference for Shot 1");
    await expect(shot(page, 1).getByTestId("v12-rig-avatar")).toHaveCount(3, { timeout: 30_000 });
    await page.getByTestId("v12-toast-action").click();
    await expect(shot(page, 1).getByTestId("v12-rig-avatar")).toHaveCount(2, { timeout: 30_000 });

    /* A connection: pick it, say what it is, and Delete takes it out. */
    await input(page, "Skipper").click();
    await page.getByTestId("v12-rig-edge").first().dispatchEvent("click");
    await expect(page.getByTestId("v12-rig-note")).toContainText(/^Remove Skipper from Shot \d/);
    await expect(page.getByTestId("v12-rig-edge")).toHaveAttribute("data-picked", "");
    await page.keyboard.press("Delete");
    await expect(page.getByTestId("v12-toast")).toContainText("Skipper is no longer an input of Shot 1");
    await expect(input(page, "Skipper")).toContainText("Character · 3 shots", { timeout: 30_000 });
    await page.getByTestId("v12-toast-action").click();
    await expect(input(page, "Skipper")).toContainText("Character · 4 shots", { timeout: 30_000 });
  });

  test("an output opens its stage; the view switch leaves the Rig; switch off: no Rig", async ({ page }) => {
    await open(page);
    await page.locator('[data-testid="v12-rig-output"][data-id="cut"]').click();
    await expect(page.getByTestId("v12-rig")).toHaveCount(0);
    await expect(page.getByTestId("v12-stage-crumb")).toHaveText("Cut");
    await page.getByTestId("v12-view-switch").getByRole("radio", { name: "Rig" }).click();
    await expect(page.getByTestId("v12-rig")).toBeVisible();
    await page.getByTestId("v12-view-switch").getByRole("radio", { name: "Canvas" }).click();
    await expect(page.getByTestId("v12-rig")).toHaveCount(0);
  });

  test("switch off: today's board, whatever the address says", async ({ page }) => {
    await openRigBoard(page, "/suites?view=board&v=rig", { on: false });
    await expect(page.locator('.bd-node[data-card-kind="take"]').first()).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId("v12-rig")).toHaveCount(0);
  });
});

test.describe("phones, switch on", () => {
  test.beforeEach(({}, info) => test.skip(!PHONE.includes(info.project.name), "phone sizes"));
  test("today's phone app: no Rig, no view switch, no sideways scroll", async ({ page }) => {
    const { errors } = await openRigBoard(page, "/suites?view=board&v=rig", { rows: MADE, rig: true });
    await expect(page.locator("[data-phone], [data-testid='phone-app']").first()).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId("v12-rig")).toHaveCount(0);
    await expect(page.getByTestId("v12-view-switch")).toHaveCount(0);
    expect(await noSideways(page)).toBe(true);
    expect(errors).toEqual([]);
  });
});
