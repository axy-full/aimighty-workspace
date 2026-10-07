import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { forbidPaidWork, generation, mockLibrary } from "./helpers/workspaceFixtures";
import { smallTargets } from "./phoneFloors";
import { monthLabel } from "../lib/usageLedgerTerms";
import { newProject, type CanvasNode } from "../lib/workbench/studio";

/**
 * Idea 25 — Workspace › Usage lists every job under the bars: when, who,
 * engine, credits and state, paged on the server, with a month filter and a
 * CSV. A workspace on credits reads the meter and never receives a dollar —
 * not in /api/usage, not in the file, not in the Inspector, not on the page.
 * A workspace that pays its vendors reads its takes in dollars. The viewer's
 * connected account is listed apart, in that provider's credits as quoted.
 * A member reads their own name and "Teammate" for everyone else's spend.
 * Real local routes on a mock engine; nothing is rendered or paid for.
 * Screenshots are opt-in: USAGE_LEDGER_SHOTS=<dir>.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const WIDE = ["workbench-1440x900", "workbench-1920x1080"];
const SHOTS = process.env.USAGE_LEDGER_SHOTS;

const SEEDANCE = "dreamina-seedance-2-5-260628";
/* What the vendors charged for the seeded jobs: figures a leak would carry. */
const VENDOR_USD = ["2.8667", "0.7777", "1.3333", "0.3512", "0.0421", "0.039"];
const OLDER = 50;

const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7);
const lastMonthAt = () => { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 12, 9, 0, 0); };

async function shot(page: Page, info: TestInfo, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}-${info.project.name.replace("workbench-", "")}.png` });
}

async function tenantOf(workspaceId: string) {
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try { return String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id = ?", args: [workspaceId] })).rows[0].db_url); }
  finally { platform.close(); }
}

/**
 * The meter as admission leaves it, for one workspace: a job held while it
 * runs, one charged, a reservation released, a failed agent run metered
 * unbilled (PR #398's shape: the vendor's cost kept, nothing billed), a job on
 * the workspace's own key, one charged although it failed, and a page's worth
 * of last month's stills. A neighbour's job lands in the same minute.
 */
async function seedMeter(workspaceId: string, userId: string) {
  const tag = randomUUID().slice(0, 8);
  const ids = { held: `gen_held_${tag}`, charged: `gen_charged_${tag}`, released: `gen_released_${tag}`, agent: `agent_${tag}`, ownKey: `gen_own_${tag}`, failedPaid: `gen_failpaid_${tag}`, neighbour: `gen_neighbour_${tag}` };
  const now = Date.now(), earlier = lastMonthAt();
  const rows: [string, string, string, string, string, string, number, number, number, string, number][] = [
    [ids.held, workspaceId, "video", "fal", "fal-ai/kling-video/v3/standard", "running", 0.7777, 12, 1, userId, now - 1000],
    [ids.charged, workspaceId, "video", "byteplus", SEEDANCE, "succeeded", 2.8667, 43, 1, userId, now - 2000],
    [ids.released, workspaceId, "image", "google", "gemini-3.1-flash-image", "failed", 0, 0, 1, userId, now - 3000],
    [ids.agent, workspaceId, "text", "vercel", "anthropic/claude-sonnet-4.6", "failed", 0.3512, 0, 1, userId, now - 4000],
    [ids.ownKey, workspaceId, "image", "openai", "gpt-image-2.5-flare", "succeeded", 0.0421, 0, 0, userId, now - 5000],
    [ids.failedPaid, workspaceId, "video", "byteplus", SEEDANCE, "failed", 1.3333, 20, 1, userId, now - 6000],
    [ids.neighbour, `ws_neighbour_${tag}`, "video", "byteplus", SEEDANCE, "succeeded", 2.8667, 43, 1, "someone", now - 500],
  ];
  for (let i = 0; i < OLDER; i++) rows.push([`gen_older_${tag}_${String(i).padStart(2, "0")}`, workspaceId, "image", "google", "gemini-3.1-flash-image", "succeeded", 0.039, 1, 1, userId, earlier + i * 60_000]);
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    for (const r of rows)
      await platform.execute({
        sql: `INSERT INTO meter_events(id,workspace_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [...r, r[10]],
      });
  } finally { platform.close(); }
  return { ids, month: monthOf(now), lastMonth: monthOf(earlier) };
}

/** Two of the viewer's own connected-account jobs, and a teammate's that is not theirs to see. */
async function seedConnected(page: Page, workspaceId: string, userId: string) {
  expect((await page.request.get("/api/usage?rows=connected")).ok()).toBe(true); // its table exists once read
  const tenant = createClient({ url: await tenantOf(workspaceId), timeout: 10_000 });
  const tag = randomUUID().slice(0, 8), now = Date.now();
  try {
    for (const [id, user, workflow, status, credits, age] of [["done", userId, "generation", "completed", 75, 1500], ["open", userId, "genjutsu", "accepted", 40.5, 2500], ["mate", "someone-else", "generation", "completed", 500, 500]] as const)
      await tenant.execute({
        sql: `INSERT INTO higgsfield_consumer_jobs(id,user_id,draft_id,connected_owner_id,connection_generation,workflow,idempotency_key,payload_json,payload_hash,immutable_hash,quote_credits,quote_expires_at,original_asset_ids,status,dispatch_claim_hash,created_at,updated_at)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [`hfc_${id}_${tag}`, user, "draft-gone", "owner", "gen", workflow, `k_${id}_${tag}`, "{}", "h", "h", credits, now + 60_000, "[]", status, "claim", now - age, now - age],
      });
  } finally { tenant.close(); }
}

/** Every body /api/usage sends this page, in whatever variant it asked for. */
function usageBodies(page: Page) {
  const reads: Promise<string>[] = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/api/usage") reads.push(response.text().catch(() => ""));
  });
  return () => Promise.all(reads);
}

/**
 * The phone floors for the ledger: nothing sideways, no text under 12px or
 * dimmer than #7C7C84 once composited onto its real ground, no serif, every
 * target 44×44 — and at the pane's end the last row sits above the tab bar.
 */
async function ledgerFloors(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no horizontal overflow").toBe(true);
  expect(await page.getByTestId("ws-ledger").evaluate((el) => el.scrollWidth <= el.clientWidth + 0.5), "the ledger fits its card").toBe(true);
  const problems = await page.evaluate(() => {
    const out: string[] = [];
    const rgba = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
    const ground = (el: Element | null): number[] => {
      const stack: number[][] = [];
      for (let node = el; node; node = node.parentElement) {
        const [r, g, b, a = 1] = rgba(getComputedStyle(node).backgroundColor);
        if (a > 0) stack.push([r, g, b, a]);
        if (a >= 1) break;
      }
      let base = [0, 0, 0];
      for (const [r, g, b, a] of stack.reverse()) base = [r * a + base[0] * (1 - a), g * a + base[1] * (1 - a), b * a + base[2] * (1 - a)];
      return base;
    };
    const lum = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const floor = lum([0x7c, 0x7c, 0x84]) - 0.5;
    const root = document.querySelector('[data-testid="ws-ledger"]')!;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.textContent ?? "").trim();
      const el = node.parentElement;
      if (!text || !el || !el.getClientRects().length || el.closest("option")) continue;
      const style = getComputedStyle(el);
      if (Number.parseFloat(style.fontSize) < 12) out.push(`${style.fontSize}: “${text.slice(0, 30)}”`);
      const [r, g, b, a = 1] = rgba(style.color);
      const under = ground(el);
      const seen = [r * a + under[0] * (1 - a), g * a + under[1] * (1 - a), b * a + under[2] * (1 - a)];
      if (lum(seen) < floor) out.push(`dim ${style.color}: “${text.slice(0, 30)}”`);
      const family = style.fontFamily.split(",")[0].trim().replace(/["']/g, "").toLowerCase();
      if (/^(serif|times|georgia|garamond|palatino|cambria)/.test(family)) out.push(`serif ${family}: “${text.slice(0, 30)}”`);
    }
    return out;
  });
  expect(problems, "ledger text floors").toEqual([]);
  expect(await smallTargets(page, '[data-testid="ws-ledger"]'), "ledger targets under 44×44").toEqual([]);
}

/** At the end of the pane that scrolls Settings (a phone's is the phone shell's own scroller, a desktop's the Settings view), where the last row of the ledger ends, and where the phone's tab bar begins. */
async function endOfPane(page: Page) {
  return page.getByTestId("ws-ledger").evaluate(async (ledger) => {
    let pane: HTMLElement | null = ledger.parentElement;
    while (pane && !(/(auto|scroll)/.test(getComputedStyle(pane).overflowY) && pane.scrollHeight > pane.clientHeight + 1)) pane = pane.parentElement;
    if (!pane) pane = document.querySelector<HTMLElement>('[data-testid="settings-view"]')!;
    pane.scrollTop = pane.scrollHeight;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rows = Array.from(ledger.querySelectorAll<HTMLElement>("li, button")).filter((el) => el.getClientRects().length);
    const last = rows[rows.length - 1];
    const bar = document.querySelector<HTMLElement>('[data-testid="mobile-dock"]');
    const fixed = Boolean(bar && bar.getClientRects().length && ["fixed", "sticky"].includes(getComputedStyle(bar).position));
    const inFlow = Boolean(bar && bar.getClientRects().length);
    return {
      last: last.textContent ?? "", bottom: last.getBoundingClientRect().bottom,
      barTop: fixed || inFlow ? bar!.getBoundingClientRect().top : null, paneBottom: Math.min(innerHeight, pane.getBoundingClientRect().bottom),
      scrolled: pane.scrollTop > 0,
    };
  });
}

test("a credit workspace's ledger: every job in credits — held, charged, not billed — a month filter, a CSV, and no dollar anywhere", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { workspace } = await signInLocally(page.request);
  await forbidPaidWork(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const me = (await (await page.request.get("/api/me")).json()) as { id: string };
  const seed = await seedMeter(workspace.id, me.id);
  await seedConnected(page, workspace.id, me.id);
  const bodies = usageBodies(page);

  await page.goto("/suites?view=workspace&tab=usage");
  const ledger = page.getByTestId("ws-ledger");
  const rows = ledger.getByTestId("ws-ledger-row");
  /* One page from the server, newest first; the neighbour's job is not here. */
  await expect(rows).toHaveCount(50, { timeout: 60_000 });
  await expect(page.getByTestId("ws-ledger-summary")).toHaveText(`All months · ${43 + 20 + OLDER} cr charged · 12 cr held while running · 3 not billed`);
  const row = (state: string) => ledger.locator(`[data-testid="ws-ledger-row"][data-state="${state}"]`);
  await expect(rows.first()).toHaveAttribute("data-state", "held");
  await expect(row("held")).toContainText("Kling 3.0");
  await expect(row("held")).toContainText("12 cr");
  await expect(row("held")).toContainText("Held");
  await expect(row("held")).toContainText("Workbench Tester");
  await expect(row("charged").first()).toContainText("Seedance 2.5");
  await expect(row("charged").first()).toContainText("43 cr");
  await expect(row("failed-not-billed")).toHaveCount(2);
  await expect(row("failed-not-billed").first()).toContainText("Failed · not billed");
  await expect(row("failed-not-billed").nth(1)).toContainText(/^Atomik · /);
  await expect(row("own-key")).toContainText("Own key · not billed");
  await expect(row("failed-charged")).toContainText("Failed · charged");
  await expect(row("failed-charged")).toContainText("20 cr");

  /* The next page on request: every job once. */
  await page.getByTestId("ws-ledger-more").click();
  await expect(rows).toHaveCount(6 + OLDER);
  await expect(page.getByTestId("ws-ledger-more")).toHaveCount(0);

  /* The viewer's own connected-account jobs, apart, in that provider's credits as quoted. */
  const connected = page.getByTestId("ws-ledger-connected");
  await expect(connected.getByTestId("ws-ledger-connected-row")).toHaveCount(2);
  await expect(connected).toContainText("2 jobs · 115.5 connected cr quoted");
  await expect(connected.getByTestId("ws-ledger-connected-row").first()).toContainText("75 connected cr");
  await expect(connected.getByTestId("ws-ledger-connected-row").first()).toContainText("Completed");
  await expect(connected).not.toContainText("500");

  if (PHONES.includes(info.project.name)) {
    await ledgerFloors(page);
    const end = await endOfPane(page);
    expect(end.scrolled, "Settings scrolls").toBe(true);
    if (info.project.name !== "workbench-844x390") expect(end.barTop, "the phone's tab bar is pinned").not.toBeNull();
    expect(end.bottom, `the last row (“${end.last.slice(0, 40)}”) ends above the tab bar`).toBeLessThanOrEqual((end.barTop ?? end.paneBottom) + 0.5);
    await shot(page, info, "ledger-end");
  }

  /* A month: its rows and its totals alone. */
  const month = page.getByTestId("ws-ledger-month");
  await expect(month.locator("option")).toHaveText(["All months", monthLabel(seed.month), monthLabel(seed.lastMonth)]);
  await month.selectOption(seed.lastMonth);
  await expect(rows).toHaveCount(OLDER);
  await expect(page.getByTestId("ws-ledger-summary")).toHaveText(`${monthLabel(seed.lastMonth)} · ${OLDER} cr charged`);
  await expect(page.getByTestId("ws-ledger-more")).toHaveCount(0);
  await expect(connected).toHaveCount(0);
  await month.selectOption(seed.month);
  await expect(rows).toHaveCount(6);
  await expect(page.getByTestId("ws-ledger-summary")).toHaveText(`${monthLabel(seed.month)} · 63 cr charged · 12 cr held while running · 3 not billed`);
  await shot(page, info, "ledger-month");

  /* The file follows the filter, in credits. */
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("ws-ledger-export").click()]);
  expect(download.suggestedFilename()).toBe(`usage-${workspace.slug}-${seed.month}.csv`);
  const csv = readFileSync((await download.path())!, "utf8");
  const lines = csv.split("\r\n").filter(Boolean);
  expect(lines[0]).toBe("date,time_utc,who,engine,kind,status,credits,failure");
  expect(lines).toHaveLength(1 + 6);
  expect(csv).toContain("Held");
  expect(csv).toContain("Failed · not billed");
  if (WIDE.includes(info.project.name)) {
    const [file] = await Promise.all([page.waitForEvent("download"), connected.getByTestId("ws-ledger-connected-export").click()]);
    const quoted = readFileSync((await file.path())!, "utf8");
    expect(quoted.split("\r\n")[0]).toBe("date,time_utc,workflow,project,status,connected_credits_quoted,failure,provider_charge");
    expect(quoted).not.toContain("500");
    expect(quoted).not.toMatch(/\$|usd/i);
  }

  /* Never a dollar: not on the page, not in any answer /api/usage gave it, not in the file, not for one job. */
  const one = await (await page.request.get(`/api/usage?rows=1&id=${seed.ids.charged}`)).json();
  expect(one.rows).toEqual([expect.objectContaining({ id: seed.ids.charged, credits: 43, state: "charged" })]);
  expect((await (await page.request.get(`/api/usage?rows=1&id=${seed.ids.neighbour}`)).json()).rows).toEqual([]);
  const wire = [...(await bodies()), csv, JSON.stringify(one), await (await page.request.get("/api/usage")).text()];
  expect(wire.length).toBeGreaterThanOrEqual(6);
  for (const body of wire) {
    expect(body).not.toContain("$");
    expect(body).not.toMatch(/usd/i);
    for (const figure of VENDOR_USD) expect(body).not.toContain(figure);
  }
  /* On the page: the ledger and the Usage rows hold no dollar. (Plan & credits' own balance row, Top up and the rate line carry a
     credit's dollars at the served rate, which are the workspace's and are not a vendor's amount.) */
  expect(await ledger.innerText()).not.toContain("$");
  for (const usage of await page.getByTestId("settings-usage-row").all()) expect(await usage.innerText()).not.toContain("$");
  expect(await page.evaluate(() => document.body.innerText)).not.toMatch(/\$\s?(2\.87|0\.78|1\.33|0\.35|0\.04)/);
  expect(errors).toEqual([]);
});

/*
 * Release 1: the Library and the Gen page's Inspector (AssetInspector's "Settled" fact, read from /api/usage?id= with its own
 * "Could not be read / Try again") are gone from every address; a take's Inspector is the board's (components/graphite/board/inspector/
 * TakeBody.tsx), which says what the take was charged from the take's own billed credits ("N cr paid"), and says nothing while it is
 * held or running. What stays asserted: the figure is the billed credits, never the take's vendor dollars and never a figure
 * re-derived from them, and no dollar is printed. The ledger's own rows, its refusal and its connected-account jobs stay in the tests
 * above (the connected-account row is retired with the sign-in).
 */
const node = (id: string, title: string): CanvasNode => ({ id, title, type: "scene", x: 0, y: 0, width: 344, linked: [] });

test("the board Inspector's paid figure is the take's billed credits — never a take's dollars, never a figure re-derived from them", async ({ page }, info) => {
  test.skip(!WIDE.includes(info.project.name), "a phone draws no board canvas; the ledger rows above are its credits");
  const { workspace } = await signInLocally(page.request);
  await forbidPaidWork(page);
  const me = (await (await page.request.get("/api/me")).json()) as { id: string };
  const scope = `particl-active-${workspace.id}-${me.id}`;
  const { ids } = await seedMeter(workspace.id, me.id);
  const project = { ...newProject("Harbour ledger"), nodes: [node("node-shot0001", "Harbour at dusk"), node("node-shot0002", "Gulls at dawn")] };
  const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const shotIds: string[] = [];
  for (const n of project.nodes) {
    const mapped = await page.request.post("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { projectId: project.id, action: "map-shot", nodeId: n.id } });
    expect(mapped.ok(), await mapped.text()).toBe(true);
    shotIds.push(((await mapped.json()) as { shotId: string }).shotId);
  }
  await page.addInitScript(({ scope, id }) => { try { localStorage.setItem(scope, id); } catch { /* storage off */ } }, { scope, id: project.id });
  /* Decoys a leak would print: the take's vendor dollars, and credits re-derived from them (99 and 77 are not what the ledger billed). */
  const take = (id: string, shotId: string, over: Record<string, unknown>) => generation({ id, shotId, version: 1, kind: "video", model: SEEDANCE, ...over });
  await mockLibrary(page, {
    uploads: [],
    generations: [
      take(ids.charged, shotIds[0], { title: "Harbour at dusk", prompt: "Harbour at dusk", costUsd: 2.8667, creditsBilled: 43 }),
      take(ids.held, shotIds[1], { title: "Gulls at dawn", prompt: "Gulls at dawn", status: "running", storedUrl: null, costUsd: 0.7777, creditsBilled: 77 }),
    ],
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/suites?project=${project.id}&view=board`);
  const insp = page.getByTestId("board-inspector");
  await page.locator('[data-card-id="node-shot0001"]').getByTestId("take-card").click();
  await expect(insp).toBeVisible({ timeout: 60_000 });
  await expect(insp.getByTestId("insp-engine")).toContainText("43 cr paid");
  await expect(insp).not.toContainText("$");
  await expect(insp).not.toContainText("99 cr");
  await expect(insp).not.toContainText("2.87");
  /* A take that is still running has been charged nothing: no "paid", no figure. */
  await page.locator('[data-card-id="node-shot0002"]').getByTestId("take-card").click();
  await expect(insp).toContainText("Gulls at dawn");
  await expect(insp.getByTestId("insp-paid")).toHaveCount(0);
  await expect(insp).not.toContainText("$");
  await expect(insp).not.toContainText("77 cr");
  await shot(page, info, "inspector");
  expect(errors).toEqual([]);
});

test("migrated workspaces retain historical external receipts without displaying vendor amounts", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "a phone and a desktop");
  const { workspace } = await signInLocally(page.request);
  await forbidPaidWork(page);
  const me = (await (await page.request.get("/api/me")).json()) as { id: string };
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try { await platform.execute({ sql: "UPDATE workspaces SET uses_platform_keys = 0 WHERE id = ?", args: [workspace.id] }); }
  finally { platform.close(); }
  const tenant = createClient({ url: await tenantOf(workspace.id), timeout: 10_000 });
  const now = Date.now();
  try {
    const gen = "INSERT INTO generations(id,model,prompt,params,status,kind,provider,cost_usd,refine_cost_usd,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)";
    await tenant.execute({ sql: gen, args: ["gen_usd_charged", SEEDANCE, "a harbour", "{}", "succeeded", "video", "byteplus", 1.25, 0.05, me.id, now - 1000, now - 1000] });
    await tenant.execute({ sql: gen, args: ["gen_usd_failed", "gemini-3.1-flash-image", "a gull", "{}", "failed", "image", "google", null, null, me.id, now - 2000, now - 2000] });
    await tenant.execute({ sql: gen, args: [`gen_hfc_${"c".repeat(40)}`, SEEDANCE, "a pier", JSON.stringify({ consumerCreditUnit: "higgsfield_credits", consumerCredits: 75 }), "succeeded", "video", "higgsfield", null, null, me.id, now - 3000, now - 3000] });
  } finally { tenant.close(); }
  const receipts = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    for (const [id, status, at] of [["gen_usd_charged", "succeeded", now - 1000], ["gen_usd_failed", "failed", now - 2000]] as const)
      await receipts.execute({ sql: "INSERT INTO meter_events(id,workspace_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_at,updated_at) VALUES(?,?,'video','byteplus',?,?,0,0,0,?,?)", args: [id + workspace.id, workspace.id, SEEDANCE, status, at, at] });
  } finally { receipts.close(); }
  await page.goto("/suites?view=workspace&tab=usage");
  const rows = page.getByTestId("ws-ledger-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("Own key · not billed");
  await expect(rows.nth(1)).toContainText("Failed · not billed");
  await expect(page.getByTestId("ws-ledger-summary")).toContainText("0 cr charged");
  await expect(page.getByTestId("ws-ledger-summary")).toContainText("2 not billed");
  await expect(page.getByTestId("ws-ledger")).not.toContainText("$");
  await expect(page.getByTestId("settings-view")).not.toContainText(/\$\s?1\.(25|3)/);
  const body = await (await page.request.get("/api/usage?rows=1")).json();
  expect(body.unit).toBe("credits");
  expect(JSON.stringify(body)).not.toMatch(/costUsd|engine_cost_usd|spendUsd/);
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("ws-ledger-export").click()]);
  expect(readFileSync((await download.path())!, "utf8").split("\r\n")[0]).toBe("date,time_utc,who,engine,kind,status,credits,failure");
  await shot(page, info, "historical-credits");
});

test("the ledger says it is reading, says when there is nothing yet, and a refused read offers Try again", async ({ page }, info) => {
  test.skip(!["workbench-360x640", "workbench-1440x900"].includes(info.project.name), "the smallest phone and a desktop");
  const { workspace } = await signInLocally(page.request);
  await forbidPaidWork(page);
  await page.goto("/suites?view=workspace&tab=usage");
  await expect(page.getByTestId("ws-ledger-empty")).toHaveText("No jobs yet.");
  await expect(page.getByTestId("ws-ledger-export")).toBeDisabled();
  await expect(page.getByTestId("ws-ledger-month").locator("option")).toHaveText(["All months"]);

  const me = (await (await page.request.get("/api/me")).json()) as { id: string };
  await seedMeter(workspace.id, me.id);
  let refuse = true;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(/\/api\/usage\?rows=1$/, async (route) => {
    if (refuse) { refuse = false; return route.fulfill({ status: 503, json: { error: "The ledger could not be read. Try again in a minute." } }); }
    await held;
    return route.fallback();
  });
  await page.reload();
  const failure = page.getByTestId("ws-ledger-error");
  await expect(failure).toContainText("The ledger could not be read. Try again in a minute.");
  await failure.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("ws-ledger").getByRole("status")).toHaveText("Reading the ledger…");
  release();
  await expect(page.getByTestId("ws-ledger-row")).toHaveCount(50);
  await expect(failure).toHaveCount(0);
  await expect(page.getByTestId("ws-ledger").getByRole("status")).toHaveCount(0);
  if (PHONES.includes(info.project.name)) await ledgerFloors(page);
  await shot(page, info, "ledger-states");
});

test("a member reads their own name and “Teammate” for everyone else's spend: on Usage, Plans & credits and the Dashboard, and in every /api/usage answer", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  /* The owner makes the workspace; a second account joins it as a member. */
  const { workspace } = await signInLocally(page.request, "Ledger Owner");
  const owner = (await (await page.request.get("/api/me")).json()) as { id: string; email: string };
  await signInLocally(page.request, "Ledger Member");
  const member = (await (await page.request.get("/api/me")).json()) as { id: string; email: string };
  const code = randomBytes(18).toString("base64url");
  const tag = randomUUID().slice(0, 8), now = Date.now();
  /* A third teammate, on the roster only. */
  const editor = { id: `u_editor_${tag}`, name: "Ledger Editor", email: `ledger-editor-${tag}@example.test` };
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await platform.execute({
      sql: "INSERT INTO workspace_invites(code,workspace_id,email,name,role,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)",
      args: [code, workspace.id, member.email, "Ledger Member", "member", owner.id, now, now + 3_600_000],
    });
    /* The meter: a job each by the owner, the editor and the member. */
    for (const [key, by, usd, credits, age] of [["owner", owner.id, 2.8667, 43, 3000], ["editor", editor.id, 1.3333, 20, 2000], ["member", member.id, 0.4444, 7, 1000]] as const)
      await platform.execute({
        sql: `INSERT INTO meter_events(id,workspace_id,kind,engine,model,status,engine_cost_usd,billed_credits,paid_by_platform,created_by,created_at,updated_at) VALUES(?,?,'video','byteplus',?,'succeeded',?,?,1,?,?,?)`,
        args: [`gen_${key}_${tag}`, workspace.id, SEEDANCE, usd, credits, by, now - age, now - age],
      });
  } finally { platform.close(); }
  const accepted = await page.request.post("/api/auth/accept", { data: { code } });
  expect(accepted.ok(), await accepted.text()).toBe(true);
  expect(await (await page.request.get("/api/me")).json()).toMatchObject({ id: member.id, role: "member", workspace: { id: workspace.id } });
  const tenant = createClient({ url: await tenantOf(workspace.id), timeout: 10_000 });
  try { await tenant.execute({ sql: "INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,'x','admin',?)", args: [editor.id, editor.email, editor.name, now] }); }
  finally { tenant.close(); }

  await forbidPaidWork(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const bodies = usageBodies(page);
  const teammates = ["Ledger Owner", owner.email, editor.name, editor.email];
  const noTeammate = async (where: string) => {
    const text = await page.evaluate(() => document.body.innerText);
    for (const other of teammates) expect(text, `${where} shows ${other}`).not.toContain(other);
  };

  /* Usage: the member's own job by name, a teammate's as "Teammate". */
  await page.goto("/suites?view=workspace&tab=usage");
  const rows = page.getByTestId("ws-ledger-row");
  await expect(rows).toHaveCount(3, { timeout: 60_000 });
  await expect(rows.filter({ hasText: "Ledger Member" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "Teammate" })).toHaveCount(2);
  await expect(page.getByTestId("settings-usage-row")).toHaveCount(1);
  await noTeammate("Usage");
  await shot(page, info, "member-usage");

  await page.getByTestId("settings-section-credits").click();
  await expect(page.getByTestId("settings-plan")).toBeVisible();
  await noTeammate("Plans & credits");

  /* The Dashboard became Activity (the control room): its credit ledger by person is not drawn there, so what is kept is the rule that matters:
     the page names no teammate. A phone has no Activity screen: its own page that says so is read instead. */
  await page.goto("/suites?suite=atomik&page=runs");
  await expect(page.getByTestId(PHONES.includes(info.project.name) ? "phone-app" : "control-room")).toBeVisible({ timeout: 60_000 });
  await noTeammate("Activity");
  await shot(page, info, "member-activity");

  /* No answer /api/usage gave the page carries a teammate's name or address, or a dollar; nor does a fresh one. */
  const wire = [...(await bodies()), await (await page.request.get("/api/usage")).text()];
  expect(wire.filter((body) => body.includes('"byPerson"')).length, "the ledger's bars and a fresh read").toBeGreaterThanOrEqual(2);
  for (const body of wire) {
    for (const other of teammates) expect(body, `an /api/usage answer names ${other}`).not.toContain(other);
    expect(body).not.toMatch(/usd/i);
  }
  expect(errors).toEqual([]);
});
