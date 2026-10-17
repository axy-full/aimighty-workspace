import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { seedHome } from "../helpers/v12Home";

/**
 * The Enhance loader, every state, as pictures (the owner's note of 16 Oct 2026, section E): idle with its price, waiting, the 2 s hint, the words arriving,
 * the changed words marked, done with Undo enhance, and a failure with Try again; at 1440×900 and at 3008×1692 @2×. Local ENGINE_MOCK server, nothing
 * real is spent. The pictures go to ENHANCE_SHOTS (a new dated folder per run; nothing is cleaned), named `<state>-<size>.png`. They are for the owner's
 * eyes, not assertions: the states themselves are asserted in tests/enhance-v12-workbench.spec.ts; run with playwright.redesign.config.ts --project=redesign-1440x900.
 */
const WORDS = "A paper kite over a grey sea";
const SIZES = [
  { name: "1440", viewport: { width: 1440, height: 900 }, scale: 1 },
  { name: "3008x1692@2x", viewport: { width: 3008, height: 1692 }, scale: 2 },
] as const;
const OUT = process.env.ENHANCE_SHOTS || join(tmpdir(), `particl-enhance-shots-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}`);

const isQuote = (r: { postDataJSON(): unknown }) => (r.postDataJSON() as { quoteOnly?: boolean } | null)?.quoteOnly === true;

for (const size of SIZES) {
  test.describe(`loader states at ${size.name}`, () => {
    test.use({ viewport: size.viewport, deviceScaleFactor: size.scale });

    test("every state", async ({ page }, info) => {
      test.skip(info.project.name !== "redesign-1440x900", "one project carries both sizes");
      test.setTimeout(300_000);
      mkdirSync(OUT, { recursive: true });
      const shot = (state: string) => page.screenshot({ path: join(OUT, `${state}-${size.name}.png`), animations: "allow" });
      await seedHome(page, { takes: 2 });
      await page.goto("/suites?view=make");
      await expect(page.getByTestId("v12-make")).toBeVisible({ timeout: 90_000 });
      await page.getByRole("radio", { name: "Image" }).click();
      const input = page.getByTestId("v12-make-bar-input");
      const button = page.getByTestId("v12-make-enhance");
      const note = page.getByTestId("v12-make-bar-note");
      const quiet = async () => { await page.mouse.move(size.viewport.width / 2, size.viewport.height / 3); await page.waitForTimeout(250); };

      await input.fill(WORDS);
      await expect(button).toHaveText(/^Enhance · [\d,]+ cr$/, { timeout: 60_000 });
      await quiet();
      await shot("1-idle");

      /* Waiting, then the hint at 2 s (the reply is held 4.5 s so both can be taken). */
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => { release = resolve; setTimeout(resolve, 4_500); });
      await page.route("**/api/prompt/enhance", async (route) => {
        if (route.request().method() !== "POST" || isQuote(route.request())) return route.fallback();
        await held;
        await route.fallback();
      });
      await button.click();
      await expect(button).toHaveText("Enhancing…");
      await quiet();
      await shot("2-waiting");
      await expect(note).toContainText("Rewriting for the chosen engine", { timeout: 5_000 });
      await shot("3-hint-at-2s");
      release();

      /* The words arriving: the first piece in the box that is not the typed words, taken at once. */
      await page.waitForFunction((typed) => { const el = document.querySelector<HTMLInputElement>('[data-testid="v12-make-bar-input"]'); return Boolean(el && el.value !== typed && el.value.length > 0); }, WORDS, { timeout: 30_000, polling: 20 });
      await shot("4-words-arriving");
      await expect(note).toContainText(/^Enhanced · /, { timeout: 30_000 });
      await shot("5-done-changed-words-marked");
      await expect(page.getByTestId("v12-make-bar-marked")).toHaveCount(0, { timeout: 10_000 });
      await quiet();
      await shot("6-done-undo-enhance");

      /* A failure: the stream is cut off; the typed words are back, with Try again. */
      await page.getByTestId("v12-make-enhance-undo").click();
      await page.unroute("**/api/prompt/enhance");
      await page.route("**/api/prompt/enhance", async (route) => {
        if (route.request().method() !== "POST" || isQuote(route.request())) return route.fallback();
        await route.fulfill({ status: 200, headers: { "Content-Type": "application/x-ndjson" }, body: '{"t":"A paper "}\n' });
      });
      await expect(button).toHaveText(/^Enhance · [\d,]+ cr$/, { timeout: 60_000 });
      await button.click();
      await expect(page.getByTestId("v12-make-enhance-again")).toBeVisible();
      await quiet();
      await shot("7-failed-try-again");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    });
  });
}

