import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomBytes } from "node:crypto";
import { openBilling } from "./helpers/billingV12";
import { localPlatformDbUrl } from "./helpers/workbenchLocal";

/**
 * The house workspace's monthly engine cap on its Credits & billing screen (lib/houseCap.ts; the owner's decision of 15 October
 * 2026: "Monthly cap on the house workspace: $500, warning at 80%"). Local ENGINE_MOCK server and a local platform database only:
 * the month's spend is a meter row seeded here, nothing is rendered and nothing is requested. The screen is a desktop one (phones
 * keep the phone app, as the credits spec says); the cap's words on a phone are the quote's and the refusal's, unit-tested.
 */
const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

/** The house workspace's row, and its own cap (null: the default). clearHouseCap takes the cap away again. */
async function seedHouseCap(capUsd: number | null): Promise<void> {
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  const at = Date.now();
  try {
    await platform.execute({
      sql: `INSERT OR IGNORE INTO workspaces (id, slug, name, db_url, db_token_enc, legacy, uses_platform_keys, owner_id, created_at, updated_at)
            VALUES ('ws_legacy', 'house-cap-screen', 'House', '(primary)', NULL, 1, 1, 'u_house_cap', ?, ?)`,
      args: [at, at],
    });
    await platform.execute({ sql: "UPDATE workspaces SET allowance_usd = ? WHERE id = 'ws_legacy'", args: [capUsd] });
  } finally { platform.close(); }
}

/**
 * A meter row for the house this month that brings its month to exactly `usd` of engine cost: what the house has already spent this
 * month, read as the screen reads it (/api/usage/house-cap), is counted in, so a job another spec ran in the house cannot move the
 * figures. Needs the house's session (openBilling). Returns what removes the row.
 */
async function seedHouseMonth(page: Page, usd: number): Promise<() => Promise<void>> {
  const read = await page.request.get("/api/usage/house-cap");
  expect(read.ok()).toBe(true);
  const already = ((await read.json()) as { houseCap: { spentUsd: number } | null }).houseCap?.spentUsd;
  expect(typeof already, "the house's session reads its cap").toBe("number");
  expect(already!, `the house has already spent $${already} this month, more than this case's $${usd}`).toBeLessThanOrEqual(usd);
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  const id = `house_cap_${randomBytes(4).toString("hex")}`;
  const at = Date.now();
  try {
    await platform.execute({
      sql: `INSERT INTO meter_events(id,workspace_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_at,updated_at)
            VALUES(?,'ws_legacy','video','byteplus','seedance-2.5','succeeded',?,0,0,?,?)`,
      args: [id, usd - already!, at, at],
    });
  } finally { platform.close(); }
  return async () => {
    const after = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
    try { await after.execute({ sql: "DELETE FROM meter_events WHERE id = ?", args: [id] }); }
    finally { after.close(); }
  };
}

async function clearHouseCap(): Promise<void> {
  const after = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try { await after.execute("UPDATE workspaces SET allowance_usd = NULL WHERE id = 'ws_legacy'"); }
  finally { after.close(); }
}

test.describe("the house's monthly cap on Credits & billing", () => {
  test.beforeEach(({}, info) => test.skip(!DESKTOP.includes(info.project.name), "desktop sizes: the screen is not on phones"));

  for (const [name, spent, cap, state, words] of [
    ["well under: the cap and the share used, no warning", 40, null, "ok", /^\$40 of \$500 used · 8%$/],
    ["from 80%: the warning, as the quote and the mail word it", 420, null, "warn", /^84% of this month's \$500 used \(\$420\)$/],
    ["the owner's own figure replaces the default", 90, 100, "warn", /^90% of this month's \$100 used \(\$90\)$/],
    ["at the cap: reached", 520, null, "stop", /^Reached · \$520 of \$500 used · 100%$/],
  ] as const) {
    test(name, async ({ page }) => {
      await seedHouseCap(cap);
      let clean = async () => {};
      try {
        const { errors } = await openBilling(page, { house: true });
        clean = await seedHouseMonth(page, spent);
        await page.reload();
        const row = page.getByTestId("v12-billing-house-cap");
        await expect(row).toBeVisible({ timeout: 60_000 });
        await expect(row).toHaveAttribute("data-state", state);
        await expect(page.getByTestId("v12-billing-house-cap-words")).toHaveText(words);
        await expect(row).toContainText("Monthly cap");
        /* In dollars only: the house has no credits, and the screen says nothing in them. */
        expect(await page.getByTestId("v12-billing").innerText()).not.toMatch(/\bcr\b/);
        expect(await noSideways(page)).toBe(true);
        expect(errors).toEqual([]);
      } finally { try { await clean(); } finally { await clearHouseCap(); } }
    });
  }

  test("a workspace that is not the house reads no cap, and its screen has no cap row", async ({ page }) => {
    await openBilling(page, {});
    await expect(page.getByTestId("v12-billing")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("v12-billing-house-cap")).toHaveCount(0);
    const read = await page.request.get("/api/usage/house-cap");
    expect(read.ok()).toBe(true);
    expect(await read.json()).toEqual({ houseCap: null });
  });
});
