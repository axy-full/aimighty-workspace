import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomBytes } from "node:crypto";
import { password, signupInvite } from "./helpers/identityAdmin";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { signInToRedesign } from "./helpers/newInterface";
import { DEFAULT_PLANS } from "../lib/plans";

/**
 * The platform console (`?view=admin`, components/v12/platform), end to end on a local ENGINE_MOCK server started with
 * SUPER_ADMIN_EMAIL=platform-owner@example.test (the mock-server script does). The platform owner's, and nobody else's: every
 * route behind it, and the page itself, refuse a member and a stranger. Each of the owner's changes (Grant credits, Pause and
 * Resume, Invite, Revoke, the Public site switches, a saved rule or limit) writes its audit line, read here from the platform
 * database. No generation is started and nothing is billed.
 */
const OWNER_EMAIL = "platform-owner@example.test";
const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const PHONE = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const ONE = "workbench-1440x900";

async function owner(page: Page) {
  const login = await page.request.post("/api/auth/login", { data: { email: OWNER_EMAIL, password } });
  if (!login.ok()) {
    const signup = await page.request.post("/api/auth/signup", { data: { code: await signupInvite(OWNER_EMAIL), name: "Platform owner", email: OWNER_EMAIL, workspace: "Platform desk", password, accept: true } });
    expect(signup.ok(), await signup.text()).toBe(true);
  }
  const me = await page.request.get("/api/me").then((r) => r.json()) as { id: string; superAdmin: boolean; workspace: { id: string } };
  expect(me.superAdmin, "start the server with SUPER_ADMIN_EMAIL=platform-owner@example.test").toBe(true);
  return me;
}

/** The owner's current workspace sees the new interface (as the platform owner would list it from the console's own site setting). */
async function owner12(page: Page) {
  const me = await owner(page);
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    const row = await db.execute({ sql: "SELECT value FROM platform_layer WHERE key = 'site'", args: [] });
    const site = row.rows.length ? JSON.parse(String(row.rows[0].value)) as Record<string, unknown> : {};
    const listed = Array.isArray(site.newInterfaceWorkspaces) ? (site.newInterfaceWorkspaces as string[]) : [];
    site.newInterfaceWorkspaces = [me.workspace.id, ...listed.filter((id) => id !== me.workspace.id)].slice(0, 40);
    await db.execute({ sql: `INSERT INTO platform_layer (key, value, updated_at, updated_by) VALUES ('site', ?, ?, 'test') ON CONFLICT(key) DO UPDATE SET value = excluded.value`, args: [JSON.stringify(site), Date.now()] });
  } finally { db.close(); }
  await expect.poll(async () => ((await (await page.request.get("/api/me")).json()) as { workspace?: { newInterface?: boolean } }).workspace?.newInterface ?? false, { timeout: 30_000 }).toBe(true);
  return me;
}

async function audit(where: string, args: (string | number)[] = []) {
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    const rs = await db.execute({ sql: `SELECT action, actor_id, target_id, workspace_id, details FROM platform_audit WHERE ${where} ORDER BY created_at, id`, args });
    return rs.rows.map((r) => ({ action: String(r.action), actor: String(r.actor_id), target: r.target_id == null ? null : String(r.target_id), workspace: r.workspace_id == null ? null : String(r.workspace_id), details: JSON.parse(String(r.details)) as Record<string, unknown> }));
  } finally { db.close(); }
}
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
const json = async (res: { json(): Promise<unknown> }) => (await res.json()) as Record<string, unknown>;

test("the console is the owner's alone: a member and a stranger are refused by every route behind it and by the page", async ({ page, browser, request }, info) => {
  test.skip(info.project.name !== ONE, "server behaviour: once");
  const me = await owner(page);
  const target = (await signInLocally(request, "Console Member")).workspace;
  const guest = await browser.newContext({ baseURL: info.project.use.baseURL });
  const stranger = guest.request;
  const routes: [string, string, unknown?][] = [
    ["GET", "/api/admin/console"], ["GET", "/api/admin/console/models"], ["GET", "/api/admin/console/failed-saves"],
    ["POST", "/api/admin/console/failed-saves", { workspaceId: target.id, id: "x" }],
    ["GET", `/api/admin/console/workspaces/${target.id}`], ["PATCH", `/api/admin/workspaces/${target.id}`, { grantCredits: 5 }], ["PATCH", `/api/admin/workspaces/${target.id}`, { suspended: true }],
    ["GET", "/api/admin/invites"], ["POST", "/api/admin/invites", { email: "x@example.test" }], ["POST", "/api/admin/invites/nope"], ["DELETE", "/api/admin/invites/nope"],
    ["GET", "/api/admin/site"], ["PATCH", "/api/admin/site", { openSignup: true }],
    ["GET", "/api/admin/platform-layer"], ["PATCH", "/api/admin/platform-layer", { key: "caps", value: { warnPct: 10 } }],
  ];
  const before = await audit("1=1");
  for (const [who, api] of [["member", request], ["stranger", stranger]] as [string, APIRequestContext][]) {
    for (const [method, url, data] of routes) {
      const res = await api.fetch(url, { method, ...(data ? { data } : {}) });
      expect(res.status(), `${who} ${method} ${url}`).toBeGreaterThanOrEqual(401);
      expect(res.status(), `${who} ${method} ${url}`).toBeLessThan(500);
    }
  }
  /* Nothing changed: no line, and the member's workspace was not touched. */
  expect(await audit("1=1")).toEqual(before);
  const sheet = await page.request.get(`/api/admin/console/workspaces/${target.id}`);
  expect(sheet.ok()).toBe(true);
  expect((await json(sheet)).paused).toBe(false);
  /* The page: the owner stays on it; a member (and a stranger, sent to sign in) never see it. */
  const ownerPage = await page.request.get("/suites?view=admin", { maxRedirects: 0 });
  expect(ownerPage.status()).toBeLessThan(400);
  const memberPage = await request.get("/suites?view=admin", { maxRedirects: 0 });
  expect(memberPage.status()).toBe(307);
  expect(memberPage.headers().location).toContain("view=home");
  expect(me.id).toBeTruthy();
  await guest.close();
});

test("a bearer token never reaches a console route, even one minted by the platform owner", async ({ page, playwright }, info) => {
  test.skip(info.project.name !== ONE, "server behaviour: once");
  const me = await owner(page);
  const headers = { "X-Workbench-Scope": `particl-active-${me.workspace.id}-${me.id}` };
  const minted = await page.request.post("/api/tokens", { headers, data: { name: "Console bearer check", scope: "read" } });
  expect(minted.ok(), await minted.text()).toBe(true);
  const agent = await playwright.request.newContext({ baseURL: info.project.use.baseURL, extraHTTPHeaders: { Authorization: `Bearer ${(await minted.json() as { token: string }).token}` } });
  const before = await audit("1=1");
  try {
    const routes: [string, string, unknown?][] = [
      ["GET", "/api/admin/console"], ["GET", "/api/admin/console/models"], ["GET", "/api/admin/console/failed-saves"], ["POST", "/api/admin/console/failed-saves", { workspaceId: me.workspace.id, id: "x" }],
      ["GET", `/api/admin/console/workspaces/${me.workspace.id}`], ["PATCH", `/api/admin/workspaces/${me.workspace.id}`, { grantCredits: 5 }], ["PATCH", `/api/admin/workspaces/${me.workspace.id}`, { suspended: true }],
      ["POST", "/api/admin/invites", { email: "token-check@example.test" }], ["POST", "/api/admin/invites/nope"], ["DELETE", "/api/admin/invites/nope"],
      ["PATCH", "/api/admin/site", { openSignup: true }], ["PATCH", "/api/admin/platform-layer", { key: "caps", value: { warnPct: 10 } }],
    ];
    for (const [method, url, data] of routes) {
      const res = await agent.fetch(url, { method, ...(data ? { data } : {}) });
      /* Refused either as "not signed in" (the route sees no browser session behind a bearer token) or as "browser session only"; never an answer. */
      expect([401, 403], `${method} ${url}`).toContain(res.status());
      expect(Object.keys(await res.json() as object), `${method} ${url}`).toEqual(["error"]);
    }
  } finally { await agent.dispose(); }
  expect(await audit("1=1")).toEqual(before);
});

test("each of the owner's changes writes its audit line, and a refused one writes none", async ({ page, request }, info) => {
  test.skip(info.project.name !== ONE, "server behaviour: once");
  test.setTimeout(240_000);
  const me = await owner(page);
  const target = (await signInLocally(request, "Console Grant Target")).workspace;
  const api = page.request;

  /* Grant credits goes through the one grant path; its line holds the amount and the word "manual", never the reason. */
  const granted = await api.patch(`/api/admin/workspaces/${target.id}`, { data: { grantCredits: 25, note: "A reason that must not reach the line" } });
  expect(granted.ok(), await granted.text()).toBe(true);
  expect(await audit("workspace_id = ? AND action = 'credits.granted'", [target.id])).toEqual([{ action: "credits.granted", actor: me.id, target: target.id, workspace: target.id, details: { credits: 25, kind: "manual" } }]);
  const sheet = await json(await api.get(`/api/admin/console/workspaces/${target.id}`)) as { history: { credits: number; note: string }[]; changes: { action: string }[] };
  expect(sheet.history[0]).toMatchObject({ credits: 25, note: "A reason that must not reach the line" });
  expect(sheet.changes.map((c) => c.action)).toContain("credits.granted");
  /* Not a number, zero: refused, and no line. */
  expect((await api.patch(`/api/admin/workspaces/${target.id}`, { data: { grantCredits: 0 } })).status()).toBe(400);
  expect((await api.patch(`/api/admin/workspaces/${target.id}`, { data: { grantCredits: "lots" } })).status()).toBe(400);
  /* Whole credits only, on the server too: a direct request cannot grant a fraction. */
  expect((await api.patch(`/api/admin/workspaces/${target.id}`, { data: { grantCredits: 2.5 } })).status()).toBe(400);
  expect((await audit("workspace_id = ? AND action = 'credits.granted'", [target.id])).length).toBe(1);
  /* The house workspace is never billed in credits: refused, no line. */
  const desk = await json(await api.get("/api/admin/invites")) as { workspaces: { id: string; house?: boolean }[] };
  const house = desk.workspaces.find((w) => w.house);
  if (house) {
    expect((await api.patch(`/api/admin/workspaces/${house.id}`, { data: { grantCredits: 5 } })).status()).toBe(400);
    expect(await audit("workspace_id = ? AND action = 'credits.granted'", [house.id])).toEqual([]);
  }

  /* Pause and Resume. */
  expect((await api.patch(`/api/admin/workspaces/${target.id}`, { data: { suspended: true, reason: "Checking" } })).ok()).toBe(true);
  expect((await json(await api.get(`/api/admin/console/workspaces/${target.id}`))).paused).toBe(true);
  expect((await api.patch(`/api/admin/workspaces/${target.id}`, { data: { suspended: false } })).ok()).toBe(true);
  expect((await audit("workspace_id = ? AND action IN ('workspace.paused','workspace.resumed')", [target.id])).map((l) => l.action)).toEqual(["workspace.paused", "workspace.resumed"]);

  /* Invites: made, resent (refused where mail is not set up: no line), revoked. The line names the invitation by a hash, never its code or address. */
  const email = `invitee-${randomBytes(4).toString("hex")}@example.test`;
  const made = await api.post("/api/admin/invites", { data: { email, name: "Console Invitee", note: "Private note", send: false } });
  expect(made.ok(), await made.text()).toBe(true);
  const { code } = await json(made) as { code: string };
  const mine = (await audit("action LIKE 'invite.%'")).filter((l) => l.actor === me.id);
  const created = mine.at(-1)!;
  expect(created).toMatchObject({ action: "invite.created", details: {} });
  expect(created.target).toMatch(/^inv_[0-9a-f]{12}$/);
  expect(JSON.stringify(created)).not.toContain(code);
  expect(JSON.stringify(created)).not.toContain(email);
  const resent = await api.post(`/api/admin/invites/${code}`);
  /* Without mail set up nothing is attempted and no line is written; with it, the attempt is on the record before the send, and the send has its own line. */
  if (resent.status() === 409) expect((await audit("action = 'invite.resent'")).length).toBe(0);
  else expect((await audit("action = 'invite.resent'")).map((l) => l.details)).toEqual([{ sent: false }, { sent: true }]);
  expect((await api.post("/api/admin/invites/not-a-code")).status()).toBe(404);
  const revoked = await api.delete(`/api/admin/invites/${code}`);
  expect(revoked.ok()).toBe(true);
  expect((await audit("action = 'invite.revoked'")).at(-1)?.target).toBe(created.target);
  /* Revoking what is gone writes no second line. */
  const total = (await audit("action = 'invite.revoked'")).length;
  expect((await api.delete(`/api/admin/invites/${code}`)).ok()).toBe(true);
  expect((await audit("action = 'invite.revoked'")).length).toBe(total);

  /* The Public site switches: the line says which switch and its new value. Restored at the end. */
  const site = await json(await api.get("/api/admin/site")) as { openSignup: boolean; guestHome: boolean; visitorPages: boolean };
  const starts = (await audit("action = 'site.changed'")).length;
  try {
    expect((await api.patch("/api/admin/site", { data: { openSignup: !site.openSignup } })).ok()).toBe(true);
    expect((await api.patch("/api/admin/site", { data: { openSignup: "yes" } })).status()).toBe(400);
    expect((await api.patch("/api/admin/site", { data: { guestWorkspace: "ws_does_not_exist" } })).status()).toBe(400);
  } finally {
    expect((await api.patch("/api/admin/site", { data: { openSignup: site.openSignup } })).ok()).toBe(true);
  }
  expect((await audit("action = 'site.changed'")).slice(starts).map((l) => l.details)).toEqual([{ openSignup: !site.openSignup }, { openSignup: site.openSignup }]);

  /* The platform layer. */
  const layerBefore = await json(await api.get("/api/admin/platform-layer")) as { stored: string[] };
  const layerLines = (await audit("action LIKE 'layer.%'")).length;
  expect((await api.patch("/api/admin/platform-layer", { data: { key: "caps", value: { warnPct: 75 } } })).ok()).toBe(true);
  expect((await api.patch("/api/admin/platform-layer", { data: { key: "caps", reset: true } })).ok()).toBe(true);
  expect((await audit("action LIKE 'layer.%'")).slice(layerLines).map((l) => [l.action, l.details])).toEqual([["layer.saved", { part: "caps" }], ["layer.reset", { part: "caps" }]]);
  expect((await api.patch("/api/admin/platform-layer", { data: { key: "nope", value: 1 } })).status()).toBe(400);
  expect(layerBefore.stored).toBeDefined();
});

test("the Overview, the models and the failed saves read from the server, in the product's own words and prices", async ({ page }, info) => {
  test.skip(info.project.name !== ONE, "server behaviour: once");
  await owner(page);
  const overview = await json(await page.request.get("/api/admin/console")) as Record<string, unknown>;
  expect(typeof overview.workspaces).toBe("number");
  expect(typeof overview.people).toBe("number");
  expect(typeof overview.grantedThisMonth).toBe("number");
  expect(overview.workspaces as number).toBeGreaterThan(0);
  const models = await json(await page.request.get("/api/admin/console/models")) as { engines: { id: string; credits: number }[]; text: { jobs: unknown[]; models: { id: string; inputUsdPerM: number }[] } };
  expect(models.engines.length).toBeGreaterThan(0);
  expect(models.engines.every((e) => e.credits > 0)).toBe(true);
  expect(models.text.jobs).toHaveLength(3);
  const failed = await json(await page.request.get("/api/admin/console/failed-saves")) as { items: unknown[]; unreadable: number };
  expect(Array.isArray(failed.items)).toBe(true);
  /* A retry that names nothing real is refused, and writes nothing. */
  const before = await audit("action = 'save.retried'");
  const refused = await page.request.post("/api/admin/console/failed-saves", { data: { workspaceId: "ws_missing", id: "gen_missing" } });
  expect(refused.status()).toBe(404);
  expect((await page.request.post("/api/admin/console/failed-saves", { data: {} })).status()).toBe(400);
  expect(await audit("action = 'save.retried'")).toEqual(before);
});

test("desktop: the nine places draw, work and save as they are touched; no horizontal overflow", async ({ page, request }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "the console is desktop only");
  test.setTimeout(420_000);
  await owner12(page);
  const target = (await signInLocally(request, `Console Row ${randomBytes(3).toString("hex")}`)).workspace;
  await page.goto("/suites?view=admin");
  const console_ = page.getByTestId("platform-console");
  await expect(console_).toBeVisible({ timeout: 90_000 });
  /* Overview: four tiles, five health cells, what is running. */
  await expect(page.getByTestId("pc-tile-workspaces")).not.toHaveText("—", { timeout: 30_000 });
  await expect(page.getByTestId("pc-health").locator("[data-testid^='pc-health-']")).toHaveCount(5);
  await expect(page.getByTestId("pc-running")).toContainText("Running ");
  expect(await noOverflow(page)).toBe(true);
  await expect(page.locator(".v12-pc-nav .v12-pc-navitem")).toHaveCount(9);

  /* Who can join. */
  await page.getByTestId("pc-nav-access").click();
  await expect(page).toHaveURL(/section=access/);
  const email = `console-${randomBytes(4).toString("hex")}@example.test`;
  await page.getByTestId("pc-invite-email").fill(email);
  await page.getByTestId("pc-invite-name").fill("Console Invitee");
  await page.getByTestId("pc-invite-send").click();
  const row = page.getByTestId("pc-invite").filter({ hasText: email });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByTestId("pc-invite-more").click();
  await page.getByTestId("pc-invite-revoke").click();
  await expect(row).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("pc-request").or(page.getByTestId("pc-requests-empty")).first()).toBeVisible();
  expect(await noOverflow(page)).toBe(true);

  /* Public site: a switch saves as it is touched; turning one on says so with an Undo. */
  await page.getByTestId("pc-nav-site").click();
  const signup = page.getByTestId("pc-site-open-signup");
  await expect(signup).toHaveAttribute("aria-checked", "false", { timeout: 30_000 });
  await signup.click();
  await expect(page.getByTestId("v12-toast")).toContainText("Open sign-up is on");
  await expect(signup).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("v12-toast-action").click();
  await expect(signup).toHaveAttribute("aria-checked", "false", { timeout: 30_000 });
  expect(((await json(await page.request.get("/api/admin/site"))) as { openSignup: boolean }).openSignup).toBe(false);

  /* All workspaces: search, the side sheet, Grant credits, Pause and Resume. */
  await page.getByTestId("pc-nav-workspaces").click();
  await page.getByTestId("pc-ws-search").fill(target.name);
  const wsRow = page.getByTestId("pc-ws-row").filter({ hasText: target.name });
  await expect(wsRow).toHaveCount(1, { timeout: 30_000 });
  await wsRow.click();
  const sheet = page.getByTestId("pc-sheet");
  await expect(sheet).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`sheet=${target.id}`));
  await page.getByTestId("pc-grant-amount").fill("25");
  await page.getByTestId("pc-grant-reason").fill("For the console test");
  await page.getByTestId("pc-grant-send").click();
  await expect(page.getByTestId("v12-toast")).toContainText("Added");
  await expect(page.getByTestId("pc-sheet-history")).toContainText("For the console test", { timeout: 30_000 });
  await expect(page.getByTestId("pc-sheet-changes")).toContainText("Added");
  await page.getByTestId("pc-pause").click();
  await page.getByTestId("pc-pause-reason").fill("Checking");
  await page.getByTestId("pc-pause-confirm").click();
  await expect(wsRow).toContainText("Paused", { timeout: 30_000 });
  await page.getByTestId("pc-resume").click();
  await expect(wsRow).toContainText("Active", { timeout: 30_000 });
  expect(await noOverflow(page)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  expect((await audit("workspace_id = ?", [target.id])).map((l) => l.action)).toEqual(["credits.granted", "workspace.paused", "workspace.resumed"]);
  /* The house reads "House · pays at cost" and cannot be granted credits. */
  await page.getByTestId("pc-ws-search").fill("");
  const house = page.getByTestId("pc-ws-row").filter({ hasText: "pays at cost" });
  if (await house.count()) {
    await house.first().click();
    await expect(page.getByTestId("pc-grant-send")).toBeDisabled();
    await page.keyboard.press("Escape");
  }

  /* AI models: engines with their prices, text models grouped by provider; a pick saves. */
  await page.getByTestId("pc-nav-engines").click();
  const video = page.getByTestId("pc-model-video");
  await expect(video).toBeVisible({ timeout: 30_000 });
  const was = ((await json(await page.request.get("/api/admin/console/models"))) as { defaults: { video: string } }).defaults.video;
  await video.click();
  const pick = page.getByTestId("pc-model-video-list").locator(`[role=option]:not([data-id="${was}"])`).first();
  if (await pick.count()) {
    const id = await pick.getAttribute("data-id");
    await pick.click();
    await expect(page.getByTestId("v12-toast")).toContainText("Saved");
    expect(((await json(await page.request.get("/api/admin/console/models"))) as { defaults: { video: string } }).defaults.video).toBe(id);
    await page.request.patch("/api/admin/platform-layer", { data: { key: "models", reset: true } });
  }
  await page.getByTestId("pc-model-enhance").click();
  await expect(page.getByTestId("pc-model-enhance-list")).toContainText("/1M");
  await page.keyboard.press("Escape");

  /* Style rules: add, write, remove with Undo; Reset to defaults. */
  await page.getByTestId("pc-nav-rules").click();
  await expect(page.getByTestId("pc-rule").first()).toBeVisible({ timeout: 30_000 });
  const count = await page.getByTestId("pc-rule").count();
  await page.getByTestId("pc-rule-add").click();
  const text = page.getByTestId("pc-rule-text").last();
  await text.fill("Console test rule: keep it short.");
  await text.press("Enter");
  await expect.poll(async () => ((await json(await page.request.get("/api/admin/platform-layer"))) as { layer: { rules: { text: string }[] } }).layer.rules.some((r) => r.text.startsWith("Console test rule")), { timeout: 30_000 }).toBe(true);
  await expect(page.getByTestId("pc-rule")).toHaveCount(count + 1);
  await page.getByTestId("pc-rule").last().getByTestId("pc-rule-remove").click();
  await expect(page.getByTestId("v12-toast")).toContainText("Rule removed");
  await page.getByTestId("v12-toast-action").click();
  await expect(page.getByTestId("pc-rule")).toHaveCount(count + 1);
  await page.getByTestId("pc-rules-reset").click();
  await expect(page.getByTestId("pc-rule")).toHaveCount(count, { timeout: 30_000 });

  /* Limits: Save keeps the numbers; Reset puts the defaults back. */
  await page.getByTestId("pc-nav-caps").click();
  const hourly = page.getByTestId("pc-limit-rendersPerHour");
  await expect(hourly).toBeVisible({ timeout: 30_000 });
  await hourly.fill("77");
  await page.getByTestId("pc-limits-save").click();
  await expect(page.getByTestId("v12-toast")).toContainText("Saved");
  await page.reload();
  await expect(page.getByTestId("pc-limit-rendersPerHour")).toHaveValue("77", { timeout: 60_000 });
  await page.getByTestId("pc-limits-reset").click();
  await expect(page.getByTestId("pc-limit-rendersPerHour")).not.toHaveValue("77", { timeout: 30_000 });

  /* Plans & prices: read only, from config; Edit prices says why it is off. */
  await page.getByTestId("pc-nav-plans").click();
  /* One card per plan in the platform layer's list (lib/plans.ts: the new Individual and Business plans since #661, with the retired ones), not a number typed here. */
  await expect(page.getByTestId("pc-plan")).toHaveCount(DEFAULT_PLANS.length);
  const edit = page.getByTestId("pc-edit-prices");
  await expect(edit).toHaveAttribute("aria-disabled", "true");
  await edit.hover();
  await expect(page.getByText("Prices are set in config — checkout comes later").first()).toBeVisible({ timeout: 5_000 });

  /* Failed saves: rows with Retry save, or "Nothing at risk." */
  await page.getByTestId("pc-nav-risk").click();
  await expect(page.getByTestId("pc-risk-row").or(page.getByTestId("pc-risk-empty")).first()).toBeVisible({ timeout: 60_000 });
  expect(await noOverflow(page)).toBe(true);
  /* The left column and the place both fit the window, and the primary of each place is reachable without scrolling the page sideways. */
  const box = await page.getByTestId("pc-main").boundingBox();
  expect(box && box.width).toBeGreaterThan(600);
});

test("a member's avatar menu has no console, and a phone never draws it", async ({ page, browser }, info) => {
  const isPhone = PHONE.includes(info.project.name);
  test.setTimeout(240_000);
  const guest = await browser.newContext({ baseURL: info.project.use.baseURL, viewport: info.project.use.viewport, isMobile: isPhone, hasTouch: isPhone });
  const mine = await guest.newPage();
  try {
    await signInToRedesign(mine.request, "Console Bystander");
    await mine.goto("/suites?view=home");
    if (!isPhone) {
      await expect(mine.getByTestId("v12-avatar")).toBeVisible({ timeout: 90_000 });
      await mine.getByTestId("v12-avatar").click();
      await expect(mine.getByTestId("v12-account-menu")).toBeVisible();
      await expect(mine.getByTestId("v12-account-platform")).toHaveCount(0);
      await expect(mine.getByText(/Platform (console|desk)/)).toHaveCount(0);
      await mine.keyboard.press("Escape");
    }
    /* Asking for the console by its address lands on Home, never on it. */
    await mine.goto("/suites?view=admin&section=workspaces");
    await expect(mine).toHaveURL(/view=home/, { timeout: 60_000 });
    await expect(mine.getByTestId("platform-console")).toHaveCount(0);
    expect(await noOverflow(mine)).toBe(true);
  } finally { await guest.close(); }
  /* The owner on a phone: no console either (it is a desktop place), and nothing runs off the screen. */
  if (isPhone) {
    await owner(page);
    await page.goto("/suites?view=admin");
    await page.waitForTimeout(3_000);
    await expect(page.getByTestId("platform-console")).toHaveCount(0);
    expect(await noOverflow(page)).toBe(true);
  }
});
