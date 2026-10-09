import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { password, signupInvite } from "./helpers/identityAdmin";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";
import { smallTargets } from "./phoneFloors";
import type { TrayReply } from "../lib/jobsTray";
import { heldPriceNow } from "../lib/creditTerms";

/**
 * One owned provider key serves every workspace on the platform's keys
 * (lib/providerPool.ts, lib/higgsfield.ts). What a person sees of it: a take
 * waiting for the shared pool says "Queued" and "Starts when a slot frees";
 * a take sent on a key that has since changed says "Checking" while that is
 * sorted out, and is never failed or sent again for it. What the platform's
 * owner sees: the pool, the takes waiting on a changed key with what to do,
 * and each request's request_id beside its correlation id — and nobody else
 * sees any of it. Real routes over seeded rows on a local ENGINE_MOCK server;
 * nothing paid is sent.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844"];
const TOUCH = [...PHONES, "workbench-844x390"];
const MIN = 60_000;
const MARKETING = "higgsfield/marketing-studio-image";
/* A key this server has never had: the one-way fingerprint of a key rotated away (no key is ever stored). */
const GONE = createHash("sha256").update(`rotated-away:${randomBytes(8).toString("hex")}`).digest("hex");
const MOCK_KEY = createHash("sha256").update("particl-mock:higgsfield").digest("hex");
/* What a still quoted at the fixture price needs to start, at today's terms: the figure Generate held it at. */
const NEEDS = heldPriceNow({ estUsd: 0.25 }, "image", MARKETING);

/** SHARED_KEY_SHOTS=<dir> keeps a picture of what was checked, per size (for review; never in CI). */
async function shoot(page: Page, project: string, name: string, target?: string) {
  const dir = process.env.SHARED_KEY_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}-${project.replace("workbench-", "")}.png`);
  if (target) await page.locator(target).screenshot({ path: file });
  else await page.screenshot({ path: file });
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
}
/** No text in `scope` dimmer than #7C7C84 on its ground (its colour laid over the backgrounds under it, down to black). */
async function dimText(page: Page, scope: string): Promise<string[]> {
  return page.evaluate((scope) => {
    const rgba = (c: string) => { const n = (c.match(/[\d.]+/g) ?? ["0", "0", "0"]).map(Number); return [n[0], n[1], n[2], n.length > 3 ? n[3] : 1]; };
    const over = (top: number[], under: number[]) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3]));
    const luminance = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    const root = document.querySelector(scope);
    if (!root) return [`no ${scope}`];
    const out: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (!el || !(node.textContent ?? "").trim() || !el.getClientRects().length) continue;
      const chain: Element[] = [];
      for (let e: Element | null = el; e; e = e.parentElement) chain.unshift(e);
      let ground = [0, 0, 0];
      for (const e of chain) { const bg = rgba(getComputedStyle(e).backgroundColor); if (bg[3] > 0) ground = over(bg, ground); }
      const style = getComputedStyle(el);
      const ink = over(rgba(style.color), ground);
      /* On a dark ground nothing dimmer than #7C7C84; on a light one, nothing paler. */
      const floor = luminance([0x7c, 0x7c, 0x84]);
      const faint = luminance(ground) > 128 ? luminance(ink) > floor + 0.5 : luminance(ink) < floor - 0.5;
      if (faint) out.push(`${el.className || el.tagName}: ${style.color} — “${(node.textContent ?? "").trim().slice(0, 24)}”`);
    }
    return out;
  }, scope);
}
/** Nothing in `scope` scrolls sideways or reaches past the screen's edge. */
async function fits(page: Page, scope: string): Promise<string[]> {
  return page.evaluate((scope) => {
    const root = document.querySelector<HTMLElement>(scope);
    if (!root) return [`no ${scope}`];
    const out: string[] = [];
    const box = root.getBoundingClientRect();
    for (const el of [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))]) {
      if (!el.getClientRects().length) continue;
      if (el.scrollWidth > el.clientWidth + 0.5 && getComputedStyle(el).overflowX !== "visible") out.push(`${el.className || el.tagName} scrolls sideways: ${el.scrollWidth} > ${el.clientWidth}`);
      const rect = el.getBoundingClientRect();
      if (rect.width && (rect.right > box.right + 0.5 || rect.right > window.innerWidth + 0.5)) out.push(`${el.className || el.tagName} ends at ${Math.round(rect.right)} past ${Math.round(Math.min(box.right, window.innerWidth))}`);
    }
    return out;
  }, scope);
}
async function lastRowAboveTabBar(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const list = document.querySelector<HTMLElement>(".gx-jobs-list");
    const bar = document.querySelector<HTMLElement>(".gx-tabbar");
    if (!list) return ["no list"];
    if (!bar || !bar.getClientRects().length) return [];
    list.scrollTop = list.scrollHeight;
    const rows = Array.from(list.querySelectorAll<HTMLElement>(".gx-jobs-row"));
    const last = rows[rows.length - 1];
    if (!last) return ["no rows"];
    const bottom = last.getBoundingClientRect().bottom, top = bar.getBoundingClientRect().top;
    return bottom <= top + 0.5 ? [] : [`last row ends at ${Math.round(bottom)}, the tab bar starts at ${Math.round(top)}`];
  });
}

/** The workspace's own database (local files only), for rows the server itself would have written. */
async function tenantOf(workspaceId: string) {
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    const url = String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id=?", args: [workspaceId] })).rows[0].db_url);
    expect(url).toMatch(/^file:/);
    return createClient({ url, timeout: 10_000 });
  } finally { platform.close(); }
}

test("the jobs tray says what a take on the shared key is doing: Queued — starts when a slot frees, or Checking while a changed key is sorted out", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const phone = PHONES.includes(info.project.name);
  const touch = TOUCH.includes(info.project.name);
  const account = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json()) as { id: string };
  const draft = `ws-shared-${randomBytes(4).toString("hex")}`;
  const tag = randomBytes(5).toString("hex");
  const tenant = await tenantOf(account.workspace.id);
  const now = Date.now();
  const pooled = `gen_${tag}_pool`, changed = `gen_${tag}_key`, slot = `gen_${tag}_slot`;
  try {
    await tenant.execute({ sql: "INSERT INTO projects(id,name,created_at) VALUES(?,?,?)", args: [`prod-${tag}`, "Bottle launch", now] });
    await tenant.execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,?,?)",
      args: [`${me.id}:${draft}`, me.id, draft, "Bottle launch", JSON.stringify({ id: draft, name: "Bottle launch", productionProjectId: `prod-${tag}` }), 1, now] });
    const row = (id: string, status: string, title: string, params: object, createdAt: number) => tenant.execute({
      sql: `INSERT INTO generations(id,project_id,kind,model,prompt,title,params,status,created_by,created_at,updated_at,provider,billed_to,task)
            VALUES(?,?,'image',?,?,?,?,?,?,?,?,'higgsfield','higgsfield','generate')`,
      args: [id, `prod-${tag}`, MARKETING, `Prompt for ${title}`, title, JSON.stringify(params), status, me.id, createdAt, createdAt],
    });
    /* Parked by Generate behind the full pool: held for a slot, marked as the pool's; nothing reserved or sent. */
    await row(pooled, "held", "Bottle on the plinth", { ratio: "3:4", resolution: "2k", held: { why: "slots", pool: "shared", needs: NEEDS, estUsd: 0.25, at: now - 2 * MIN } }, now - 2 * MIN);
    /* Waiting for one of this workspace's own slots: said the way it always was. */
    await row(slot, "held", "Bottle in the rain", { ratio: "3:4", resolution: "2k", held: { why: "slots", needs: NEEDS, estUsd: 0.25, at: now - 3 * MIN } }, now - 3 * MIN);
    /* Sent and accepted on a key this server no longer has: its collection must not ask anything, fail it or send it again. */
    await row(changed, "running", "Bottle at dusk", { ratio: "3:4", resolution: "2k", references: [], marketing: { quality: "high", enhancePrompt: false },
      paidClaim: now - 4 * MIN, higgsfieldCredentialFingerprint: GONE, higgsfieldVendorCostUsd: 0.25,
      higgsfieldStillHandle: { provider: "higgsfield", model: MARKETING, ref: `mock_higgsfield_${now - 4 * MIN}`, credentialFingerprint: GONE } }, now - 4 * MIN);

    /* A read of the jobs collects what is in flight, after its reply: the changed key is found, and the take waits. */
    const read = await page.request.get("/api/jobs?view=tray");
    expect(read.ok(), await read.text()).toBe(true);
    await expect.poll(async () => {
      const got = (await tenant.execute({ sql: "SELECT status,json_extract(params,'$.providerKeyChanged') AS waiting FROM generations WHERE id=?", args: [changed] })).rows[0];
      return got.waiting != null ? got.status : null;
    }, { timeout: 60_000, message: "the collector finds the changed key" }).toBe("running");
    /* The platform's owner is alerted; the take is never failed for it. */
    const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
    try {
      const alert = (await platform.execute({ sql: "SELECT workspace_id,key_prefix,resolved_at FROM provider_key_alerts WHERE id=?", args: [changed] })).rows[0];
      expect({ ...alert }).toEqual({ workspace_id: account.workspace.id, key_prefix: GONE.slice(0, 12), resolved_at: null });
    } finally { platform.close(); }

    /* The tray's own reply: in the line, or checking; no request handle, key fingerprint or correlation id in it. */
    const reply = await page.request.get("/api/jobs?view=tray&sync=0");
    const text = await reply.text();
    expect(text).not.toContain(GONE.slice(0, 12));
    expect(text).not.toMatch(/mock_higgsfield|correlation|credentialFingerprint|higgsfieldStillHandle/i);
    const rows = new Map((JSON.parse(text) as TrayReply).jobs.map((job) => [job.id, job]));
    expect(rows.get(pooled)).toMatchObject({ stage: "queued", label: "Queued", reason: "Starts when a slot frees", action: null, price: { amount: NEEDS, unit: "cr" } });
    expect(rows.get(slot)).toMatchObject({ stage: "queued", label: "Queued", reason: "Waiting for a free slot", action: null });
    expect(rows.get(changed)).toMatchObject({ stage: "confirming", label: "Checking", tone: "amber", reason: "The provider key changed; checking with the provider", action: null });

    /* What the person sees. */
    await forbidPaidWork(page);
    await mockMedia(page);
    const fixture = (): Project => ({ ...newProject("Bottle launch"), id: draft, productionProjectId: `prod-${tag}`, shotMappings: {} });
    await mockProjects(page, { current: fixture(), list: [{ id: draft, name: "Bottle launch" }] });
    await mockLibrary(page, { uploads: [], generations: [] });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/suites?suite=atomik&page=agent&sp=agent");
    await expect(page.getByTestId("project-name").first()).toHaveText("Bottle launch");
    const pill = page.getByTestId("running-jobs");
    await expect(pill).toBeVisible();
    await pill.click();
    const panel = page.getByRole("dialog", { name: "Jobs" });
    await expect(panel).toBeVisible();
    const named = (title: string) => panel.getByTestId("jobs-row").filter({ hasText: title });
    await expect(named("Bottle on the plinth").getByTestId("jobs-stage")).toHaveText("Queued");
    await expect(named("Bottle on the plinth").getByTestId("jobs-reason")).toHaveText("Starts when a slot frees");
    await expect(named("Bottle on the plinth").getByTestId("jobs-price")).toHaveText(`${NEEDS} cr`);
    await expect(named("Bottle on the plinth").getByTestId("jobs-action")).toHaveCount(0);
    await expect(named("Bottle in the rain").getByTestId("jobs-reason")).toHaveText("Waiting for a free slot");
    await expect(named("Bottle at dusk").getByTestId("jobs-stage")).toHaveText("Checking");
    await expect(named("Bottle at dusk").getByTestId("jobs-reason")).toHaveText("The provider key changed; checking with the provider");
    await expect(named("Bottle at dusk").getByTestId("jobs-action")).toHaveCount(0);
    await expect(named("Bottle at dusk")).toHaveAttribute("data-tone", "amber");
    /* The phone floors hold: targets, contrast, nothing sideways, the last row above the tab bar. */
    /* The sheet rises and the popover pops in: measured once it has arrived. */
    await page.getByTestId("jobs-veil").evaluate((veil) =>
      Promise.all(veil.getAnimations({ subtree: true }).filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished)));
    if (touch) expect(await smallTargets(page, ".gx-jobs-tray"), "targets under 44×44").toEqual([]);
    expect(await dimText(page, ".gx-jobs-tray"), "text dimmer than #7C7C84").toEqual([]);
    expect(await fits(page, ".gx-jobs-tray"), "the tray").toEqual([]);
    if (phone) expect(await lastRowAboveTabBar(page), "the last row and the tab bar").toEqual([]);
    await noOverflow(page);
    await shoot(page, info.project.name, "tray");
    expect(errors).toEqual([]);
    /* Still waiting, never failed or charged: nothing was asked of the provider for it. */
    const still = (await tenant.execute({ sql: "SELECT status,cost_usd FROM generations WHERE id IN (?,?) ORDER BY id", args: [changed, pooled] })).rows.map((r) => ({ ...r }));
    expect(still).toEqual([{ status: "running", cost_usd: null }, { status: "held", cost_usd: null }]);
  } finally {
    tenant.close();
  }
});

/** The platform's owner, as the local server names it (SUPER_ADMIN_EMAIL): signed in, or signed up once through an invitation. */
async function signInAsPlatformOwner(api: APIRequestContext) {
  const ownerEmail = "platform-owner@example.test";
  const login = await api.post("/api/auth/login", { data: { email: ownerEmail, password } });
  if (!login.ok()) {
    const code = await signupInvite(ownerEmail);
    const signup = await api.post("/api/auth/signup", { data: { code, name: "Platform owner", email: ownerEmail, workspace: "Platform desk", password, accept: true } });
    expect(signup.ok(), await signup.text()).toBe(true);
  }
  const me = await api.get("/api/me").then((r) => r.json()) as { superAdmin?: boolean; workspace: { id: string; name: string } };
  expect(me.superAdmin, `start the server with SUPER_ADMIN_EMAIL=${ownerEmail}`).toBe(true);
  return me;
}

test("the platform desk shows the shared key to its owner — the pool, takes on a changed key, request and correlation ids — and to nobody else", async ({ page, browser }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const touch = TOUCH.includes(info.project.name);
  const me = await signInAsPlatformOwner(page.request);
  // The desk's tables exist once it has been read.
  expect((await page.request.get("/api/admin/shared-key")).status()).toBe(200);
  const tag = randomBytes(5).toString("hex");
  const take = `gen_${tag}_desk`, waiting = `gen_${tag}_waits`;
  const requestId = randomUUID();
  const correlation = `corr-${tag}-${randomBytes(6).toString("hex")}`;
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    const now = Date.now();
    await platform.execute({
      sql: "INSERT INTO higgsfield_generation_receipts(id,workspace_id,handle_json,credential_fingerprint,updated_at) VALUES(?,?,?,?,?)",
      args: [take, me.workspace.id, JSON.stringify({ provider: "higgsfield", model: MARKETING, ref: requestId, credentialFingerprint: MOCK_KEY, correlationId: correlation }), MOCK_KEY, now + 60_000],
    });
    await platform.execute({
      sql: "INSERT INTO provider_key_alerts(id,workspace_id,key_prefix,first_at,last_at) VALUES(?,?,?,?,?)",
      args: [waiting, me.workspace.id, GONE.slice(0, 12), now - 5 * MIN, now - MIN],
    });

    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/admin");
    const card = page.getByTestId("shared-key-card");
    await expect(card).toBeVisible();
    await card.scrollIntoViewIfNeeded();
    await expect(card.getByText("Shared provider key", { exact: true })).toBeVisible();
    /* This server runs the mock engine with no pool configured: the card says the pool is off, by its setting's name. */
    await expect(card.getByTestId("shared-key-pool")).toContainText("The pool is off (HF_POOL_SIZE)");
    const changes = card.getByTestId("shared-key-changes");
    await expect(changes).toContainText(`take ${waiting} · key ${GONE.slice(0, 12)}…`);
    await expect(changes).toContainText("HF_CREDENTIALS_PREVIOUS");
    const request = card.getByTestId("shared-key-request").filter({ hasText: take });
    await expect(request.getByTestId("shared-key-request-id")).toHaveText(requestId);
    await expect(request.getByTestId("shared-key-correlation-id")).toHaveText(correlation);
    await expect(request).toContainText("platform key");
    await expect(card).toContainText("Give support both ids.");
    /* Ids and one-way prefixes only: no key, no dollars. */
    await expect(card).not.toContainText(/particl-mock|secret|\$\d/i);
    expect(await fits(page, '[data-testid="shared-key-card"]'), "the card").toEqual([]);
    expect(await dimText(page, '[data-testid="shared-key-card"]'), "text dimmer than #7C7C84").toEqual([]);
    await shoot(page, info.project.name, "desk-card", '[data-testid="shared-key-card"]');
    expect(errors).toEqual([]);

    /* A read that fails says so, with Try again, and Try again reads it. */
    let failing = true;
    await page.route("**/api/admin/shared-key", (route) => (failing ? route.fulfill({ status: 503, json: { error: "unavailable" } }) : route.fallback()));
    await page.reload();
    const fault = page.getByTestId("shared-key-fault");
    await expect(fault).toContainText("could not be read");
    const again = fault.getByRole("button", { name: "Try again" });
    if (touch) {
      const box = (await again.boundingBox())!;
      expect(Math.round(box.height)).toBeGreaterThanOrEqual(44);
      expect(Math.round(box.width)).toBeGreaterThanOrEqual(44);
    }
    failing = false;
    await again.click();
    await expect(page.getByTestId("shared-key-request").filter({ hasText: take }).getByTestId("shared-key-correlation-id")).toHaveText(correlation);
    await page.unroute("**/api/admin/shared-key");

    /* Anyone else — a workspace's own owner included — is refused the route, and the desk is not theirs to see. */
    const other = await browser.newContext({ baseURL: process.env.PW_BASE_URL || "http://localhost:4551", viewport: page.viewportSize() ?? undefined });
    try {
      const stranger = await other.newPage();
      await signInLocally(stranger.request, "Studio owner");
      const refused = await stranger.request.get("/api/admin/shared-key");
      expect(refused.status()).toBe(403);
      expect(await refused.text()).not.toContain(correlation);
      await stranger.goto("/admin");
      await expect(stranger.getByText("The platform owner only")).toBeVisible();
      await expect(stranger.getByTestId("shared-key-card")).toHaveCount(0);
    } finally { await other.close(); }
  } finally {
    // Leave the alert answered so the desk reads clean on a rerun (kept, never deleted).
    await platform.execute({ sql: "UPDATE provider_key_alerts SET resolved_at=? WHERE id=?", args: [Date.now(), waiting] }).catch(() => {});
    await platform.execute({ sql: "UPDATE higgsfield_generation_receipts SET settled_at=? WHERE id=?", args: [Date.now(), take] }).catch(() => {});
    platform.close();
  }
});
