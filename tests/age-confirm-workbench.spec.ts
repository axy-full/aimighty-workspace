import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * The 18+ tick on every sign-up screen (components/AgeConfirm.tsx; lib/ageConfirm.ts): the exact sentence with "Terms" linking to the Terms page, a required checkbox that is unchecked until ticked, a
 * row that is at least 44 px high, a visible focus ring when reached by keyboard, no horizontal overflow, and a screenshot of each screen at the five sizes this config runs. The API answers
 * that tell a screen what to draw are stubbed; nothing is created or sent. Screenshots go to AGE_SHOTS_DIR (a new folder per run).
 */
const LABEL = "I'm 18 or older and agree to the Terms";
const shots = process.env.AGE_SHOTS_DIR;

const SCREENS: { name: string; path: string; ready: (page: Page) => Promise<void>; box: (page: Page) => ReturnType<Page["getByRole"]> }[] = [
  { name: "signup", path: "/signup", ready: async (page) => { await page.route("**/api/auth/signup", (r) => r.request().method() === "GET" ? r.fulfill({ json: { mode: "self-serve", open: true, verificationRequired: true } }) : r.continue()); }, box: (p) => p.getByTestId("signup-terms") },
  { name: "signup-invited", path: "/signup?code=age-test-code", ready: async (page) => { await page.route(/\/api\/auth\/signup(\?.*)?$/, (r) => r.request().method() === "GET" ? r.fulfill({ json: { mode: "self-serve", open: true, verificationRequired: false, email: "invited@example.test", name: "Invited" } }) : r.continue()); }, box: (p) => p.getByTestId("signup-terms") },
  { name: "team-invite", path: "/invite/age-test-code", ready: async (page) => { await page.route("**/api/auth/accept?code=*", (r) => r.fulfill({ json: { workspace: "A studio", email: "new@example.test", name: "New", role: "member", hasAccount: false, signedInAsInvitee: false } })); }, box: (p) => p.getByTestId("invite-terms") },
  { name: "setup", path: "/setup", ready: async () => {}, box: (p) => p.getByTestId("setup-terms") },
];
/* The prototype-12 join sheet's Google row (`join-google`, on its test page /v12-join) went with that build (23 Oct 2026; docs/old-shells.md). */
test.fixme("join-google: the join sheet's Continue with Google row carries the same required 18+ tick — no home: the visitor join sheet is deleted, and today's /login Google button needs no tick (tests/google-signin-workbench.spec.ts); owner question: does v31.16 bring a join sheet with Google back?", () => {});

for (const screen of SCREENS) {
  test(`${screen.name}: the 18+ tick is the required sentence with a Terms link, 44 px, keyboard reachable with a visible ring, and nothing overflows`, async ({ page }, info) => {
    test.setTimeout(240_000);
    await screen.ready(page);
    const res = await page.goto(screen.path);
    test.skip(res?.status() === 404, "requires a local ENGINE_MOCK=1 development server");
    const box = screen.box(page);
    await expect(box).toBeVisible({ timeout: 90_000 });
    const named = page.getByRole("checkbox", { name: LABEL });
    await expect(named).toHaveCount(1);
    await expect(named).not.toBeChecked();
    await expect(named).toHaveAttribute("required", "");
    const row = page.locator("label.age-confirm");
    await expect(row).toContainText(LABEL);
    const terms = row.getByRole("link", { name: "Terms" });
    await expect(terms).toHaveAttribute("href", "/terms");
    await expect(terms).toHaveAttribute("target", "_blank");
    /* Untouched, the form would not submit: the browser holds it. */
    expect(await named.evaluate((el) => (el as HTMLInputElement).validity.valueMissing)).toBe(true);
    await page.waitForTimeout(700); /* a sheet that opens with a small scale is measured at rest */
    const size = await row.boundingBox();
    expect(size?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    /* Reached by keyboard: Tab until the box has focus, then its ring shows. */
    let focused = false;
    for (let i = 0; i < 30 && !focused; i++) { await page.keyboard.press("Tab"); focused = await named.evaluate((el) => el === document.activeElement); }
    expect(focused, "the box is in the tab order").toBe(true);
    const ring = await named.evaluate((el) => { const s = getComputedStyle(el); return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) }; });
    expect(ring.style).not.toBe("none");
    expect(ring.width).toBeGreaterThanOrEqual(2);
    /* Space ticks it; ticking it again clears it. */
    await page.keyboard.press("Space");
    await expect(named).toBeChecked();
    expect(await named.evaluate((el) => (el as HTMLInputElement).validity.valueMissing)).toBe(false);
    await page.keyboard.press("Space");
    await expect(named).not.toBeChecked();
    if (shots) { mkdirSync(shots, { recursive: true }); await row.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(shots, `${screen.name}-${info.project.name.replace("workbench-", "")}.png`) }); }
  });
}
