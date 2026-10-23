import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { joinLocallyAsMember, localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";

/*
 * Gap screens, lane 4 · Settings › Spending rules › Budget and cap (design Gaps B: ?view=workspace&ws=rules&edit=rules,
 * and &role=member), on the real routes of the local ENGINE_MOCK=1 server, nothing answered by the browser:
 *  - an admin edits the budget per production; the field saves when it is left or on Enter (PATCH /api/settings), never a
 *    figure still being typed; "Undo changes" puts back what was there, "Done" closes;
 *  - a member reads the same figure, can't change it (the route refuses it too), and "Ask an admin" tells the owner.
 * Owner values (6 Oct): budget 400 cr with the warning at 320 cr. (The 200 cr ask line was retired on 20 Oct 2026: no per-job line. The per-shot cap
 * "before an admin" was retired on 21 Oct 2026 with the admin approval rule: no field, no row, and the route refuses it.)
 */
const SHOTS = process.env.L4_SHOTS || join(tmpdir(), "claude-gaps-l4-shots");
const size = (name: string) => name.replace("workbench-", "");
const compact = (page: Page) => (page.viewportSize()?.width ?? 0) < 768 || (page.viewportSize()?.height ?? 0) < 500;
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
async function shoot(page: Page, name: string, project: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/l4-${name}-${size(project)}.png` });
}
async function settingsOf(api: APIRequestContext) {
  const body = await (await api.get("/api/settings")).json() as { settings: Record<string, string> };
  return body.settings;
}
/** Readable dark and phone floors inside the panel: text ≥ 12 px; on a phone every control ≥ 44 px tall and wide. */
async function panelFloors(page: Page) {
  const small = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-testid="settings-budget-panel"] *')]
    .filter((el) => el.childElementCount === 0 && (el.textContent ?? "").trim() && parseFloat(getComputedStyle(el).fontSize) < 12).map((el) => el.textContent));
  expect(small).toEqual([]);
  if (compact(page)) {
    /* Measured once the sheet has settled (its phone styles and fonts applied on a cold server), not on its first frame. */
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-testid="settings-budget-panel"] :is(button, input)')]
      .map((el) => ({ el, r: el.getBoundingClientRect() })).filter(({ r }) => r.width > 0 && (r.height < 44 || r.width < 44)).map(({ el }) => el.textContent || el.getAttribute("data-testid"))), { timeout: 10_000 }).toEqual([]);
  }
  /* The panel is fully on screen: nothing cut at the edges. */
  const box = await page.getByTestId("settings-budget-panel").boundingBox();
  const vp = page.viewportSize()!;
  expect(box && box.x >= 0 && box.x + box.width <= vp.width + 1 && box.y >= 0 && box.y + box.height <= vp.height + 1).toBe(true);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
}

test("an admin edits the budget per production; the field saves on Enter or when left, never mid-figure; Undo changes puts it back; Done closes; there is no per-shot cap to set (21 Oct 2026)", async ({ page }, info) => {
  const { workspace } = await signInLocally(page.request, "Rules Admin");
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/suites?view=workspace&ws=rules");
  const section = page.getByTestId("settings-budget-cap");
  await expect(section).toBeVisible({ timeout: 20_000 });
  await expect(section).toContainText("admins only");
  await expect(page.getByTestId("settings-budget-value").locator(".gs-row-v")).toHaveText("none");
  await expect(page.getByTestId("settings-cap-value")).toHaveCount(0);
  await expect(page.getByTestId("settings-budget-open")).toHaveText("Edit");
  await page.getByTestId("settings-budget-open").click();
  const panel = page.getByTestId("settings-budget-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Admins only. The field saves when you leave it or press Enter.");
  /* No "Before an admin" field: the per-shot cap went with the admin approval rule. */
  await expect(page.getByTestId("settings-cap-field")).toHaveCount(0);
  await expect(panel).not.toContainText(/Before an admin|needs an admin/i);
  /* No platform per-job line (owner, 20 Oct 2026: guardrail 4 retired): the panel shows no line field and no line sentence. */
  await expect(page.getByTestId("settings-line-field")).toHaveCount(0);
  await expect(panel).not.toContainText(/Platform line|Any job over|even under Auto/);
  await expect(page.getByTestId("settings-budget-undo")).toBeDisabled();

  /* A figure still being typed is never saved: "4" on the way to "400" stays unsaved however long it waits. */
  await page.getByTestId("settings-budget-field").pressSequentially("4");
  await page.waitForTimeout(1500);
  expect((await settingsOf(page.request)).productionBudgetCredits ?? "").toBe("");
  await page.getByTestId("settings-budget-field").pressSequentially("00");
  await page.getByTestId("settings-budget-field").press("Enter");
  await expect(page.getByTestId("settings-budget-state")).toHaveText("Saved · last changed by you");
  await expect.poll(async () => (await settingsOf(page.request)).productionBudgetCredits).toBe("400");
  /* No Auto (owner, 20 Oct 2026): the budget warns; nothing is said to run or pause on its own. */
  await expect(panel).toContainText("Warns at 80 % (320 cr); every render still waits for a person, and an approved plan runs on to the budget.");
  await expect(panel).not.toContainText(/\bAuto\b/);
  await expect(page.getByTestId("settings-budget-value")).toContainText("warns at 320 cr (80 %)");
  await expect(page.getByTestId("settings-budget-value").locator(".gs-row-v")).toHaveText("400 cr");
  /* The retired keys are never sent, nor shown by the settings route. */
  const s0 = await settingsOf(page.request);
  expect(s0).not.toHaveProperty("approvalRule");
  expect(s0).not.toHaveProperty("shotCapCredits");
  /* A figure the route would refuse is said, and not saved. */
  await page.getByTestId("settings-budget-field").fill("0");
  await page.getByTestId("settings-budget-field").press("Enter");
  await expect(page.getByTestId("settings-budget-state")).toHaveText(/whole number of credits/);
  expect((await settingsOf(page.request)).productionBudgetCredits).toBe("400");
  await page.getByTestId("settings-budget-field").fill("400");
  await page.getByTestId("settings-budget-field").press("Enter");
  await expect(page.getByTestId("settings-budget-state")).toHaveText("Saved · last changed by you");
  await panelFloors(page);
  await shoot(page, "rules-admin", info.project.name);

  /* Undo changes: what was there when the panel opened, written back. */
  await page.getByTestId("settings-budget-undo").click();
  await expect(page.getByTestId("settings-budget-state")).toHaveText("Put back as it was.");
  await expect.poll(async () => (await settingsOf(page.request)).productionBudgetCredits ?? "").toBe("");
  await expect(page.getByTestId("settings-budget-field")).toHaveValue("");
  /* The owner's sample value again, then Done: it saves what is waiting. */
  await page.getByTestId("settings-budget-field").pressSequentially("400");
  await page.getByTestId("settings-budget-done").click();
  await expect(panel).toHaveCount(0);
  await expect.poll(async () => (await settingsOf(page.request)).productionBudgetCredits).toBe("400");
  await shoot(page, "rules-page", info.project.name);
  expect(await overflow(page)).toBeLessThanOrEqual(0);

  /* The frame's URL opens the panel. */
  await page.goto("/suites?view=workspace&ws=rules&open=budget");
  await expect(page.getByTestId("settings-budget-panel")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("settings-budget-field")).toHaveValue("400");
  expect(errors).toEqual([]);
  void workspace; void me;
});

test("a member reads the budget, can't change it, and asks an admin; the retired per-shot cap is refused even to the owner", async ({ page, playwright }, info) => {
  const owner = await playwright.request.newContext({ baseURL: process.env.PW_BASE_URL });
  const { workspace } = await joinLocallyAsMember(owner, page.request);
  const ownerMe = await (await owner.get("/api/me")).json() as { id: string };
  const scope = { "X-Workbench-Scope": `particl-active-${workspace.id}-${ownerMe.id}` };
  /* The retired keys are refused whole, even to the owner (410, "retired"), and nothing in the save is written. */
  const retired = await owner.patch("/api/settings", { headers: scope, data: { productionBudgetCredits: "400", approvalRule: "cap", shotCapCredits: "50" } });
  expect(retired.status(), await retired.text()).toBe(410);
  expect(await retired.json()).toMatchObject({ code: "retired" });
  const set = await owner.patch("/api/settings", { headers: scope, data: { productionBudgetCredits: "400" } });
  expect(set.ok(), await set.text()).toBe(true);
  const member = await (await page.request.get("/api/me")).json() as { id: string };
  /* The route refuses a member, whatever the screen shows. */
  const refused = await page.request.patch("/api/settings", { headers: { "X-Workbench-Scope": `particl-active-${workspace.id}-${member.id}` }, data: { productionBudgetCredits: "100000" } });
  expect(refused.status()).toBe(403);
  expect((await settingsOf(page.request)).productionBudgetCredits).toBe("400");

  await page.goto("/suites?view=workspace&ws=rules&open=budget");
  const panel = page.getByTestId("settings-budget-panel");
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(panel).toContainText("Only an admin can change these. Ask the owner or an admin.");
  await expect(page.getByTestId("settings-budget-field")).toHaveValue("400");
  await expect(page.getByTestId("settings-budget-field")).toHaveAttribute("readonly", "");
  await expect(page.getByTestId("settings-cap-field")).toHaveCount(0);
  await expect(page.getByTestId("settings-budget-undo")).toHaveCount(0);
  await expect(page.getByTestId("settings-budget-done")).toHaveCount(0);
  await panelFloors(page);
  await shoot(page, "rules-member", info.project.name);
  /* Typing changes nothing. */
  await page.getByTestId("settings-budget-field").focus();
  await page.keyboard.type("9");
  await expect(page.getByTestId("settings-budget-field")).toHaveValue("400");
  /* Ask an admin: the real route; the owner is told; nothing changes. */
  const asked = page.waitForResponse((r) => r.url().endsWith("/api/workbench/ask-admin") && r.request().method() === "POST");
  await page.getByTestId("settings-budget-ask").click();
  expect((await asked).status()).toBe(200);
  await expect(page.getByTestId("toast")).toContainText("Asked. The owner and admins were told; nothing was spent.");
  await page.getByTestId("settings-budget-close").click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByTestId("settings-budget-cap")).toContainText("only an admin can change these");
  await expect(page.getByTestId("settings-budget-open")).toHaveText("View");
  const after = await settingsOf(page.request);
  expect(after).toMatchObject({ productionBudgetCredits: "400" });
  expect(after).not.toHaveProperty("approvalRule");
  await owner.dispose();
});

/* ── An Unlock is tied to the cap it was shown for (review of #556, round 2): one screen, and two tabs ── */

/** A production of this workspace that has used US$2 of takes (one take row written into this mock server's own workspace database; nothing rendered). */
async function spentProduction(page: Page, workspaceId: string, scope: Record<string, string>, name: string) {
  const made = await page.request.post("/api/projects", { headers: scope, data: { name } });
  expect(made.ok(), await made.text()).toBe(true);
  const id = ((await made.json()) as { id: string }).id;
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const platform = createClient({ url: localPlatformDbUrl() });
  const dbUrl = String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id=?", args: [workspaceId] })).rows[0].db_url);
  platform.close();
  const tenant = createClient({ url: dbUrl });
  await tenant.execute({ sql: "INSERT INTO generations(id,project_id,kind,model,status,cost_usd,created_at,updated_at,prompt,params,created_by) VALUES(?,?,'image','flux','succeeded',2,?,?,'x','{}',?)", args: [`gen_${id}`, id, Date.now(), Date.now(), me.id] });
  tenant.close();
  return id;
}

test("one screen: after a new budget, Each production reads again (the new cap, no Unlock); two tabs: a stale Unlock is refused with the new figure and the row reads again", async ({ page, context }, info) => {
  const { workspace } = await signInLocally(page.request, "Unlock Admin");
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const scope = { "X-Workbench-Scope": `particl-active-${workspace.id}-${me.id}` };
  const id = await spentProduction(page, workspace.id, scope, "Unlock film");
  expect((await page.request.patch("/api/settings", { headers: scope, data: { productionBudgetCredits: "10" } })).ok()).toBe(true);
  const projectOf = async () => (await (await page.request.get(`/api/projects/${id}`)).json() as { project: { capCredits: number; capUnlocked: boolean } }).project;

  /* One screen: at the 10 cr budget, Unlock is offered. */
  await page.goto("/suites?view=workspace&ws=rules");
  await page.getByTestId("settings-fold-productions-toggle").click();
  const row = page.getByTestId("settings-production").filter({ hasText: "Unlock film" });
  await expect(row).toContainText("of 10 cr", { timeout: 20_000 });
  await expect(row).toContainText("at the workspace budget");
  await expect(row.getByTestId("settings-production-unlock")).toBeVisible();

  /* A second tab, the same admin: it shows the same row and Unlock. */
  const tab = await context.newPage();
  await tab.goto("/suites?view=workspace&ws=rules");
  await tab.getByTestId("settings-fold-productions-toggle").click();
  const tabRow = tab.getByTestId("settings-production").filter({ hasText: "Unlock film" });
  await expect(tabRow.getByTestId("settings-production-unlock")).toBeVisible({ timeout: 20_000 });

  /* On the first screen the admin raises the budget in Budget and cap: Each production reads again. */
  await page.getByTestId("settings-budget-open").click();
  await page.getByTestId("settings-budget-field").fill("100000");
  await page.getByTestId("settings-budget-field").press("Enter");
  await expect(page.getByTestId("settings-budget-state")).toHaveText("Saved · last changed by you");
  await page.getByTestId("settings-budget-done").click();
  await expect(row).toContainText("of 100,000 cr");
  await expect(row.getByTestId("settings-production-unlock")).toHaveCount(0);
  expect(await projectOf()).toMatchObject({ capCredits: 100000, capUnlocked: false });

  /* The second tab still shows 10 cr and Unlock. Pressed, it is refused with the new figure; nothing is unlocked; the row reads again. */
  await tabRow.getByTestId("settings-production-unlock").click();
  await expect(tab.getByTestId("settings-productions-note")).toContainText("The cap changed to 100,000 cr: look again before unlocking.");
  await expect(tabRow).toContainText("of 100,000 cr");
  await expect(tabRow.getByTestId("settings-production-unlock")).toHaveCount(0);
  expect(await projectOf()).toMatchObject({ capCredits: 100000, capUnlocked: false });
  if (info.project.name.includes("1440")) { mkdirSync(SHOTS, { recursive: true }); await tab.screenshot({ path: `${SHOTS}/l4-rules-stale-unlock-${size(info.project.name)}.png` }); }
  await tab.close();
  expect((await page.request.patch("/api/settings", { headers: scope, data: { productionBudgetCredits: "" } })).ok()).toBe(true);
});
