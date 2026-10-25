import { test, expect, type Page } from "@playwright/test";

/*
 * "Continue with Google" on the sign-in page (lib/useGoogleSignIn.ts, components/WelcomeSignIn.tsx). It is drawn only where the server says
 * Google sign-in is on (GET /api/auth/google/status); this spec turns that answer on in the browser and checks what the button does (it only
 * goes to the start route, which is stubbed: nothing leaves this machine) and what the page says when a sign-in is refused. The server rules
 * themselves are tests/unit/googleSignIn.spec.ts.
 *
 * Moved from tests/google-signin-v12-workbench.spec.ts when the prototype-12 build was deleted (23 Oct 2026; docs/old-shells.md): the
 * sign-in page's two tests unchanged; the join sheet's test kept as a fixme, its sheet having gone with that build.
 */
const status = (page: Page, enabled: boolean) => page.route("**/api/auth/google/status", (route) => route.fulfill({ json: { enabled } }));
async function stubStart(page: Page) {
  /* What reached the start: its method and its fields (a POST's form body, or a GET's query). */
  const started: { method: string; fields: string }[] = [];
  await page.route("**/api/auth/google/start**", (route) => {
    const r = route.request();
    started.push({ method: r.method(), fields: r.method() === "POST" ? r.postData() ?? "" : new URL(r.url()).search });
    return route.fulfill({ status: 200, contentType: "text/html", body: "<title>Google stub</title>" });
  });
  return started;
}
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

test.fixme("the join sheet draws Continue with Google only when it is on, with the required 18+ tick; without the tick nothing starts; with it the start is a POST carrying the invite, accept=1 and a same-site next — no home: the visitor join sheet is deleted (23 Oct 2026), and no live page posts an invite to the Google start (the server rule is tests/unit/googleSignIn.spec.ts); owner question: does v31.16 bring it back?", () => {});

test("the sign-in page offers Continue with Google when it is on, and says in a line why a refused attempt was", async ({ page }) => {
  test.setTimeout(240_000);
  await status(page, true);
  const started = await stubStart(page);
  await page.goto("/login?next=%2Fsuites");
  const google = page.getByTestId("signin-google");
  await expect(google).toBeVisible({ timeout: 60_000 });
  await google.click();
  await expect.poll(() => started.length).toBe(1);
  expect(started[0].method).toBe("GET");
  expect(new URLSearchParams(started[0].fields).get("next")).toBe("/suites");
  expect(new URLSearchParams(started[0].fields).get("invite")).toBeNull();
  await noOverflow(page);
  for (const [code, words] of [["no_account", "invite-only"], ["unverified", "has not verified"], ["invite_mismatch", "different email address"], ["two_step", "two-step"], ["expired", "Start again"], ["limited", "Too many attempts"], ["use_email", "Continue with email"]]) {
    await page.goto(`/login?google=${code}`);
    await expect(page.getByRole("status").filter({ hasText: words })).toBeVisible({ timeout: 60_000 });
  }
  /* A made-up code says nothing. */
  await page.goto("/login?google=%3Cscript%3E");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("status").filter({ hasText: "Google" })).toHaveCount(0);
});

test("with Google off the sign-in page has no Google button", async ({ page }) => {
  test.setTimeout(240_000);
  await status(page, false);
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("signin-google")).toHaveCount(0);
});
