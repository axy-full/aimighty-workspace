import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { captureBeside, closePrototypeServer } from "../helpers/redesignShots";
import { openShotsBoard, BATCH_ROWS, type ShotRow } from "../helpers/shotsV12";
import { seedHome } from "../helpers/v12Home";
import { localPlatformDbUrl } from "../helpers/workbenchLocal";

/*
 * Render cards (redesign P3) beside prototype 12's render URLs, with Atomik closed as they are drawn: queued, rendering, slow,
 * failed, the batch, "Tell me when it's done", and Make's tiles. Seeded rows only: nothing is generated or spent. The reveal
 * (`demo=reveal`) plays for 0.6 s as a take lands: it is checked in the spec, not photographed.
 */
test.afterAll(closePrototypeServer);

const KLING = "fal-ai/kling-video/v3/standard";
const SEEDANCE = "dreamina-seedance-2-5-260628";
const rest = (n: number): (ShotRow | null)[] => Array.from({ length: n }, () => ({ status: "queued", kind: "video", model: KLING, ageS: 5, arkTaskId: "task-seed" }));
const ready: ShotRow[] = [{ status: "succeeded" }, { status: "succeeded" }];
/** The prototype's single-state boards: Shots 1–2 ready, Shot 3 in the state, the rest waiting. */
const one = (row: ShotRow): (ShotRow | null)[] => [...ready, row, ...rest(5)];

async function settle(page: Page) {
  const collapse = page.getByTestId("agent-collapse");
  await collapse.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
  let quiet = 0;
  await expect.poll(async () => {
    if (await collapse.isVisible().catch(() => false)) { await collapse.click({ timeout: 2_000 }).catch(() => {}); quiet = 0; return false; }
    quiet = (await page.getByTestId("board-agent-panel").count()) === 0 ? quiet + 1 : 0;
    return quiet >= 8;
  }, { timeout: 30_000, intervals: [250] }).toBe(true);
  const gotIt = page.getByTestId("v12-tools-got-it");
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click();
  await page.mouse.move(700, 120);
  await page.waitForTimeout(1500);
}

const CASES: [string, string, (ShotRow | null)[]][] = [
  ["queued", "?view=board&stage=Shots&render=queued", one({ status: "queued", kind: "video", model: KLING, ageS: 4, arkTaskId: "task-seed-3" })],
  ["rendering", "?view=board&stage=Shots&render=rendering", one({ status: "running", kind: "video", model: KLING, ageS: 72 })],
  ["slow", "?view=board&stage=Shots&render=slow", one({ status: "running", kind: "video", model: SEEDANCE, ageS: 700 })],
  ["failed", "?view=board&stage=Shots&render=failed", one({ status: "failed", kind: "video", model: KLING, ageS: 200, error: "The engine did not finish this take." })],
  ["batch", "?view=board&stage=Shots&render=batch", BATCH_ROWS],
];
for (const [name, query, rows] of CASES) {
  test(`render · ${name}`, async ({ page }) => {
    test.setTimeout(180_000);
    await openShotsBoard(page, "/suites?view=board&stage=shots", { rows });
    await expect(page.locator('.bd-node[data-card-kind="take"]')).toHaveCount(8, { timeout: 90_000 });
    await settle(page);
    await captureBeside(page, `render-${name}`, query);
  });
}

test("render · notify", async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    class Fake { static permission = "default"; static requestPermission() { return Promise.resolve("granted"); } }
    Object.defineProperty(window, "Notification", { value: Fake, configurable: true });
  });
  await openShotsBoard(page, "/suites?view=board&stage=shots", { rows: one({ status: "running", kind: "video", model: KLING, ageS: 75 }) });
  await expect(page.locator('.bd-node[data-card-kind="take"]')).toHaveCount(8, { timeout: 90_000 });
  await settle(page);
  await expect(page.getByTestId("v12-notify-ask")).toBeVisible({ timeout: 30_000 });
  await captureBeside(page, "render-notify", "?view=board&stage=Shots&render=rendering&notify=1");
});

test("render · make tiles", async ({ page }) => {
  test.setTimeout(300_000);
  const { signed } = await seedHome(page, { takes: 6 });
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    const url = String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id = ?", args: [signed.workspace.id] })).rows[0].db_url);
    const db = createClient({ url, timeout: 10_000 });
    try {
      /* The two newest takes are still in flight: one rendering (21 s in), one just asked for. */
      const newest = (await db.execute("SELECT id FROM generations ORDER BY created_at DESC LIMIT 2")).rows.map((r) => String(r.id));
      const ages = [21_000, 3_000];
      for (const [i, id] of newest.entries()) await db.execute({ sql: "UPDATE generations SET status=?, stored_url=NULL, created_at=?, updated_at=? WHERE id=?", args: [i === 0 ? "running" : "queued", Date.now() - ages[i], Date.now(), id] });
    } finally { db.close(); }
  } finally { platform.close(); }
  await page.goto("/suites?view=make");
  await expect(page.getByTestId("v12-make-tile")).toHaveCount(6, { timeout: 90_000 });
  await expect(page.getByTestId("v12-make-tile-render")).toHaveCount(2, { timeout: 60_000 });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(800);
  await captureBeside(page, "render-make", "?view=make&render=1");
});
