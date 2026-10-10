import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomBytes } from "node:crypto";
import { isCompact } from "./helpers/shellMode";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";

/*
 * The join sheet (components/v12/join; docs/redesign/inventory.md § 8.3, § 8.5, FIX 4), on the test-only page
 * app/(test)/v12-join until the visitor screens that open it land. Desktop: two equal columns that fit; phone: one
 * column in a bottom sheet with Continue with email. Esc and × keep the typed text. A code goes to today's invitation
 * pages; a request goes to today's access-request route (intercepted here: the route caps requests per address a day).
 */

const PROMPT = "A 30 s ad for a spice brand · a desert camp at night";

async function open(page: Page, query: string) {
  const res = await page.goto(`/v12-join?${query}`);
  test.skip(res?.status() === 404, "requires a local ENGINE_MOCK=1 development server");
  await expect(page.getByRole("heading", { name: "Join sheet" })).toBeVisible();
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  /* Every field and button sits inside the sheet. */
  const outside = await page.getByTestId("v12-join").evaluate((sheet) => {
    const box = sheet.getBoundingClientRect();
    return Array.from(sheet.querySelectorAll("input:not([aria-hidden]), select, textarea, button")).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && (r.left < box.left - 0.5 || r.right > box.right + 0.5);
    }).length;
  });
  expect(outside, "fields inside the sheet").toBe(0);
}

test("the sheet by reason: title, the prompt quoted, both ways in; Esc and × close it and keep what was typed", async ({ page }, info) => {
  await open(page, `join=start&prompt=${encodeURIComponent(PROMPT)}`);
  const sheet = page.getByTestId("v12-join");
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId("v12-join-title")).toHaveText("To start a board you need a Particl account");
  await expect(page.getByTestId("v12-join-prompt")).toHaveText(`“${PROMPT}”`);
  await expect(sheet.getByText("Particl is invite-only")).toBeVisible();
  await expect(page.getByTestId("v12-join-want")).toHaveValue(PROMPT);
  await expect(page.getByTestId("v12-join-email")).toBeVisible();
  await expect(page.getByTestId("v12-join-google")).toBeVisible();
  await expect(page.getByTestId("v12-join-size")).toBeVisible();
  await expect(page.getByTestId("v12-join-login")).toHaveAttribute("href", "/login?next=%2Fv12-join");
  await noOverflow(page);

  const invite = (await page.getByTestId("v12-join-invite").boundingBox())!;
  const request = (await page.getByTestId("v12-join-request").boundingBox())!;
  if (isCompact(info)) {
    /* One column, the sheet on the bottom edge. */
    expect(Math.abs(invite.x - request.x)).toBeLessThanOrEqual(1);
    expect(request.y).toBeGreaterThan(invite.y);
    await sheet.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    const box = (await sheet.boundingBox())!;
    expect(Math.abs(box.y + box.height - page.viewportSize()!.height)).toBeLessThanOrEqual(1);
    expect((await page.getByTestId("v12-join-email").boundingBox())!.height).toBeGreaterThanOrEqual(44);
  } else {
    /* Two equal columns, side by side. */
    expect(Math.abs(invite.width - request.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(invite.y - request.y)).toBeLessThanOrEqual(1);
    expect((await sheet.boundingBox())!.width).toBeLessThanOrEqual(720);
  }

  await page.getByTestId("v12-join-name").fill("Ana");
  await page.getByTestId("v12-join-code").fill("ABC");
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await page.getByTestId("open-make").click();
  await expect(page.getByTestId("v12-join-title")).toHaveText("To make this you need a Particl account");
  await expect(page.getByTestId("v12-join-name")).toHaveValue("Ana");
  await expect(page.getByTestId("v12-join-code")).toHaveValue("ABC");
  await page.getByTestId("v12-dialog-close").click();
  await expect(sheet).toHaveCount(0);
  for (const [reason, title] of [["upload", "To upload or attach files"], ["ask", "To ask Atomik"], ["download", "To download originals"], ["plus", "To open a new board"], ["library", "To add to a Library"], ["approve", "To change the sample"]] as const) {
    await page.getByTestId(`open-${reason}`).click();
    await expect(page.getByTestId("v12-join-title")).toContainText(title);
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
  }
});

test("request access: today's route, with company, role and size in their own fields, then You're on the list", async ({ page }) => {
  await open(page, `join=start&prompt=${encodeURIComponent(PROMPT)}`);
  let sent: Record<string, string> | null = null;
  await page.route("**/api/access-request", async (route) => {
    sent = route.request().postDataJSON();
    await route.fulfill({ json: { ok: true, mailed: false } });
  });
  await page.getByTestId("v12-join-send").click();
  await expect(page.getByTestId("v12-join-request-problem")).toHaveText("Tell us your name.");
  await page.getByTestId("v12-join-name").fill("Ana Lima");
  await page.getByTestId("v12-join-work-email").fill("ana@studio.example");
  await page.getByTestId("v12-join-company").fill("North Studio");
  await page.getByTestId("v12-join-role").selectOption("Agency");
  await page.getByTestId("v12-join-size").selectOption("11–50");
  await page.getByTestId("v12-join-send").click();
  await expect(page.getByTestId("v12-join-requested")).toContainText("You’re on the list.");
  expect(sent).toEqual({ name: "Ana Lima", email: "ana@studio.example", note: "From the join sheet (start)", organisation: "North Studio", role: "Agency", size: "11–50", brief: PROMPT });
  await page.getByTestId("v12-join-keep-looking").click();
  await expect(page.getByTestId("v12-join")).toHaveCount(0);
});

test("the address opens the confirmation: ?join=start&requested=1", async ({ page }) => {
  await open(page, "join=start&requested=1");
  await expect(page.getByTestId("v12-join-requested")).toContainText("We’ll email you when your invite is ready");
});

test("an invite code goes to today's pages: a team invite to /invite, a new-workspace invite to /signup; a bad code says so", async ({ page, playwright }, info) => {
  test.skip(isCompact(info), "the same code path on every size; the phone's sheet layout is checked above");
  /* A real team invite and a real new-workspace invite in the local platform database. */
  const owner = await playwright.request.newContext({ baseURL: process.env.PW_BASE_URL || "http://localhost:4551" });
  const signed = await signInLocally(owner, "Invite Owner");
  await owner.dispose();
  const team = `T${randomBytes(6).toString("hex")}`;
  const fresh = `N${randomBytes(6).toString("hex")}`;
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    const now = Date.now();
    await db.execute({ sql: "INSERT INTO workspace_invites (code, workspace_id, email, name, role, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)", args: [team, signed.workspace.id, `t-${team}@example.test`, "", "member", "test", now, now + 3_600_000] });
    await db.execute({ sql: "INSERT INTO signup_invites (code, email, name, note, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?)", args: [fresh, `n-${fresh}@example.test`, "", "Local browser test", "test", now, now + 3_600_000] });
  } finally { db.close(); }

  await open(page, "join=start");
  await page.getByTestId("v12-join-email").click();
  await expect(page.getByTestId("v12-join-invite-problem")).toHaveText("Enter your invite code first.");
  await page.getByTestId("v12-join-code").fill("NOT-A-CODE");
  await page.getByTestId("v12-join-email").click();
  await expect(page.getByTestId("v12-join-invite-problem")).toContainText("isn’t valid");
  await page.getByTestId("v12-join-google").click();
  await expect(page.getByTestId("v12-join-invite-problem")).toHaveText("Google sign-in isn’t on yet. Use Continue with email.");

  await page.getByTestId("v12-join-code").fill(team);
  await page.getByTestId("v12-join-email").click();
  await page.waitForURL(`**/invite/${team}`);

  await open(page, "join=start");
  await page.getByTestId("v12-join-code").fill(fresh);
  await page.getByTestId("v12-join-email").click();
  await page.waitForURL(`**/signup?invite=${fresh}`);
});
