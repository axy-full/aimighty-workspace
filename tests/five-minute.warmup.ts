import { chromium, type FullConfig } from "@playwright/test";
import { mockInvitation, PASSPHRASE, scopeFor, startAtomikOnApi } from "./helpers/fiveMinute";

/**
 * Not timed, not asserted. One throwaway person walks the same path first, so a cold dev server has compiled the
 * sign-up page, Home, the board, the phone's screens and the routes behind them before the timed run starts (a cold
 * server fails the first test on compile time alone). A failure here only means the server is not ready: say so and stop.
 */
export default async function warmUp(config: FullConfig) {
  const use = config.projects[0].use;
  const base = String(use.baseURL ?? process.env.PW_BASE_URL ?? "http://localhost:4551");
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(base)) throw new Error("The five-minute test runs only against a local server.");
  const health = await fetch(`${base}/api/health`).then((r) => r.json()).catch(() => null) as { mock?: boolean } | null;
  if (!health?.mock) throw new Error("The five-minute test needs a local server started with ENGINE_MOCK=1 (no real generation).");
  const browser = await chromium.launch({ channel: use.channel, executablePath: use.launchOptions?.executablePath });
  try {
    for (const phone of [false, true]) {
      const context = await browser.newContext({ baseURL: base, viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: phone, hasTouch: phone });
      const page = await context.newPage();
      const invite = await mockInvitation(base, "Warm Up");
      await page.goto(invite.link, { timeout: 120_000 });
      await page.getByLabel(/workspace name/i).fill("Warm up");
      await page.getByLabel(/^password/i).fill(PASSPHRASE);
      await page.getByLabel(/^confirm password/i).fill(PASSPHRASE);
      await page.getByRole("checkbox").check();
      await page.getByRole("button", { name: /Create the workspace/ }).click();
      await page.waitForURL((url) => !/signup/.test(url.pathname), { timeout: 120_000 });
      await page.goto("/suites?view=home", { timeout: 120_000 });
      await page.waitForTimeout(2500);
      const started = await startAtomikOnApi(page.request, "A short film about a courier on a rooftop at dawn, three shots.");
      const { scope } = await scopeFor(page.request);
      await page.addInitScript(({ scope, id }) => { try { localStorage.setItem(scope, id); } catch { /* storage off */ } }, { scope, id: started.draftId });
      await page.goto(`/suites?project=${started.draftId}&view=board&atomik=1`, { timeout: 120_000 });
      await page.waitForTimeout(4000);
      if (phone) {
        for (const screen of ["plan", "record", "make", "review"]) {
          await page.goto(`/suites?project=${started.draftId}&screen=${screen}`, { timeout: 120_000 });
          await page.waitForTimeout(1500);
        }
      }
      await context.close();
    }
  } catch (error) {
    throw new Error(`The warm-up walk did not finish, so the server is not ready: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await browser.close();
  }
}
