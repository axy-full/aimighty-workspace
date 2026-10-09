import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { test, expect, type Page, type Route } from "@playwright/test";
import { createClient } from "@libsql/client";
import { localPlatformDbUrl } from "./helpers/workbenchLocal";
import { signInWithNewInterface } from "./helpers/newInterface";
import { forbidPaidWork } from "./helpers/workspaceFixtures";
import { smallTargets, smallText } from "./phoneFloors";
import { newProject, type Project } from "../lib/workbench/studio";
import type { QueueItem } from "../lib/control-room/queue";

const S02_SHOTS = process.env.S02_SHOTS || join(tmpdir(), "claude-s02-shots");
mkdirSync(S02_SHOTS, { recursive: true });

/**
 * Home's money (design/particl-graphite/README.md § 1.1, § 4, § 5): Start · up to N cr with Atomik's
 * thinking line, and Waiting for you on the shared approvals queue (stream 8's lib/control-room). Every
 * figure is the server's; each press goes through the item's own existing route, and every paid route
 * is answered here, so nothing is spent. `S02_HOME_URL` points at the local harness until the shell
 * mounts Home.
 */
const HOME = process.env.S02_HOME_URL || "/suites?view=home";
const DESKTOP = "workbench-1440x900";
const PHONE = "workbench-390x844";
const COARSE = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];

async function account(page: Page) {
  const signed = await signInWithNewInterface(page.request);
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try { await db.execute({ sql: "UPDATE workspaces SET plan_id='studio' WHERE id=?", args: [signed.workspace.id] }); } finally { db.close(); }
  const me = await page.request.get("/api/me").then((r) => r.json());
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  return { scope, headers: { "X-Workbench-Scope": scope } };
}

async function saveProject(page: Page, headers: Record<string, string>, name: string): Promise<Project> {
  const project = newProject(name);
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  return project;
}

async function quietTray(page: Page) {
  await page.route((url) => url.pathname === "/api/jobs" && url.searchParams.get("view") === "tray", (route) => route.fulfill({ json: { jobs: [], pollAfterSeconds: 60 } }));
}

/** The shared queue's read, answered with `items` (each a QueueItem, as GET /api/control-room/approvals sends them). */
async function queue(page: Page, items: () => QueueItem[]) {
  await page.route((url) => url.pathname === "/api/control-room/approvals", (route) => route.fulfill({ json: { items: items(), decided: [], inCredits: true } }));
}

const item = (over: Partial<QueueItem> & Pick<QueueItem, "id" | "title">): QueueItem => ({
  source: "held", where: "Make", at: Date.now() - 5 * 60_000,
  project: { productionId: "prod-x", draftId: null, name: "Harbour test" },
  price: { kind: "exact", credits: 3 }, needsAdmin: false, canApprove: true, why: null, shortBy: null, note: null, step: null, sample: false,
  approve: { kind: "release", genId: "gen_held_1", credits: 3 }, decline: { kind: "discard", genId: "gen_held_1" },
  open: { kind: "take", genId: "gen_held_1", draftId: null },
  ...over,
});

async function openHome(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(HOME);
  await expect(page.getByTestId("home")).toBeVisible({ timeout: 60_000 });
  return errors;
}

/** The server's figure for a new board (GET …team-canvas?agent=1&board=new): read, never spent. */
async function newBoardFigure(page: Page, headers: Record<string, string>): Promise<number> {
  const reply = await page.request.get("/api/workbench/team-canvas?agent=1&board=new", { headers }).then((r) => r.json());
  expect(reply.agent).toMatchObject({ enabled: true, run: null });
  expect(reply.agent.ask.planning).toBeGreaterThan(0);
  return reply.agent.ask.planning as number;
}

test("Start shows Atomik's thinking at the server's figure, the dollars on hover, and the box keeps its place in the layout", async ({ page }, info) => {
  const { headers } = await account(page);
  await forbidPaidWork(page);
  await quietTray(page);
  await queue(page, () => []);
  const figure = await newBoardFigure(page, headers);
  const errors = await openHome(page);

  await expect(page.getByTestId("home-thinking")).toHaveText(`Atomik’s thinking may cost up to ${figure} cr`);
  const start = page.getByTestId("home-start");
  await expect(start).toHaveText(`Start · up to ${figure} cr`);
  await expect(start).toHaveAttribute("title", /^up to \$\d+\.\d\d$/);
  await expect(start).toBeEnabled();
  await expect(page.getByTestId("home-waiting")).toHaveCount(0);
  expect(await smallText(page, ".gx-header, .gx-toast"), "text under 12px").toEqual([]);
  if (COARSE.includes(info.project.name)) expect(await smallTargets(page, ".gx-hm"), "targets under 44×44").toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
});

test("the figure is read without a session token: an API token is refused, and reading it spends and writes nothing", async ({ page, playwright, baseURL }, info) => {
  test.skip(info.project.name !== DESKTOP, "one desktop");
  const { headers } = await account(page);
  const before = await page.request.get("/api/workbench/projects", { headers }).then((r) => r.json());
  await newBoardFigure(page, headers);
  await newBoardFigure(page, headers);
  const after = await page.request.get("/api/workbench/projects", { headers }).then((r) => r.json());
  expect(after.projects).toEqual(before.projects);
  /* A real render-scoped token, called with no session cookie: people only (requireSession). */
  const minted = await page.request.post("/api/tokens", { headers, data: { name: "Home read check", scope: "render", capCredits: 5 } });
  expect(minted.ok(), await minted.text()).toBe(true);
  const agent = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Authorization: `Bearer ${(await minted.json()).token}`, ...headers } });
  try {
    const token = await agent.get("/api/workbench/team-canvas?agent=1&board=new");
    expect(token.status()).toBe(403);
    expect(await token.text()).not.toContain("planning");
  } finally { await agent.dispose(); }
});

test("Start makes the project, checks the figure for it, and asks Atomik once with that limit, in Ask", async ({ page }, info) => {
  test.skip(![DESKTOP, PHONE].includes(info.project.name), "one desktop, one phone");
  const { headers } = await account(page);
  await forbidPaidWork(page);
  await quietTray(page);
  await queue(page, () => []);
  const figure = await newBoardFigure(page, headers);
  const asks: Record<string, unknown>[] = [];
  await page.route((url) => url.pathname === "/api/workbench/team-canvas", (route: Route) => {
    const request = route.request();
    if (request.method() === "POST" && (request.postDataJSON() as { action?: string }).action === "agent.plan") {
      asks.push(request.postDataJSON());
      return route.fulfill({ status: 202, json: { agent: { enabled: true, run: null, ask: null } } });
    }
    return route.fallback();
  });
  await openHome(page);

  await page.getByTestId("home-start").click();
  await expect(page.getByTestId("home-start-problem")).toHaveText("Say what we are making, or pick a template.");
  expect(asks).toEqual([]);

  await page.getByTestId("home-brief").fill("A lighthouse keeper's last night. Wind on the glass.");
  await page.locator('[data-testid="home-length"][data-value="30 s"]').click();
  const put = page.waitForRequest((r) => r.method() === "PUT" && new URL(r.url()).pathname === "/api/workbench/projects");
  await page.getByTestId("home-start").click();
  const project = (await put).postDataJSON().project as Project & { boardKind?: string };
  expect(project).toMatchObject({ name: "A lighthouse keeper's last night", boardKind: "studio", deliverables: "30 s" });
  await expect(page).toHaveURL(/page=rig|view=board/);
  expect(asks).toHaveLength(1);
  expect(asks[0]).toMatchObject({ action: "agent.plan", projectId: project.id, limit: figure, mode: "ask", goal: "A lighthouse keeper's last night. Wind on the glass. · 16:9 · 30 s" });
  expect(String(asks[0].productionId)).not.toBe("");
  /* The board replaces Home on screen, with Atomik's panel docked beside it (one move, never back on Home). */
  await expect(page.getByTestId("board")).toBeVisible({ timeout: 60_000 });
  expect(new URL(page.url()).searchParams.get("view")).toBe("board");
  expect(new URL(page.url()).searchParams.get("atomik")).toBe("1");
});

test("a higher figure for the new project is shown for another press, never spent; the next press asks at it", async ({ page }, info) => {
  test.skip(info.project.name !== DESKTOP, "one desktop");
  const { headers } = await account(page);
  await forbidPaidWork(page);
  await quietTray(page);
  await queue(page, () => []);
  const figure = await newBoardFigure(page, headers);
  const asks: Record<string, unknown>[] = [];
  let puts = 0;
  page.on("request", (r) => { if (r.method() === "PUT" && new URL(r.url()).pathname === "/api/workbench/projects") puts++; });
  await page.route((url) => url.pathname === "/api/workbench/team-canvas", (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.searchParams.get("projectId"))
      return route.fulfill({ json: { agent: { enabled: true, run: null, ask: { limit: 200, jobCeiling: 200, planning: figure + 5 } } } });
    if (request.method() === "POST") { asks.push(request.postDataJSON()); return route.fulfill({ status: 202, json: { agent: { enabled: true, run: null, ask: null } } }); }
    return route.fallback();
  });
  await openHome(page);
  await page.getByTestId("home-brief").fill("A long brief that costs a little more to read.");
  await page.getByTestId("home-start").click();
  await expect(page.getByTestId("home-start-problem")).toHaveText(`For this brief, Atomik's thinking may cost up to ${figure + 5} cr. Press Start again to approve it.`);
  await expect(page.getByTestId("home-start")).toHaveText(`Start · up to ${figure + 5} cr`);
  expect(asks).toEqual([]);
  await page.getByTestId("home-start").click();
  await expect(page).toHaveURL(/page=rig|view=board/);
  expect(asks).toHaveLength(1);
  expect(asks[0]).toMatchObject({ limit: figure + 5, mode: "ask" });
  expect(puts).toBe(1);
});

test("with Atomik off for the workspace, Home says so and Start can't be pressed", async ({ page }, info) => {
  test.skip(![DESKTOP, PHONE].includes(info.project.name), "one desktop, one phone");
  await account(page);
  await forbidPaidWork(page);
  await quietTray(page);
  await queue(page, () => []);
  await page.route((url) => url.pathname === "/api/workbench/team-canvas" && url.searchParams.get("board") === "new", (route) => route.fulfill({ json: { agent: { enabled: false, run: null, ask: null } } }));
  await openHome(page);
  await expect(page.getByTestId("home-thinking")).toHaveText("Atomik isn't on for this workspace yet.");
  await expect(page.getByTestId("home-start")).toHaveText("Start");
  await expect(page.getByTestId("home-start")).toBeDisabled();
  await expect(page.getByTestId("home-templates").getByRole("button")).toHaveCount(4);
});

test("Waiting for you: each item at its own price, approved alone through its own route; admin, short and plan steps say so", async ({ page }, info) => {
  const { headers } = await account(page);
  await forbidPaidWork(page);
  await quietTray(page);
  const mine = await saveProject(page, headers, "Kitchen at dawn");
  let items: QueueItem[] = [
    item({ id: "held:gen_held_1", title: "Keyframe · retake", project: { productionId: "prod-k", draftId: mine.id, name: "Kitchen at dawn" } }),
    item({ id: "board-render:r1:2", title: "Shot 2 · render", source: "board-render", where: "Board", price: { kind: "up-to", credits: 43 }, needsAdmin: true, canApprove: false, why: "An admin has to press this one.",
      approve: { kind: "board-render", productionId: "prod-k", runId: "rar_" + "a".repeat(24), seq: 2, fingerprint: "b".repeat(64) }, decline: null, open: { kind: "board", productionId: "prod-k", draftId: mine.id },
      project: { productionId: "prod-k", draftId: mine.id, name: "Kitchen at dawn" } }),
    item({ id: "held:gen_held_2", title: "Hero take · retake", price: { kind: "exact", credits: 43 }, shortBy: 12, approve: { kind: "release", genId: "gen_held_2", credits: 43 } }),
    item({ id: "thread:s1", title: "Plan the shots", source: "thread", where: "Atomik", price: { kind: "up-to", credits: 9 }, step: { n: 1, of: 3 }, approve: { kind: "thread", chatId: "c1", stepId: "s1", productionId: null }, decline: null, open: { kind: "thread", chatId: "c1", productionId: null } }),
  ];
  await queue(page, () => items);
  const releases: { url: string; body: unknown }[] = [];
  await page.route(/\/api\/jobs\/[^/]+\/release$/, (route) => {
    releases.push({ url: route.request().url(), body: route.request().postDataJSON() });
    items = items.filter((i) => i.id !== "held:gen_held_1");
    return route.fulfill({ json: { ok: true } });
  });
  const errors = await openHome(page);

  const strip = page.getByTestId("home-waiting");
  await expect(strip.getByRole("heading", { name: "Waiting for you" })).toBeVisible();
  const rows = page.getByTestId("home-waiting-row");
  await expect(rows).toHaveCount(4);
  const held = page.locator('[data-item="held:gen_held_1"]');
  await expect(held).toContainText("Keyframe · retake");
  await expect(held).toContainText(/Kitchen at dawn · Make · \d\d:\d\d/);
  await expect(held.getByTestId("home-waiting-approve")).toHaveText("Approve · 3 cr");
  await expect(held.getByTestId("home-waiting-approve")).toHaveAttribute("title", /^\$\d+\.\d\d$/);
  await expect(page.locator('[data-item="board-render:r1:2"]').getByTestId("home-waiting-why")).toHaveText("Needs an admin");
  await expect(page.locator('[data-item="board-render:r1:2"]').getByTestId("home-waiting-approve")).toHaveCount(0);
  const short = page.locator('[data-item="held:gen_held_2"]');
  await expect(short.getByTestId("home-waiting-short")).toContainText("Short by 12 cr · Top up");
  await expect(short.getByTestId("home-waiting-approve")).toBeDisabled();
  const step = page.locator('[data-item="thread:s1"]');
  await expect(step).toContainText("Atomik · step 1 of 3");
  await expect(step.getByTestId("home-waiting-approve")).toHaveCount(0);
  /* The card counts what waits in it. */
  await expect(page.locator(`[data-project="${mine.id}"]`).getByTestId("home-project-needs")).toHaveText("2 approvals waiting");
  if (COARSE.includes(info.project.name)) expect(await smallTargets(page, ".gx-hm"), "targets under 44×44").toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.getByTestId("home-waiting").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${S02_SHOTS}/home-waiting-${info.project.name.replace("workbench-", "")}.png`, animations: "disabled" });

  if (![DESKTOP, PHONE].includes(info.project.name)) return;
  await held.getByTestId("home-waiting-approve").click();
  await expect(held).toHaveCount(0);
  expect(releases).toHaveLength(1);
  expect(releases[0].url).toMatch(/\/api\/jobs\/gen_held_1\/release$/);
  expect(releases[0].body).toEqual({ credits: 3 });
  await expect(page.locator(`[data-project="${mine.id}"]`).getByTestId("home-project-needs")).toHaveText("1 approval waiting");
  expect(errors).toEqual([]);
});

test("a refused approval is said on its row; Open and Top up go where the item is approved and credits are asked for", async ({ page }, info) => {
  test.skip(info.project.name !== DESKTOP, "one desktop");
  await account(page);
  await forbidPaidWork(page);
  await quietTray(page);
  await queue(page, () => [item({ id: "held:gen_held_1", title: "Keyframe · retake" }), item({ id: "held:gen_held_2", title: "Hero take", shortBy: 5, approve: { kind: "release", genId: "gen_held_2", credits: 43 }, price: { kind: "exact", credits: 43 } })]);
  await page.route(/\/api\/jobs\/[^/]+\/release$/, (route) => route.fulfill({ status: 409, json: { error: "The price is now 4 cr. Press Release again to approve it.", credits: 4 } }));
  await openHome(page);
  const held = page.locator('[data-item="held:gen_held_1"]');
  await held.getByTestId("home-waiting-approve").click();
  await expect(held.getByTestId("home-waiting-problem")).toHaveText("The price is now 4 cr. Press Release again to approve it.");
  await page.locator('[data-item="held:gen_held_2"]').getByTestId("home-waiting-topup").click();
  await expect(page).toHaveURL(/view=workspace/);
  await expect(page).toHaveURL(/tab=credits/);
  await page.goto(HOME);
  await page.locator('[data-item="held:gen_held_1"]').getByTestId("home-waiting-open").click();
  await expect(page).toHaveURL(/suite=atomik/);
  await expect(page).toHaveURL(/page=approvals/);
});

test("more than five waiting: five rows and All approvals", async ({ page }, info) => {
  test.skip(info.project.name !== DESKTOP, "one desktop");
  await account(page);
  await forbidPaidWork(page);
  await quietTray(page);
  await queue(page, () => Array.from({ length: 7 }, (_, i) => item({ id: `held:gen_${i}`, title: `Take ${i + 1}`, at: Date.now() - (10 - i) * 60_000, approve: { kind: "release", genId: `gen_${i}`, credits: 3 } })));
  await openHome(page);
  await expect(page.getByTestId("home-waiting-row")).toHaveCount(5);
  await expect(page.getByTestId("home-waiting-all")).toHaveText("All approvals · 7");
  await page.getByTestId("home-waiting-all").click();
  await expect(page).toHaveURL(/page=approvals/);
});
