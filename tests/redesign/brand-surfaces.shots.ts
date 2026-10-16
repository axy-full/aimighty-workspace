import { test, expect } from "@playwright/test";
import { createClient } from "@libsql/client";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { signInLocally, localPlatformDbUrl } from "../helpers/workbenchLocal";
import { setSite } from "../helpers/visitorV12";

/*
 * The error page, the guest header, the no-workspace page and the phone's Home bar at the rule-7 widths and the five desktop sizes of 15 Oct 22:30 (1280, 1440, 1728, 1920, 2560). Run once per server with
 * SHOT_LABEL=before|after; writes <REDESIGN_SHOTS_DIR>/<label>/<surface>-<w>x<h>.png. Touch at the three phone sizes. Also asserts nothing overflows sideways.
 */
const SIZES = [[360, 640], [390, 844], [844, 390], [1280, 800], [1440, 900], [1728, 1117], [1920, 1080], [2560, 1440]] as const;
test.use({ hasTouch: true });
test("the surfaces, before or after", async ({ page, browser }, info) => {
  test.skip(info.project.name !== "redesign-1440x900", "once");
  test.setTimeout(600_000);
  const dir = path.resolve(process.env.REDESIGN_SHOTS_DIR ?? "../redesign-shots", process.env.SHOT_LABEL ?? "after");
  await mkdir(dir, { recursive: true });
  const shoot = async (surface: string, wait: () => Promise<void>) => {
    for (const [w, h] of SIZES) {
      await page.setViewportSize({ width: w, height: h });
      await wait();
      await page.waitForTimeout(900);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `${surface} ${w}x${h} overflow`).toBeLessThanOrEqual(0);
      await page.screenshot({ path: path.join(dir, `${surface}-${w}x${h}.png`) });
    }
  };
  /* The error page. */
  await shoot("error-page", async () => { await page.goto("/this-page-is-not-there"); await expect(page.locator("header.gx-header")).toBeVisible({ timeout: 60_000 }); });
  /* The guest header. */
  await setSite({ guestHome: true, visitorPages: false });
  try { await shoot("guest", async () => { await page.goto("/?guest=1"); await expect(page.getByTestId("guest-header")).toBeVisible({ timeout: 60_000 }); }); } finally { await setSite({}); }
  /* The phone's Home bar, signed in (phone sizes show the phone app; desktop sizes the desktop Home, for the record). */
  await signInLocally(page.request, "Brand Shots");
  await shoot("home", async () => { await page.goto("/suites?view=home"); await expect(page.locator("[data-testid=phone-header], header.gx-header").first()).toBeVisible({ timeout: 60_000 }); });
  /* The no-workspace page. */
  const me = await page.request.get("/api/me").then((response) => response.json());
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await db.batch([
      { sql: "DELETE FROM memberships WHERE account_id=?", args: [me.id] },
      { sql: "UPDATE p_sessions SET workspace_id=NULL WHERE account_id=?", args: [me.id] },
    ], "write");
  } finally { db.close(); }
  await shoot("no-workspace", async () => { await page.goto("/suites"); await expect(page.getByTestId("no-workspace-title")).toBeVisible({ timeout: 60_000 }); });
  void browser;
});
