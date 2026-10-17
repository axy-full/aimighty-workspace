import { test, expect, type Page, type Route } from "@playwright/test";
import { seedHome } from "./helpers/v12Home";
import { ENHANCE_HINT, ENHANCE_TIP_LINE } from "../lib/v12/enhance";
import { ENHANCE_FAILED } from "../lib/shell/enhance-press";

/**
 * Enhance in Make, the new interface (lib/v12/enhance.ts; the owner's loader of 16 Oct 2026). "Enhance" is a button that wears its price ("Enhance · 1 cr").
 * Pressing it shows the loader (the dot-arc, a dimmed box under a sweep, a progress line, the hint at 2 s), streams the rewrite into the box word by word,
 * marks the changed words for a moment, and leaves "Undo enhance"; it sends NO take, and Make then sends the box as it is. Make never calls the enhancer.
 * Cancel or Esc before any word, a stream cut off midway, no word by 10 s, or any error: the typed words are back and "Couldn't enhance this time. Nothing
 * was charged." says so, with Try again. Each take is labelled in the viewer: Enhanced, with its original words one press away, or Raw. Local ENGINE_MOCK
 * server: the enhancer and the render are mock (a failing provider is a route in the browser); nothing real is spent.
 */
const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const PHONE = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const WORDS = "A paper kite over a grey sea";

const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "no horizontal overflow").toBe(true);
const button = (page: Page) => page.getByTestId("v12-make-enhance");
const info = (page: Page) => page.getByTestId("v12-make-enhance-info");
const note = (page: Page) => page.getByTestId("v12-make-bar-note");
const input = (page: Page) => page.getByTestId("v12-make-bar-input");
const go = (page: Page) => page.getByTestId("v12-make-go");
const live = (page: Page) => page.getByTestId("v12-make-enhance-live");
const isQuote = (r: { postDataJSON(): unknown }) => (r.postDataJSON() as { quoteOnly?: boolean } | null)?.quoteOnly === true;
const isEnhanceRoute = (r: { url(): string; method(): string }) => new URL(r.url()).pathname === "/api/prompt/enhance" && r.method() === "POST";
const isEnhanceRun = (r: { url(): string; method(): string; postDataJSON(): unknown }) => isEnhanceRoute(r) && !isQuote(r);
const isGenerate = (r: { url(): string; method(): string }) => new URL(r.url()).pathname === "/api/generate" && r.method() === "POST";

async function openMake(page: Page, takes = 2) {
  const seeded = await seedHome(page, { takes });
  await page.goto("/suites?view=make");
  await expect(page.getByTestId("v12-make")).toBeVisible({ timeout: 90_000 });
  await page.getByRole("radio", { name: "Image" }).click();
  await page.getByTestId("v12-make-chip-count").click();
  await page.getByRole("menuitem", { name: "1" }).click();
  return seeded;
}

/** Calls the browser sends to the enhancer's run and to Generate, in order. */
function watch(page: Page) {
  const log: string[] = [];
  page.on("request", (r) => {
    if (isEnhanceRun(r)) log.push("enhance");
    else if (isGenerate(r)) log.push("generate");
  });
  return log;
}

/** The enhancer's run answered by the test (its quote is the real mock server's). `then` runs instead of the server. */
async function answerRun(page: Page, then: (route: Route) => Promise<void>) {
  await page.route("**/api/prompt/enhance", async (route) => {
    const request = route.request();
    if (request.method() !== "POST" || isQuote(request)) return route.fallback();
    try { await then(route); } catch { /* the page gave up first: nothing to answer */ }
  });
}

/** The enhancer's run held back for `ms`, then let through to the real mock server (which streams). Returns a function that lets it go at once. */
function holdRuns(page: Page, ms: number): () => void {
  let release: () => void = () => undefined;
  const open = new Promise<void>((resolve) => { release = resolve; setTimeout(resolve, ms); });
  void page.route("**/api/prompt/enhance", async (route) => {
    const request = route.request();
    if (request.method() !== "POST" || isQuote(request)) return route.fallback();
    await open;
    await route.fallback();
  });
  return release;
}
/** A streamed answer made by the test: one line per piece, then the last line. */
function ndjson(route: Route, pieces: string[], prompt: string) {
  const body = [...pieces.map((t) => JSON.stringify({ t })), JSON.stringify({ done: true, prompt, provider: "claude", writer: "test" })].join("\n") + "\n";
  return route.fulfill({ status: 200, headers: { "Content-Type": "application/x-ndjson" }, body });
}

test.describe("desktop", () => {
  test.beforeEach(({}, testInfo) => test.skip(!DESKTOP.includes(testInfo.project.name), "desktop sizes"));

  test("Enhance wears its price before it is pressed, ⓘ says what it does, and there is nothing to switch", async ({ page }) => {
    test.setTimeout(300_000);
    await openMake(page);
    await expect(button(page)).toHaveText(/^Enhance$/);
    await expect(button(page), "no words, nothing to press").toHaveAttribute("aria-disabled", "true");
    await expect(info(page)).toHaveText("ⓘ");
    /* Sound is not offered it: its request carries no label, so it goes as written. */
    await page.getByRole("radio", { name: "Audio" }).click();
    await expect(button(page)).toHaveCount(0);
    await page.getByRole("radio", { name: "Image" }).click();
    await expect(button(page)).toBeVisible();
    await input(page).fill(WORDS);
    /* The enhancer's own quote, read free: "Enhance · 1 cr"; Make's figure is the take alone and never includes it. */
    await expect(button(page)).toHaveText(/^Enhance · [\d,]+ cr$/, { timeout: 60_000 });
    await expect(button(page)).not.toHaveAttribute("aria-disabled", "true");
    await expect(button(page)).toHaveAttribute("data-spend", "priced");
    await expect(go(page)).toHaveText(/^Make · [\d,]+ cr$/, { timeout: 60_000 });
    const makeFigure = await go(page).innerText();
    /* The ⓘ is its own control: the tooltip opens on hover, on focus, and a tap or click pins it until a click elsewhere or Esc. */
    const tip = page.getByTestId("v12-tooltip");
    await info(page).hover();
    await expect(tip).toBeVisible();
    await expect(tip.locator(".v12-tip-name")).toHaveText("Enhance");
    await expect(tip.locator(".v12-tip-line")).toHaveText(ENHANCE_TIP_LINE);
    await page.mouse.move(700, 600);
    await expect(tip).toHaveCount(0);
    await button(page).focus();
    await page.keyboard.press("Tab");
    await expect(info(page)).toBeFocused();
    await expect(tip).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(tip).toHaveCount(0);
    await info(page).click();
    await expect(info(page)).toHaveAttribute("aria-expanded", "true");
    await page.mouse.click(700, 600);
    await expect(tip).toHaveCount(0);
    /* Nothing was pressed: no run, and nothing remembered on this device. */
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("particl:v12-enhance:")))).toEqual([]);
    expect(await go(page).innerText()).toBe(makeFigure);
    await noOverflow(page);
  });

  test("Make never calls the enhancer: a press of Make sends the box as written, and the take is Raw", async ({ page }) => {
    test.setTimeout(300_000);
    const seeded = await openMake(page);
    const log = watch(page);
    await input(page).fill(WORDS);
    await expect(button(page)).toHaveText(/^Enhance · [\d,]+ cr$/, { timeout: 60_000 });
    await expect(go(page)).toHaveText(/^Make · [\d,]+ cr$/, { timeout: 60_000 });
    const shown = Number((await go(page).innerText()).match(/· ([\d,]+) cr$/)![1].replace(/,/g, ""));
    const sent = page.waitForRequest(isGenerate);
    await go(page).click();
    const body = (await sent).postDataJSON() as { maxCredits?: number; prompt?: string; enhanced?: unknown };
    expect(body.prompt).toBe(WORDS);
    expect(body.enhanced).toBe(false);
    expect(body.maxCredits).toBe(shown);
    await expect(page.getByTestId("v12-make-count")).toHaveText("3 results", { timeout: 90_000 });
    /* A raw: line is not enhanced either; and neither press ever called the enhancer's run. */
    await input(page).fill(`raw: ${WORDS}`);
    await expect(go(page)).toHaveText(/^Make · [\d,]+ cr$/, { timeout: 60_000 });
    await expect(button(page)).toHaveAttribute("aria-disabled", "true");
    const sentRaw = page.waitForRequest(isGenerate);
    await go(page).click();
    expect(((await sentRaw).postDataJSON() as { prompt?: string; enhanced?: unknown })).toMatchObject({ prompt: `raw: ${WORDS}`, enhanced: false });
    expect(log.filter((entry) => entry === "enhance"), "Make never called the enhancer").toEqual([]);
    await expect.poll(async () => {
      const jobs = await page.request.get("/api/jobs?limit=10", { headers: seeded.headers }).then((r) => r.json()) as { generations?: { params?: { enhanced?: boolean } }[] };
      return (jobs.generations ?? []).filter((g) => g.params?.enhanced === false).length;
    }, { timeout: 60_000 }).toBe(2);
  });

  test("pressing Enhance: the loader states, the words stream into the box, the changed words are marked, Undo enhance, and nothing is generated until Make", async ({ page }) => {
    test.setTimeout(300_000);
    const seeded = await openMake(page);
    const log = watch(page);
    await input(page).fill(WORDS);
    await expect(button(page)).toHaveText(/^Enhance · [\d,]+ cr$/, { timeout: 60_000 });
    await expect(go(page)).toHaveText(/^Make · [\d,]+ cr$/, { timeout: 60_000 });
    const take = Number((await go(page).innerText()).match(/· ([\d,]+) cr$/)![1].replace(/,/g, ""));
    const quoted = Number((await button(page).innerText()).match(/· ([\d,]+) cr$/)![1].replace(/,/g, ""));
    /* The server's reply is held for 2.6 s, so the waiting states (and the hint at 2 s) can be seen; then it streams for real. */
    const hold = holdRuns(page, 2_600);
    const enhanceSent = page.waitForRequest(isEnhanceRun);
    const streamed = page.waitForResponse((r) => isEnhanceRun(r.request()));
    /* The words seen in the box as they arrive: more than one value means it streamed. */
    await page.evaluate(() => {
      const box = document.querySelector<HTMLInputElement>('[data-testid="v12-make-bar-input"]')!;
      (window as unknown as { seen: string[] }).seen = [];
      const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!;
      Object.defineProperty(box, "value", { configurable: true, get() { return proto.get!.call(this); }, set(v: string) { (window as unknown as { seen: string[] }).seen.push(v); proto.set!.call(this, v); } });
    });
    await button(page).click();
    /* Waiting: the button wears the dot-arc loader and is disabled; the box dims under a sweep; a progress line runs; Make waits. */
    await expect(button(page)).toHaveText("Enhancing…");
    await expect(button(page)).toHaveAttribute("aria-busy", "true");
    await expect(button(page)).toHaveAttribute("aria-disabled", "true");
    await expect(button(page).getByTestId("v12-arc")).toBeVisible();
    await expect(input(page)).toHaveAttribute("readonly", "");
    await expect(input(page)).toHaveAttribute("aria-busy", "true");
    await expect(page.getByTestId("v12-make-bar-sweep")).toBeVisible();
    await expect(page.getByTestId("v12-make-bar-progress")).toBeVisible();
    await expect(page.locator(".v12-bar-field")).toHaveAttribute("data-working", "");
    expect(Number(await input(page).evaluate((el) => getComputedStyle(el).opacity)), "the box is dimmed").toBeLessThan(0.9);
    await expect(note(page)).toContainText("Enhancing…");
    await expect(live(page)).toHaveText("Enhancing…");
    await expect(go(page)).toBeDisabled();
    /* At 2 s: what it is doing, with no engine named. */
    await expect(note(page)).toHaveText(new RegExp(`^${ENHANCE_HINT}\\s*Cancel$`), { timeout: 10_000 });
    await expect(live(page)).toHaveText(ENHANCE_HINT);
    /* A second press while it works is not another press. */
    await button(page).click({ force: true });
    hold();
    const enhanceBody = (await enhanceSent).postDataJSON() as { maxCredits?: number; prompt?: string; stream?: boolean };
    expect(enhanceBody.prompt).toBe(WORDS);
    expect(enhanceBody.stream).toBe(true);
    expect(enhanceBody.maxCredits, "approved at the figure on the button").toBe(quoted);
    const reply = await streamed;
    expect(reply.headers()["content-type"]).toMatch(/ndjson/);
    /* Done: the words are in the box (they arrived in pieces), the changed ones are marked for a moment, and the line says what it cost with Undo enhance. */
    await expect(note(page)).toContainText(/^Enhanced · [\d,]+ cr/, { timeout: 30_000 });
    const written = await input(page).inputValue();
    expect(written.length).toBeGreaterThan(WORDS.length - 1);
    const seen = await page.evaluate(() => (window as unknown as { seen: string[] }).seen);
    expect(new Set(seen.filter((v) => v !== WORDS && v !== written)).size, "the words arrived one by one, not all at once").toBeGreaterThan(1);
    expect(seen.at(-1)).toBe(written);
    await expect(page.getByTestId("v12-make-bar-marked")).toBeVisible();
    await expect(page.getByTestId("v12-make-bar-marked")).toHaveCount(0, { timeout: 10_000 });
    await expect(live(page)).toHaveText(/^Enhanced\. Undo enhance is available\.$/);
    await expect(page.getByTestId("v12-make-enhance-undo")).toHaveText("Undo enhance");
    await expect(button(page)).toHaveText(/^Enhance · /);
    await expect(input(page)).not.toHaveAttribute("readonly", "");
    expect(log, "Enhance alone sends no take, and one press sent one request").toEqual(["enhance"]);
    await expect(go(page)).toHaveText(/^Make · [\d,]+ cr$/);
    /* The next Make press spends: the take at its own figure, with the words in the box, labelled Enhanced from the typed ones. */
    const generateSent = page.waitForRequest(isGenerate);
    await go(page).click();
    const generated = (await generateSent).postDataJSON() as { maxCredits?: number; prompt?: string; enhanced?: { from: string } | false };
    expect(generated.prompt?.trim()).toBe(written.trim());
    expect(generated.enhanced, "the take says what it was made from").toEqual({ from: WORDS });
    expect(generated.maxCredits, "Make's figure is the take alone").toBe(take);
    expect(log).toEqual(["enhance", "generate"]);
    await expect.poll(async () => {
      const jobs = await page.request.get("/api/jobs?limit=10", { headers: seeded.headers }).then((r) => r.json()) as { generations?: { prompt?: string; params?: { enhanced?: boolean; enhancedFrom?: string; rawPrompt?: string } }[] };
      const mine = (jobs.generations ?? []).find((g) => g.params?.enhancedFrom === WORDS);
      return mine ? { enhanced: mine.params?.enhanced, enhancedFrom: mine.params?.enhancedFrom, rawPromptIsWordsSent: mine.params?.rawPrompt === written.trim() } : null;
    }, { timeout: 60_000 }).toEqual({ enhanced: true, enhancedFrom: WORDS, rawPromptIsWordsSent: true });
    await noOverflow(page);
  });

  test("Undo enhance puts the typed words back, and editing the enhanced words makes the take Raw", async ({ page }) => {
    test.setTimeout(300_000);
    await openMake(page);
    await answerRun(page, (route) => ndjson(route, ["A paper kite, ", "low sun over ", "a grey sea, slow dolly."], "A paper kite, low sun over a grey sea, slow dolly."));
    await input(page).fill(WORDS);
    await expect(button(page)).toHaveText(/^Enhance · [\d,]+ cr$/, { timeout: 60_000 });
    await button(page).click();
    await expect(input(page)).toHaveValue("A paper kite, low sun over a grey sea, slow dolly.");
    await page.getByTestId("v12-make-enhance-undo").click();
    await expect(input(page)).toHaveValue(WORDS);
    await expect(note(page)).toHaveCount(0);
    /* Enhanced again, then edited: the words are the person's own, so the take does not claim to be Enhanced. */
    await button(page).click();
    await expect(input(page)).toHaveValue("A paper kite, low sun over a grey sea, slow dolly.");
    await input(page).fill("A paper kite, low sun over a grey sea, slow dolly. Wide lens.");
    await expect(note(page)).toHaveCount(0);
    await expect(go(page)).toHaveText(/^Make · [\d,]+ cr$/, { timeout: 60_000 });
    const sent = page.waitForRequest(isGenerate);
    await go(page).click();
    expect(((await sent).postDataJSON() as { enhanced?: unknown }).enhanced).toBe(false);
  });

  test("Cancel (and Esc) before any word charges nothing: the request is dropped, the typed words stay, nothing is said", async ({ page }) => {
    test.setTimeout(300_000);
    await openMake(page);
    const log = watch(page);
    let dropped = 0;
    await answerRun(page, async () => { await new Promise((resolve) => setTimeout(resolve, 30_000)); });
    page.on("requestfailed", (r) => { if (isEnhanceRun(r)) dropped++; });
    await input(page).fill(WORDS);
    await expect(button(page)).toHaveText(/^Enhance · [\d,]+ cr$/, { timeout: 60_000 });
    for (const how of ["button", "esc"] as const) {
      await button(page).click();
      await expect(button(page)).toHaveText("Enhancing…");
      if (how === "button") await page.getByTestId("v12-make-enhance-cancel").click();
      else await page.keyboard.press("Escape");
      await expect(button(page)).toHaveText(/^Enhance · /);
      await expect(input(page)).toHaveValue(WORDS);
      await expect(input(page)).not.toHaveAttribute("readonly", "");
      await expect(note(page)).toHaveCount(0);
    }
    await expect.poll(() => dropped, { timeout: 10_000 }).toBe(2);
    expect(log).toEqual(["enhance", "enhance"]);
    await expect(go(page)).toHaveText(/^Make · [\d,]+ cr$/);
    await noOverflow(page);
  });

  test("a stream cut off midway restores the typed words, charges nothing, and says so with Try again, which works", async ({ page }) => {
    test.setTimeout(300_000);
    await openMake(page);
    let first = true;
    await page.route("**/api/prompt/enhance", async (route) => {
      const request = route.request();
      if (request.method() !== "POST" || isQuote(request)) return route.fallback();
      if (!first) return route.fallback();
      first = false;
      /* Two words, then the stream ends with no last line. */
      await route.fulfill({ status: 200, headers: { "Content-Type": "application/x-ndjson" }, body: '{"t":"A paper "}\n{"t":"kite, "}\n' });
    });
    await input(page).fill(WORDS);
    await expect(button(page)).toHaveText(/^Enhance · [\d,]+ cr$/, { timeout: 60_000 });
    await button(page).click();
    await expect(note(page)).toContainText(ENHANCE_FAILED);
    await expect(note(page)).toHaveText(`${ENHANCE_FAILED} Try again`);
    await expect(note(page)).toHaveAttribute("role", "alert");
    await expect(live(page)).toHaveText(ENHANCE_FAILED);
    await expect(input(page), "the original text is back").toHaveValue(WORDS);
    await expect(button(page)).toHaveText(/^Enhance · /);
    await page.getByTestId("v12-make-enhance-again").click();
    await expect(note(page)).toContainText(/^Enhanced · /, { timeout: 30_000 });
    await expect(input(page)).not.toHaveValue(WORDS);
  });

  test("a slow provider: no word by 10 s, the typed words stay, the one line says so, and Make still sends them", async ({ page }) => {
    test.setTimeout(300_000);
    await openMake(page);
    const log = watch(page);
    /* The provider takes far longer than the client will wait. */
    await answerRun(page, async () => { await new Promise((resolve) => setTimeout(resolve, 20_000)); });
    await input(page).fill(WORDS);
    await expect(button(page)).toHaveText(/^Enhance · [\d,]+ cr$/, { timeout: 60_000 });
    const pressed = Date.now();
    await button(page).click();
    await expect(button(page)).toHaveText("Enhancing…");
    await expect(note(page)).toHaveText(`${ENHANCE_FAILED} Try again`, { timeout: 18_000 });
    expect(Date.now() - pressed, "given up on at about 10 s").toBeLessThan(15_000);
    expect(Date.now() - pressed).toBeGreaterThan(9_000);
    await expect(note(page)).toHaveAttribute("role", "alert");
    await expect(input(page)).toHaveValue(WORDS);
    await expect(button(page)).toHaveText(/^Enhance · /);
    /* Make is not held up by it: the typed words go as written. */
    const sent = page.waitForRequest(isGenerate);
    await go(page).click();
    expect(((await sent).postDataJSON() as { prompt?: string; enhanced?: unknown })).toMatchObject({ prompt: WORDS, enhanced: false });
    expect(log).toEqual(["enhance", "generate"]);
    await noOverflow(page);
  });

  test("a provider error says the one line, never nothing, and leaves the words alone", async ({ page }) => {
    test.setTimeout(300_000);
    await openMake(page);
    await answerRun(page, (route) => route.fulfill({ status: 502, json: { error: "The writer answered, but not with a prompt.", nothingBilled: true }, headers: { "Idempotency-Status": "complete" } }));
    await input(page).fill(WORDS);
    await expect(button(page)).toHaveText(/^Enhance · [\d,]+ cr$/, { timeout: 60_000 });
    await button(page).click();
    await expect(note(page)).toHaveText(`${ENHANCE_FAILED} Try again`);
    await expect(input(page)).toHaveValue(WORDS);
    await expect(button(page)).toHaveText(/^Enhance · /);
    /* New words clear the complaint. */
    await input(page).fill(`${WORDS}, at dusk`);
    await expect(note(page)).toHaveCount(0);
    await noOverflow(page);
  });

  test("a missing key answers 503 at once: the button says why and Make still works", async ({ page }) => {
    test.setTimeout(300_000);
    await openMake(page);
    const log = watch(page);
    /* The server has no writer: the quote is refused too, fast. */
    await page.route("**/api/prompt/enhance", (route) => route.fulfill({ status: 503, json: { error: "No text writer is set up for this workspace." } }));
    await input(page).fill(WORDS);
    const started = Date.now();
    await expect(button(page)).toHaveAttribute("aria-disabled", "true", { timeout: 30_000 });
    await expect(page.getByTestId("v12-make-enhance-price")).toHaveAttribute("data-price-state", "error", { timeout: 30_000 });
    await expect(page.getByTestId("v12-make-enhance-price")).toHaveAttribute("title", "No text writer is set up for this workspace.");
    expect(Date.now() - started, "fast, not a wait").toBeLessThan(10_000);
    await expect(go(page)).toHaveText(/^Make · [\d,]+ cr$/, { timeout: 60_000 });
    const sent = page.waitForRequest(isGenerate);
    await go(page).click();
    expect(((await sent).postDataJSON() as { prompt?: string; enhanced?: unknown })).toMatchObject({ prompt: WORDS, enhanced: false });
    expect(log).toEqual(["generate"]);
  });

  test("a missing key found at the press (the quote was fine): the one line, at once", async ({ page }) => {
    test.setTimeout(300_000);
    await openMake(page);
    await answerRun(page, (route) => route.fulfill({ status: 503, json: { error: "No text writer is set up for this workspace.", nothingBilled: true }, headers: { "Idempotency-Status": "complete" } }));
    await input(page).fill(WORDS);
    await expect(button(page)).toHaveText(/^Enhance · [\d,]+ cr$/, { timeout: 60_000 });
    const pressed = Date.now();
    await button(page).click();
    await expect(note(page)).toHaveText(`${ENHANCE_FAILED} Try again`);
    expect(Date.now() - pressed).toBeLessThan(5_000);
    await expect(input(page)).toHaveValue(WORDS);
  });

  test("reduced motion: no sweep, no run along the card, the loader holds still, and the states are still said", async ({ page }) => {
    test.setTimeout(300_000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openMake(page);
    const hold = holdRuns(page, 1_500);
    await input(page).fill(WORDS);
    await expect(button(page)).toHaveText(/^Enhance · [\d,]+ cr$/, { timeout: 60_000 });
    await button(page).click();
    await expect(button(page)).toHaveText("Enhancing…");
    expect(await page.getByTestId("v12-make-bar-sweep").evaluate((el) => getComputedStyle(el).display), "no sweep").toBe("none");
    expect(await page.locator(".v12-bar-progress").evaluate((el) => getComputedStyle(el, "::after").animationName), "no run along the card").toBe("none");
    expect(await page.locator(".v12-arc-dot").first().evaluate((el) => getComputedStyle(el).animationName), "the loader holds still").toBe("none");
    await expect(live(page)).toHaveText("Enhancing…");
    hold();
    await expect(note(page)).toContainText(/^Enhanced · /, { timeout: 30_000 });
  });

  test("the workspace's setting (Settings › Advanced) says whether Make offers the button", async ({ page }) => {
    test.setTimeout(300_000);
    const seeded = await openMake(page);
    await expect(button(page)).toBeVisible({ timeout: 60_000 });
    const set = await page.request.patch("/api/settings", { headers: seeded.headers, data: { enhanceDefault: "off" } });
    expect(set.ok(), await set.text()).toBe(true);
    await page.reload();
    await expect(page.getByTestId("v12-make")).toBeVisible({ timeout: 90_000 });
    await page.getByRole("radio", { name: "Image" }).click();
    await expect(page.getByTestId("v12-make-chip-count")).toBeVisible();
    await expect(button(page)).toHaveCount(0);
    /* Settings holds the same choice. */
    await page.goto("/suites?view=workspace&tab=advanced&open=models");
    await expect(page.getByTestId("settings-enhance-default")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("settings-enhance-default-off")).toHaveAttribute("aria-checked", "true");
    await page.getByTestId("settings-enhance-default-on").click();
    await expect(page.getByTestId("settings-enhance-default-on")).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
    const read = await page.request.get("/api/settings", { headers: seeded.headers }).then((r) => r.json()) as { settings: Record<string, string> };
    expect(read.settings.enhanceDefault).toBe("on");
  });

  test("Variations of an Enhanced take loads words that are already enhanced: the take stays Enhanced, and Make does not call the enhancer", async ({ page }) => {
    test.setTimeout(300_000);
    await seedHome(page, { takes: 3 });
    await page.route(/\/api\/jobs\?limit=/, async (route) => {
      try {
        const reply = await route.fetch();
        const body = await reply.json() as { generations?: Record<string, unknown>[] };
        const a = body.generations?.[0];
        if (a) a.params = { ...(a.params as object), enhanced: true, enhancedFrom: "a kite, grey sea" };
        await route.fulfill({ response: reply, json: body });
      } catch { await route.fallback().catch(() => undefined); }
    });
    const log = watch(page);
    await page.goto("/suites?view=make&viewer=1");
    await expect(page.getByTestId("v12-make-viewer")).toBeVisible({ timeout: 90_000 });
    await page.getByTestId("v12-make-viewer-reuse").click();
    await expect(input(page)).not.toHaveValue("", { timeout: 30_000 });
    await expect(go(page)).toHaveText(/^Make( \d takes)? · \d[\d,]* cr$/, { timeout: 60_000 });
    const figure = async () => { const m = (await go(page).innerText()).match(/· ([\d,]+) cr$/); return m ? Number(m[1].replace(/,/g, "")) : -1; };
    const withReused = await figure();
    /* The press sends them as the take they came from: Enhanced, from the typed words. */
    const sent = page.waitForRequest(isGenerate);
    await go(page).click();
    const body = (await sent).postDataJSON() as { enhanced?: { from: string } | false; maxCredits?: number };
    expect(body.enhanced).toEqual({ from: "a kite, grey sea" });
    expect(body.maxCredits).toBe(withReused);
    expect(log, "no enhancement").toEqual(["generate"]);
  });

  test("the viewer's prompt line is the enhanced words, See original is what was typed, and Raw says Raw; an older take says nothing", async ({ page }) => {
    test.setTimeout(300_000);
    await seedHome(page, { takes: 3 });
    await page.route(/\/api\/jobs\?limit=/, async (route) => {
      try {
        const reply = await route.fetch();
        const body = await reply.json() as { generations?: Record<string, unknown>[] };
        const [a, b] = body.generations ?? [];
        if (a) a.params = { ...(a.params as object), enhanced: true, enhancedFrom: "a kite, grey sea" };
        if (b) b.params = { ...(b.params as object), enhanced: false };
        await route.fulfill({ response: reply, json: body });
      } catch { await route.fallback().catch(() => undefined); }
    });
    await page.goto("/suites?view=make&viewer=1");
    await expect(page.getByTestId("v12-make-viewer")).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId("v12-make-viewer-enhance-label")).toHaveText("Enhanced");
    /* The words the take was made from lead the viewer; the typed ones appear only when asked for, and never replace them. */
    const made = (await page.getByTestId("v12-make-viewer-prompt").innerText()).trim();
    expect(made.length).toBeGreaterThan(10);
    expect(made).not.toBe("a kite, grey sea");
    await expect(page.getByTestId("v12-make-viewer-original")).toHaveCount(0);
    await page.getByTestId("v12-make-viewer-see-original").click();
    await expect(page.getByTestId("v12-make-viewer-original")).toHaveText("a kite, grey sea");
    await expect(page.getByTestId("v12-make-viewer-prompt")).toHaveText(made);
    await page.getByTestId("v12-make-viewer-next").click();
    await expect(page.getByTestId("v12-make-viewer-enhance-label")).toHaveText("Raw");
    await expect(page.getByTestId("v12-make-viewer-see-original")).toHaveCount(0);
    await expect(page.getByTestId("v12-make-viewer-original")).toHaveCount(0);
    await page.getByTestId("v12-make-viewer-next").click();
    await expect(page.getByTestId("v12-make-viewer-enhance")).toHaveCount(0);
    await noOverflow(page);
  });
});

test("phones keep the phone app: no Enhance button, and nothing overflows", async ({ page }, testInfo) => {
  test.skip(!PHONE.includes(testInfo.project.name), "phone sizes");
  test.setTimeout(240_000);
  await seedHome(page, { takes: 1 });
  const log = watch(page);
  await page.goto("/suites?view=make");
  await expect(page.locator("[data-phone]")).toHaveCount(1, { timeout: 90_000 });
  await expect(button(page)).toHaveCount(0);
  expect(log).toEqual([]);
  await noOverflow(page);
});
