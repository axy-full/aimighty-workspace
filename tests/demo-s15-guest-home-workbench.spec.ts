import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomBytes } from "node:crypto";
import { SITE_ROW } from "../lib/site/settings";
import { localPlatformDbUrl } from "./helpers/workbenchLocal";
import { smallTargets, smallText } from "./phoneFloors";
import { seedMarkedSample } from "./helpers/guestSample";

/**
 * Guest Home (lead decisions 35, 36 and 39; design README § 3.7) at the five sizes, against a local ENGINE_MOCK
 * server. The site switches are written in the server's LOCAL platform database, the way the new-interface helpers
 * do it; no admin endpoint is called. A guest never reaches a route that thinks, spends or writes: every request the
 * page makes is listed and checked.
 */
const DESKTOP = "workbench-1440x900";
const SHOTS = process.env.S15_SHOTS_DIR;
const BRIEF = "A 15-second fashion film about quiet confidence. A woman in ivory crosses a sculptural desert; a mirror sphere reflects the world around her.";
/* The only routes a guest's page may call (plus the framework's own files). */
const GUEST_ROUTES = [/^\/api\/auth\/signup\?code=/, /^\/api\/access-request$/];

async function setSite(value: { openSignup?: boolean; guestHome?: boolean; guestWorkspace?: string | null }) {
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await db.execute({
      sql: `INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES (?,?,?,?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      args: [SITE_ROW, JSON.stringify({ openSignup: false, guestHome: false, guestWorkspace: null, ...value }), Date.now(), "test"],
    });
  } finally {
    db.close();
  }
}
async function invite(email: string) {
  const code = randomBytes(18).toString("base64url");
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await db.execute({
      sql: "INSERT INTO signup_invites(code,email,name,note,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?)",
      args: [code, email, "Guest Tester", "Local browser test", "test", Date.now(), Date.now() + 3_600_000],
    });
  } finally {
    db.close();
  }
  return code;
}
/** Every API request the page makes, so a spec can show a guest reached nothing it shouldn't. */
function apiLog(page: Page) {
  const seen: string[] = [];
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (url.pathname.startsWith("/api/")) seen.push(`${req.method()} ${url.pathname}${url.search}`);
  });
  return seen;
}
const notAllowed = (seen: string[]) => seen.filter((line) => !GUEST_ROUTES.some((re) => re.test(line.replace(/^\w+ /, ""))));
const phone = (info: TestInfo) => /workbench-(360x640|390x844|844x390)/.test(info.project.name);
async function floors(page: Page, info: TestInfo, where: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), `${where}: wider than the window`).toBe(false);
  expect(await smallText(page), `${where}: text under 12px`).toEqual([]);
  /* The request form's honeypot is off-screen and aria-hidden, as the site's own form's is: not a target. The terms
     box's target is its whole label row, at least 44 px (checked below), not the box drawn inside it. */
  if (phone(info)) {
    const scope = (await page.locator(".gx-guest").count()) ? ".gx-guest" : ".gx-signup-page";
    expect((await smallTargets(page, scope)).filter((t) => !t.startsWith("gx-su-trap") && !t.startsWith("signup-terms")), `${where}: targets under 44×44`).toEqual([]);
    const terms = page.locator(".gx-su-check");
    if (await terms.count()) expect((await terms.boundingBox())!.height, `${where}: the terms row`).toBeGreaterThanOrEqual(43.5);
  }
}
async function shot(page: Page, info: TestInfo, name: string) {
  if (!SHOTS) return;
  const size = info.project.name.replace("workbench-", "");
  if (size === "1440x900" || size === "390x844") await page.screenshot({ path: `${SHOTS}/${name}-${size}.png` });
}

test.describe.configure({ mode: "serial" });
test.beforeEach(async ({ request }) => {
  const health = await request.get("/api/health").then((r) => r.json()).catch(() => null);
  test.skip(!health?.mock, "requires a local ENGINE_MOCK=1 server");
});
test.afterAll(async () => { await setSite({}); });

test("Guest Home off (the default): a visitor at / sees today's site", async ({ page }) => {
  await setSite({});
  await page.goto("/");
  await expect(page.getByTestId("guest-home")).toHaveCount(0);
  /* Today's public site: its header (brand, Request access) and its Main navigation, not the app's Suites bar. The site's tabs
     fold into a menu on a phone, so the navigation is only required to be there; the header and the way in are seen. */
  await expect(page.locator(".mk-header")).toBeVisible();
  await expect(page.locator(".mk-header").getByRole("link", { name: "Request access" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Suites" })).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
});

test("Guest Home on: Home signed out, and every action that thinks or spends opens the sheet", async ({ page }, info) => {
  await setSite({ guestHome: true });
  const seen = apiLog(page);
  await page.goto("/");
  await expect(page.getByTestId("guest-home")).toBeVisible();
  await expect(page.getByTestId("page-title")).toHaveText("What are we making?");
  await expect(page.getByTestId("guest-signin")).toHaveAttribute("href", "/login");
  await expect(page.getByTestId("guest-signup")).toBeVisible();
  /* No projects, no Waiting for you, no balance, no price on Start, no thinking line. */
  const text = await page.getByTestId("guest-home").innerText();
  expect(text).not.toMatch(/Your projects|Waiting for you|\bcr\b|thinking|\$\d/);
  await expect(page.getByTestId("home-start")).toHaveText("Start");
  await expect(page.getByTestId("guest-sample-card")).toContainText("A 15-second film");
  await floors(page, info, "guest Home");
  await shot(page, info, "G1-guest-home");

  /* Start with nothing typed says what to do; with a brief it opens the sheet, which keeps it. */
  await page.getByTestId("home-start").click();
  await expect(page.getByTestId("home-box-status")).toHaveText("Say what we are making, or pick a template.");
  await page.getByTestId("home-brief").fill(BRIEF);
  await page.getByTestId("home-start").click();
  await expect(page.getByTestId("signup-sheet")).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("Particl is invite-only for now.");
  await expect(page.getByTestId("signup-brief")).toContainText("A 15-second fashion film");
  await expect(page).toHaveURL(/signup=1/);
  await floors(page, info, "the sheet");
  /* The dialog sits inside the window, centred on a desktop (frame 3b). */
  const box = await page.getByRole("dialog").boundingBox();
  const vp = page.viewportSize()!;
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height + 1);
  if (!phone(info)) {
    expect(Math.abs(box!.x + box!.width / 2 - vp.width / 2)).toBeLessThan(2);
    /* Centred on the other axis too, and Request access is inside the window (decision 39 a). */
    expect(Math.abs(box!.y + box!.height / 2 - vp.height / 2)).toBeLessThan(2);
    const request = await page.getByTestId("signup-request").boundingBox();
    expect(request!.y + request!.height).toBeLessThanOrEqual(vp.height + 1);
  }
  await shot(page, info, "G3b-request-access");
  await page.getByTestId("signup-close").click();
  await expect(page.getByTestId("signup-sheet")).toHaveCount(0);

  for (const id of ["home-template-film", "home-template-ads", "home-add-refs"]) {
    await page.getByTestId(id).click();
    await expect(page.getByTestId("signup-sheet"), id).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("signup-sheet")).toHaveCount(0);
  }
  if (!phone(info) || info.project.name.includes("844")) {
    for (const id of ["guest-tab-make", "guest-tab-atomik"]) {
      const tab = page.getByTestId(id);
      if (!(await tab.isVisible())) continue;
      await tab.click();
      await expect(page.getByTestId("signup-sheet"), id).toBeVisible();
      await page.keyboard.press("Escape");
    }
  }
  /* What was typed is kept in this browser for the first board. */
  await page.reload();
  await expect(page.getByTestId("home-brief")).toHaveValue(BRIEF);
  expect(notAllowed(seen), "a guest's page called these routes").toEqual([]);
});

test("the sample production is read-only: the frame's layout, the title, no media, actions open the sheet", async ({ page }, info) => {
  await setSite({ guestHome: true });
  const seen = apiLog(page);
  await page.goto("/");
  await page.getByTestId("guest-sample-card").click();
  await expect(page.getByTestId("guest-sample")).toBeVisible();
  await expect(page).toHaveURL(/sample=1/);
  await expect(page.getByTestId("guest-sample-title")).toHaveText("A 15-second film");
  await expect(page.getByTestId("guest-sample")).toContainText("A sample production.");
  expect(await page.getByTestId("guest-sample").locator("img, video").count(), "no media until the sample is made").toBe(0);
  await floors(page, info, "the sample");
  await shot(page, info, "G2-sample");
  await page.getByTestId("guest-sample-make").click();
  await expect(page.getByTestId("signup-sheet")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByTestId("guest-sample-signup").click();
  await expect(page.getByTestId("signup-sheet")).toBeVisible();
  expect(notAllowed(seen)).toEqual([]);
});

test("the sheet's kept brief clamps cleanly to three lines with an ellipsis", async ({ page }) => {
  await setSite({ guestHome: true });
  await page.goto("/");
  await page.getByTestId("home-brief").fill(`${BRIEF} `.repeat(6));
  await page.getByTestId("home-start").click();
  await expect(page.getByTestId("signup-sheet")).toBeVisible();
  const brief = page.getByTestId("signup-brief").locator("span");
  const m = await brief.evaluate((el) => {
    const css = getComputedStyle(el);
    return { lines: Math.round(el.clientHeight / parseFloat(css.lineHeight)), clamped: el.scrollHeight > el.clientHeight + 1, clamp: css.webkitLineClamp };
  });
  expect(m.clamp).toBe("3");
  expect(m.lines).toBeLessThanOrEqual(3);
  expect(m.clamped, "a long brief is cut, not spilled").toBe(true);
});

test("the sample production from the Particl sample workspace: plan, shots, cast and cut, read-only", async ({ browser, page }, info) => {
  const { workspaceId } = await seedMarkedSample(page);
  await setSite({ guestHome: true, guestWorkspace: workspaceId });
  /* A guest is a visitor with no cookie at all: a context of its own. */
  const context = await browser.newContext({ viewport: page.viewportSize() ?? undefined, isMobile: phone(info), hasTouch: phone(info) });
  const guest = await context.newPage();
  const seen = apiLog(guest);
  try {
    await guest.goto("/?sample=1");
    await expect(guest.getByTestId("guest-sample")).toHaveAttribute("data-board", "sample");
    await expect(guest.getByTestId("guest-sample-title")).toHaveText("A 15-second film");
    await expect(guest.getByTestId("guest-sample-brief")).toContainText("A short film about a walk to a sculpture.");
    /* The plan: exactly the three shot lines, the total, and twice the total as the most the fixes cost (correction b). */
    await expect(guest.getByTestId("guest-plan-heading")).toHaveText("Make 3 shots · 93 cr");
    await expect(guest.getByTestId("guest-plan-step")).toHaveCount(3);
    await expect(guest.getByTestId("guest-plan-step").nth(0)).toContainText("Shot 1 · Seedance 2.5 · 5 s · 1080p");
    await expect(guest.getByTestId("guest-plan-step").nth(0)).toContainText("43 cr");
    await expect(guest.getByTestId("guest-plan-step").nth(2)).toContainText("7 cr");
    await expect(guest.getByTestId("guest-plan-fixes")).toHaveText("Fixes if needed: up to 2 per shot, at most 186 cr");
    /* Shot 3's own state, not another shot's (correction d); the cut and delivery (correction e). */
    await expect(guest.getByTestId("guest-shots-heading")).toHaveText("Shots · 2 of 3 approved");
    await expect(guest.getByTestId("guest-review")).toContainText("Shot 3 · review");
    await expect(guest.getByTestId("guest-review")).toContainText("needs review");
    await expect(guest.getByTestId("guest-cut-line")).toHaveText("2 approved takes · 0:10 · Shot 3 waits for review");
    await expect(guest.getByTestId("guest-deliver")).toContainText("pending");
    await expect(guest.getByTestId("guest-cast")).toHaveText("Lead · ivory suit, short dark bob");
    const text = await guest.getByTestId("guest-sample").innerText();
    expect(text).not.toMatch(/Dune|Mira\b|Mara\b|Sethi|Northline|\bSH\d|consent|cr left|\bof \d+ cr\b/i);
    expect(await guest.getByTestId("guest-sample").locator("img, video").count(), "no media until stream 12's media route").toBe(0);
    const at = (name: string) => SHOTS && /1440x900|390x844/.test(info.project.name) ? guest.screenshot({ path: `${SHOTS}/${name}-${info.project.name.replace("workbench-", "")}.png` }) : null;
    await guest.getByTestId("guest-sample").evaluate((el) => { el.scrollTop = 0; });
    await at("G2-sample-board");
    await guest.getByTestId("guest-shots-heading").scrollIntoViewIfNeeded();
    await at("G2-sample-board-shots");
    /* Read-only: every action opens the sheet. */
    for (const id of ["guest-sample-make", "guest-review-gated"]) {
      await guest.getByTestId(id).click();
      await expect(guest.getByTestId("signup-sheet"), id).toBeVisible();
      await guest.keyboard.press("Escape");
      await expect(guest.getByTestId("signup-sheet")).toHaveCount(0);
    }
    await floors(guest, info, "the sample board");
    expect(notAllowed(seen), "a guest's page called these routes").toEqual([]);
  } finally {
    await context.close();
  }
});

test("Request access is stored for the owner with what they make and the brief", async ({ page }, info) => {
  await setSite({ guestHome: true });
  /* A test server trusts no forwarded header (lib/clientIp.ts), so every request here counts against one shared
     per-source daily limit (5). Requests left by this spec's earlier runs (any size; workers=1, and
     localPlatformDbUrl() only ever names a local file database) are cleared first, so they can't push it over. */
  const own = `guest-${info.project.name.replace(/\W/g, "")}-`;
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await db.execute("DELETE FROM access_requests WHERE email LIKE 'guest-%@example.test'")
      .catch((error) => { if (!/no such table/.test(String(error))) throw error; });
  } finally {
    db.close();
  }
  await page.goto("/?signup=1");
  const email = `${own}${Date.now()}@example.test`;
  await page.getByTestId("signup-name").fill("Guest Tester");
  await page.getByTestId("signup-email").fill(email);
  await page.getByTestId("signup-make").fill("Ad films");
  await page.getByTestId("signup-request").click();
  await expect(page.getByRole("dialog")).toContainText("Request sent");
  await expect(page.getByTestId("signup-sent")).toBeVisible();
  const read = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    const row = (await read.execute({ sql: "SELECT note FROM access_requests WHERE email = ?", args: [email] })).rows[0] as unknown as { note: string };
    expect(row.note).toContain("What they make: Ad films");
  } finally {
    read.close();
  }
});

test("an invitation link: the sheet's Create account, then the brief becomes the first board", async ({ page }, info) => {
  await setSite({ guestHome: true });
  const email = `guest-invite-${info.project.name.replace(/\W/g, "")}-${Date.now()}@example.test`;
  const code = await invite(email);
  await page.goto("/");
  await page.getByTestId("home-brief").fill(BRIEF);
  await page.goto(`/?invite=${code}`);
  await expect(page.getByRole("dialog")).toContainText("Create your account");
  await expect(page.getByTestId("signup-email")).toHaveValue(email);
  await expect(page.getByTestId("signup-brief")).toContainText("A 15-second fashion film");
  await floors(page, info, "the invitation sheet");
  await shot(page, info, "G3a-invitation");
  if (info.project.name !== DESKTOP) return;
  /* A dev server compiles the page sign-up lands on at first request; warm it so the hand-off isn't raced. */
  await page.request.get("/workbench?onboarding=1");
  await page.getByTestId("signup-create").click();
  await expect(page).toHaveURL(new RegExp(`/signup\\?invite=${code}`));
  await expect(page.getByTestId("signup-kept-brief")).toContainText("A 15-second fashion film");
  /* The invitation fills the email and the name: the form asks only for what is missing. */
  await expect(page.getByTestId("signup-email")).toHaveValue(email);
  await expect(page.getByTestId("signup-name")).toHaveCount(0);
  await page.getByTestId("signup-workspace").fill(`Guest ${Date.now()}`);
  await page.getByTestId("signup-password").fill("a local browser test passphrase 42");
  await page.getByTestId("signup-confirm").fill("a local browser test passphrase 42");
  await page.getByTestId("signup-terms").check();
  await page.getByTestId("signup-submit").click();
  await page.waitForURL((url) => !url.pathname.startsWith("/signup"), { timeout: 60_000 });
  const projects = await page.request.get("/api/workbench/projects").then((r) => r.json());
  const names = JSON.stringify(projects);
  expect(names).toContain("A 15-second fashion film about quiet confidence");
  expect(await page.evaluate(() => localStorage.getItem("particl:guest-brief"))).toBeNull();
});

test("/signup with an invitation, on Graphite: the email filled in, only what is missing asked", async ({ page }, info) => {
  await setSite({});
  const email = `signup-page-${info.project.name.replace(/\W/g, "")}-${Date.now()}@example.test`;
  const code = await invite(email);
  await page.goto(`/signup?invite=${code}`);
  await expect(page.getByTestId("signup-page")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  await expect(page.getByTestId("signup-email")).toHaveValue(email);
  await expect(page.getByTestId("signup-email")).toHaveAttribute("readonly", "");
  await expect(page.getByTestId("signup-name")).toHaveCount(0);
  await expect(page.getByTestId("signup-workspace")).toBeVisible();
  /* Graphite only: no old sign-up sheets on the page. */
  expect(await page.evaluate(() => [...document.querySelectorAll(".auth-card, .auth-page, .mk-access-form")].length)).toBe(0);
  await floors(page, info, "/signup with an invitation");
  await shot(page, info, "signup-invitation");
});

test("/signup without a link, while sign-up is by invitation, offers to ask for access", async ({ page }, info) => {
  await setSite({});
  await page.goto("/signup");
  await expect(page.getByTestId("signup-invite-only")).toBeVisible();
  await expect(page.getByText("Sign-up needs an invitation link.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Request access" })).toBeVisible();
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await floors(page, info, "/signup without a link");
  await shot(page, info, "signup-request-access");
  const res = await page.request.post("/api/auth/signup", { data: { name: "X", email: "x@example.test", workspace: "X", password: "a long passphrase 42", accept: true } });
  expect(res.status()).toBe(403);
  expect((await res.json()).error).toBe("Sign-up needs an invitation link.");
});

test("a self-serve verification link after sign-up closed is refused and offers Request access", async ({ page }, info) => {
  await setSite({});
  await page.goto(`/signup?verify=${"v".repeat(48)}`);
  await expect(page.getByTestId("signup-invite-only")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Particl is invite-only for now." })).toBeVisible();
  await expect(page.getByTestId("request-access-form")).toBeVisible();
  await floors(page, info, "a refused verification");
});
