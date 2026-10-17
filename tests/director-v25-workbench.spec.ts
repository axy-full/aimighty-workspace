import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { isCompact } from "./helpers/shellMode";

/*
 * v25 PR 7: Director on Shots (components/v12/board/DirectorColumn.tsx, DirectorBar.tsx, use-director-render.ts), on the test-only page app/(test)/v25-board-parts
 * (a 404 outside a local ENGINE_MOCK=1 development server). The shots are mock; the quote, the send and the job reads are answered here, so what is checked is
 * what the bar asks of the real routes: the price is the SUM of the quotes for exactly what will be sent, a press prices again and sends nothing if a figure moved,
 * each shot is sent once at its own quote as its ceiling, "Making…" until the takes settle, "Cancel" only while one is still queued, then "Next: Edit →".
 * Nothing real is spent.
 */
/* The test page's stand-in pick, centred first: on a phone Director's bar is fixed at the bottom and would lie over it. */
async function pickEngine(page: Page) {
  const button = page.getByTestId("v25-parts-pick-engine");
  await button.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await button.click();
}
type Sent = { body: Record<string, unknown>; key: string | undefined };
async function routes(page: Page, opts: { credits?: (body: Record<string, unknown>) => number; engine?: boolean } = {}) {
  const quotes: Record<string, unknown>[] = [], sent: Sent[] = [], cancels: string[] = [];
  const state = { phase: "queued" as "queued" | "running" | "succeeded", bump: 0 };
  const priceOf = opts.credits ?? ((b) => (b.resolution === "480p" ? 7 : 43));
  const sha = (b: unknown) => createHash("sha256").update(JSON.stringify(b)).digest("hex");
  await page.route("**/api/generate/quote", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    quotes.push(body);
    const credits = priceOf(body) + state.bump;
    await route.fulfill({ json: { estimatedCredits: credits, price: credits, unit: "cr", fingerprint: sha({ ...body, credits }) } });
  });
  await page.route("**/api/generate", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    sent.push({ body, key: route.request().headers()["idempotency-key"] });
    await route.fulfill({ json: { id: `gen_dir_${sent.length}`, status: "queued" } });
  });
  await page.route("**/api/jobs/gen_dir_*", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const id = new URL(route.request().url()).pathname.split("/").pop()!;
    await route.fulfill({ json: { generation: { id, status: state.phase } } });
  });
  await page.route("**/api/generations/*/cancel", async (route) => {
    cancels.push(new URL(route.request().url()).pathname.split("/").slice(-2)[0]);
    await route.fulfill({ json: { status: "cancelled" } });
  });
  /* Director opens with no engine (owner, 16 Oct 2026, 2a); the test page's stand-in pick sets one, as PR 9's pop-up will. */
  if (opts.engine !== false) await pickEngine(page);
  return { quotes, sent, cancels, state };
}

test.beforeEach(async ({ page }) => {
  const res = await page.goto("/v25-board-parts");
  test.skip(res?.status() === 404, "requires a local ENGINE_MOCK=1 development server");
  await expect(page.getByTestId("v25-board-director")).toBeVisible();
});

const board = (page: Page) => page.getByTestId("v25-board-director");
const card = (page: Page, id: string) => board(page).locator(`[data-card="${id}"]`);
const go = (page: Page) => page.getByTestId("v12-director-go");
const pill = (page: Page) => page.getByTestId("v12-director-scope");
const colHead = (page: Page) => page.getByTestId("v12-director-column-scope");
async function pick(page: Page, setting: string, choice: string) {
  await page.getByTestId(`v12-director-${setting}`).click();
  await page.getByTestId("v12-director-popup").getByRole("radio", { name: choice, exact: true }).click();
}

test("Director opens with no engine: the model line reads None, nothing is priced, and Render is off until one is picked", async ({ page }) => {
  const net = await routes(page, { engine: false });
  await expect(page.getByTestId("v12-director-model")).toContainText("None");
  await expect(page.getByTestId("v12-director-model")).toHaveAttribute("data-empty", "");
  await expect(page.getByTestId("v12-director-model")).not.toContainText("Auto");
  await expect(go(page)).toHaveText("Render 4 shots");
  await expect(go(page)).toBeDisabled();
  await expect(go(page)).toHaveAttribute("data-spend", "unpriced");
  await expect(page.getByTestId("v12-director-note")).toHaveText("Pick an engine first.");
  await page.waitForTimeout(1500);
  expect(net.quotes, "nothing is priced before an engine is picked").toEqual([]);
  /* A press on the disabled button sends nothing. */
  await go(page).click({ force: true });
  expect(net.sent).toEqual([]);
  /* Picked: the model line names it, the price is read and Render turns on. */
  await pickEngine(page);
  await expect(page.getByTestId("v12-director-model")).toContainText("Seedance 2.5");
  await expect(page.getByTestId("v12-director-model")).not.toHaveAttribute("data-empty", /.*/);
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
  await expect(go(page)).toBeEnabled();
  await expect(page.getByTestId("v12-director-note")).toHaveCount(0);
});

test("the column, the pill and the button say the same words; the price is the sum of the server's quotes; one filled button", async ({ page }) => {
  await routes(page);
  await expect(pill(page)).toHaveText("All 4 shots");
  await expect(colHead(page)).toHaveText("All 4 shots");
  await expect(page.getByTestId("v12-director-model")).toContainText("Seedance 2.5");
  await expect(page.getByTestId("v12-director-quality")).toContainText("Final");
  await expect(page.getByTestId("v12-director-length")).toContainText("5 s");
  await expect(page.getByTestId("v12-director-ratio")).toContainText("16:9");
  await expect(page.getByTestId("v12-director-sound")).toContainText("Off");
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
  await expect(go(page)).toHaveAttribute("data-spend", "priced");
  await expect(go(page)).toHaveAttribute("data-spend-price", "172 cr");
  /* Selecting a card narrows all three to it. */
  await card(page, "d4").click();
  await expect(pill(page)).toHaveText("Shot 4");
  await expect(colHead(page)).toHaveText("Shot 4");
  await expect(go(page)).toHaveText(/^Render Shot 4 · 43 cr$/, { timeout: 30_000 });
  /* One filled button on the screen's bar. */
  await expect(page.getByTestId("v12-director-bar").locator("button.v12-dirbar-go")).toHaveCount(1);
});

test("a setting for the selected shot is a chip on that card only, changes its price, and the others keep the step's", async ({ page }) => {
  await routes(page);
  await card(page, "d4").click();
  await pick(page, "quality", "Draft");
  await expect(card(page, "d4").locator(".v12-card-chip")).toHaveText(["Draft"]);
  await expect(card(page, "d1").locator(".v12-card-chip")).toHaveCount(0);
  await expect(go(page)).toHaveText(/^Render Shot 4 · 7 cr$/, { timeout: 30_000 });
  await expect(page.getByTestId("v12-director-quality")).toContainText("Draft");
  /* Back on every shot: the step's own (Final), with Shot 4's draft kept as its own. */
  await card(page, "d4").click();
  await expect(pill(page)).toHaveText("All 4 shots");
  await expect(page.getByTestId("v12-director-quality")).toContainText("Final");
  await expect(go(page)).toHaveText(/^Render 4 shots · 136 cr$/, { timeout: 30_000 });
  /* Setting a step's value for all moves every card without its own override. */
  await pick(page, "length", "8 s");
  await expect(page.getByTestId("v12-director-length")).toContainText("8 s");
  await expect(card(page, "d1").locator(".v12-card-chip")).toHaveCount(0);
  /* Hovering a row outlines the cards that set it differently and sets the rest back. */
  await page.getByTestId("v12-director-quality").hover();
  await expect(card(page, "d4")).toHaveAttribute("data-differs", "");
  await expect(card(page, "d1")).toHaveAttribute("data-dimmed", "");
  /* Several selected that disagree read "Mixed". */
  await card(page, "d1").click();
  await card(page, "d4").click({ modifiers: ["Shift"] });
  await expect(pill(page)).toHaveText("2 shots");
  await expect(page.getByTestId("v12-director-quality")).toContainText("Mixed");
});

test("a press sends each shot once at its own quote as its ceiling, then Making…, Cancel only while queued, and Next: Edit → when they settle", async ({ page }) => {
  const net = await routes(page);
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
  const quoted = net.quotes.length;
  await go(page).click();
  await expect(go(page)).toHaveText(/^Making…/, { timeout: 30_000 });
  await expect(go(page)).toBeDisabled();
  await expect.poll(() => net.sent.length).toBe(4);
  /* Priced again, every shot, before any was sent; each sent with its own quote as the ceiling and a fingerprint, under its own key. */
  expect(net.quotes.length - quoted).toBeGreaterThanOrEqual(4);
  for (const s of net.sent) {
    expect(s.body).toMatchObject({ maxCredits: 43, resolution: "1080p", duration: 5, ratio: "16:9", model: "dreamina-seedance-2-5-260628" });
    expect(String(s.body.quoteFingerprint)).toMatch(/^[a-f0-9]{64}$/);
    expect(s.key).toBeTruthy();
  }
  expect(new Set(net.sent.map((s) => s.key)).size).toBe(4);
  expect(new Set(net.sent.map((s) => s.body.shotId)).size).toBe(4);
  /* While a take is still queued at the provider: Cancel. */
  await expect(page.getByTestId("v12-director-cancel")).toBeVisible({ timeout: 15_000 });
  net.state.phase = "running";
  await expect(page.getByTestId("v12-director-cancel")).toHaveCount(0, { timeout: 15_000 });
  net.state.phase = "succeeded";
  await expect(go(page)).toHaveText("Next: Edit →", { timeout: 20_000 });
  await expect(go(page)).toBeEnabled();
  await expect(go(page)).not.toHaveAttribute("data-spend", /.*/);
  expect(net.sent).toHaveLength(4);
  /* Next hands the bar back to the next press. */
  await go(page).click();
  await expect(go(page)).toHaveText(/^Render 4 shots/, { timeout: 30_000 });
});

test("Cancel asks the provider to drop the takes still queued, and says what it did", async ({ page }) => {
  const net = await routes(page);
  await expect(go(page)).toHaveText(/^Render 4 shots/, { timeout: 30_000 });
  await go(page).click();
  await expect(page.getByTestId("v12-director-cancel")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("v12-director-cancel").click();
  await expect.poll(() => net.cancels.length).toBe(4);
  await expect(page.getByTestId("v12-director-note")).toContainText("Cancelled. The take says what it cost.");
});

test("a price that moved between the button and the press sends nothing: the new figure is shown and the person presses again", async ({ page }) => {
  const net = await routes(page);
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
  net.state.bump = 5;
  await go(page).click();
  await expect(page.getByTestId("v12-director-note")).toContainText("The price is now 192 cr. Press it again to approve it.", { timeout: 30_000 });
  expect(net.sent).toEqual([]);
  await expect(go(page)).toHaveText(/^Render 4 shots · 192 cr$/, { timeout: 30_000 });
  await go(page).click();
  await expect.poll(() => net.sent.length).toBe(4);
  expect(net.sent[0].body).toMatchObject({ maxCredits: 48 });
});

test("the bar and the column fit the window at every size: no sideways scroll, text 12 px or more, 44 px controls on a touch screen", async ({ page }, info) => {
  await routes(page);
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
  await card(page, "d4").click();
  const view = page.viewportSize()!;
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), "horizontal overflow").toBeLessThanOrEqual(0);
  for (const id of ["v12-director-column", "v12-director-bar", "v12-director-go"]) {
    await page.getByTestId(id).scrollIntoViewIfNeeded();
    const box = (await page.getByTestId(id).boundingBox())!;
    expect(box.x >= -0.5 && box.x + box.width <= view.width + 0.5, `${id} inside ${view.width}px`).toBe(true);
  }
  const small = await board(page).evaluate((root) => {
    const out: string[] = [];
    for (const el of root.querySelectorAll<HTMLElement>("*")) {
      if (![...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? "").trim())) continue;
      const px = parseFloat(getComputedStyle(el).fontSize);
      if (px < 12) out.push(`${el.className} ${px}px`);
    }
    return out;
  });
  expect(small, "text under 12 px").toEqual([]);
  if (isCompact(info)) {
    const tiny = await page.getByTestId("v12-director-column").evaluate((el) => [...el.querySelectorAll<HTMLElement>("button")].filter((b) => b.getBoundingClientRect().height < 43.5).map((b) => b.textContent));
    expect(tiny, "column rows under 44 px").toEqual([]);
    const goBox = (await go(page).boundingBox())!;
    expect(goBox.height).toBeGreaterThanOrEqual(43.5);
  }
});

test("the large screens: the column and the bar sit inside the window", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1920x1080", "the large sizes are set here, once");
  await routes(page);
  for (const [width, height] of [[1728, 1117], [2560, 1440]]) {
    await page.setViewportSize({ width, height });
    await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
    for (const id of ["v12-director-column", "v12-director-go"]) {
      await page.getByTestId(id).scrollIntoViewIfNeeded();
      const box = (await page.getByTestId(id).boundingBox())!;
      expect(box.x >= 0 && box.x + box.width <= width, `${id} inside ${width}px`).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${width}: horizontal overflow`).toBeLessThanOrEqual(0);
  }
});
