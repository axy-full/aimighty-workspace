import { test, expect, type Page } from "@playwright/test";
import { seedHome } from "./helpers/v12Home";
import { ENHANCE_TIP_LINE } from "../lib/v12/enhance";

/**
 * Make's Enhance switch in the new interface (the owner's night queue, item 2; lib/v12/enhance.ts). "Enhance ⓘ", On by default,
 * remembered per person, the workspace's default in Settings › Advanced under it. With it On, the one press enhances the words first
 * (the enhancer's own priced job, approved at its figure) and then sends the take, and the button's figure is the two together;
 * Off, or a raw: line, sends the words as written. Each take is labelled in the viewer: Enhanced, with its original words one
 * press away, or Raw. Local ENGINE_MOCK server: the enhancer and the render are mock; nothing real is spent.
 */
const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const PHONE = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const WORDS = "A paper kite over a grey sea";

const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "no horizontal overflow").toBe(true);
const toggle = (page: Page) => page.getByTestId("v12-make-enhance");
const info = (page: Page) => page.getByTestId("v12-make-enhance-info");
const credits = async (page: Page) => Number((await page.getByTestId("v12-make-go").innerText()).match(/· ([\d,]+) cr$/)![1].replace(/,/g, ""));
const isEnhanceCall = (r: { url(): string; method(): string; postDataJSON(): unknown }) =>
  new URL(r.url()).pathname === "/api/prompt/enhance" && r.method() === "POST" && (r.postDataJSON() as { quoteOnly?: boolean } | null)?.quoteOnly !== true;
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

test.describe("desktop, switch on", () => {
  test.beforeEach(({}, info) => test.skip(!DESKTOP.includes(info.project.name), "desktop sizes"));

  test("Enhance ⓘ: On by default, the owner's tooltip word for word, and remembered per person", async ({ page }) => {
    test.setTimeout(300_000);
    await openMake(page);
    await expect(toggle(page)).toHaveText(/^Enhance$/);
    await expect(info(page)).toHaveText("ⓘ");
    await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
    /* Sound is not offered it: its request carries no label, so it goes as written. */
    await page.getByRole("radio", { name: "Audio" }).click();
    await expect(toggle(page)).toHaveCount(0);
    await page.getByRole("radio", { name: "Image" }).click();
    await expect(toggle(page)).toBeVisible();
    /* The bar reflows when the quote lands: the price joins the button and the Auto line shortens, which moves the ⓘ about 40 px left. A hover sent before
       that leaves the pointer where the ⓘ was (pointerleave, so no tooltip), so hover only once the price is there. */
    await expect(page.getByTestId("v12-make-go")).toHaveText(/· [\d,]+ cr$/);
    /* The ⓘ is its own control: the tooltip opens on hover, on focus, and a tap or click pins it until a click elsewhere or Esc. */
    const tip = page.getByTestId("v12-tooltip");
    await info(page).hover();
    await expect(tip).toBeVisible();
    await expect(tip.locator(".v12-tip-name")).toHaveText("Enhance");
    await expect(tip.locator(".v12-tip-line")).toHaveText(ENHANCE_TIP_LINE);
    await page.mouse.move(700, 600);
    await expect(tip).toHaveCount(0);
    await toggle(page).focus();
    await page.keyboard.press("Tab");
    await expect(info(page)).toBeFocused();
    await expect(tip).toBeVisible();
    await expect(tip.locator(".v12-tip-line")).toHaveText(ENHANCE_TIP_LINE);
    await page.keyboard.press("Escape");
    await expect(tip).toHaveCount(0);
    await info(page).click();
    await expect(info(page)).toHaveAttribute("aria-expanded", "true");
    await page.mouse.move(700, 600);
    await expect(tip).toBeVisible();
    await expect(toggle(page), "pressing the ⓘ does not move the switch").toHaveAttribute("aria-checked", "true");
    await page.mouse.click(700, 600);
    await expect(tip).toHaveCount(0);
    await info(page).click();
    await expect(tip).toBeVisible();
    await info(page).click();
    await page.mouse.move(700, 600);
    await expect(tip).toHaveCount(0);
    expect(ENHANCE_TIP_LINE).toBe("On: Particl rewrites your prompt for the chosen engine (light, camera, detail) before it runs. Its small cost is included in the price shown. Off: your prompt is sent exactly as you typed it.");
    /* Off is kept for this person in this browser, through a reload; nothing was chosen for them before. */
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("particl:v12-enhance:")))).toEqual([]);
    await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute("aria-checked", "false");
    expect(await page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith("particl:v12-enhance:")).map(([, v]) => v))).toEqual(["0"]);
    await page.reload();
    await expect(page.getByTestId("v12-make")).toBeVisible({ timeout: 90_000 });
    await page.getByRole("radio", { name: "Image" }).click();
    await expect(toggle(page)).toHaveAttribute("aria-checked", "false");
    await noOverflow(page);
  });

  test("On, the button's figure is the take plus its enhancement, and the press enhances then sends, each at its own approval", async ({ page }) => {
    test.setTimeout(300_000);
    const seeded = await openMake(page);
    const input = page.getByTestId("v12-make-bar-input");
    /* The take alone, Off. */
    await toggle(page).click();
    await input.fill(WORDS);
    const go = page.getByTestId("v12-make-go");
    await expect(go).toHaveText(/^Make · \d[\d,]* cr$/, { timeout: 60_000 });
    const takeOnly = await credits(page);
    /* On: the enhancer's own quote is added, and the figure is the sum. */
    const quoted = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/prompt/enhance" && r.request().method() === "POST" && r.request().postDataJSON()?.quoteOnly === true);
    await toggle(page).click();
    const enhancement = ((await (await quoted).json()) as { estimateCredits: number }).estimateCredits;
    await expect(go).toHaveText(/^Make · \d[\d,]* cr$/, { timeout: 60_000 });
    await expect.poll(() => credits(page), { timeout: 30_000 }).toBe(takeOnly + enhancement);
    /* The press: the enhancer at its quoted figure, then the take at its own; together the button's figure. */
    const enhanceSent = page.waitForRequest(isEnhanceCall);
    const enhanceReply = page.waitForResponse((r) => isEnhanceCall(r.request()));
    const generateSent = page.waitForRequest(isGenerate);
    await go.click();
    const enhanceBody = (await enhanceSent).postDataJSON() as { maxCredits?: number; prompt?: string };
    expect(enhanceBody.prompt).toBe(WORDS);
    expect(enhanceBody.maxCredits).toBe(enhancement);
    const written = ((await (await enhanceReply).json()) as { prompt: string }).prompt;
    const generated = (await generateSent).postDataJSON() as { maxCredits?: number; prompt?: string; enhanced?: { from: string } | false };
    expect(generated.prompt?.trim()).toBe(written.trim());
    expect(generated.enhanced, "the take says what it was made from").toEqual({ from: WORDS });
    expect((enhanceBody.maxCredits ?? 0) + (generated.maxCredits ?? 0), "the approvals together are the figure on the button").toBe(takeOnly + enhancement);
    expect(generated.maxCredits).toBe(takeOnly);
    /* The take keeps it: Enhanced, and the words typed under their own key; rawPrompt keeps its meaning (the words sent), so the take reads as the enhanced words. (The mock enhancer answers with the words it was given, so typed and enhanced are equal here; the viewer test below tells them apart.) */
    await expect.poll(async () => {
      const jobs = await page.request.get("/api/jobs?limit=10", { headers: seeded.headers }).then((r) => r.json()) as { generations?: { prompt?: string; params?: { enhanced?: boolean; enhancedFrom?: string; rawPrompt?: string } }[] };
      const mine = (jobs.generations ?? []).find((g) => g.params?.enhancedFrom === WORDS);
      return mine ? { enhanced: mine.params?.enhanced, enhancedFrom: mine.params?.enhancedFrom, rawPromptIsWordsSent: mine.params?.rawPrompt === written.trim(), startsWithWordsSent: (mine.prompt ?? "").startsWith(written.trim()) } : null;
    }, { timeout: 60_000 }).toEqual({ enhanced: true, enhancedFrom: WORDS, rawPromptIsWordsSent: true, startsWithWordsSent: true });
  });

  test("Off, or a raw: line, sends the words as written, at the take's figure alone, and says Raw", async ({ page }) => {
    test.setTimeout(300_000);
    const seeded = await openMake(page);
    const input = page.getByTestId("v12-make-bar-input");
    const go = page.getByTestId("v12-make-go");
    const enhanceCalls: string[] = [];
    page.on("request", (r) => { if (isEnhanceCall(r)) enhanceCalls.push(r.url()); });
    /* Off. */
    await toggle(page).click();
    await input.fill(WORDS);
    await expect(go).toHaveText(/^Make · \d[\d,]* cr$/, { timeout: 60_000 });
    const shown = await credits(page);
    let sent = page.waitForRequest(isGenerate);
    await go.click();
    let body = (await sent).postDataJSON() as { maxCredits?: number; prompt?: string; enhanced?: unknown };
    expect(body.prompt).toBe(WORDS);
    expect(body.enhanced).toBe(false);
    expect(body.maxCredits).toBe(shown);
    await expect(page.getByTestId("v12-make-count")).toHaveText("3 results", { timeout: 90_000 });
    /* On, but a raw: line is never rewritten and is not priced for it. */
    await toggle(page).click();
    await input.fill(`raw: ${WORDS}`);
    await expect(go).toHaveText(/^Make · \d[\d,]* cr$/, { timeout: 60_000 });
    await expect.poll(() => credits(page), { timeout: 30_000 }).toBe(shown);
    sent = page.waitForRequest(isGenerate);
    await go.click();
    body = (await sent).postDataJSON() as { maxCredits?: number; prompt?: string; enhanced?: unknown };
    expect(body.prompt).toBe(`raw: ${WORDS}`);
    expect(body.enhanced).toBe(false);
    expect(body.maxCredits).toBe(shown);
    expect(enhanceCalls, "nothing was enhanced").toEqual([]);
    /* Both takes keep Raw. */
    await expect.poll(async () => {
      const jobs = await page.request.get("/api/jobs?limit=10", { headers: seeded.headers }).then((r) => r.json()) as { generations?: { params?: { enhanced?: boolean } }[] };
      return (jobs.generations ?? []).filter((g) => g.params?.enhanced === false).length;
    }, { timeout: 60_000 }).toBe(2);
  });

  test("the workspace's default (Settings › Advanced) sets where it starts; a person's own choice overrides it", async ({ page }) => {
    test.setTimeout(300_000);
    const seeded = await openMake(page);
    const set = await page.request.patch("/api/settings", { headers: seeded.headers, data: { enhanceDefault: "off" } });
    expect(set.ok(), await set.text()).toBe(true);
    await page.reload();
    await expect(page.getByTestId("v12-make")).toBeVisible({ timeout: 90_000 });
    await page.getByRole("radio", { name: "Image" }).click();
    await expect(toggle(page)).toHaveAttribute("aria-checked", "false");
    await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
    await page.reload();
    await expect(page.getByTestId("v12-make")).toBeVisible({ timeout: 90_000 });
    await page.getByRole("radio", { name: "Image" }).click();
    await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
    /* Settings holds the same choice. */
    await page.goto("/suites?view=workspace&tab=advanced&open=models");
    const row = page.getByTestId("settings-enhance-default");
    await expect(row).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("settings-enhance-default-off")).toHaveAttribute("aria-checked", "true");
    await page.getByTestId("settings-enhance-default-on").click();
    await expect(page.getByTestId("settings-enhance-default-on")).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
    const read = await page.request.get("/api/settings", { headers: seeded.headers }).then((r) => r.json()) as { settings: Record<string, string> };
    expect(read.settings.enhanceDefault).toBe("on");
  });

  test("Variations of an Enhanced take loads words that are already enhanced: no second enhancement, until they are edited", async ({ page }) => {
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
    const enhanceCalls: string[] = [];
    page.on("request", (r) => { if (isEnhanceCall(r)) enhanceCalls.push(r.url()); });
    await page.goto("/suites?view=make&viewer=1");
    await expect(page.getByTestId("v12-make-viewer")).toBeVisible({ timeout: 90_000 });
    await page.getByTestId("v12-make-viewer-reuse").click();
    const go = page.getByTestId("v12-make-go");
    await expect(page.getByTestId("v12-make-bar-input")).not.toHaveValue("", { timeout: 30_000 });
    await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
    await expect(go).toHaveText(/^Make( \d takes)? · \d[\d,]* cr$/, { timeout: 60_000 });
    const loaded = await page.getByTestId("v12-make-bar-input").inputValue();
    /* On, the figure is the take alone: the same as with the switch Off. */
    const figure = async () => { const m = (await go.innerText()).match(/· ([\d,]+) cr$/); return m ? Number(m[1].replace(/,/g, "")) : -1; };
    const withOn = await figure();
    await toggle(page).click();
    await expect.poll(figure, { timeout: 30_000 }).toBe(withOn);
    await toggle(page).click();
    await expect.poll(figure, { timeout: 30_000 }).toBe(withOn);
    /* The press sends them as the take they came from: Enhanced, from the typed words, nothing enhanced again. */
    const sent = page.waitForRequest(isGenerate);
    await go.click();
    const body = (await sent).postDataJSON() as { enhanced?: { from: string } | false; maxCredits?: number };
    expect(body.enhanced).toEqual({ from: "a kite, grey sea" });
    expect(body.maxCredits).toBe(withOn);
    expect(enhanceCalls, "no second enhancement").toEqual([]);
    /* Edited words are the person's again: Enhance prices and runs for them. */
    await page.getByTestId("v12-make-bar-input").fill(`${loaded} Wide lens.`);
    await expect.poll(figure, { timeout: 60_000 }).toBeGreaterThan(withOn);
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

test("phones keep the phone app: no switch", async ({ page }, info) => {
  test.skip(!PHONE.includes(info.project.name), "phone sizes");
  test.setTimeout(240_000);
  await seedHome(page, { takes: 1 });
  await page.goto("/suites?view=make");
  await expect(page.locator("[data-phone]")).toHaveCount(1, { timeout: 90_000 });
  await expect(toggle(page)).toHaveCount(0);
  await noOverflow(page);
});
