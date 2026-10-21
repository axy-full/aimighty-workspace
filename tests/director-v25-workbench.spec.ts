import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { isCompact } from "./helpers/shellMode";

/*
 * v25 PR 7: Director on Shots (components/v12/board/DirectorColumn.tsx, DirectorBar.tsx, use-director-render.ts), on the test-only page app/(test)/v25-board-parts
 * (a 404 outside a local ENGINE_MOCK=1 development server). The shots are mock; the batch press route (POST /api/generate/batch, #815) and the job reads are
 * answered here, so what is checked is what the bar asks of the real route: a multi-shot press is ONE job with one approval for the total. The price is the
 * server's quote for the whole press; a press the workspace's monthly cap would not cover is refused at the quote and nothing can be pressed; a press quotes
 * again and sends nothing if the total moved; it is sent once, the total as its ceiling with the quote's fingerprint, under one Idempotency-Key that a lost
 * reply reuses; never shot by shot. "Making…" until the takes settle, "Cancel" (the press's own cancel) only while one is still queued, then "Next: Edit →".
 * Nothing real is spent.
 */
/* The test page's stand-in pick, centred first: on a phone Director's bar is fixed at the bottom and would lie over it. */
async function pickEngine(page: Page) {
  const button = page.getByTestId("v25-parts-pick-engine");
  await button.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await button.click();
}
type Sent = { body: Record<string, unknown>; key: string | undefined };
/** A synthetic refusal, as the batch route answers a press over the workspace's monthly cap (429, in the cap's own words). Test text, not the product's. */
const CAP_WORDS = "Synthetic test refusal: this press would pass the monthly spending limit.";
async function routes(page: Page, opts: { credits?: (body: Record<string, unknown>) => number; engine?: boolean; capAtQuote?: boolean; lose?: number } = {}) {
  const quotes: Record<string, unknown>[] = [], sent: Sent[] = [], cancels: string[] = [], single: string[] = [], fingerprints: string[] = [];
  const state = { phase: "queued" as "queued" | "running" | "succeeded", bump: 0, lose: opts.lose ?? 0 };
  const priceOf = opts.credits ?? ((b) => (b.resolution === "480p" ? 7 : 43));
  const sha = (b: unknown) => createHash("sha256").update(JSON.stringify(b)).digest("hex");
  /* Never shot by shot: a per-shot quote or send is recorded, and every test below expects none. */
  await page.route("**/api/generate/quote", async (route) => { single.push("quote"); await route.fulfill({ status: 500, json: { error: "not this route" } }); });
  await page.route("**/api/generate", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    single.push("send");
    await route.fulfill({ status: 500, json: { error: "not this route" } });
  });
  await page.route("**/api/generate/batch", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    const key = route.request().headers()["idempotency-key"];
    if (body.cancel === true) {
      cancels.push(String(key));
      return route.fulfill({ json: { status: "cancelled", members: sent.at(-1) ? (sent.at(-1)!.body.members as unknown[]).map((_, index) => ({ index, id: `gen_dir_${sent.length}_${index + 1}`, status: "cancelled", charged: 0 })) : [] } });
    }
    const members = body.members as Record<string, unknown>[];
    const total = members.reduce((n, m) => n + priceOf(m) + state.bump, 0);
    const fingerprint = sha({ members, total });
    if (body.quoteOnly === true) {
      quotes.push(body);
      if (opts.capAtQuote) return route.fulfill({ status: 429, json: { error: CAP_WORDS } });
      fingerprints.push(fingerprint);
      return route.fulfill({ json: { estimatedCredits: total, price: total, unit: "cr", members: members.length, batchId: `bt_${fingerprint.slice(0, 24)}`, fingerprint } });
    }
    sent.push({ body, key });
    if (state.lose > 0) { state.lose -= 1; return route.abort("connectionreset"); }
    /* The route's own checks, as lib/batchPress.ts makes them: the approval is the quote's fingerprint and covers the total. */
    if (body.fingerprint !== fingerprint) return route.fulfill({ status: 409, json: { error: "The shots or their prices changed. Look at the total again before approving.", quoteChanged: true } });
    if (body.maxCredits !== total) return route.fulfill({ status: 409, json: { error: "Approve the price first: the total is above the approved credit amount." } });
    await route.fulfill({ json: { id: `bt_${fingerprint.slice(0, 24)}`, batchId: `bt_${fingerprint.slice(0, 24)}`, status: "started", estimatedCredits: total, members: members.map((_, index) => ({ index, id: `gen_dir_${sent.length}_${index + 1}`, status: "queued" })) } });
  });
  await page.route("**/api/jobs/gen_dir_*", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const id = new URL(route.request().url()).pathname.split("/").pop()!;
    await route.fulfill({ json: { generation: { id, status: state.phase } } });
  });
  /* Director opens with no engine (owner, 16 Oct 2026, 2a); the test page's stand-in pick sets one, as PR 9's pop-up will. */
  if (opts.engine !== false) await pickEngine(page);
  return { quotes, sent, cancels, single, fingerprints, state };
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
  expect(net.single).toEqual([]);
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

test("the column, the pill and the button say the same words; the price is the server's quote for the whole press; one filled button", async ({ page }) => {
  const net = await routes(page);
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
  /* The price was the press's quote, never a shot's own. */
  expect(net.quotes.at(-1)?.members).toHaveLength(1);
  expect(net.single).toEqual([]);
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

test("a press is one job: quoted again, then sent once with the total as its ceiling and the quote's fingerprint under one key; Making…, Cancel only while queued, Next: Edit →", async ({ page }) => {
  const net = await routes(page);
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
  const quoted = net.quotes.length;
  await go(page).click();
  await expect(go(page)).toHaveText(/^Making…/, { timeout: 30_000 });
  await expect(go(page)).toBeDisabled();
  await expect.poll(() => net.sent.length).toBe(1);
  /* Priced again, the whole press, before it was sent; sent once, the total as its ceiling and that quote's fingerprint, under one key. */
  expect(net.quotes.length - quoted).toBeGreaterThanOrEqual(1);
  const [press] = net.sent;
  expect(press.body).toMatchObject({ maxCredits: 172 });
  expect(press.body.fingerprint).toBe(net.fingerprints.at(-1));
  expect(String(press.body.fingerprint)).toMatch(/^[a-f0-9]{64}$/);
  expect(press.key).toBeTruthy();
  const members = press.body.members as Record<string, unknown>[];
  expect(members).toHaveLength(4);
  for (const m of members) {
    expect(m).toMatchObject({ resolution: "1080p", duration: 5, ratio: "16:9", model: "dreamina-seedance-2-5-260628" });
    /* A member carries no approval of its own: the press's is the one. */
    expect(m.maxCredits).toBeUndefined();
    expect(m.quoteFingerprint).toBeUndefined();
  }
  expect(new Set(members.map((m) => m.shotId)).size).toBe(4);
  expect(net.single, "never shot by shot").toEqual([]);
  /* While a take is still queued at the provider: Cancel. */
  await expect(page.getByTestId("v12-director-cancel")).toBeVisible({ timeout: 15_000 });
  net.state.phase = "running";
  await expect(page.getByTestId("v12-director-cancel")).toHaveCount(0, { timeout: 15_000 });
  net.state.phase = "succeeded";
  await expect(go(page)).toHaveText("Next: Edit →", { timeout: 20_000 });
  await expect(go(page)).toBeEnabled();
  await expect(go(page)).not.toHaveAttribute("data-spend", /.*/);
  expect(net.sent).toHaveLength(1);
  /* Next hands the bar back to the next press. */
  await go(page).click();
  await expect(go(page)).toHaveText(/^Render 4 shots/, { timeout: 30_000 });
});

test("Cancel cancels the press under its own key, once, and says what it did", async ({ page }) => {
  const net = await routes(page);
  await expect(go(page)).toHaveText(/^Render 4 shots/, { timeout: 30_000 });
  await go(page).click();
  await expect(page.getByTestId("v12-director-cancel")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("v12-director-cancel").click();
  await expect.poll(() => net.cancels.length).toBe(1);
  expect(net.cancels[0]).toBe(net.sent[0].key);
  await expect(page.getByTestId("v12-director-note")).toContainText("Cancelled. The take says what it cost.");
});

test("a total that moved between the button and the press sends nothing: the new figure is shown and the person presses again", async ({ page }) => {
  const net = await routes(page);
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
  net.state.bump = 5;
  await go(page).click();
  await expect(page.getByTestId("v12-director-note")).toContainText("The price is now 192 cr. Press it again to approve it.", { timeout: 30_000 });
  expect(net.sent).toEqual([]);
  await expect(go(page)).toHaveText(/^Render 4 shots · 192 cr$/, { timeout: 30_000 });
  await go(page).click();
  await expect.poll(() => net.sent.length).toBe(1);
  expect(net.sent[0].body).toMatchObject({ maxCredits: 192 });
});

test("a press the workspace's monthly cap would not cover is refused at the quote: the cap's words, Render off, nothing sent", async ({ page }) => {
  const net = await routes(page, { capAtQuote: true });
  await expect(page.getByTestId("v12-director-note")).toContainText(CAP_WORDS, { timeout: 30_000 });
  await expect(go(page)).toHaveText("Render 4 shots");
  await expect(go(page)).toBeDisabled();
  await expect(go(page)).toHaveAttribute("data-spend", "unpriced");
  await go(page).click({ force: true });
  await page.waitForTimeout(800);
  expect(net.sent).toEqual([]);
  expect(net.single).toEqual([]);
});

test("a press whose reply was lost is asked again under the same key, so nothing is sent twice", async ({ page }) => {
  const net = await routes(page, { lose: 1 });
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
  await go(page).click();
  await expect(page.getByTestId("v12-director-note")).toContainText("The connection dropped before the server answered.", { timeout: 30_000 });
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/);
  await go(page).click();
  await expect.poll(() => net.sent.length).toBe(2);
  expect(net.sent[1].key).toBe(net.sent[0].key);
  await expect(go(page)).toHaveText(/^Making…/, { timeout: 30_000 });
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
