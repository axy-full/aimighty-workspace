import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";

/**
 * The public site (app/(marketing)/site, served by proxy.ts). A visitor sees
 * it at the product's own paths; a member at / still gets the app. Every
 * page is checked at the five sizes for overflow and phone targets, and the
 * hero's handoff is followed into Gen, where the quote on Gen's own button
 * must equal the one the site printed.
 */

const PAGES: [string, string][] = [
  ["/", "Gen"], ["/studio", "Studio"], ["/business", "Business"], ["/viral", "Viral"],
  ["/atomik", "Atomik"], ["/workspace", "Workspace"], ["/pricing", "Pricing"],
];
const DESKTOP = "workbench-1440x900";

async function fits(page: Page) {
  return page.evaluate(() => {
    const phone = window.innerWidth <= 720;
    const small = phone
      ? [...document.querySelectorAll<HTMLElement>("a, button, input, textarea, select")]
        .filter((el) => el.getAttribute("aria-hidden") !== "true")
        .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 44; })
        .map((el) => `${(el.textContent || el.tagName).trim().slice(0, 30)} (${Math.round(el.getBoundingClientRect().height)}px)`)
      : [];
    return { overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, small };
  });
}

for (const [path, tab] of PAGES) {
  test(`a visitor sees the site at ${path}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const res = await page.goto(path);
    expect(res?.status()).toBe(200);
    const nav = page.getByRole("navigation", { name: "Suites" }).first();
    await expect(nav.getByRole("link", { name: tab, exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#access form")).toBeVisible();
    const { overflow, small } = await fits(page);
    expect(overflow, `${path} is wider than the window`).toBe(false);
    expect(small, `${path} has phone targets under 44px`).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test("the internal /site path redirects to the public one", async ({ page }, info) => {
  test.skip(info.project.name !== DESKTOP, "routing, once");
  const res = await page.request.get("/site/studio", { maxRedirects: 0 });
  expect(res.status()).toBe(308);
  expect(res.headers().location).toMatch(/\/studio$/);
});

test("request access posts to the real endpoint and confirms", async ({ page }, info) => {
  test.skip(info.project.name !== DESKTOP, "one post");
  let body: Record<string, unknown> | null = null;
  await page.route("**/api/access-request", async (route) => {
    body = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.goto("/pricing");
  await page.locator("#access").getByLabel("Work email").fill("someone@example.test");
  await page.locator("#access").getByRole("button", { name: "Request access" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Noted." })).toBeVisible();
  expect(body).toMatchObject({ email: "someone@example.test", company: "" });
});

test("a member keeps the app at /, and the site offers the app instead of sign-in", async ({ page }, info) => {
  test.skip(info.project.name !== DESKTOP, "one member");
  await signInLocally(page.request);
  /* Read, not visited: the app at / hands a member on to the shell by itself,
     and that navigation would abort the next goto. */
  const home = await page.request.get("/");
  expect(home.ok()).toBe(true);
  expect(await home.text()).not.toContain("mk-header");
  await page.goto("/studio");
  await expect(page.locator(".mk-header").getByRole("link", { name: "Open Particl" })).toHaveAttribute("href", "/suites");
  await expect(page.locator(".mk-header").getByRole("link", { name: "Sign in" })).toHaveCount(0);
});

test("the hero keeps a visitor's prompt and opens it in Gen, quoted as the site said", async ({ page }, info) => {
  test.skip(info.project.name !== DESKTOP, "one handoff");
  await page.goto("/");
  const go = page.locator(".mk-go");
  const quoted = (await go.textContent())!.match(/(\d[\d,]*) cr/)![1];
  await page.getByLabel("Describe the shot").fill("A lighthouse keeper walks the gallery in a storm.");
  await go.click();
  const signIn = page.locator(".mk-take").getByRole("link", { name: "Sign in" });
  await expect(signIn).toHaveAttribute("href", "/login?next=%2Fsuites%3Fview%3Dgen");

  await signInLocally(page.request);
  await page.goto("/suites?view=gen");
  await expect(page.getByTestId("gen-prompt")).toHaveValue("A lighthouse keeper walks the gallery in a storm.");
  await expect(page.getByTestId("gen-preset-note")).toContainText("From the site");
  await expect(page.getByRole("group", { name: "Resolution" }).getByRole("button", { name: "1080p" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("gen-length")).toHaveValue("5");
  await expect(page.getByTestId("gen-generate")).toContainText(`${quoted} cr`);
});
