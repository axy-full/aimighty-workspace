import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { everySpendButtonPriced, noBannedNames, PHONES, signedInWarm, watchErrors } from "./helpers/r1-gaps";
import { openProjectFor, textReadsAtFloor } from "./helpers/gaps-l1";
import { signInLocally } from "./helpers/workbenchLocal";
import { smallText } from "./phoneFloors";

/*
 * Gaps, lane 1 · Make details (design/particl-graphite "Gaps B frames": Make details, audio, insufficient credits, failed).
 * Make's short form keeps the extra settings folded in Advanced; opened, they read as the frames draw them: what the brief set,
 * the shot's film chips, Enhance with Auto (its figure is in the button's), the settings, the takes with each total, and for
 * audio the voice, the sound and the music length. Short of credits, Top up is the button and Make waits beside it at its
 * price; a press that does not go through says so under Result with Retry at the figure. Against a local ENGINE_MOCK server;
 * every paid route is answered in the browser, nothing real is sent, and nothing is sent before a person presses.
 */
const PHONE = "the phone's Make is the simple one (tests/demo-s10-phone-make-workbench.spec.ts); the panel's Advanced is desktop";
const SHOTS = process.env.GAPS_L1_SHOTS || "/private/tmp/claude-gaps-l1-shots";
const shoot = (page: Page, name: string, project: string) => { mkdirSync(SHOTS, { recursive: true }); return page.screenshot({ path: `${SHOTS}/l1-${name}-${project.replace("workbench-", "")}.png`, animations: "disabled" }); };
const priceOf = async (page: Page) => Number(((await page.getByTestId("gen-generate").innerText()).match(/([\d,]+(?:\.\d+)?) cr/)?.[1] ?? "NaN").replace(/,/g, ""));

/** The panel's floors: no overflow, nothing under 12 px or under 55% white, every spending control priced, no retired name. */
async function floors(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), "horizontal overflow").toBeLessThanOrEqual(0);
  expect(await smallText(page), "text under 12 px").toEqual([]);
  expect(await textReadsAtFloor(page, '[data-testid="make-panel"]'), "text under 55% white").toEqual([]);
  await everySpendButtonPriced(page, '[data-testid="make-panel"]');
  await noBannedNames(page, '[data-testid="make-panel"]');
}
async function say(page: Page, words: string) { const box = page.getByTestId("gen-prompt"); await box.click(); await box.fill(words); }

test("Advanced as the frames draw it: the brief's chips, shot control, Enhance, settings and the takes, each total from the quote", async ({ page }, info) => {
  test.skip(PHONES.includes(info.project.name), PHONE);
  test.setTimeout(180_000);
  const errors = watchErrors(page);
  const paid: string[] = [];
  page.on("request", (r) => { const p = new URL(r.url()).pathname; if (r.method() === "POST" && (p === "/api/generate" || p === "/api/audio" || (p === "/api/prompt/enhance" && !(r.postDataJSON() as { quoteOnly?: boolean })?.quoteOnly))) paid.push(p); });
  const workspaceId = await signedInWarm(page);
  const { project } = await openProjectFor(page, workspaceId);
  await page.goto(`/suites?project=${project.id}&view=board&make=change`);
  await expect(page.getByTestId("make-panel")).toBeVisible();
  await say(page, "make shot 2 at golden hour");
  const go = page.getByTestId("gen-generate");
  await expect(go).toHaveText(/^Make · \d[\d,]* cr$/, { timeout: 60_000 });
  const one = await priceOf(page);
  await page.getByTestId("make-advanced-toggle").click();
  const adv = page.getByTestId("make-advanced");
  await expect(adv.getByTestId("make-from-brief")).toContainText("16:9");
  await expect(adv.getByTestId("make-shot-control")).toBeVisible();
  await expect(adv.getByTestId("gen-film")).toBeVisible();
  await expect(adv.getByTestId("enhance-auto-state")).toContainText("off");
  /* Enhance now wears the enhancer's own quote, as a marked spending button; pressing nothing sends nothing. */
  const enhance = adv.getByTestId("enhance");
  await expect(enhance).toHaveText(/^Enhance now · \d[\d,]* cr$/, { timeout: 60_000 });
  await expect(enhance).toHaveAttribute("data-spend", "priced");
  /* Takes: ×1 to ×4, each with its total; pressing ×2 puts that total on Make. */
  const chips = adv.getByTestId("gen-takes").getByRole("button");
  await expect(chips).toHaveCount(4);
  await expect(adv.getByTestId("gen-takes-2")).toContainText(`${one * 2} cr`);
  await adv.getByTestId("gen-takes-2").click();
  await expect(go).toHaveText(new RegExp(`^Make 2 takes · ${(one * 2).toLocaleString("en-US")} cr$`), { timeout: 60_000 });
  await adv.scrollIntoViewIfNeeded();
  await floors(page);
  await shoot(page, "make", info.project.name);
  expect(paid, "nothing is sent until a person presses").toEqual([]);
  expect(errors).toEqual([]);
});

test("Auto enhance is in the figure: Make reads take + enhancement, and the press enhances first and then sends those words", async ({ page }, info) => {
  test.skip(PHONES.includes(info.project.name), PHONE);
  test.setTimeout(180_000);
  const errors = watchErrors(page);
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  await signedInWarm(page);
  /* The enhancer answers in the browser: its free quote, and the one paid run. */
  await page.route("**/api/prompt/enhance", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    calls.push({ path: "enhance", body });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body.quoteOnly ? { estimateCredits: 1 } : { prompt: "A slow push toward the stall at golden hour, warm low sun", provider: "higgsfield" }) });
  });
  /* The render is never sent: the press that would send it is answered with a refusal, which also shows Result. */
  await page.route(/\/api\/generate$/, (route) => {
    if (route.request().method() !== "POST") return route.continue();
    calls.push({ path: "generate", body: route.request().postDataJSON() as Record<string, unknown> });
    return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "No render is made in this test." }) });
  });
  await page.goto("/suites?make=change");
  await say(page, "make shot 2 at golden hour");
  const go = page.getByTestId("gen-generate");
  await expect(go).toHaveText(/^Make · \d[\d,]* cr$/, { timeout: 60_000 });
  const take = await priceOf(page);
  await page.getByTestId("make-advanced-toggle").click();
  const adv = page.getByTestId("make-advanced");
  await expect(adv.getByTestId("enhance")).toHaveText("Enhance now · 1 cr", { timeout: 60_000 });
  await adv.getByTestId("enhance-auto").click();
  await expect(adv.getByTestId("enhance-auto-state")).toContainText("on");
  /* The button's figure now includes the enhancement. */
  await expect(go).toHaveText(new RegExp(`^Make · ${(take + 1).toLocaleString("en-US")} cr$`));
  await expect(go).toHaveAttribute("data-spend", "priced");
  await shoot(page, "make-auto", info.project.name);
  expect(calls.filter((c) => c.path === "generate" || (c.path === "enhance" && !c.body.quoteOnly)), "nothing paid is sent before the press").toEqual([]);
  /* Off again: the figure is the take's alone. */
  await adv.getByTestId("enhance-auto").click();
  await expect(go).toHaveText(new RegExp(`^Make · ${take.toLocaleString("en-US")} cr$`));
  await adv.getByTestId("enhance-auto").click();
  await expect(go).toHaveText(new RegExp(`^Make · ${(take + 1).toLocaleString("en-US")} cr$`));

  /* The press: the enhancement is run first, at the 1 cr it quoted, then the take is sent with the enhanced words. */
  await go.click();
  await expect.poll(() => calls.filter((c) => c.path === "enhance" && !c.body.quoteOnly).length, { timeout: 30_000 }).toBe(1);
  expect(calls.find((c) => c.path === "enhance" && !c.body.quoteOnly)!.body.maxCredits).toBe(1);
  await expect.poll(() => calls.filter((c) => c.path === "generate").length, { timeout: 30_000 }).toBe(1);
  expect(JSON.stringify(calls.find((c) => c.path === "generate")!.body)).toContain("A slow push toward the stall");
  /* The refusal is Result, with Retry at the same figure; nothing about the charge is claimed. */
  const result = page.getByTestId("make-result");
  await expect(result).toContainText("No render is made in this test.", { timeout: 30_000 });
  await expect(result).not.toContainText(/nothing billed/i);
  await expect(page.getByTestId("make-retry")).toHaveAttribute("data-spend", "priced");
  await expect(page.getByTestId("make-retry")).toContainText(/^Retry · \d[\d,]* cr$/);
  await floors(page);
  await shoot(page, "make-failed", info.project.name);
  expect(errors.filter((e) => !/400|Bad Request/.test(e))).toEqual([]);
});

test("short of credits, Top up is the button and Make waits beside it at its price", async ({ page }, info) => {
  test.skip(PHONES.includes(info.project.name), PHONE);
  test.setTimeout(180_000);
  const errors = watchErrors(page);
  const paid: string[] = [];
  page.on("request", (r) => { const p = new URL(r.url()).pathname; if (r.method() === "POST" && (p === "/api/generate" || p === "/api/audio")) paid.push(p); });
  /* A new local workspace holds a starter balance only. */
  await signInLocally(page.request, "Short Tester");
  await page.goto("/suites?make=change");
  await say(page, "make shot 2 at golden hour");
  const go = page.getByTestId("gen-generate");
  await expect(go).toHaveText(/^Make · \d[\d,]* cr$/, { timeout: 60_000 });
  await page.getByTestId("make-advanced-toggle").click();
  const adv = page.getByTestId("make-advanced");
  const length = adv.getByTestId("gen-length");
  if (await length.count()) await length.selectOption({ index: (await length.locator("option").count()) - 1 });
  const sizes = adv.getByRole("group", { name: "Resolution" }).getByRole("button");
  if (await sizes.count()) await sizes.last().click();
  await adv.getByTestId("gen-takes-4").click();
  await expect(go).toHaveText(/^Make 4 takes · \d[\d,]* cr$/, { timeout: 60_000 });
  const short = page.getByTestId("make-short");
  await expect(short).toHaveText(/^Balance [\d,]+ cr · short by [\d,.]+ cr$/);
  const top = page.getByTestId("make-top-up");
  await expect(top).toHaveText("Top up");
  await expect(top).toHaveClass(/gx-primary/);
  await expect(go).not.toHaveClass(/gx-primary/);
  await expect(go).toHaveAttribute("data-spend", "priced");
  await page.getByTestId("gen-model").click();
  await top.scrollIntoViewIfNeeded();
  await floors(page);
  await shoot(page, "make-short", info.project.name);
  await top.click();
  await expect.poll(() => new URL(page.url()).searchParams.get("tab")).toBe("credits");
  expect(paid).toEqual([]);
  expect(errors).toEqual([]);
});

test("audio: the voice, the sound to make and the music length, priced like any take", async ({ page }, info) => {
  test.skip(PHONES.includes(info.project.name), PHONE);
  test.setTimeout(180_000);
  const errors = watchErrors(page);
  const paid: string[] = [];
  /* An audio price is read through the same route with `quoteOnly`; only a send without it is paid. */
  page.on("request", (r) => { const p = new URL(r.url()).pathname; if (r.method() === "POST" && (p === "/api/generate" || (p === "/api/audio" && !String(r.postData()).includes("quoteOnly")))) paid.push(p); });
  await signedInWarm(page);
  await page.goto("/suites?make=audio");
  await say(page, "calm narration for the opening shot");
  await page.getByTestId("gen-model").click();
  await page.getByTestId("make-advanced-toggle").click();
  const adv = page.getByTestId("make-advanced");
  await expect(adv.getByTestId("make-sound-kind")).toBeVisible();
  const kinds = adv.getByTestId("make-sound-kind").getByRole("button");
  expect(await kinds.count()).toBeGreaterThan(0);
  const music = adv.getByTestId("make-sound-music");
  if (await music.count()) {
    await music.click();
    const lengths = page.getByTestId("make-music-chip");
    for (const n of [15, 30, 60]) await expect(lengths.filter({ hasText: new RegExp(`\\b${n} s`) })).toHaveCount(1);
    await lengths.filter({ hasText: /\b30 s/ }).click();
    await expect(page.getByTestId("gen-seconds-value")).toHaveText("30 s");
  }
  const speech = adv.getByTestId("make-sound-speech");
  if (await speech.count()) { await speech.click(); await expect(adv.getByTestId("make-voice")).toBeVisible(); }
  await expect(page.getByTestId("gen-generate")).toHaveAttribute("data-spend", /priced|unpriced/);
  await floors(page);
  await shoot(page, "make-audio", info.project.name);
  expect(paid).toEqual([]);
  expect(errors).toEqual([]);
});
