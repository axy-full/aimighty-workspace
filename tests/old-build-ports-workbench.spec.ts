import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { signInToRedesign } from "./helpers/newInterface";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { removeHouseJobsOf } from "./helpers/houseJobs";
import { openBilling } from "./helpers/billingV12";
import { openShotsBoard, type ShotRow } from "./helpers/shotsV12";
import { openBoard } from "./helpers/boardV12";
import { mockMedia } from "./helpers/workspaceFixtures";
import { signedInWarm, watchErrors, PHONES } from "./helpers/r1-gaps";
import { MODELS } from "../lib/models";
import { takesSeed } from "../lib/workspace/composer";
import { newProject, type Project } from "../lib/workbench/studio";

/**
 * The money, sign-in and tenancy assertions of the prototype-12 build's browser specs, ported to where each feature lives now: the live
 * shell (components/graphite) that every workspace sees, the house and any workspace with the new-interface switch on included (owner,
 * 23 Oct 2026: the prototype-12 build behind lib/newInterface.ts is deleted; v31.16 is built behind the same switch from scratch).
 * Each test names the spec and test it came from; docs/old-shells.md has one line per deleted spec. An assertion whose feature has no
 * home in the live shell is kept as a fixme with its reason and the owner's question.
 *
 * Local ENGINE_MOCK server. Every paid route is answered in the browser or refused; nothing real is generated or spent.
 */
const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const priceOf = async (page: Page) => Number(((await page.getByTestId("gen-generate").innerText()).match(/([\d,]+) cr/)?.[1] ?? "NaN").replace(/,/g, ""));
async function say(page: Page, words: string) { const box = page.getByTestId("gen-prompt"); await box.click(); await box.fill(words); }

/* ── What the switch draws now ─────────────────────────────────────────────────────────────────────────────────────── */

test.describe("the new-interface switch on, with nothing built behind it", () => {
  test("a workspace with the switch on sees the live shell, the same as a customer: its header, Home, a board, Make as a panel and Plan & credits", async ({ page }, info) => {
    test.setTimeout(300_000);
    const errors = watchErrors(page);
    await signInToRedesign(page.request, "Switch On Tester");
    await expect.poll(async () => ((await (await page.request.get("/api/me")).json()) as { workspace?: { newInterface?: boolean } }).workspace?.newInterface ?? false,
      { timeout: 30_000, intervals: [500, 1000, 2000] }).toBe(true);
    const phone = PHONES.includes(info.project.name);
    /* Nothing of the deleted build is asked for, from Home's first load on. */
    const asked: string[] = [];
    page.on("request", (r) => { const path = new URL(r.url()).pathname; if (path.startsWith("/api/v12")) asked.push(path); });
    await page.goto("/suites?view=home");
    if (phone) await expect(page.getByTestId("phone-app")).toBeVisible({ timeout: 90_000 });
    else {
      await expect(page.locator("header.gx-header")).toBeVisible({ timeout: 90_000 });
      await expect(page.getByTestId("screen")).toHaveAttribute("data-screen", "home");
    }
    /* Nothing of the deleted build is drawn: no .v12 root, no v12 test id. */
    expect(await page.locator(".v12, [data-testid^='v12-']").count()).toBe(0);
    if (!phone) {
      await page.goto("/suites?view=board");
      await expect(page.getByTestId("board").or(page.getByTestId("board-no-project")).first()).toBeVisible({ timeout: 90_000 });
      expect(await page.locator("[data-v12], .v12-stage-canvas").count()).toBe(0);
      await page.goto("/suites?make=image");
      await expect(page.getByTestId("make-panel")).toBeVisible({ timeout: 90_000 });
      await page.goto("/suites?view=workspace&tab=credits");
      await expect(page.getByTestId("settings-title")).toHaveText("Plan & credits", { timeout: 90_000 });
    }
    expect(await page.locator(".v12, [data-testid^='v12-']").count()).toBe(0);
    expect(asked).toEqual([]);
    expect(await noSideways(page)).toBe(true);
    expect(errors).toEqual([]);
  });
});

/* ── Make (from make-v12, enhance-v12, enhance-house-v12, house-make-press-v12) ────────────────────────────────────── */

/** The enhancer and the render, answered in the browser: the free quotes, the one paid enhancement and the one take. */
async function answerMake(page: Page) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  await page.route("**/api/prompt/enhance", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    calls.push({ path: "enhance", body });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body.quoteOnly ? { estimateCredits: 1 } : { prompt: "A slow push toward the stall at golden hour, warm low sun", provider: "higgsfield" }) });
  });
  await page.route(/\/api\/generate$/, (route) => {
    if (route.request().method() !== "POST") return route.continue();
    calls.push({ path: "generate", body: route.request().postDataJSON() as Record<string, unknown> });
    return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "No render is made in this test." }) });
  });
  return calls;
}

test.describe("Make, at the figure on its button", () => {
  test.beforeEach(({}, info) => test.skip(!DESKTOP.includes(info.project.name), "the panel's Advanced (Enhance) is desktop; the phone's Make is tests/demo-s10-phone-make-workbench.spec.ts"));

  test("enhance-v12 › On: the enhancement is approved at its own quote and the take at the take's own figure; the two are the button's", async ({ page }) => {
    test.setTimeout(240_000);
    const calls = await answerMake(page);
    await signedInWarm(page, "Make Ports Tester");
    await page.goto("/suites?make=change");
    await say(page, "make shot 2 at golden hour");
    const go = page.getByTestId("gen-generate");
    await expect(go).toHaveText(/^Make · \d[\d,]* cr$/, { timeout: 60_000 });
    const take = await priceOf(page);
    await page.getByTestId("make-advanced-toggle").click();
    const adv = page.getByTestId("make-advanced");
    await expect(adv.getByTestId("enhance")).toHaveText("Enhance now · 1 cr", { timeout: 60_000 });
    await adv.getByTestId("enhance-auto").click();
    await expect(go).toHaveText(new RegExp(`^Make · ${(take + 1).toLocaleString("en-US")} cr$`));
    expect(calls.filter((c) => c.path === "generate" || (c.path === "enhance" && !c.body.quoteOnly)), "nothing paid before the press").toEqual([]);
    await go.click();
    await expect.poll(() => calls.filter((c) => c.path === "generate").length, { timeout: 30_000 }).toBe(1);
    const enhanced = calls.filter((c) => c.path === "enhance" && !c.body.quoteOnly);
    expect(enhanced).toHaveLength(1);
    const sent = calls.find((c) => c.path === "generate")!.body;
    /* Each approval at its own figure, and together the figure the person saw. */
    expect(enhanced[0].body.maxCredits).toBe(1);
    expect(sent.maxCredits).toBe(take);
    expect(Number(enhanced[0].body.maxCredits) + Number(sent.maxCredits)).toBe(take + 1);
    expect(typeof sent.quoteFingerprint).toBe("string");
  });

  test("enhance-v12 › Off: the words go as written, at the take's figure alone, and no enhancement is run", async ({ page }) => {
    test.setTimeout(240_000);
    const calls = await answerMake(page);
    await signedInWarm(page, "Make Ports Tester");
    await page.goto("/suites?make=image");
    await say(page, "A paper kite over a grey sea");
    const go = page.getByTestId("gen-generate");
    await expect(go).toHaveText(/^Make · \d[\d,]* cr$/, { timeout: 60_000 });
    const take = await priceOf(page);
    await go.click();
    await expect.poll(() => calls.filter((c) => c.path === "generate").length, { timeout: 30_000 }).toBe(1);
    expect(calls.filter((c) => c.path === "enhance" && !c.body.quoteOnly)).toEqual([]);
    expect(calls.find((c) => c.path === "generate")!.body.maxCredits).toBe(take);
  });

  test("house-make-press-v12 › the house's Make press goes through: no credits worded, no repricing, one take sent with its ceiling", async ({ page }) => {
    test.setTimeout(300_000);
    const signed = await signInLocally(page.request, "House Make Tester");
    const me = await page.request.get("/api/me").then((r) => r.json()) as { id: string };
    const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
    try {
      const existing = await db.execute({ sql: "SELECT 1 FROM workspaces WHERE id = 'ws_legacy'", args: [] });
      test.skip(existing.rows.length > 0, "this local deployment already has a house workspace");
      const at = Date.now();
      await db.execute({ sql: `INSERT INTO workspaces (id, slug, name, db_url, db_token_enc, legacy, uses_platform_keys, owner_id, created_at, updated_at) VALUES ('ws_legacy','house-test','House test','file:house',NULL,1,1,?,?,?)`, args: [me.id, at, at] });
      await db.execute({ sql: "INSERT INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES('ws_legacy',?,'owner',0,?)", args: [me.id, at] });
      try {
        expect((await page.request.post("/api/workspaces/switch", { data: { id: "ws_legacy" } })).ok()).toBe(true);
        await expect.poll(async () => ((await (await page.request.get("/api/me")).json()) as { workspace?: { id: string } }).workspace?.id).toBe("ws_legacy");
        const isGenerate = (r: { url(): string; method(): string }) => new URL(r.url()).pathname === "/api/generate" && r.method() === "POST";
        await page.goto("/suites?make=image");
        await say(page, "A paper kite over a grey sea");
        const go = page.getByTestId("gen-generate");
        await expect(go).toHaveAttribute("data-spend", "priced", { timeout: 60_000 });
        await expect(go).not.toContainText(/\bcr\b/);
        const sent = page.waitForRequest(isGenerate);
        const answered = page.waitForResponse((r) => isGenerate(r.request()));
        await go.click();
        expect(typeof ((await sent).postDataJSON() as { maxCredits?: number }).maxCredits).toBe("number");
        expect((await answered).ok()).toBe(true);
        expect(await page.locator("body").innerText()).not.toMatch(/The price is now/);
        expect(await noSideways(page)).toBe(true);
        await page.request.post("/api/workspaces/switch", { data: { id: signed.workspace.id } });
      } finally {
        try { await removeHouseJobsOf(db, me.id); }
        finally {
          await db.execute({ sql: "DELETE FROM memberships WHERE workspace_id = 'ws_legacy'", args: [] });
          await db.execute({ sql: "DELETE FROM workspaces WHERE id = 'ws_legacy'", args: [] });
        }
      }
    } finally { db.close(); }
  });

  /* Found by this port (23 Oct 2026): on the live panel the house's still reads "Make · —" with "Priced at cost once the engine's price is read."
     (lib/shell/price-words.ts NO_AT_COST_TITLE), though /api/workbench/engines answers it the engine's dollars; the press itself goes through (above).
     The prototype-12 Make page showed "$…" here. The dollars never reach the value drawn: components/graphite/make/price.tsx:21 renders
     price.value and never reads price.usd, and use-make.ts:437/442 with goFigure (lib/shell/make-price.ts:104, 108) build that value with no usd. */
  test.fixme("house-make-press-v12 › the house's Make button reads the engine's dollars, hovered Pays at cost — fails on the live panel today: it reads \"—\" (see the note above); money display, owner question: fix the live panel's house figure now, or with v31.16's Make?", () => {});
  test.fixme("enhance-house-v12 › the house's Enhance is one total in dollars, \"up to\", hovered Pays at cost: the take's dollars plus the enhancement's estimateUsd, never credits — to port onto the live panel's Auto enhance (components/graphite/make/EngineList.tsx), whose house figure no spec reads yet; owner question: port now, or with v31.16's Make?", () => {});
  test.fixme("enhance-v12 › Variations of an Enhanced take are sent with the enhanced words and no second enhancement, at the figure shown — no home: the live panel's Recent Again (components/graphite/make/use-make.ts) has no spec for it; owner question: port now, or with v31.16's Make?", () => {});
  test.fixme("enhance-v12 › the workspace's Enhance default (Settings › Advanced) decides where the switch starts — no home: the live panel's Auto enhance starts off whatever the setting says (lib/shell/use-enhancer.ts); owner question: should the live panel read enhanceDefault?", () => {});
  test.fixme("make-v12 › Reuse seed loads a clip with its seed and the next priced press quotes and sends that seed — no home: the live panel has no Reuse seed control; the seed's server rule is the test below", () => {});
  test.fixme("remix-v12 / menus-v12 / home-v12 › Remix's four ops read \"quoted\" with a reason, the wall's Remix item carries its quote, and Start from a picked tile asks Atomik at the figure shown — no home: the live shell has no Remix row, wall or tile menu; owner question: does v31.16 carry them?", () => {});
  test.fixme("skills-v12 › the \"/\" list in the bars prices each built-in skill from the quote layer and runs only dry runs — no home: the live \"/\" list is Atomik's composer (saved skills only, unpriced); saved skills' dry runs are tests/demo-s08-skills-workbench.spec.ts", () => {});
});

test("make-v12 › a seed is a whole number from 0 to 4294967295: the server refuses any other before it quotes, and nothing is spent", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one run, API only");
  test.setTimeout(120_000);
  const engine = MODELS.find((m) => m.kind === "video" && takesSeed(m.id) && !m.retired);
  test.skip(!engine, "no engine that takes a seed is offered");
  const signed = await signInLocally(page.request, "Seed Tester");
  const me = await page.request.get("/api/me").then((r) => r.json()) as { id: string };
  const scope = `particl-active-${signed.workspace.id}-${me.id}`;
  const project: Project = newProject(`Seed ${randomUUID().slice(0, 6)}`);
  const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const read = await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers: { "X-Workbench-Scope": scope } }).then((r) => r.json()) as { project: Project };
  const ratio = engine!.ratios.includes("16:9") ? "16:9" : engine!.ratios.find((r) => r !== "adaptive")!;
  const resolution = engine!.resolutions.includes("1080p") ? "1080p" : engine!.resolutions[engine!.resolutions.length - 1];
  const body = { model: engine!.id, prompt: "A wave breaking on a black beach", projectId: read.project.productionProjectId, ratio, resolution, duration: 5, refine: false };
  const quote = (seed: unknown) => page.request.post("/api/generate/quote", { headers: { "X-Workbench-Scope": scope }, data: seed === undefined ? body : { ...body, seed } });
  /* The request is one the server prices: what refuses below is the seed alone. */
  const plain = await quote(undefined);
  expect(plain.ok(), await plain.text()).toBe(true);
  for (const bad of [-1, 1.5, 4_294_967_296, "abc"]) expect((await quote(bad)).status(), `seed ${bad}`).toBe(400);
  const top = await quote(4_294_967_295);
  expect(top.ok(), await top.text()).toBe(true);
  /* Quotes only: the meter holds nothing for this workspace. */
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try { expect((await platform.execute({ sql: "SELECT COUNT(*) AS n FROM meter_events WHERE workspace_id = ?", args: [signed.workspace.id] })).rows[0].n).toBe(0); } finally { platform.close(); }
});

/* ── Credits on a phone (from credits-reachable-v12) ───────────────────────────────────────────────────────────────── */

test.describe("phones: the credits chip", () => {
  test.beforeEach(({}, info) => test.skip(!PHONES.includes(info.project.name), "phone sizes"));

  test("credits-reachable-v12 › the phone app's credits chip shows the balance", async ({ page }) => {
    await openBilling(page, { path: "/suites", on: false });
    await expect(page.getByTestId("phone-credits")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("phone-credits")).toContainText(/\d/);
    expect(await noSideways(page)).toBe(true);
  });

  test("credits-reachable-v12 › the house's chip reads At cost, with the reason on hover and for a screen reader", async ({ page }) => {
    await openBilling(page, { path: "/suites", house: true, on: false });
    const chip = page.getByTestId("phone-credits");
    await expect(chip).toBeVisible({ timeout: 60_000 });
    await expect(chip).toHaveText("At cost");
    await expect(chip).toHaveAttribute("title", /no credits to top up/);
    await expect(chip).toHaveAttribute("aria-label", "At cost, no top-up");
    expect(await noSideways(page)).toBe(true);
  });
});

test.describe("credits and billing with no live home", () => {
  test.fixme("credits-reachable-v12 / settings-billing-v12 › the avatar menu holds the balance and Top up; a member reads \"Ask an admin for credits\" — covered on the live header and Settings: tests/credit-value-workbench.spec.ts, tests/hf-credits-out-workbench.spec.ts, tests/demo-s09-settings-workbench.spec.ts; the menu's own balance and Top up have no home", () => {});
  test.fixme("credits-reachable-v12 › the house's Credits & billing page in dollars: spent, per board, history and the CSV, no plans, no top-up, no \"cr\" — partly live (Settings › Plan & credits, components/graphite/settings/credits/CreditsSection.tsx; its ledger in dollars) with no browser spec; owner question: port onto Plan & credits now, or with v31.16's Settings?", () => {});
  test.fixme("settings-billing-v12 › the low-credit line shows under 20% of the plan's included credits (the welcome grant on Invite); never for the house — no home: the live shell has no low-credit rule (its pill is \"below the last quote\": tests/hf-credits-out-workbench.spec.ts); owner question: does v31.16 carry the 20% rule?", () => {});
  test.fixme("settings-billing-v12 › Business seats: \"5 seats · $500/month · 5,000 credits\", the next seat and the next level; spend per board with Open on a board — no home in the live Plan & credits; owner question: does v31.16 carry them?", () => {});
  test.fixme("house-cap › the house's monthly cap on its own Credits & billing: \"$40 of $500 used · 8%\", the warning from 80%, the owner's own figure, Reached at the cap, in dollars only; a workspace that is not the house has no cap row — no home on the customer screen: /admin shows the cap (tests/platform-desk.spec.ts), the words are tests/unit/houseCap.spec.ts and GET /api/usage/house-cap answers {houseCap:null} to others (tests/unit/houseCap.spec.ts); owner question: should Plan & credits show the house its cap?", () => {});
});

/* ── A take that failed (from render-v12) ──────────────────────────────────────────────────────────────────────────── */

test.describe("the board's take card", () => {
  test.beforeEach(({}, info) => test.skip(!DESKTOP.includes(info.project.name), "the board's canvas is desktop; phones draw the board's list"));

  test("render-v12 › a failed take never says Nothing billed while the ledger still holds credits for it", async ({ page }) => {
    test.setTimeout(240_000);
    const held: (ShotRow | null)[] = [{ status: "failed", ageS: 300, error: "The engine did not finish this take.", reserved: 7 }, null, null, null, null, null, null, null];
    const { errors } = await openShotsBoard(page, "/suites?view=board", { on: false, rows: held });
    const card = page.locator('.bd-node[data-card-kind="take"]').first();
    await expect(card.getByTestId("take-failed")).toBeVisible({ timeout: 90_000 });
    await expect(card.getByTestId("take-nothing-billed")).toHaveCount(0);
    await expect(card).not.toContainText(/nothing billed/i);
    expect(errors).toEqual([]);
  });

  test.fixme("render-v12 › a take in flight says its held figure once (\"7 cr held · charged only when it's ready\"), and Cancel is offered only where nothing is billed, with each provider answer worded as it is — no home on the live board: its take card has no render overlay or Cancel (the jobs tray holds the figure: tests/hf-jobs-tray-workbench.spec.ts; the cancel route: tests/queued-cancel-workbench.spec.ts); owner question: does v31.16's take card carry them?", () => {});
  test.fixme("rig-v12 / deliver-v12 / social-v12 / campaign-v12 › the Rig's change price, Deliver's \"Adapt all · quoted\", the Voice stage's live narration and music quotes, and Formats' one price or \"quoted\" — no home: the stage pages and the Rig went with the prototype-12 board; owner question: does v31.16 carry them?", () => {});
});

/* ── A teammate's board (from team-boards-v12) ─────────────────────────────────────────────────────────────────────── */

test("team-boards-v12 › a board its author shared opens view-only for a teammate, and the teammate's browser never saves it", async ({ browser, page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop sizes");
  test.setTimeout(300_000);
  const made = await openBoard(page, "/suites?view=board", { on: false });
  const owner = await page.request.get("/api/me").then((r) => r.json()) as { id: string; workspace: { id: string } };
  const ownerScope = `particl-active-${owner.workspace.id}-${owner.id}`;
  const context = await browser.newContext({ baseURL: info.project.use.baseURL, viewport: info.project.use.viewport });
  const mate = await context.newPage();
  try {
    await signInLocally(mate.request, "Teammate Viewer");
    const me = await mate.request.get("/api/me").then((r) => r.json()) as { id: string };
    const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
    try { await db.execute({ sql: "INSERT INTO memberships(workspace_id,account_id,role,disabled,created_at) VALUES(?,?,?,?,?)", args: [owner.workspace.id, me.id, "member", 0, Date.now()] }); } finally { db.close(); }
    expect((await mate.request.post("/api/workspaces/switch", { data: { id: owner.workspace.id } })).ok()).toBe(true);
    const scope = `particl-active-${owner.workspace.id}-${me.id}`;
    /* Private until shared. */
    expect(((await (await mate.request.get(`/api/workbench/projects?id=${made.project.id}`, { headers: { "X-Workbench-Scope": scope } })).json()) as { project: unknown }).project ?? null).toBeNull();
    /* The author shares (the route the share item called; the live shell has no share item: see the fixme below). */
    const shared = await page.request.post("/api/workbench/projects", { headers: { "X-Workbench-Scope": ownerScope, "Content-Type": "application/json" }, data: { projectId: made.project.id, action: "team-share", shared: true } });
    expect(shared.ok(), await shared.text()).toBe(true);
    await mockMedia(mate);
    const saves: string[] = [];
    mate.on("request", (request) => { if (request.method() === "PUT" && new URL(request.url()).pathname === "/api/workbench/projects") saves.push(request.url()); });
    await mate.goto(`/suites?view=board&project=${made.project.id}`);
    await expect(mate.getByTestId("board")).toBeVisible({ timeout: 90_000 });
    await mate.waitForTimeout(2_500);
    expect(saves, "a teammate's board is never saved").toEqual([]);
    const seen = await (await mate.request.get(`/api/workbench/projects?id=${made.project.id}`, { headers: { "X-Workbench-Scope": scope } })).json() as { project: { id: string }; viewOnly?: { owner: { id: string } } };
    expect(seen.viewOnly?.owner.id).toBe(owner.id);
    const refused = await mate.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope, "Content-Type": "application/json" }, data: { project: { ...seen.project, name: "Renamed" }, revision: 0 } });
    expect(refused.status()).toBe(403);
    /* Stop sharing: the teammate reads nothing again. */
    const stopped = await page.request.post("/api/workbench/projects", { headers: { "X-Workbench-Scope": ownerScope, "Content-Type": "application/json" }, data: { projectId: made.project.id, action: "team-share", shared: false } });
    expect(stopped.ok(), await stopped.text()).toBe(true);
    expect(((await (await mate.request.get(`/api/workbench/projects?id=${made.project.id}`, { headers: { "X-Workbench-Scope": scope } })).json()) as { project: unknown }).project ?? null).toBeNull();
  } finally { await context.close(); }
});

test.fixme("team-boards-v12 › the author shares from the board's ⋯ menu or Home's right-click (with Undo), Home lists teammates' boards with their maker, and the opened board says whose it is with every making tool off — no home: the live shell has no share item, no team list and no view-only line, and its tool pill is not turned off on a view-only board (components/graphite/board/BoardView.tsx passes ToolPill readOnly={offline} only); owner question: add them to the live board, or wait for v31.16?", () => {});

/* ── Visitors and joining (from visitor-v12, join-v12, join-return-v12) ──────────────────────────────────────────────── */

test.describe("visitors and joining with no live home", () => {
  test.fixme("visitor-v12 / join-v12 › a visitor's every action opens the join sheet, Log in returns to /?guest=1, the page reads only the invite checks and the access request, and a board link that is not theirs says \"You don't have access\" — no home: \"/?guest=1\" is Guest Home now (tests/demo-s15-guest-home-workbench.spec.ts; the server side: tests/visitor-privacy-workbench.spec.ts); owner question: does v31.16 bring the visitor pages back?", () => {});
  test.fixme("join-v12 › the join sheet's invite-code field: empty says \"Enter your invite code first.\", a bad code \"isn't valid\", a team code goes to /invite/{code} and a new-workspace code to /signup?invite= — no home: invites arrive as links (tests/demo-s15-guest-home-workbench.spec.ts, tests/account-identity.spec.ts)", () => {});
  test.fixme("visitor-v12 › a new-workspace invite shows the plan cards (\"Checkout is not open yet\") and a seat count before sign-up — no home: sign-up has no plan or seat choice", () => {});
  test.fixme("join-return-v12 › after joining, the person lands back on Home or Make with the words they typed, used once — no home: the guest brief becomes the first board instead (tests/demo-s15-guest-home-workbench.spec.ts)", () => {});
  test.fixme("visitor-privacy-workbench › a member of another workspace who opens A's board link is told they have no access — no home: the live shell falls back to the member's own first board (components/graphite/screens.tsx BoardOrNew); the API half stays in tests/visitor-privacy-workbench.spec.ts", () => {});
});
