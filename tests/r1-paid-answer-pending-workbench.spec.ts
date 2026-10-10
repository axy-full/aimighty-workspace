import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { forbidPaidWork } from "./helpers/workspaceFixtures";
import { isCompact } from "./helpers/shellMode";
import { newProject } from "../lib/workbench/studio";

/**
 * A long Atomik turn (high effort, a slow model) is answered "still being accepted" after 25 s and finishes on the
 * server (lib/generationRequests.ts answerAfterMs); the browser asks again with the same saved request, under the same
 * Idempotency-Key, until the saved reply is there (lib/pendingReplay.ts). No request is silent for more than ~25 s, the
 * person sees the turn answered without pressing anything, and the turn is reserved and charged once.
 *
 * The mocked planner is made slow by the test-only delay (lib/mock.ts mockDelayMs): the server needs ENGINE_MOCK=1
 * and PARTICL_TEST_MOCK_DELAYS=1 (verify.yml sets both for the browser suite). Nothing renders: forbidPaidWork.
 */

const SLOW_MS = 40_000;
const ASK = `plan a short film about the market at dawn [[mock-delay:${SLOW_MS}]]`;

type Turn = { key: string | null; status: number; final: boolean; pending: boolean; ms: number };

async function setUp(page: Page) {
  const signed = await signInLocally(page.request, "Pending Tester");
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  let tenantUrl: string;
  try {
    await platform.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), signed.workspace.id, 2000, "Pending turn fixture", "manual", "test", Date.now()] });
    tenantUrl = String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id=?", args: [signed.workspace.id] })).rows[0].db_url);
  } finally { platform.close(); }
  const scope = `particl-active-${signed.workspace.id}-${me.id}`;
  const project = { ...newProject(`Pending ${randomUUID().slice(0, 6)}`), brief: "A short film about a morning market opening." };
  const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.addInitScript(({ scope, id }) => { try { localStorage.setItem(scope, id); } catch { /* storage off */ } }, { scope, id: project.id });
  await forbidPaidWork(page);
  /* Every paid turn request the page sends, with what it was answered and how long the answer took. */
  const turns: Turn[] = [];
  page.on("requestfinished", async (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== "POST" || !/^\/api\/atomik\/[^/]+$/.test(path) || ["memory", "skills", "threads", "ideas", "treatment"].includes(path.split("/")[3])) return;
    if ((request.postDataJSON() as { quoteOnly?: boolean } | null)?.quoteOnly === true) return;
    const response = await request.response();
    if (!response) return;
    const body = await response.json().catch(() => ({})) as { pending?: boolean };
    const timing = request.timing();
    turns.push({ key: request.headers()["idempotency-key"] ?? null, status: response.status(), final: response.headers()["idempotency-status"] === "complete", pending: body.pending === true, ms: timing.responseEnd });
  });
  return { workspaceId: signed.workspace.id, tenantUrl, turns, projectId: project.id };
}

/** The workspace's text charges on the meter, and the claims its tenant database holds. */
async function books(workspaceId: string, tenantUrl: string) {
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  const tenant = createClient({ url: tenantUrl, timeout: 10_000 });
  try {
    const charges = (await platform.execute({ sql: "SELECT status,billed_credits FROM meter_events WHERE workspace_id=? AND kind='text'", args: [workspaceId] })).rows.map((r) => ({ status: String(r.status), credits: Number(r.billed_credits) }));
    const claims = (await tenant.execute("SELECT request_key,response_status FROM generation_requests")).rows.map((r) => ({ key: String(r.request_key), status: r.response_status == null ? null : Number(r.response_status) }));
    return { charges, claims };
  } finally { platform.close(); tenant.close(); }
}

async function answeredOnce(page: Page, turns: Turn[], books: () => Promise<{ charges: { status: string; credits: number }[]; claims: { key: string; status: number | null }[] }>) {
  /* The first answer is the early one: pending, not final, and well inside 100 s. */
  await expect.poll(() => turns.length, { timeout: 45_000 }).toBeGreaterThan(0);
  expect(turns[0]).toMatchObject({ status: 409, pending: true, final: false });
  /* Asked again, the same saved request, until its saved reply comes back. */
  await expect.poll(() => turns.at(-1)?.final ?? false, { timeout: 120_000 }).toBe(true);
  expect(turns.length).toBeGreaterThan(1);
  expect(turns.at(-1)).toMatchObject({ status: 200, final: true });
  expect(new Set(turns.map((t) => t.key)).size).toBe(1);
  expect(turns[0].key).toBeTruthy();
  for (const turn of turns) expect(turn.ms, "no answer is silent for long").toBeLessThan(35_000);
  /* One claim, one turn charged once. */
  const after = await books();
  expect(after.claims.filter((c) => c.key === turns[0].key)).toEqual([{ key: turns[0].key, status: 200 }]);
  expect(after.charges).toHaveLength(1);
  expect(after.charges[0].status).toBe("succeeded");
  expect(after.charges[0].credits).toBeGreaterThan(0);
  await expect(page.getByText("Recover the saved request")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), "no horizontal overflow").toBeLessThanOrEqual(1);
}

test.beforeEach(() => {
  test.skip(process.env.PARTICL_TEST_MOCK_DELAYS !== "1", "needs a server started with ENGINE_MOCK=1 and PARTICL_TEST_MOCK_DELAYS=1 (verify.yml sets both)");
});

test("the panel: a long planning turn goes pending, is asked again with the same request, and is answered and charged once", async ({ page }, info) => {
  test.skip(isCompact(info), "at compact widths the shell mounts the phone app, whose Atomik is the sheet: the next test");
  test.setTimeout(300_000);
  const { workspaceId, tenantUrl, turns, projectId } = await setUp(page);
  await page.goto(`/suites?project=${projectId}&atomik=1`);
  const panel = page.getByTestId("atomik-panel-global");
  const send = panel.getByTestId("atomik-send");
  await expect(async () => {
    await panel.getByTestId("atomik-input").fill(ASK);
    await expect(send).toHaveText(/^Ask · up to \d+ cr$/, { timeout: 20_000 });
  }).toPass({ timeout: 90_000 });
  await send.click();
  await expect(panel.getByTestId("atomik-thread-line").first()).toContainText("plan a short film about the market at dawn", { timeout: 30_000 });
  await answeredOnce(page, turns, () => books(workspaceId, tenantUrl));
  await expect(panel.getByTestId("atomik-thread-line").nth(1)).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: info.outputPath("panel-answered.png") });
});

test("the phone sheet: a long planning turn goes pending, is asked again with the same request, and is answered and charged once", async ({ page }, info) => {
  test.skip(!isCompact(info), "phone widths; the desktop panel's own is the test above");
  test.setTimeout(300_000);
  const { workspaceId, tenantUrl, turns } = await setUp(page);
  /* A cold dev server reloads once while it first compiles the quote routes (Fast Refresh, which empties the box): warm them first. */
  await page.goto("/suites?screen=home");
  await page.getByTestId("phone-tab-atomik").click();
  await page.getByTestId("phone-atomik-input").fill("warm the quote");
  await expect(page.getByTestId("phone-atomik-send")).toHaveText(/^Ask · up to \d+ cr$/, { timeout: 60_000 }).catch(() => undefined);
  await page.goto("/suites?screen=home");
  await page.getByTestId("phone-tab-atomik").click();
  const send = page.getByTestId("phone-atomik-send");
  /* The sheet settles its address once it opens, which can empty the box: typed again until the request is priced. */
  await expect(async () => {
    await page.getByTestId("phone-atomik-input").fill(ASK);
    await expect(send).toHaveText(/^Ask · up to \d+ cr$/, { timeout: 20_000 });
  }).toPass({ timeout: 90_000 });
  await send.click();
  const thread = page.getByTestId("phone-atomik-thread-line");
  await expect(thread.first()).toContainText("plan a short film about the market at dawn", { timeout: 30_000 });
  await answeredOnce(page, turns, () => books(workspaceId, tenantUrl));
  await expect(thread.nth(1)).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: info.outputPath("sheet-answered.png") });
});
