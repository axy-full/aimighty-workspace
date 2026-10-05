import { test, expect, type Page } from "@playwright/test";
import { retiredFindings } from "./helpers/retiredSignIn";
import { signInLocally } from "./helpers/workbenchLocal";

/**
 * The public site (app/(marketing)/site, served by proxy.ts). A visitor sees
 * it at the product's own paths; a member at / still gets the app. Every
 * page is checked at the five sizes for overflow, phone targets, copy about
 * charging, and anything that needs a Higgsfield sign-in, none of which the
 * public site carries. Signed out, / is Guest Home (tests/demo-s15-guest-home-workbench.spec.ts).
 */

const PAGES: [string, string][] = [
  ["/studio", "Studio"], ["/business", "Business"], ["/viral", "Viral"],
  ["/atomik", "Atomik"], ["/workspace", "Workspace"], ["/pricing", "Pricing"],
];
const DESKTOP = "workbench-1440x900";

async function fits(page: Page) {
  return page.evaluate(() => {
    const phone = window.innerWidth <= 720;
    const small = phone
      ? [...document.querySelectorAll<HTMLElement>("a, button, input, textarea, select")]
        .filter((el) => el.getAttribute("aria-hidden") !== "true")
        .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && Math.round(r.height * 100) / 100 < 44; })
        .map((el) => `${(el.textContent || el.tagName).trim().slice(0, 30)} (${Math.round(el.getBoundingClientRect().height)}px)`)
      : [];
    return { overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, small };
  });
}

for (const [path, tab] of PAGES) {
  test(`a visitor sees the site at ${path}`, async ({ page }, info) => {
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
    /* The public site does not describe how work is charged. */
    expect(await page.locator("main").innerText(), `${path} talks about charging`).not.toMatch(/\bquot(e|es|ed|ing)\b|\bestimat|\bcharg|\bbill(ed|ing)? (at|there|in|from)|never billed|\bwallet\b/i);
    /* Nor does it offer what needs a Higgsfield sign-in (CLAUDE.md, ground rule 10): not in the
       page, its title or description, or a screenshot's path or caption. */
    const said = await page.evaluate(() => [
      document.body.innerText, document.title,
      document.querySelector('meta[name="description"]')?.getAttribute("content") ?? "",
      ...Array.from(document.querySelectorAll("img"), (img) => `${img.alt} ${img.getAttribute("src") ?? ""}`),
    ].join("\n"));
    expect(retiredFindings(said), `${path} offers what needs a Higgsfield sign-in`).toEqual([]);
    /* Every picture it shows is served (once: the files are the same at every size). */
    if (info.project.name === DESKTOP) {
      const sources = await page.locator("img").evaluateAll((all) => [...new Set(all.map((img) => (img as HTMLImageElement).src))]);
      for (const src of sources) expect((await page.request.get(src)).status(), src).toBe(200);
    }
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
