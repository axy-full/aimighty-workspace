import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { joinLocallyAsMember, localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { newProject, type CanvasNode, type Project } from "../lib/workbench/studio";

/*
 * Gap screens, lane 4 · money states on the board (design Gaps B: ?view=board&gap=money&state=short|failed|unavailable|
 * admin|paused, with the owner's corrections of 6 Oct). The board, the session, the balance, the rule and the settings
 * are the real ones on the local ENGINE_MOCK=1 server. Atomik's run is answered by the browser (no planner, no engine),
 * as the board plan spec does, and so are the quote route's replies (fixtures at the rate card's figures: Seedance 2.5
 * at 43 cr a 5 s shot, 86 cr for 10 s, Kling 3.0 Standard at 7 cr) and the budget read for the paused state: these
 * states need spend that a test may not make. The server's own rules are held by the unit specs
 * (tests/unit/demo-gaps-l4-*.spec.ts, tests/unit/rigAgentRuns.spec.ts). Nothing paid is ever sent. Neutral names only.
 */
const SHOTS = process.env.L4_SHOTS || join(tmpdir(), "claude-gaps-l4-shots");
const SEED = "dreamina-seedance-2-5-260628", KLING = "fal-ai/kling-video/v3/standard";
const FP = "c".repeat(64);
const RUN = "rar_000000000000000000000004";

type Step = { seq: number; title: string; state?: string; quote?: number | null; outcome?: string | null; charge?: { credits: number; settled: boolean } | null; canRender?: boolean; fingerprint?: string | null; pause?: string | null };
const step = (s: Step) => ({
  tool: "render", state: "next", quote: null, worst: null, pause: null, charged: null, outcome: null, charge: null, reason: null, canRender: false, fingerprint: null, ...s,
});
const runOf = (state: string, paid: ReturnType<typeof step>[], over: Record<string, unknown> = {}) => ({
  id: RUN, state, reason: null, goal: "A 15-second film", mine: true,
  proposal: state === "awaiting_approval" ? { title: "Three shots", summary: "", groups: [], cards: 0, wires: 0, tidy: false, next: [], fingerprint: FP } : null,
  steps: [], built: { cards: 0, wires: 0 }, held: [], undo: null, canUndo: false, credits: 9,
  money: { mode: "ask", limit: 500, jobCeiling: 200, spent: 9, inFlight: 0, left: 491, planning: { state: "settled", credits: 9 } },
  paid, at: Date.now(), ...over,
});
const proposalSteps = () => [step({ seq: 1, title: "Shot 1" }), step({ seq: 2, title: "Shot 2" }), step({ seq: 3, title: "Shot 3" })];
/** The plan gate (plan approval): built, each render priced by the run, the server's quote waiting for the one approval. `asks`: renders outside it (an admin's). */
const gateRun = (prices: [number, number, number], asks: number[] = [], over: Partial<Step>[] = []) => {
  const total = prices.filter((_, i) => !asks.includes(i + 1)).reduce((a, b) => a + b, 0);
  return runOf("needs_you", prices.map((q, i) => step({ seq: i + 1, title: `Shot ${i + 1}`, state: "waiting", quote: q, canRender: true, fingerprint: FP, ...(over[i] ?? {}) })), {
    reason: "Shot 1 is ready to render.",
    plan: { quote: { total, ceiling: 2 * total, approximate: false, fingerprint: PLAN_FP, covered: prices.map((_, i) => i + 1).filter((n) => !asks.includes(n)), asks }, blocked: null, approval: null },
  });
};
const PLAN_FP = "d".repeat(64);

const shot = (id: string, title: string, engine: string, x: number, durationS = 5): CanvasNode => ({
  id, title, type: "scene", x, y: 100, width: 238, linked: [], role: "Director", status: "draft", mode: "Video", engine, durationS, ratio: "16:9", resolution: "1080p", text: `${title}: a quiet wide frame.`,
});

/** Credits for this workspace, as the fixture helpers grant them (stamped 0, so the ledger's price of a credit is not moved). */
async function grant(workspaceId: string, credits: number) {
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await db.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,kind,created_at) VALUES(?,?,?,'manual',0)", args: [`l4_${workspaceId}_${credits}_${Date.now().toString(36)}`, workspaceId, credits] });
  } finally { db.close(); }
}

type Seeded = { project: Project; productionId: string; shotIds: string[]; me: string; scope: string; asks: Record<string, unknown>[]; posts: Record<string, unknown>[]; paid: string[] };

/** A board of three shots for whoever `api` is signed in as, its run answered by the browser. */
async function board(page: Page, api: APIRequestContext, workspaceId: string, run: ReturnType<typeof runOf>, opts: { shot1Seconds?: number; noKey?: boolean; budget?: unknown } = {}): Promise<Seeded> {
  const me = await (await api.get("/api/me")).json() as { id: string };
  const scope = `particl-active-${workspaceId}-${me.id}`;
  const headers = { "X-Workbench-Scope": scope };
  const project: Project = {
    ...newProject("A 15-second film"), id: `l4-${Date.now().toString(36)}`, aspect: "16:9", fps: 24, brief: "A 15-second film.", direction: "Soft light.",
    nodes: [shot("node-shot0001", "Shot 1", SEED, 0, opts.shot1Seconds ?? 5), shot("node-shot0002", "Shot 2", SEED, 300), shot("node-shot0003", "Shot 3", KLING, 600)],
  };
  const saved = await api.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const { productionProjectId: productionId } = await saved.json() as { productionProjectId: string };
  const shotIds: string[] = [];
  for (const n of project.nodes) {
    const mapped = await api.post("/api/workbench/projects", { headers, data: { projectId: project.id, action: "map-shot", nodeId: n.id } });
    expect(mapped.ok()).toBe(true);
    shotIds.push((await mapped.json() as { shotId: string }).shotId);
  }
  await page.addInitScript(({ scope, id }) => { try { localStorage.setItem(scope, id); } catch { /* storage off */ } }, { scope, id: project.id });
  const posts: Record<string, unknown>[] = [], asks: Record<string, unknown>[] = [], paid: string[] = [];
  await page.route(/\/api\/workbench\/team-canvas(\?|$)/, async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "GET" && url.searchParams.get("agent") === "1")
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ agent: { enabled: true, run, ask: null } }) });
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      if (typeof body.action === "string" && body.action.startsWith("agent.")) {
        posts.push(body);
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ agent: { enabled: true, run } }) });
      }
    }
    return route.continue();
  });
  /* The quote route's replies, at the rate card's figures; Kling has no key in the unavailable state. */
  await page.route("**/api/generate/quote", async (route) => {
    const body = route.request().postDataJSON() as { model?: string; duration?: number };
    if (body.model === KLING && opts.noKey) return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "no key on this workspace" }) });
    const credits = body.model === KLING ? 7 : Number(body.duration) >= 10 ? 86 : 43;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ estimatedCredits: credits, fingerprint: "q".repeat(64) }) });
  });
  if (opts.budget !== undefined) {
    await page.route("**/api/workbench/budget?**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ budget: opts.budget }) }));
  }
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && (path === "/api/generate" || /\/release$/.test(path) || path === "/api/workspaces/topups")) paid.push(path);
    if (request.method() === "POST" && path === "/api/workbench/ask-admin") asks.push(request.postDataJSON() as Record<string, unknown>);
  });
  return { project, productionId, shotIds, me: me.id, scope, asks, posts, paid };
}

const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1280;
const size = (name: string) => name.replace("workbench-", "");
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const plan = (page: Page) => page.locator('[data-card-id="plan:run"]').getByTestId("board-plan");
async function shoot(page: Page, name: string, project: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/l4-${name}-${size(project)}.png` });
}
/** Readable dark: nothing on the plan card under 12 px. */
async function smallText(page: Page) {
  return page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-testid="board-plan"] *')]
    .filter((el) => el.childElementCount === 0 && (el.textContent ?? "").trim() && parseFloat(getComputedStyle(el).fontSize) < 12).map((el) => el.textContent));
}
/** Phone widths: the board gives way to the phone app (stream 10); the floors that hold at every width. */
async function phoneFloors(page: Page, project: Project, seeded: Seeded) {
  await page.goto(`/suites?project=${project.id}&view=board`);
  await page.waitForTimeout(1500);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  expect(seeded.paid).toEqual([]);
}
/** The header's balance as a person reads it ("40 cr"): the smallest element in the header whose text is a credit figure. */
async function headerBalance(page: Page): Promise<string> {
  return page.evaluate(() => {
    const all = [...document.querySelectorAll<HTMLElement>("header *")].filter((el) => /^\s*[\d,]+\s*cr\s*$/.test(el.innerText ?? ""));
    const leaf = all.find((el) => ![...el.children].some((c) => /^\s*[\d,]+\s*cr\s*$/.test((c as HTMLElement).innerText ?? "")));
    return (leaf?.innerText ?? "").replace(/\s+/g, " ").trim();
  });
}

test("short: Approve waits, Top up beside it opens Settings › Plan & credits, and the header's balance is the one the card counts", async ({ page }, info) => {
  const { workspace } = await signInLocally(page.request, "Short Tester");
  /* The design's 40 cr: a fresh workspace's sign-up credits brought down to 40 on this local fixture database. */
  const before = (await (await page.request.get("/api/workspaces/topups")).json() as { credits?: { balance?: number } }).credits?.balance ?? 0;
  if (before !== 40) await grant(workspace.id, 40 - before);
  const seeded = await board(page, page.request, workspace.id, gateRun([43, 43, 7]));
  if (!desktop(page)) return phoneFloors(page, seeded.project, seeded);
  await page.goto(`/suites?project=${seeded.project.id}&view=board`);
  const card = plan(page);
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText("Make 3 shots · 93 cr · at most 186 cr");
  /* The header's balance is the one the card counts: 40 cr, short by 53. */
  await expect.poll(() => headerBalance(page)).toBe("40 cr");
  const balance = 40;
  await expect(card.getByTestId("board-plan-money")).toHaveText(`Short by ${93 - balance} cr`);
  await expect(card).toHaveAttribute("data-money", "short");
  /* The plan's own button, the server's total, waits. */
  await expect(card.getByTestId("board-plan-primary")).toHaveText("Approve · 93 cr");
  await expect(card.getByTestId("board-plan-primary")).toBeDisabled();
  await expect(card.getByTestId("board-plan-primary")).toHaveAttribute("data-spend-price", "93 cr");
  const topUp = card.getByTestId("board-plan-topup");
  /* The platform's smallest pack, read from the server (the local deployment sells the Starter pack). */
  await expect(topUp).toHaveText(/^Top up · [\d,]+ cr · \$[\d.,]+$/);
  await expect(card).toContainText("Top up, then approve. Nothing is spent until you do.");
  expect(await smallText(page)).toEqual([]);
  await shoot(page, "money-short", info.project.name);
  await topUp.click();
  await expect(page).toHaveURL(/view=workspace/);
  await expect(page).toHaveURL(/credits/);
  /* Nothing was asked for or bought from the board. */
  expect(seeded.paid).toEqual([]);
  expect(seeded.posts).toEqual([]);
});

test("a step needs an admin: Shot 1 at 86 cr is over the 50 cr per-shot cap; a member asks an admin; Approve the rest leaves it out", async ({ page, playwright }, info) => {
  const owner = await playwright.request.newContext({ baseURL: process.env.PW_BASE_URL });
  const { workspace } = await joinLocallyAsMember(owner, page.request);
  await grant(workspace.id, 2000);
  const ownerMe = await (await owner.get("/api/me")).json() as { id: string };
  const rule = await owner.patch("/api/settings", { headers: { "X-Workbench-Scope": `particl-active-${workspace.id}-${ownerMe.id}` }, data: { approvalRule: "cap", shotCapCredits: "50" } });
  expect(rule.ok(), await rule.text()).toBe(true);
  /* Shot 1 as a 10 s shot at 86 cr, paused for an admin: it asks on its own, outside the plan's one approval. */
  const seeded = await board(page, page.request, workspace.id, gateRun([86, 43, 7], [1], [{ state: "paused", pause: "admin" }]), { shot1Seconds: 10 });
  await page.route("**/api/workbench/ask-admin", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ asked: 1, line: "Asked. The owner and admins were told; nothing was spent." }) }));
  if (!desktop(page)) { await phoneFloors(page, seeded.project, seeded); await owner.dispose(); return; }
  await page.goto(`/suites?project=${seeded.project.id}&view=board`);
  const card = plan(page);
  await expect(card).toHaveAttribute("data-money", "admin", { timeout: 20_000 });
  await expect(card.getByTestId("board-plan-money")).toHaveText("Shot 1 is over 50 cr a shot · needs an admin");
  await expect(card.getByTestId("board-plan-rest")).toHaveText("The rest: 2 shots · 50 cr");
  /* The plan's one approval leaves the admin's step out: the server's total for the rest. */
  await expect(card).toContainText("Make 3 shots · 50 cr · at most 100 cr");
  await expect(card.getByTestId("board-plan-primary")).toHaveText("Approve the rest · 50 cr");
  await expect(card.getByTestId("board-plan-primary")).toHaveAttribute("data-spend-price", "50 cr");
  await expect(card.getByTestId("board-plan-admin")).toHaveText("Needs an admin · over 50 cr on a shot");
  expect(await smallText(page)).toEqual([]);
  await shoot(page, "money-admin", info.project.name);
  await card.getByTestId("board-plan-ask-admin").click();
  await expect(page.getByTestId("toast")).toContainText("Asked. The owner and admins were told");
  expect(seeded.asks).toEqual([{ about: "step", productionId: seeded.productionId, runId: RUN, seq: 1 }]);
  await card.getByTestId("board-plan-primary").click();
  await expect.poll(() => seeded.posts.length).toBe(1);
  expect(seeded.posts[0]).toMatchObject({ action: "agent.approvePlan", runId: RUN, fingerprint: PLAN_FP });
  expect(seeded.paid).toEqual([]);
  await owner.dispose();
});

test("engine unavailable: the server's reason; Move Shot 3 to Seedance 2.5 at its quote moves it on the board (free), and the plan is whole again", async ({ page }, info) => {
  const { workspace } = await signInLocally(page.request, "Unavailable Tester");
  await grant(workspace.id, 2000);
  const seeded = await board(page, page.request, workspace.id, runOf("awaiting_approval", proposalSteps()), { noKey: true });
  if (!desktop(page)) return phoneFloors(page, seeded.project, seeded);
  await page.goto(`/suites?project=${seeded.project.id}&view=board`);
  const card = plan(page);
  await expect(card).toHaveAttribute("data-money", "unavailable", { timeout: 20_000 });
  await expect(card.getByTestId("board-plan-money")).toHaveText("Shot 3 can't render · no key on this workspace");
  await expect(card.getByTestId("board-plan-rest")).toHaveText("The rest: 2 shots · 86 cr");
  /* Before the build the plan's own button builds, free; the shots are approved once, at the plan gate. */
  await expect(card.getByTestId("board-plan-primary")).toHaveText("Build · free");
  const move = card.getByTestId("board-plan-move");
  await expect(move).toHaveText("Move Shot 3 to Seedance 2.5 · 43 cr");
  await expect(move).toHaveAttribute("title", /^\$[\d.]+$/);
  expect(await smallText(page)).toEqual([]);
  await shoot(page, "money-unavailable", info.project.name);
  await move.click();
  /* Moved on the board: Shot 3 is priced on its new engine and the plan has no unavailable step. */
  await expect(card).not.toHaveAttribute("data-money", /.*/, { timeout: 15_000 });
  expect(seeded.posts).toEqual([]);
  expect(seeded.paid).toEqual([]);
});

test("a take failed: Nothing billed only where the provider's outcome says so; the plan carries on", async ({ page }, info) => {
  const { workspace } = await signInLocally(page.request, "Failed Tester");
  await grant(workspace.id, 2000);
  const run = runOf("running", [
    step({ seq: 1, title: "Shot 1", state: "done", quote: 43 }),
    step({ seq: 2, title: "Shot 2", state: "failed", quote: 43, outcome: "not_billed", charge: { credits: 0, settled: true } }),
    step({ seq: 3, title: "Shot 3", state: "rendering", quote: 7 }),
  ]);
  const seeded = await board(page, page.request, workspace.id, run);
  /* Shot 2's failed take, as the library route would list it: the provider's outcome says nothing was charged, and the
     ledger agrees (settled at 0). The rest of the library is the server's own reply. */
  const failedTake = {
    id: "gen_l4failed", projectId: seeded.productionId, projectName: "A 15-second film", arkTaskId: null, kind: "video", reviewState: "", reviewBy: null, pickedBy: null, pickedAt: null,
    approvedBy: null, approvedAt: null, model: SEED, prompt: "Shot 2: a quiet wide frame.", title: null,
    params: { ratio: "16:9", resolution: "1080p", duration: 5, references: [] }, status: "failed", sourceUrl: null, storedUrl: null, totalTokens: null,
    costUsd: null, creditsBilled: null, refineCostUsd: null, refineModel: null, refineInTokens: null, refineOutTokens: null, error: "The engine did not return a take.",
    failure: { provider: "byteplus", stage: null, code: "provider_error", kind: "provider_error", message: "The engine did not return a take.", billing: { state: "not_charged", basis: "ark-success-only" }, payer: "platform", charge: { credits: 0, settled: true } },
    createdBy: seeded.me, authorName: "Failed Tester", shotId: seeded.shotIds[1], shotCode: null, shotScene: null, shotTitle: "Shot 2", version: 1, durationMs: null, durationS: null,
    provider: "byteplus", attempts: 1, task: "generate", sourceGenId: null, createdAt: Date.now() - 60_000, updatedAt: Date.now() - 30_000, settledAt: Date.now() - 30_000,
  };
  await page.route("**/api/workbench/library?**", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== "GET" || url.searchParams.get("source") !== "generations") return route.continue();
    const real = await route.fetch();
    const body = await real.json() as { generations?: unknown[] };
    return route.fulfill({ response: real, json: { ...body, generations: [failedTake, ...(body.generations ?? [])] } });
  });
  if (!desktop(page)) return phoneFloors(page, seeded.project, seeded);
  await page.goto(`/suites?project=${seeded.project.id}&view=board`);
  const card = plan(page);
  await expect(card).toHaveAttribute("data-money", "failed", { timeout: 20_000 });
  /* The take card: Nothing billed (confirmed), and Retry at the server's quote for the request it makes again. */
  const take = page.locator('[data-testid="take-card"]').filter({ has: page.getByTestId("take-failed") }).first();
  await expect(take.getByTestId("take-nothing-billed")).toHaveText("Nothing billed");
  const retry = take.getByTestId("take-retry");
  await expect(retry).toHaveText("Retry · 43 cr");
  await expect(retry).toHaveAttribute("data-spend", "priced");
  await expect(retry).toHaveAttribute("title", /^\$[\d.]+$/);
  await expect(card.getByTestId("board-plan-money")).toHaveText("Shot 2 failed · Nothing billed");
  await expect(card.getByTestId("board-plan-step").nth(1)).toContainText("Failed · nothing billed");
  expect(await smallText(page)).toEqual([]);
  await expect(card.getByTestId("board-plan-step").nth(1).locator(".gx-plan-step-later")).toHaveText("nothing billed");
  await expect(card.getByTestId("board-plan-step").nth(1)).not.toContainText("free");
  await shoot(page, "money-failed", info.project.name);
  await page.getByTestId("board-rail").getByText("Shots", { exact: true }).click();
  await shoot(page, "money-failed-take", info.project.name);
  /* Retry hands the recipe to Make, where a person presses Make at its price: nothing is sent from the card. */
  await retry.click();
  await expect(page).toHaveURL(/make=/);
  expect(seeded.posts).toEqual([]);
  expect(seeded.paid).toEqual([]);
});

test("paused at 80 % of the budget: 320 of 400 cr used; Continue · 7 cr is the next render's own tap; Stop keeps what is made", async ({ page }, info) => {
  const { workspace } = await signInLocally(page.request, "Paused Tester");
  await grant(workspace.id, 2000);
  const run = runOf("needs_you", [
    step({ seq: 1, title: "Shot 1", state: "done", quote: 43 }),
    step({ seq: 2, title: "Shot 2", state: "done", quote: 43 }),
    step({ seq: 3, title: "Shot 3", state: "waiting", quote: 7, canRender: true, fingerprint: FP }),
  ], { reason: "Paused at 80 % of the budget: 320 of 400 cr used. Continue or stop. Shot 3 is next · about 7 cr." });
  const seeded = await board(page, page.request, workspace.id, run, { budget: { cap: 400, used: 320, warnPct: 80, pauseAt: 320, unlocked: false, from: "workspace" } });
  if (!desktop(page)) return phoneFloors(page, seeded.project, seeded);
  await page.goto(`/suites?project=${seeded.project.id}&view=board`);
  const card = plan(page);
  await expect(card).toHaveAttribute("data-money", "paused", { timeout: 20_000 });
  await expect(card.locator(".gx-plan-title")).toHaveText("Paused at 80 % of the budget");
  await expect(card.getByTestId("board-plan-line")).toHaveText("320 of 400 cr used");
  await expect(card.getByTestId("board-plan-money")).toHaveText("Shot 3 waits · 7 cr more");
  await expect(card.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "80");
  const rows = card.getByTestId("board-plan-budget-row");
  await expect(rows.nth(0)).toContainText("320 cr");
  await expect(rows.nth(2)).toContainText("400 cr · change in Settings › Spending rules");
  const go = card.getByTestId("board-plan-primary");
  await expect(go).toHaveText("Continue · 7 cr");
  await expect(go).toHaveAttribute("data-spend", "priced");
  await expect(go).toHaveAttribute("data-spend-price", "7 cr");
  await expect(card.getByTestId("board-plan-stop")).toHaveText("Stop · keep what’s made");
  expect(await smallText(page)).toEqual([]);
  await shoot(page, "money-paused", info.project.name);
  /* Continue is the run's render tap at the price shown (its fingerprint); Stop is the run's stop. Both are the person's. */
  await go.click();
  await expect.poll(() => seeded.posts.length).toBe(1);
  expect(seeded.posts[0]).toMatchObject({ action: "agent.render", runId: RUN, seq: 3, fingerprint: FP });
  await card.getByTestId("board-plan-stop").click();
  await expect.poll(() => seeded.posts.length).toBe(2);
  expect(seeded.posts[1]).toMatchObject({ action: "agent.stop", runId: RUN });
  expect(seeded.paid).toEqual([]);
});

test("before Approve at the plan gate, one plain line says where the plan's at most takes the production against its budget; Approve keeps its price (board and phone)", async ({ page }, info) => {
  const { workspace } = await signInLocally(page.request, "Plan Budget Tester");
  await grant(workspace.id, 2000);
  const LINE = "This plan’s at most 186 cr is more than A 15-second film has left (150 cr); it will stop at the cap.";
  /* The server's line (GET /api/workbench/budget with the run; its figures: tests/unit/demo-gaps-l4-people-only.spec.ts). */
  const seeded = await board(page, page.request, workspace.id, gateRun([43, 43, 7]));
  const reads: string[] = [];
  await page.route("**/api/workbench/budget?**", (route) => {
    reads.push(new URL(route.request().url()).search);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ budget: { cap: 400, used: 250, warnPct: 80, pauseAt: 320, unlocked: false, from: "workspace" }, plan: { atMost: 186, line: LINE } }) });
  });
  if (desktop(page)) {
    await page.goto(`/suites?project=${seeded.project.id}&view=board`);
    const card = plan(page);
    await expect(card.getByTestId("board-plan-budget-line")).toHaveText(LINE, { timeout: 20_000 });
    await expect(card.getByTestId("board-plan-primary")).toHaveText("Approve · 93 cr");
    await expect(card.getByTestId("board-plan-primary")).toHaveAttribute("data-spend-price", "93 cr");
    await expect(card.getByTestId("board-plan-primary")).toBeEnabled();
    expect(await smallText(page)).toEqual([]);
    await shoot(page, "money-plan-budget", info.project.name);
  } else {
    await page.goto(`/suites?project=${seeded.project.id}&screen=plan`);
    await expect(page.getByTestId("phone-plan-budget-line")).toHaveText(LINE, { timeout: 20_000 });
    await expect(page.getByTestId("phone-plan-primary")).toHaveText("Approve · 93 cr");
    await expect(page.getByTestId("phone-plan-primary")).toHaveAttribute("data-spend-price", "93 cr");
    const size = await page.getByTestId("phone-plan-budget-line").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(size).toBeGreaterThanOrEqual(12);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await shoot(page, "money-plan-budget", info.project.name);
  }
  /* The card asked with the run; nothing was pressed, nothing spent. */
  expect(reads.some((q) => q.includes(`runId=${RUN}`))).toBe(true);
  expect(seeded.posts).toEqual([]);
  expect(seeded.paid).toEqual([]);
});
