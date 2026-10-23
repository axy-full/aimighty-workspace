import { test, expect, type Page } from "@playwright/test";

/*
 * "Continue with Google" in the pages (lib/useGoogleSignIn.ts, components/v12/join/JoinSheet.tsx, components/WelcomeSignIn.tsx). It is drawn
 * only where the server says Google sign-in is on (GET /api/auth/google/status); this spec turns that answer on in the browser and checks
 * what the buttons do (they only go to the start route, which is stubbed: nothing leaves this machine) and what the pages say when a
 * sign-in is refused. The server rules themselves are tests/unit/googleSignIn.spec.ts.
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
async function openJoin(page: Page, google: boolean) {
  const res = await page.goto(`/v12-join?join=start${google ? "&google=1" : ""}`);
  test.skip(res?.status() === 404, "requires a local ENGINE_MOCK=1 development server");
  await expect(page.getByTestId("v12-join")).toBeVisible({ timeout: 60_000 });
}
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

test("the join sheet draws Continue with Google only when it is on, beside Continue with email, with the required 18+ tick; a visitor's page asks nothing to know", async ({ page }) => {
  test.setTimeout(240_000);
  const asked: string[] = [];
  page.on("request", (r) => { const path = new URL(r.url()).pathname; if (path.startsWith("/api/")) asked.push(path); });
  await openJoin(page, false);
  await expect(page.getByTestId("v12-join-email")).toBeVisible();
  await expect(page.getByTestId("v12-join-google")).toHaveCount(0);
  await expect(page.getByTestId("v12-join-age")).toHaveCount(0);
  await noOverflow(page);
  const started = await stubStart(page);
  await openJoin(page, true);
  const google = page.getByTestId("v12-join-google");
  await expect(google).toBeVisible();
  await expect(google).toHaveText("Continue with Google");
  await expect(page.getByTestId("v12-join-age-row")).toHaveText("I'm 18 or older and agree to the Terms");
  await expect(page.getByTestId("v12-join-age-row").getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");
  expect(asked.filter((path) => path.startsWith("/api/auth/google"))).toEqual([]);
  await page.getByTestId("v12-join-code").fill("an-invite-code-123");
  /* The tick is required: without it the form does not post, and Google is not started. */
  await google.click();
  await page.waitForTimeout(500);
  expect(started).toHaveLength(0);
  await page.getByTestId("v12-join-age").check();
  await google.click();
  await expect.poll(() => started.length).toBe(1);
  /* The join sheet starts with a form POST from its own page: only that keeps the invite (lib/googleSignIn.ts startIntent). */
  expect(started[0].method).toBe("POST");
  const query = new URLSearchParams(started[0].fields);
  expect(query.get("invite")).toBe("an-invite-code-123");
  expect(query.get("accept")).toBe("1");
  expect(query.get("next")?.startsWith("/")).toBe(true);
  await noOverflow(page);
});

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
