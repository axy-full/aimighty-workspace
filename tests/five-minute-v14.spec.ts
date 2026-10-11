import { test, expect, request as playwrightRequest, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import {
  bannedNamesIn, mockInvitation, noSidewaysScroll, PASSPHRASE, runOf, scopeFor, unpricedSpendButtons, visibleText,
  watchSpending, type SpendLedger,
} from "./helpers/fiveMinute";

/**
 * THE FIVE-MINUTE TEST ON THE NEW SCREENS (prototype 14; docs/plans/u1-ease.md § 3.1; ground rules 6 and 17).
 *
 * A DRAFT of tests/five-minute.spec.ts for the interface every workspace now gets (#665), kept as its own file so the
 * original is untouched until the owner decides. If he says to port the journey, this file replaces that one's laptop path.
 *
 * A brand-new person with a mocked invitation reaches an approved first render on a laptop (1440x900) in under five minutes
 * of wall time, against a local server with ENGINE_MOCK=1: sign-up (invite-only, email filled in), the new Home, a brief, Start
 * at its price, the board's plan, a person's approval, the first render, its approval.
 *
 * On every screen of the path it asserts, as the original does:
 *  - every spending button shows its price (a figure in credits, or "free");
 *  - no paid request goes out before a person presses the button that spends it (the ledger in helpers/fiveMinute.ts);
 *  - an agent identity (an API token, as the MCP and a skill act) cannot approve a plan or a render, and nothing moves;
 *  - no retired name is on screen; nothing scrolls sideways.
 *
 * Rule 17: it records time to first render, approvals and where the path stopped, as ids and timings only (never the brief's
 * words): the marks below go to the report's annotation and to a JSON file beside it.
 *
 * What differs from the original (the screens, not the rules): Home is the bar ("Describe a film, ad or idea" and Start · up to N cr,
 * the same figure and the same single approval); Start opens the board, where the Shots stage holds the plan card (the plan card and the
 * take cards are the same components as before, so their test ids are the same); the take's Approve is on its card. The phone's journey
 * is the phone app's, unchanged, and stays in tests/five-minute.spec.ts.
 *
 * Run: ENGINE_MOCK=1 PW_BASE_URL=http://localhost:<port> PW_PLATFORM_DATABASE_URL=file:<its platform.db> \
 *      npx playwright test --config=playwright.five-minute-v14.config.ts
 */
const FIVE_MINUTES = 5 * 60_000;
/** Taps from the invitation link to the approved take: terms, sign up, Start, the Shots stage, Build, Approve (plan), Approve (take). Typing is not a tap. */
const TAP_BUDGET = 7;
const BRIEF = "A 15-second film about a courier crossing a rooftop at dawn, three shots.";

type Run = {
  page: Page;
  context: BrowserContext;
  spend: SpendLedger;
  errors: string[];
  started: number;
  taps: number;
  marks: Record<string, number>;
  approvals: number;
  draftId: string;
  productionId: string;
  balanceAtStart: number | null;
  thinking: number | null;
  rendered: number | null;
  /** The most the approved plan may spend, fixes included, as the card said it. */
  ceiling: number | null;
  /** The N on Start, as the screen showed it. */
  startFigure: number | null;
  /** The last step that passed: where the path stopped, if it did. */
  reached: string;
};

async function balanceOf(page: Page): Promise<number> {
  const me = (await (await page.request.get("/api/me")).json()) as { credits?: { balance?: number } };
  return Number(me.credits?.balance ?? NaN);
}

/** The takes of the project the Library holds as approved: a lasting state, read from the server. */
async function approvedTakes(run: Run): Promise<number> {
  const { headers } = await scopeFor(run.page.request);
  const reply = await run.page.request.get(`/api/workbench/library?projectId=${encodeURIComponent(run.draftId)}&source=generations&limit=60`, { headers });
  const json = await reply.json().catch(() => null) as { generations?: { reviewState?: string }[] } | null;
  return (json?.generations ?? []).filter((g) => g.reviewState === "approved").length;
}

async function open(browser: Browser): Promise<Run> {
  const base = process.env.PW_BASE_URL || "http://localhost:4551";
  test.skip(!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(base), "runs only against a local server");
  const health = await fetch(`${base}/api/health`).then((r) => r.json()).catch(() => null) as { mock?: boolean } | null;
  test.skip(!health?.mock, "runs only against a local server started with ENGINE_MOCK=1");
  const context = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { page, context, spend: watchSpending(page), errors, started: 0, taps: 0, marks: {}, approvals: 0, draftId: "", productionId: "", balanceAtStart: null, thinking: null, rendered: null, ceiling: null, startFigure: null, reached: "none" };
}

const elapsed = (run: Run) => (run.started ? Date.now() - run.started : 0);
const mark = (run: Run, name: string) => { run.marks[name] = Math.round(elapsed(run) / 100) / 10; run.reached = name; };
async function tap(run: Run, target: ReturnType<Page["getByRole"]>) {
  run.taps++;
  await target.click();
}
/** What every screen of the path must be: nothing retired on it, nothing sideways, no spending button without its price. */
async function screenIsClean(run: Run, spendRoots: string[] = []) {
  const { page } = run;
  expect(bannedNamesIn(await visibleText(page)), "retired names on screen").toEqual([]);
  expect(await noSidewaysScroll(page), "nothing scrolls sideways").toBe(true);
  for (const root of spendRoots) await expect.poll(() => unpricedSpendButtons(page, root), { message: `spending buttons without a price inside ${root}`, timeout: 15_000 }).toEqual([]);
}

/** The agent half of "only a person approves": a token (how an agent, a skill or an MCP caller acts) tries to approve the plan once it is priced. */
async function anAgentCannotApprove(run: Run, runId: string, fingerprint: string | null) {
  const { headers } = await scopeFor(run.page.request);
  const minted = await run.page.request.post("/api/tokens", { headers, data: { name: "Five-minute agent", scope: "render", capCredits: 500 } });
  expect(minted.ok(), await minted.text()).toBe(true);
  const agent = await playwrightRequest.newContext({
    baseURL: process.env.PW_BASE_URL || "http://localhost:4551",
    extraHTTPHeaders: { Authorization: `Bearer ${(await minted.json()).token}`, "X-Workbench-Scope": headers["X-Workbench-Scope"] },
  });
  try {
    const attempts = [
      { action: "agent.approvePlan", fingerprint: fingerprint ?? "f".repeat(64) },
      { action: "agent.approve", fingerprint: "f".repeat(64) },
      { action: "agent.limit", limit: 400 },
      { action: "agent.render", seq: 1 },
    ];
    for (const attempt of attempts) {
      const refused = await agent.post("/api/workbench/team-canvas", { data: { productionId: run.productionId, runId, ...attempt } });
      expect(refused.status(), `${attempt.action} by an agent identity`).toBe(403);
      expect(await refused.json()).toEqual({ error: expect.stringContaining("signed-in browser session") });
    }
  } finally {
    await agent.dispose();
  }
  const { headers: h } = await scopeFor(run.page.request);
  const after = await runOf(run.page.request, h, run.productionId, run.draftId);
  expect(after.run?.id).toBe(runId);
  expect(after.run?.state, "the plan is still waiting for a person").toBe("needs_you");
  expect(after.run?.plan?.quote, "the plan is still unapproved, at its quote").toBeTruthy();
}

test.describe("the five-minute test on the new screens · laptop 1440x900", () => {
  test.describe.configure({ mode: "serial" });
  let run: Run;
  test.beforeAll(async ({ browser }) => { run = await open(browser); });
  test.afterAll(async ({}, info) => {
    if (!run) return;
    /* Rule 17: timings and counts only, never the brief's words. */
    const record = { project: info.project.name, marks: run.marks, reached: run.reached, taps: run.taps, approvals: run.approvals, seconds: Math.round(elapsed(run) / 100) / 10, paid: run.spend.spent.map((s) => s.kind) };
    info.annotations.push({ type: "five-minute-v14", description: JSON.stringify(record) });
    try { writeFileSync(info.outputPath("five-minute-v14-timings.json"), JSON.stringify(record, null, 2)); } catch { /* the report's annotation still has it */ }
    await run.context.close();
  });

  test("1 · the invitation link opens sign-up, the email already filled in", async () => {
    const base = process.env.PW_BASE_URL || "http://localhost:4551";
    const invite = await mockInvitation(base);
    const forged = await run.page.request.get("/api/auth/signup?code=not-an-issued-invitation");
    expect(forged.ok(), "a made-up invitation opens nothing").toBe(false);
    run.started = Date.now();
    await run.page.goto(invite.link, { timeout: 120_000 });
    await expect(run.page.getByRole("heading", { name: /create your account/i })).toBeVisible({ timeout: 60_000 });
    await expect(run.page.getByTestId("signup-email")).toHaveValue(invite.email);
    await expect(run.page.getByTestId("signup-email")).toHaveJSProperty("readOnly", true);
    await expect(run.page.getByTestId("signup-name")).toHaveCount(0);
    await screenIsClean(run);
    mark(run, "invitation");
  });

  test("2 · the person names the workspace and signs up", async () => {
    const { page } = run;
    await page.getByTestId("signup-workspace").fill("Five Minute Studio");
    await page.getByTestId("signup-password").fill(PASSPHRASE);
    await page.getByTestId("signup-confirm").fill(PASSPHRASE);
    await tap(run, page.getByTestId("signup-terms"));
    await tap(run, page.getByTestId("signup-submit"));
    await page.waitForURL((url) => !/\/signup/.test(url.pathname), { timeout: 120_000 });
    mark(run, "signed up");
  });

  test("3 · sign-up lands on the new Home: the bar, Start with its price", async () => {
    const { page } = run;
    await expect(page.getByTestId("v12-home")).toBeVisible({ timeout: 90_000 });
    expect(new URL(page.url()).searchParams.get("view"), "the address is Home's").toBe("home");
    await expect(page.getByTestId("v12-home-bar-input")).toBeVisible();
    await expect(page.getByTestId("v12-home-start")).toHaveText(/^Start · up to \d[\d,]* cr$/, { timeout: 60_000 });
    run.balanceAtStart = await balanceOf(page);
    expect(run.balanceAtStart, "the new workspace has its welcome credits").toBeGreaterThan(0);
    mark(run, "landed on Home");
  });

  test("4 · Home: the brief typed, Start shows the server's own figure", async () => {
    const { page } = run;
    await page.getByTestId("v12-home-bar-input").fill(BRIEF);
    const start = page.getByTestId("v12-home-start");
    await expect(start).toBeEnabled({ timeout: 30_000 });
    /* The figure is the server's own: the quote route's answer for a new board, never a number kept in the app. */
    const { headers } = await scopeFor(page.request);
    const quote = await page.request.get("/api/workbench/team-canvas?agent=1&board=new", { headers });
    expect(quote.ok(), await quote.text()).toBe(true);
    const planning = ((await quote.json()) as { agent?: { ask?: { planning?: number } | null } }).agent?.ask?.planning;
    expect(planning, "the quote route prices Atomik's thinking").toBeGreaterThan(0);
    run.startFigure = Number(/(\d[\d,]*)/.exec(await start.innerText())?.[1].replace(/,/g, ""));
    expect(run.startFigure, "Start shows the server's figure").toBe(planning);
    await screenIsClean(run, ['[data-testid="v12-home-bar"]']);
    expect(run.spend.spent, "typing the brief spends nothing").toEqual([]);
    mark(run, "brief typed");
  });

  test("5 · the person presses Start at its price; the board opens and Atomik's plan is waiting on Shots", async () => {
    const { page } = run;
    run.spend.allow("agent.plan", "Start · up to N cr");
    await tap(run, page.getByTestId("v12-home-start"));
    await expect(page.getByTestId("board")).toBeVisible({ timeout: 90_000 });
    const params = new URL(page.url()).searchParams;
    run.draftId = params.get("project") ?? "";
    expect(run.draftId, "the board is the new project's").not.toBe("");
    expect(params.get("view"), "Start lands on the board").toBe("board");
    const { headers } = await scopeFor(page.request);
    const saved = await page.request.get(`/api/workbench/projects?id=${run.draftId}`, { headers });
    run.productionId = String(((await saved.json()) as { project?: { productionProjectId?: string } }).project?.productionProjectId ?? "");
    expect(run.productionId, "the project has its production").not.toBe("");
    await expect.poll(async () => (await runOf(page.request, headers, run.productionId, run.draftId)).run?.state, { message: "Atomik has answered the brief with a plan", timeout: 90_000 }).toBe("awaiting_approval");
    run.spend.close("agent.plan");
    const planRequest = run.spend.spent.find((x) => x.kind === "agent.plan");
    expect(planRequest?.body?.limit, "the ask's limit is the figure on Start").toBe(run.startFigure);
    expect(run.spend.spent.map((x) => x.kind)).toEqual(["agent.plan"]);
    await screenIsClean(run);
    mark(run, "board");
  });

  test("6 · the person opens Shots: the plan card says what it makes, and Build is free", async () => {
    const { page } = run;
    await tap(run, page.getByTestId("v12-stage-row").filter({ hasText: "Shots" }));
    await expect(page.getByTestId("board-plan")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("board-plan")).toContainText(/Make \d+ shots?/);
    await expect(page.getByTestId("board-plan-primary")).toHaveText("Build · free");
    await screenIsClean(run, ['[data-testid="board-plan"]']);
    expect(run.spend.spent.map((x) => x.kind), "opening the plan spent nothing more").toEqual(["agent.plan"]);
    mark(run, "plan card");
  });

  test("7 · Build is free; once the shots are on the board the card says 'Make N shots · N cr · at most 2N cr' and Approve carries its price", async () => {
    const { page } = run;
    const primary = page.getByTestId("board-plan-primary");
    await tap(run, primary);
    await expect(primary).toHaveText(/^Approve · (up to )?\d[\d,]*(\.\d)? cr$/, { timeout: 90_000 });
    const card = page.getByTestId("board-plan");
    await expect(card).toContainText(/Make \d+ shots? · (up to )?\d[\d,]*(\.\d)? cr · at most \d[\d,]*(\.\d)? cr/);
    run.ceiling = Number(/at most (\d[\d,]*(?:\.\d)?) cr/.exec(await card.innerText())?.[1].replace(/,/g, "") ?? NaN);
    expect(run.spend.spent.map((s) => s.kind), "building billed nothing").toEqual(["agent.plan"]);
    run.thinking = Number(/Thinking · (\d[\d,]*(?:\.\d)?) cr/.exec(await visibleText(page))?.[1] ?? NaN);
    await screenIsClean(run, ['[data-testid="board-plan"]']);
    mark(run, "plan priced");
  });

  test("8 · an agent identity cannot approve the plan, build it, raise its limit or press a render", async () => {
    const { headers } = await scopeFor(run.page.request);
    const state = await runOf(run.page.request, headers, run.productionId, run.draftId);
    expect(state.run?.state).toBe("needs_you");
    await anAgentCannotApprove(run, state.run!.id, state.run!.plan?.quote?.fingerprint ?? null);
    await expect(run.page.getByTestId("board-plan-primary")).toHaveText(/^Approve · /);
    expect(run.spend.spent.map((s) => s.kind), "the agent's tries spent nothing").toEqual(["agent.plan"]);
  });

  test("9 · a person approves the plan once, at its price; the renders go with no tap of their own", async () => {
    const { page } = run;
    const primary = page.getByTestId("board-plan-primary");
    const quoted = (await runOf(page.request, (await scopeFor(page.request)).headers, run.productionId, run.draftId)).run?.plan?.quote?.fingerprint ?? null;
    expect(quoted, "the priced plan has a quote fingerprint").toMatch(/^[a-f0-9]{64}$/);
    run.spend.allow("agent.approvePlan", await primary.innerText());
    await tap(run, primary);
    run.approvals++;
    const card = page.getByTestId("board-plan");
    await expect(card).toContainText(/Rendered · [\d.,]+ cr settled/, { timeout: 120_000 });
    run.spend.close("agent.approvePlan");
    expect(run.spend.spent.find((x) => x.kind === "agent.approvePlan")?.body?.fingerprint, "the approval carries the quoted fingerprint").toBe(quoted);
    await expect(card).toContainText(/Making \d+ shots?/);
    run.rendered = Number(/Rendered · ([\d.,]+) cr settled/.exec(await card.innerText())?.[1].replace(/,/g, "") ?? NaN);
    expect(run.rendered).toBeGreaterThan(0);
    expect(run.spend.spent.map((s) => s.kind), "one approval, and no render pressed").toEqual(["agent.plan", "agent.approvePlan"]);
    await screenIsClean(run, ['[data-testid="board-plan"]']);
    mark(run, "plan approved");
  });

  test("10 · the first take lands on the board, and the balance fell by what was settled", async () => {
    const { page } = run;
    const first = page.getByTestId("take-card").filter({ hasText: "Shot 1" });
    await expect(first.locator("img, video").first()).toBeVisible({ timeout: 60_000 });
    mark(run, "first render on the board");
    expect(run.spend.spent.map((s) => s.kind)).toEqual(["agent.plan", "agent.approvePlan"]);
    const start = (run.balanceAtStart ?? NaN) - (run.thinking ?? NaN);
    await expect.poll(() => balanceOf(page), { timeout: 30_000 }).toBeLessThanOrEqual(start - run.rendered!);
    expect(await balanceOf(page)).toBeGreaterThanOrEqual(start - run.ceiling!);
    await screenIsClean(run, ['[data-testid="board-plan"]']);
  });

  test("11 · the person approves the first take", async () => {
    const { page } = run;
    const first = page.getByTestId("take-card").filter({ hasText: "Shot 1" });
    const approve = first.getByTestId("take-approve");
    await expect(approve).toBeEnabled({ timeout: 60_000 });
    expect(await unpricedSpendButtons(page, '[data-testid="take-card"]'), "take buttons that spend carry their price").toEqual([]);
    await tap(run, approve);
    run.approvals++;
    await expect.poll(() => approvedTakes(run), { message: "the Library holds the take as approved", timeout: 30_000 }).toBeGreaterThanOrEqual(1);
    mark(run, "first take approved");
    expect(run.spend.spent.map((s) => s.kind), "approving a take spends nothing").toEqual(["agent.plan", "agent.approvePlan"]);
    expect(bannedNamesIn(await visibleText(page)), "retired names on screen").toEqual([]);
  });

  test("12 · all of it inside five minutes, within the tap budget, nothing paid unasked", async () => {
    const wall = elapsed(run);
    console.log(`five-minute v14 (laptop 1440x900): ${Math.round(wall / 100) / 10} s, ${run.taps} taps, ${run.approvals} approvals, marks ${JSON.stringify(run.marks)}, paid ${JSON.stringify(run.spend.spent.map((s) => s.kind))}`);
    expect(wall, "wall time from the invitation link to the approved take").toBeLessThan(FIVE_MINUTES);
    expect(run.taps, "taps from the invitation link to the approved take").toBeLessThanOrEqual(TAP_BUDGET);
    expect(run.spend.violations, "paid requests with no person's press").toEqual([]);
    expect(run.errors, "page errors on the path").toEqual([]);
  });
});
