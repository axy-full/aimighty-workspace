import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { redesignWithBoards } from "../helpers/v12Header";
import { localPlatformDbUrl, signInLocally } from "../helpers/workbenchLocal";

/*
 * Workspace settings (prototype v14, README § V14.2), one image per section at 1440 × 900 and 1280 × 800: an admin's eight and the
 * account's two, a member's view, and the house's billing. The prototype's settings frames do not render in the screenshot
 * harness (its address opens Home), so each image is the build alone; set REDESIGN_SHOTS_DIR.
 */
const root = path.resolve(process.env.REDESIGN_SHOTS_DIR ?? "../redesign-shots");
async function shoot(page: Page, name: string, url: string, ready: () => Promise<void>) {
  const size = page.viewportSize() ?? { width: 1440, height: 900 };
  const tag = `${size.width}x${size.height}`;
  await page.goto(url);
  await expect(page.getByTestId("v12-settings")).toBeVisible({ timeout: 90_000 });
  await ready();
  await page.mouse.move(size.width - 4, size.height - 4);
  await page.waitForTimeout(900);
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${tag}-app.png`), animations: "disabled" });
  writeFileSync(path.join(dir, `${tag}.json`), JSON.stringify({ name, app: url, prototype: "not rendered in the harness", size }));
}
async function platform<T>(fn: (db: ReturnType<typeof createClient>) => Promise<T>): Promise<T> {
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try { return await fn(db); } finally { db.close(); }
}

test("Workspace settings, every section", async ({ page, browser }) => {
  test.setTimeout(600_000);
  const { workspace } = await redesignWithBoards(page, ["Harbour film", "Spring launch", "Ridge clips"], "Lena Rowan");
  const me = (await (await page.request.get("/api/me")).json()) as { id: string };
  const scope = { "X-Workbench-Scope": `particl-active-${workspace.id}-${me.id}` };
  /* A teammate, an open invitation, some spend by board and person, a rule, a limit. */
  const mctx = await browser.newContext();
  await signInLocally(mctx.request, "Sam Iyer");
  const sam = (await (await mctx.request.get("/api/me")).json()) as { id: string; email: string };
  const code = randomBytes(18).toString("base64url");
  await platform((db) => db.execute({ sql: "INSERT INTO workspace_invites(code,workspace_id,email,name,role,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)", args: [code, workspace.id, sam.email, "Sam Iyer", "member", me.id, Date.now(), Date.now() + 3_600_000] }));
  expect((await mctx.request.post("/api/auth/accept", { data: { code, accept: true } })).ok()).toBe(true);
  expect((await page.request.post("/api/team", { headers: scope, data: { email: `noor@example.test`, name: "Noor", role: "member" } })).ok()).toBe(true);
  await page.request.post("/api/rules", { headers: scope, data: { text: "Keep the light warm and low.", scope: "all", apply: "prompt" } });
  await page.request.post("/api/rules", { headers: scope, data: { text: "No text in the frame.", scope: "image", apply: "writer" } });
  await page.request.patch("/api/settings", { headers: scope, data: { productionBudgetCredits: "400", capWarnPct: "80", defaultAspect: "16:9" } });
  /* The meter files spend under each board's production id (GET /api/projects lists them by name). */
  const listed = (await (await page.request.get("/api/projects", { headers: scope })).json()) as { projects?: { id: string; name: string }[] };
  const production = (name: string) => listed.projects?.find((p) => p.name === name)?.id ?? null;
  const rows: [string | null, string, string, number, number][] = [
    [production("Harbour film"), me.id, "video", 18, 0], [production("Harbour film"), sam.id, "image", 4, 0], [production("Spring launch"), me.id, "image", 6, 0], [production("Ridge clips"), sam.id, "video", 12, 1], [production("Spring launch"), sam.id, "image", 150, 3],
  ];
  for (const [project, author, kind, credits, daysAgo] of rows)
    await platform((db) => db.execute({ sql: "INSERT INTO meter_events(id,workspace_id,project_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,0,?,1,?,?,?)", args: [`shot_${randomBytes(5).toString("hex")}`, workspace.id, project, kind, kind === "video" ? "Seedance 2.5" : "Nano Banana 2", kind === "video" ? "seedance" : "nano-banana", "succeeded", credits, author, Date.now() - daysAgo * 86_400_000 - 3_600_000, Date.now()] }));
  /* 210 of the month's 250 credits are spent, so the Low-credit warning shows. */
  await platform((db) => db.execute({ sql: "INSERT INTO meter_events(id,workspace_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,0,?,1,?,?,?)", args: [`shot_${randomBytes(5).toString("hex")}`, workspace.id, "image", "Nano Banana Pro", "nano-banana-pro", "succeeded", 20, me.id, Date.now() - 7_200_000, Date.now()] }));
  const sections: [string, string][] = [["overview", ""], ["people", "&section=people"], ["billing", "&section=billing"], ["usage", "&section=usage"], ["defaults", "&section=defaults"], ["rules", "&section=rules"], ["limits", "&section=limits"], ["workspace", "&section=workspace"], ["profile", "&section=profile"], ["notifications", "&section=notifications"]];
  for (const [name, query] of sections) {
    await shoot(page, `settings-${name}`, `/suites?view=settings${query}`, async () => {
      if (name === "overview") await expect(page.getByTestId("v12-settings-activity-row").first()).toBeVisible({ timeout: 60_000 });
      if (name === "people") await expect(page.getByTestId("v12-settings-person")).toHaveCount(2, { timeout: 60_000 });
      if (name === "billing") await expect(page.getByTestId("v12-billing-board").first()).toBeVisible({ timeout: 60_000 });
      if (name === "usage") await expect(page.getByTestId("v12-settings-usage-person").first()).toBeVisible({ timeout: 60_000 });
      if (name === "defaults") await expect(page.getByTestId("v12-settings-defaultImageModel-select").locator("option")).not.toHaveCount(1, { timeout: 60_000 });
      if (name === "rules") await expect(page.getByTestId("v12-settings-rule").first()).toBeVisible({ timeout: 60_000 });
      if (name === "limits") await expect(page.getByTestId("v12-settings-limit-board")).toHaveValue("400", { timeout: 60_000 });
    });
  }
  /* A member's view. */
  const mpage = await mctx.newPage();
  await shoot(mpage, "settings-member-usage", "/suites?view=settings&section=usage", async () => { await expect(mpage.getByTestId("v12-settings-usage-person")).toHaveCount(1, { timeout: 60_000 }); });
  await shoot(mpage, "settings-member-plan", "/suites?view=settings&section=billing", async () => { await expect(mpage.getByTestId("v12-billing-low")).toBeVisible({ timeout: 60_000 }); });
});
