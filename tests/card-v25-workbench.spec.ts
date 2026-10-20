import { test, expect, type Page } from "@playwright/test";
import { isCompact } from "./helpers/shellMode";

/*
 * The v25 card (components/v12/board/StepCard.tsx), on its test-only page app/(test)/v25-board-parts (a 404 outside a local ENGINE_MOCK=1
 * development server). Five statuses, ✓ and ✕ on hover and on focus, ✕'s reasons ending in "Other" with one optional line, no marks over a
 * text card's words, user-owned cards without ✓ ✕, readable text, and no horizontal overflow at the five widths. The data on the page is mock.
 */
test.beforeEach(async ({ page }) => {
  const res = await page.goto("/v25-board-parts");
  test.skip(res?.status() === 404, "requires a local ENGINE_MOCK=1 development server");
  await expect(page.getByTestId("v25-board-shots")).toBeVisible();
});

const shots = (page: Page) => page.getByTestId("v25-board-shots");
const kinds = (page: Page) => page.getByTestId("v25-board-kinds");
const card = (scope: ReturnType<typeof shots>, id: string) => scope.locator(`[data-card="${id}"]`);
/* ✕ on a card, retried until the reasons show: the first press can land before the page has hydrated (a dev server compiling the page). */
async function openReasons(scope: ReturnType<typeof shots>, id: string) {
  await expect(async () => {
    if (!(await card(scope, id).getByTestId("v12-card-reasons").count())) { await card(scope, id).hover(); await card(scope, id).getByRole("button", { name: /^Not right/ }).click(); }
    await expect(card(scope, id).getByTestId("v12-card-reasons")).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 20_000 });
}

test("five statuses, each as one line under the title", async ({ page }) => {
  const k = kinds(page);
  const status = (id: string) => card(k, id).getByTestId("v12-card-status");
  await expect(status("k-none")).toHaveText("Not started");
  await expect(status("k-making")).toHaveText("Making…");
  await expect(status("k-ready")).toHaveText("Ready");
  await expect(status("k-ready3")).toHaveText("Ready · v3");
  await expect(status("k-ok")).toHaveText("✓ Sent");
  await expect(status("k-no")).toHaveText("✕ Look · warmer");
  /* Making shows its bar on the picture; an owned item says what it is. */
  await expect(card(k, "k-making").getByRole("progressbar")).toHaveAttribute("aria-valuenow", "60");
  await expect(status("k-tile")).toHaveText("Brand kit · 3 files");
});

test("hovering a ready card shows ✓ ✕ ⋯; a card not made yet and a user-owned card show no ✓ ✕", async ({ page }, info) => {
  test.skip(isCompact(info), "a touch screen has no hover: the marks are always there (next test)");
  const s = shots(page);
  const marks = (id: string) => card(s, id).locator(".v12-card-marks");
  await expect(marks("s1")).toHaveCSS("opacity", "0");
  await card(s, "s1").hover();
  await expect(marks("s1")).toHaveCSS("opacity", "1");
  await expect(card(s, "s1").getByRole("button", { name: "Send Shot 1 · Camp at night" })).toBeVisible();
  await expect(card(s, "s1").getByRole("button", { name: /^Not right/ })).toBeVisible();
  await card(s, "s3").hover();
  await expect(card(s, "s3").getByRole("button", { name: /^Send/ })).toHaveCount(0);
  await expect(card(s, "s3").getByRole("button", { name: /^More/ })).toBeVisible();
  const k = kinds(page);
  await card(k, "k-tile").hover();
  await expect(card(k, "k-tile").getByRole("button", { name: /^Send|^Not right/ })).toHaveCount(0);
  await card(k, "k-grey").hover();
  await expect(card(k, "k-grey").getByRole("button", { name: /^Send/ })).toHaveCount(0);
});

test("the keyboard reaches ✓ and ✕: focusing a card shows its marks", async ({ page }) => {
  const s = shots(page);
  await card(s, "s1").focus();
  await expect(card(s, "s1").locator(".v12-card-marks")).toHaveCSS("opacity", "1");
  await page.keyboard.press("Tab");
  await expect(card(s, "s1").getByRole("button", { name: /^Send/ })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(card(s, "s1").getByTestId("v12-card-status")).toHaveText("✓ Sent");
  /* ✓ again undoes it. */
  await page.keyboard.press("Enter");
  await expect(card(s, "s1").getByTestId("v12-card-status")).toHaveText("Ready · v2");
});

test("✕ opens the step's reasons ending in Other and one optional line; a reason sends; Enter sends the line; Esc closes", async ({ page }) => {
  const s = shots(page);
  await openReasons(s, "s4");
  const reasons = card(s, "s4").getByTestId("v12-card-reasons");
  await expect(reasons.getByRole("button")).toHaveText(["Look", "Framing", "Motion", "Face", "Text", "Other"]);
  await expect(reasons.getByLabel("One line, optional")).toHaveAttribute("placeholder", "One line, optional · ⏎ to send");
  /* A reason sends at once, with the line if one is written. */
  await reasons.getByLabel("One line, optional").fill("warmer");
  await reasons.getByRole("button", { name: "Look" }).click();
  await expect(card(s, "s4").getByTestId("v12-card-status")).toHaveText("✕ Look · warmer");
  await expect(card(s, "s4").getByTestId("v12-card-reasons")).toHaveCount(0);
  /* Other, with a line, Enter sends it. */
  await openReasons(s, "s1");
  const second = card(s, "s1").getByTestId("v12-card-reasons");
  await second.getByRole("button", { name: "Other" }).click();
  await expect(second.getByLabel("One line, optional")).toBeFocused();
  await page.keyboard.type("the camp is wrong");
  await page.keyboard.press("Enter");
  await expect(card(s, "s1").getByTestId("v12-card-status")).toHaveText("✕ the camp is wrong");
  /* Esc closes the reasons and keeps the status. */
  await openReasons(s, "s4");
  await page.keyboard.press("Escape");
  await expect(card(s, "s4").getByTestId("v12-card-reasons")).toHaveCount(0);
  await expect(card(s, "s4").getByTestId("v12-card-status")).toHaveText("✕ Look · warmer");
});

test("a click selects with an outline, a double-click opens the preview, ⋯ and right-click ask for the menu", async ({ page }) => {
  const s = shots(page);
  await card(s, "s2").click({ position: { x: 40, y: 30 } });
  await expect(card(s, "s2")).toHaveAttribute("data-selected", "");
  await expect.poll(() => card(s, "s2").evaluate((el) => getComputedStyle(el).boxShadow)).toContain("rgb(10, 132, 255)");
  await card(s, "s2").dblclick({ position: { x: 40, y: 30 } });
  await expect(page.getByTestId("v25-said").first()).toHaveText("Preview Shot 2 · MAYA arrives");
  await card(s, "s2").getByRole("button", { name: /^More/ }).click();
  await expect(page.getByTestId("v25-said").first()).toHaveText("Menu Shot 2 · MAYA arrives");
  await card(s, "s3").click({ button: "right", position: { x: 40, y: 30 } });
  await expect(page.getByTestId("v25-said").first()).toHaveText("Menu Shot 3 · At the water");
});

test("a text card's title steps aside for the marks: they never sit over its words", async ({ page }) => {
  const k = kinds(page);
  const text = card(k, "k-text");
  await text.hover();
  const marks = (await text.locator(".v12-card-marks").boundingBox())!;
  /* The title's words end where its box ends less the padding it keeps for the marks. */
  await expect.poll(() => text.locator(".v12-card-page-title").evaluate((el) => { const r = el.getBoundingClientRect(); return r.right - parseFloat(getComputedStyle(el).paddingRight); })).toBeLessThanOrEqual(marks.x + 1);
  const handle = await text.locator(".v12-card-handle").boundingBox();
  if (handle) await expect.poll(() => text.locator(".v12-card-page-title").evaluate((el) => { const r = el.getBoundingClientRect(); return r.left + parseFloat(getComputedStyle(el).paddingLeft); })).toBeGreaterThanOrEqual(handle.x + handle.width - 1);
  const body = (await text.locator(".v12-card-page-text").boundingBox())!;
  expect(marks.y + marks.height, "the marks end above the text").toBeLessThanOrEqual(body.y + 4);
});

test("every word on a card is 12 px or more, and there is no horizontal overflow", async ({ page }, info) => {
  const small = await page.evaluate(() => [...document.querySelectorAll(".v12-card *")].filter((el) => el.childNodes.length && [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? "").trim()) && parseFloat(getComputedStyle(el).fontSize) < 12).map((el) => `${el.className}: ${getComputedStyle(el).fontSize}`));
  expect(small, "text under 12 px").toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `no horizontal overflow at ${info.project.name}`).toBeLessThanOrEqual(0);
  const cols = await page.evaluate(() => getComputedStyle(document.querySelector(".v25-parts-grid")!).gridTemplateColumns.split(" ").length);
  const width = page.viewportSize()!.width;
  expect(cols).toBe(width >= 1800 ? 5 : width >= 1400 ? 4 : width >= 1000 ? 3 : width >= 560 ? 2 : 1);
});

test.describe("touch", () => {
  test.use({ hasTouch: true });
  test("on a phone the marks are always there and 44 px", async ({ page }, info) => {
  test.skip(!isCompact(info), "desktop shows the marks on hover and focus");
  const s = shots(page);
  await expect(card(s, "s1").locator(".v12-card-marks")).toHaveCSS("opacity", "1");
  for (const name of [/^Send/, /^Not right/, /^More/]) {
    const box = (await card(s, "s1").getByRole("button", { name }).boundingBox())!;
    expect(box.width, String(name)).toBeGreaterThanOrEqual(44);
    expect(box.height, String(name)).toBeGreaterThanOrEqual(44);
  }
});
});

test("keyboard focus is a white ring in every state, distinct from the blue selected ring", async ({ page }, info) => {
  test.skip(isCompact(info), "no keyboard on a phone");
  const k = kinds(page);
  const ring = (id: string) => card(k, id).evaluate((el) => { const c = getComputedStyle(el); return { color: c.outlineColor, style: c.outlineStyle, width: parseFloat(c.outlineWidth), shadow: c.boxShadow }; });
  /* Every state a card can be in, focused from the keyboard. */
  for (const id of ["k-ready", "k-none", "k-sel", "k-diff", "k-tgt", "k-dim", "k-grey", "k-ok", "k-no", "k-text", "k-tile"]) {
    await card(k, id).scrollIntoViewIfNeeded();
    /* A key press first, so the browser treats the focus as the keyboard's (:focus-visible). */
    await page.keyboard.press("Shift");
    await card(k, id).focus();
    await expect(card(k, id)).toBeFocused();
    const r = await ring(id);
    expect(r.style, `${id}: focus ring`).toBe("solid");
    expect(r.width, `${id}: focus ring width`).toBeGreaterThanOrEqual(2);
    expect(r.color, `${id}: focus ring colour`).toBe("rgb(245, 245, 247)");
  }
  /* Selected keeps its own blue ring as well as the focus ring. */
  expect((await ring("k-sel")).shadow).toContain("rgb(10, 132, 255)");
});

/** The opacity a word is drawn at: its own times every ancestor's. */
const drawnAt = (loc: ReturnType<typeof card>) => loc.evaluate((el) => { let o = 1; for (let n: Element | null = el; n; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity); return o; });

test("dimming touches the picture only: a card not started, a dimmed card and a dimmed page of text keep every word at full opacity", async ({ page }) => {
  const k = kinds(page);
  /* Not started: the picture is half-dimmed; the card, its title and its status are not. */
  expect(await card(k, "k-none").locator(".v12-card-img").evaluate((el) => getComputedStyle(el).opacity)).toBe("0.55");
  expect(await drawnAt(card(k, "k-none"))).toBe(1);
  expect(await drawnAt(card(k, "k-none").locator(".v12-card-title"))).toBe(1);
  expect(await drawnAt(card(k, "k-none").getByTestId("v12-card-status"))).toBe(1);
  /* Dimmed: the picture fades to 35%; the title, the status and the chips are drawn at full opacity. */
  expect(await card(k, "k-dim").locator(".v12-card-img").evaluate((el) => getComputedStyle(el).opacity)).toBe("0.35");
  expect(await drawnAt(card(k, "k-dim"))).toBe(1);
  for (const words of [card(k, "k-dim").locator(".v12-card-title"), card(k, "k-dim").getByTestId("v12-card-status"), card(k, "k-dim").locator(".v12-card-chip")]) expect(await drawnAt(words)).toBe(1);
  /* A dimmed page of text: its title row and its lines are words, and stay full. */
  for (const words of [card(k, "k-dim-text").locator(".v12-card-page-title"), card(k, "k-dim-text").locator(".v12-card-page-text"), card(k, "k-dim-text").locator(".v12-card-title")]) expect(await drawnAt(words)).toBe(1);
  /* And a card is never dimmed whole. */
  for (const id of ["k-dim", "k-dim-text", "k-none"]) expect(await card(k, id).evaluate((el) => getComputedStyle(el).opacity), id).toBe("1");
});
