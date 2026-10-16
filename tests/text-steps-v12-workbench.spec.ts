import { test, expect, type Page } from "@playwright/test";
import { filmBoard, openBoard } from "./helpers/boardV12";
import { faintText } from "./helpers/s11-board";
import { textReadsAtFloor } from "./helpers/gaps-l1";

/**
 * Brief and Script in the new interface (demo plan PR 11; components/v12/board/TextStage.tsx): each step is one text card over the draft's own
 * words; the Script opens to Script · Beats · Breakdown and a Hindi version, whose price is the server's quote and whose press is a person's.
 * Local ENGINE_MOCK server (the Hindi script is the stand-in tool, lib/v12/translate-script.ts); nothing is generated or sent, and a send to
 * /api/generate fails the test.
 */
const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const PHONE = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const saved = (page: Page) => page.waitForResponse((r) => r.url().includes("/api/workbench/projects") && r.request().method() === "PUT" && r.ok(), { timeout: 30_000 });
const SCRIPT = "PICTURE: Harbour, dawn. SOUND: Gulls, a rope on a cleat.\nVO (SKIPPER): “Every morning starts the same.”";
const board = () => ({ ...filmBoard(), script: SCRIPT });

test.describe("desktop, switch on", () => {
  test.beforeEach(({}, info) => test.skip(!DESKTOP.includes(info.project.name), "desktop sizes"));

  test("Brief: one card with the brief's words and its spec; it opens to edit, keeps the edit, and ✓ goes stale when the words change", async ({ page }) => {
    const generates: string[] = [];
    page.on("request", (r) => { if (r.method() === "POST" && /\/api\/generate$/.test(r.url())) generates.push(r.url()); });
    const { errors } = await openBoard(page, "/suites?view=board&stage=brief", { project: board() });
    const stage = page.getByTestId("v12-text-stage");
    await expect(stage).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("v12-stage-crumb")).toHaveText("Brief");
    const cards = stage.getByTestId("v12-card");
    await expect(cards).toHaveCount(1);
    await expect(cards).toContainText("A short film about a harbour waking up.");
    await expect(cards.getByTestId("v12-card-status")).toHaveText("Ready");
    await expect(stage.locator("[data-chip]")).toContainText(["16:9", "24 fps"]);
    /* One tile, in the title row. */
    await expect(stage.locator(".v12-card-tile")).toHaveCount(1);

    await cards.hover();
    await cards.locator('[data-mark="ok"]').click();
    await expect(cards.getByTestId("v12-card-status")).toHaveText("✓ Approved");

    await cards.click();
    const words = page.getByTestId("v12-brief-words");
    await expect(words).toBeVisible();
    await expect(page.getByTestId("v12-brief-spec")).toContainText("16:9");
    const put = saved(page);
    await words.fill("A 30 s ad about a harbour waking up. For families.");
    await page.getByTestId("v12-brief-ask").focus();
    await put;
    await page.getByTestId("v12-dialog-close").click();
    await expect(page.getByTestId("v12-brief-preview")).toHaveCount(0);
    await expect(cards).toContainText("For families.");
    await expect(cards.getByTestId("v12-card-status")).toHaveText("Ready");

    await cards.hover();
    await cards.locator('[data-mark="no"]').click();
    await page.getByRole("button", { name: "Tone" }).click();
    await expect(cards.getByTestId("v12-card-status")).toHaveText("✕ Tone");
    expect(generates).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("Script: the card, the three tabs read from the breakdown, and the Hindi script is priced by the server and made by a person's press", async ({ page }) => {
    const generates: string[] = [];
    page.on("request", (r) => { if (r.method() === "POST" && /\/api\/generate$/.test(r.url())) generates.push(r.url()); });
    const runs: unknown[] = [];
    page.on("request", (r) => { if (r.method() === "POST" && /translate-script$/.test(r.url()) && r.postDataJSON()?.mode === "run") runs.push(r.postDataJSON()); });
    const { errors } = await openBoard(page, "/suites?view=board&stage=script", { project: board() });
    const stage = page.getByTestId("v12-text-stage");
    await expect(stage).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("v12-stage-crumb")).toHaveText("Script");
    await expect(stage.getByTestId("v12-card")).toHaveCount(2);
    await expect(stage.locator('[data-card="script"]')).toContainText("Every morning starts the same");
    await expect(stage.locator('[data-card="script"]').locator("[data-chip]")).toContainText(["1 scene", "8 shots"]);
    await expect(stage.locator('[data-card="hindi"] [data-testid="v12-card-status"]')).toHaveText("Not made yet");

    await stage.locator('[data-card="script"]').click();
    await expect(page.getByTestId("v12-script-words")).toHaveValue(SCRIPT);
    await page.getByRole("radio", { name: "Beats" }).click();
    await expect(page.getByTestId("v12-script-beats")).toContainText("I · EXT. HARBOUR - DAWN — 8 shots");
    await page.getByRole("radio", { name: "Breakdown" }).click();
    await expect(page.getByTestId("v12-script-breakdown")).toContainText("Shots: 8 · 24 s");
    await page.getByRole("radio", { name: "Script" }).click();

    /* Hindi: the price is the server's, the button wears it, and nothing runs until it is pressed. */
    await page.getByRole("radio", { name: "हिन्दी" }).click();
    const make = page.getByTestId("v12-hindi-make");
    await expect(make).toHaveAttribute("data-spend", "priced", { timeout: 30_000 });
    await expect(make).toHaveText(/Make the Hindi script · (up to )?\d+ cr|Make the Hindi script · \$/);
    expect(runs).toEqual([]);
    await make.click();
    await expect(page.getByTestId("v12-hindi-words")).toHaveValue(/हिन्दी \(नमूना\) · PICTURE: Harbour, dawn/);
    expect(runs).toHaveLength(1);
    expect((runs[0] as { approved: number }).approved).toBeGreaterThan(0);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("v12-script-preview")).toHaveCount(0);
    await expect(stage.locator('[data-card="hindi"] [data-testid="v12-card-status"]')).toHaveText("Hindi · from the script");
    /* The Hindi card opens the Script on its Hindi view, with what was made. */
    await stage.locator('[data-card="hindi"]').click();
    await expect(page.getByTestId("v12-hindi-words")).toHaveValue(/हिन्दी \(नमूना\)/);
    expect(generates).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("Hindi script: a failed run says Nothing billed and offers Retry, which asks again under the same price", async ({ page }) => {
    await page.route(/\/api\/v12\/translate-script$/, (route) => {
      if (route.request().method() === "POST" && route.request().postDataJSON()?.mode === "run") return route.fulfill({ status: 502, json: { error: "Sarvam could not do this." } });
      return route.fallback();
    });
    await openBoard(page, "/suites?view=board&stage=script", { project: board() });
    await page.getByTestId("v12-text-stage").locator('[data-card="script"]').click();
    await page.getByRole("radio", { name: "हिन्दी" }).click();
    const make = page.getByTestId("v12-hindi-make");
    await expect(make).toHaveAttribute("data-spend", "priced", { timeout: 30_000 });
    await make.click();
    await expect(page.getByTestId("v12-hindi-failed")).toHaveText("Sarvam could not do this. Nothing billed.");
    await expect(make).toContainText("Retry");
    await expect(make).toHaveAttribute("data-spend", "priced");
  });

  test("Hindi script: a script past the tool's limit is refused in words, with no price asked", async ({ page }) => {
    const asked: string[] = [];
    page.on("request", (r) => { if (/translate-script$/.test(r.url())) asked.push(r.url()); });
    await openBoard(page, "/suites?view=board&stage=script", { project: { ...filmBoard(), script: "x ".repeat(1500) } });
    await page.getByTestId("v12-text-stage").locator('[data-card="script"]').click();
    await page.getByRole("radio", { name: "हिन्दी" }).click();
    await expect(page.getByTestId("v12-hindi-problem")).toContainText("takes up to 2,000 characters");
    await expect(page.getByTestId("v12-hindi-make")).toBeDisabled();
    expect(asked).toEqual([]);
  });

  test("no sideways scroll, and the cards stay inside the window", async ({ page }) => {
    await openBoard(page, "/suites?view=board&stage=script", { project: board() });
    await expect(page.getByTestId("v12-text-stage")).toBeVisible({ timeout: 60_000 });
    expect(await noSideways(page)).toBe(true);
    const outside = await page.locator('[data-testid="v12-text-stage"] [data-testid="v12-card"]').evaluateAll((els) => els.filter((el) => el.getBoundingClientRect().right > innerWidth).length);
    expect(outside).toBe(0);
  });
});

/* What a person reads on the page: each card's title, status and page of text, and the row of buttons. (The card's ✓ ✕ ⋯ show on hover and their screen-reader
   words are clipped away: they are not words on the page.) */
const CARD_WORDS = ['[data-testid="v12-text-stage"] .v12-card-body', '[data-testid="v12-text-stage"] .v12-card-page', '[data-testid="v12-text-stage"] .v12-ts-acts'].join(", ");

/* The owner's five sizes (15 Oct 2026, 22:30), through one open board: the cards stay inside the window, nothing scrolls sideways, and every word is
   at least 12 px and at least 55% white, on the page and in the open preview (rule 15). */
test("Script at the five desktop sizes: no sideways scroll, cards inside the window, words readable", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop sizes");
  test.setTimeout(240_000);
  await openBoard(page, "/suites?view=board&stage=script", { project: board() });
  const stage = page.getByTestId("v12-text-stage");
  await expect(stage).toBeVisible({ timeout: 60_000 });
  for (const [width, height] of [[1280, 800], [1440, 900], [1728, 1117], [1920, 1080], [2560, 1440]] as const) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(400);
    expect(await noSideways(page), `${width}: no sideways scroll`).toBe(true);
    const outside = await stage.getByTestId("v12-card").evaluateAll((els) => els.filter((el) => { const r = el.getBoundingClientRect(); return r.right > innerWidth || r.bottom > innerHeight + 1 || r.left < 0; }).length);
    expect(outside, `${width}: cards inside the window`).toBe(0);
    expect(await faintText(page, '[data-testid="v12-text-stage"]'), `${width}: words 12 px and 55% white`).toEqual([]);
    expect(await textReadsAtFloor(page, CARD_WORDS), `${width}: words read on their ground`).toEqual([]);
  }
  await stage.locator('[data-card="script"]').click();
  await page.getByRole("radio", { name: "हिन्दी" }).click();
  await expect(page.getByTestId("v12-hindi-make")).toBeVisible();
  expect(await faintText(page, '[data-testid="v12-script-preview"]'), "the preview's words").toEqual([]);
  expect(await textReadsAtFloor(page, '[data-testid="v12-script-preview"]'), "the preview's words read on their ground").toEqual([]);
});

test.describe("phones, switch on", () => {
  test.beforeEach(({}, info) => test.skip(!PHONE.includes(info.project.name), "phone sizes"));
  test("the phone app keeps today's board: no text steps", async ({ page }) => {
    await openBoard(page, "/suites?view=board&stage=script", { project: board() });
    await expect(page.locator("[data-phone]")).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId("v12-text-stage")).toHaveCount(0);
    expect(await noSideways(page)).toBe(true);
  });
});
