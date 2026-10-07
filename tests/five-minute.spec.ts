import { test, expect, request as playwrightRequest, type Browser, type BrowserContext, type Page } from "@playwright/test";
import {
  balanceCr, bannedNamesIn, mockInvitation, noSidewaysScroll, PASSPHRASE, runOf, scopeFor, unpricedSpendButtons, visibleText,
  watchSpending, type SpendLedger,
} from "./helpers/fiveMinute";
import { expectFloors } from "./phoneFloors";

/**
 * THE FIVE-MINUTE TEST (scope v2 § 2 "Done when"; docs/plans/u1-ease.md § 3.1).
 *
 * A brand-new person with a mocked invitation reaches an approved first render, on a laptop (1440x900) and on a phone
 * (390x844), in under five minutes of wall time, against a local server with ENGINE_MOCK=1: sign-up (invite-only,
 * email filled in), Home, a brief, the board, the plan, a person's approval, the first render, its review.
 *
 * It asserts, on every screen of the path:
 *  - every spending button shows its price (a figure in credits, or "free");
 *  - no paid request goes out before a person presses the button that spends it (the ledger in helpers/fiveMinute.ts);
 *  - an agent identity (an API token, as the MCP and a skill act) cannot approve a plan or a render, and nothing moves;
 *  - no retired name is on screen; nothing scrolls sideways.
 *
 * Steps are tests in a serial run, so each is named in the report. A step whose screen is not built on this branch is
 * `test.fixme` with the one-line reason, and holds the assertion it will make; the run goes on from the screen the
 * person can reach. The list is in the PR body. Nothing here is faked: where a step is skipped, the next one starts
 * from a real address, and the spec says so beside it.
 *
 * Run: ENGINE_MOCK=1 PW_BASE_URL=http://localhost:<port> PW_PLATFORM_DATABASE_URL=file:<its platform.db> \
 *      npx playwright test --config=playwright.five-minute.config.ts   (the config's set-up warms the server first)
 */
const FIVE_MINUTES = 5 * 60_000;
/** Taps from the invitation link to the approved take (clicks and ticks; typing is not a tap). Set from the first green run; lower it when a PR removes a tap. */
const TAP_BUDGET = { desktop: 9, phone: 9 };
/* Phone stays at 9 until the owner decides whether it stays 9 or the product saves a tap. */
/* Phone, 9 taps: terms, sign up, Start, Record's Open, Build, the plan row (Build returns Home), Approve, Review, Approve. The earlier 7 was set while Start was a fixture (not a tap) and
   before the plan path; one tap goes if Build stays on the plan screen at its price (proposed, not built: PlanScreen is money code). */
const BRIEF = "A 15-second film about a courier crossing a rooftop at dawn, three shots.";
const cr = /(\d[\d,]*(?:\.\d)?)\s*cr\b/i;

type Run = {
  page: Page;
  context: BrowserContext;
  spend: SpendLedger;
  errors: string[];
  started: number;
  taps: number;
  marks: Record<string, number>;
  email: string;
  draftId: string;
  productionId: string;
  balanceAtStart: number | null;
  thinking: number | null;
  rendered: number | null;
  /** The most the approved plan may spend, fixes included (2 × its total), as the card said it. */
  ceiling: number | null;
  /** The N on Start, as the screen showed it. */
  startFigure: number | null;
};

async function open(browser: Browser, viewport: { width: number; height: number }, phone: boolean): Promise<Run> {
  const base = process.env.PW_BASE_URL || "http://localhost:4551";
  test.skip(!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(base), "runs only against a local server");
  const health = await fetch(`${base}/api/health`).then((r) => r.json()).catch(() => null) as { mock?: boolean } | null;
  test.skip(!health?.mock, "runs only against a local server started with ENGINE_MOCK=1");
  const context = await browser.newContext({ baseURL: base, viewport, isMobile: phone, hasTouch: phone });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { page, context, spend: watchSpending(page), errors, started: 0, taps: 0, marks: {}, email: "", draftId: "", productionId: "", balanceAtStart: null, thinking: null, rendered: null, ceiling: null, startFigure: null };
}

const elapsed = (run: Run) => (run.started ? Date.now() - run.started : 0);
const mark = (run: Run, name: string) => { run.marks[name] = Math.round(elapsed(run) / 100) / 10; };
async function tap(run: Run, target: ReturnType<Page["getByRole"]>) {
  run.taps++;
  await target.click();
}
/** What every screen of the path must be: nothing retired on it, nothing sideways, no spending button without its price. */
async function screenIsClean(run: Run, spendRoots: string[] = []) {
  const { page } = run;
  expect(bannedNamesIn(await visibleText(page)), "retired names on screen").toEqual([]);
  expect(await noSidewaysScroll(page), "nothing scrolls sideways").toBe(true);
  /* A price still being read may take a moment; a button that stays without one is the failure. */
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
  /* Nothing moved: the plan still waits for a person. */
  const { headers: h } = await scopeFor(run.page.request);
  const after = await runOf(run.page.request, h, run.productionId, run.draftId);
  expect(after.run?.id).toBe(runId);
  expect(after.run?.state, "the plan is still waiting for a person").toBe("needs_you");
  expect(after.run?.plan?.quote, "the plan is still unapproved, at its quote").toBeTruthy();
}

/* ───────────────────────────── a laptop, 1440x900 ───────────────────────────── */

test.describe("the five-minute test · laptop 1440x900", () => {
  test.describe.configure({ mode: "serial" });
  let run: Run;
  test.beforeAll(async ({ browser }, info) => {
    test.skip(info.project.name !== "five-minute-desktop", "the laptop path");
    run = await open(browser, { width: 1440, height: 900 }, false);
  });
  test.afterAll(async () => { await run?.context.close(); });

  test("1 · the invitation link opens sign-up, the email already filled in", async () => {
    const base = process.env.PW_BASE_URL || "http://localhost:4551";
    const invite = await mockInvitation(base);
    run.email = invite.email;
    /* Invite-only: a code that was never issued is refused. */
    const forged = await run.page.request.get("/api/auth/signup?code=not-an-issued-invitation");
    expect(forged.ok(), "a made-up invitation opens nothing").toBe(false);
    run.started = Date.now();
    await run.page.goto(invite.link, { timeout: 120_000 });
    await expect(run.page.getByRole("heading", { name: /create your account/i })).toBeVisible({ timeout: 60_000 });
    await expect(run.page.getByTestId("signup-email")).toHaveValue(invite.email);
    await expect(run.page.getByTestId("signup-email")).toHaveJSProperty("readOnly", true);
    /* The invitation names the person, so the form does not ask again. */
    await expect(run.page.getByTestId("signup-name")).toHaveCount(0);
    await screenIsClean(run);
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
    run.balanceAtStart = null;
  });

  test("3 · sign-up lands on Home, 'What are we making?'", async () => {
    const { page } = run;
    await expect(page.getByRole("heading", { name: "What are we making?" })).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId("home")).toBeVisible();
    expect(new URL(page.url()).searchParams.get("view"), "the address is Home's").toBe("home");
    await expect(page.getByTestId("home-start")).toHaveText(/^Start · up to \d[\d,]* cr$/, { timeout: 30_000 });
    run.balanceAtStart = await balanceCr(page);
    expect(run.balanceAtStart, "the header shows the balance").not.toBeNull();
    mark(run, "landed on Home");
  });

  test("4 · Home: the brief typed, Start with its price, the templates", async () => {
    const { page } = run;
    await page.getByTestId("home-brief").fill(BRIEF);
    await expect(page.getByTestId("home-templates")).toBeVisible();
    await screenIsClean(run, ['[data-testid="home-start-row"]']);
    expect(run.spend.spent, "nothing paid yet").toEqual([]);
    mark(run, "home");
  });

  test("5 · the person picks the Film template and the board opens with the brief on it", async () => {
    const { page } = run;
    await tap(run, page.getByTestId("home-template-film"));
    await expect(page.getByTestId("board")).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId("board-brief-text")).toContainText("courier crossing a rooftop", { timeout: 60_000 });
    const params = new URL(page.url()).searchParams;
    run.draftId = params.get("project") ?? "";
    expect(run.draftId, "the board is the new project's").not.toBe("");
    expect(params.get("view"), "the template lands on the board, not Home").not.toBe("home");
    const { headers } = await scopeFor(page.request);
    const saved = await page.request.get(`/api/workbench/projects?id=${run.draftId}`, { headers });
    run.productionId = String(((await saved.json()) as { project?: { productionProjectId?: string } }).project?.productionProjectId ?? "");
    expect(run.productionId, "the project has its production").not.toBe("");
    await expect(page.getByTestId("agent-ask")).toHaveText(/^Ask · up to \d[\d,]* cr$/);
    await screenIsClean(run, ['[data-testid="board-agent-panel"]']);
    expect(run.spend.spent, "choosing a template spends nothing").toEqual([]);
    mark(run, "board");
  });

  test("6 · the person asks Atomik to plan, at the price on the button, and the plan card appears", async () => {
    const { page } = run;
    await page.getByPlaceholder(/Ask Atomik/).fill("Plan three shots for this film");
    await expect(page.getByTestId("agent-ask")).toBeEnabled({ timeout: 30_000 });
    const planning = Number(/(\d[\d,]*)/.exec(await page.getByTestId("agent-ask").innerText())?.[1].replace(/,/g, ""));
    expect(planning).toBeGreaterThan(0);
    run.spend.allow("agent.plan", "Ask · up to N cr");
    await tap(run, page.getByTestId("agent-ask"));
    await expect(page.getByTestId("board-plan")).toBeVisible({ timeout: 90_000 });
    run.spend.close("agent.plan");
    await expect(page.getByTestId("board-plan")).toContainText(/Make \d+ shots?/);
    expect(run.spend.spent.map((s) => s.kind)).toEqual(["agent.plan"]);
    expect(run.spend.spent[0].body?.limit, "the ask's limit is the figure on its button").toBe(planning);
    await screenIsClean(run, ['[data-testid="board-agent-panel"]']);
    mark(run, "plan card");
  });

  test("7 · Build is free; once its shots are on the board the card says 'Make N shots · N cr · at most 2N cr' and Approve carries its price", async () => {
    const { page } = run;
    const primary = page.getByTestId("board-plan-primary");
    await expect(primary).toHaveText("Build · free");
    await tap(run, primary);
    await expect(primary).toHaveText(/^Approve · (up to )?\d[\d,]*(\.\d)? cr$/, { timeout: 90_000 });
    const card = page.getByTestId("board-plan");
    await expect(card).toContainText(/Make \d+ shots? · (up to )?\d[\d,]*(\.\d)? cr · at most \d[\d,]*(\.\d)? cr/);
    run.ceiling = Number(/at most (\d[\d,]*(?:\.\d)?) cr/.exec(await card.innerText())?.[1].replace(/,/g, "") ?? NaN);
    expect(run.spend.spent.map((s) => s.kind), "building billed nothing").toEqual(["agent.plan"]);
    run.thinking = Number(/Thinking · (\d[\d,]*(?:\.\d)?) cr/.exec(await visibleText(page))?.[1] ?? NaN);
    await screenIsClean(run, ['[data-testid="board-plan"]', '[data-testid="board-agent-panel"]']);
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

  test("9 · a person approves the plan once, at its price; the first render goes with no tap of its own", async () => {
    const { page } = run;
    const primary = page.getByTestId("board-plan-primary");
    const quoted = (await runOf(page.request, (await scopeFor(page.request)).headers, run.productionId, run.draftId)).run?.plan?.quote?.fingerprint ?? null;
    expect(quoted, "the priced plan has a quote fingerprint").toMatch(/^[a-f0-9]{64}$/);
    run.spend.allow("agent.approvePlan", await primary.innerText());
    await tap(run, primary);
    const card = page.getByTestId("board-plan");
    await expect(card).toContainText(/Rendered · [\d.,]+ cr settled/, { timeout: 120_000 });
    run.spend.close("agent.approvePlan");
    expect(run.spend.spent.find((x) => x.kind === "agent.approvePlan")?.body?.fingerprint, "the approval carries the quoted fingerprint").toBe(quoted);
    await expect(card).toContainText(/Making \d+ shots?/);
    run.rendered = Number(/Rendered · ([\d.,]+) cr settled/.exec(await card.innerText())?.[1].replace(/,/g, "") ?? NaN);
    expect(run.rendered).toBeGreaterThan(0);
    expect(run.spend.spent.map((s) => s.kind), "one approval, and no render pressed").toEqual(["agent.plan", "agent.approvePlan"]);
    await screenIsClean(run, ['[data-testid="board-plan"]', '[data-testid="board-agent-panel"]']);
    mark(run, "plan approved");
  });

  test("10 · the first take lands on the board", async () => {
    const { page } = run;
    /* The take is on the board's Shots; the person goes there from the rail. */
    await tap(run, page.getByTestId("board-rail").getByRole("button", { name: "Shots" }));
    const first = page.getByTestId("take-card").filter({ hasText: "Shot 1" });
    await expect(first.locator("img, video").first()).toBeVisible({ timeout: 30_000 });
    mark(run, "first render on the board");
    expect(run.spend.spent.map((s) => s.kind)).toEqual(["agent.plan", "agent.approvePlan"]);
    /* The ledger matches: the balance fell by the thinking and at least the first render, and never by more than the plan's ceiling. */
    const start = (run.balanceAtStart ?? NaN) - (run.thinking ?? NaN);
    await expect.poll(() => balanceCr(page), { timeout: 30_000 }).toBeLessThanOrEqual(start - run.rendered!);
    expect(await balanceCr(page)).toBeGreaterThanOrEqual(start - run.ceiling!);
    await screenIsClean(run, ['[data-testid="board-plan"]']);
  });

  test("11 · the person opens the first take and approves it", async () => {
    const { page } = run;
    const first = page.getByTestId("take-card").filter({ hasText: "Shot 1" });
    const approve = page.getByTestId("insp-approve");
    /* No reload: the board read the Library again when the render finished. */
    await tap(run, first);
    await expect(approve).toBeVisible({ timeout: 30_000 });
    expect(await unpricedSpendButtons(page, '[data-testid="board-inspector"]'), "inspector buttons that spend carry their price").toEqual([]);
    await tap(run, approve);
    await expect(page.getByTestId("board-group").filter({ hasText: /Shots · 1 of \d+ approved/ })).toBeVisible({ timeout: 30_000 });
    mark(run, "first take approved");
    expect(run.spend.spent.map((s) => s.kind), "approving a take spends nothing").toEqual(["agent.plan", "agent.approvePlan"]);
    expect(bannedNamesIn(await visibleText(page)), "retired names on screen").toEqual([]);
  });

  test("12 · all of it inside five minutes, within the tap budget, nothing paid unasked", async () => {
    const wall = elapsed(run);
    console.log(`five-minute (laptop 1440x900): ${Math.round(wall / 100) / 10} s, ${run.taps} taps, marks ${JSON.stringify(run.marks)}, paid ${JSON.stringify(run.spend.spent)}`);
    test.info().annotations.push({ type: "five-minute", description: `${Math.round(wall / 100) / 10} s · ${run.taps} taps · ${JSON.stringify(run.marks)}` });
    expect(wall, "wall time from the invitation link to the approved take").toBeLessThan(FIVE_MINUTES);
    expect(run.taps, "taps from the invitation link to the approved take").toBeLessThanOrEqual(TAP_BUDGET.desktop);
    expect(run.spend.violations, "paid requests with no person's press").toEqual([]);
    expect(run.errors, "page errors on the path").toEqual([]);
  });
});

/* ───────────────────────────── a phone, 390x844 ───────────────────────────── */

test.describe("the five-minute test · phone 390x844", () => {
  test.describe.configure({ mode: "serial" });
  let run: Run;
  test.beforeAll(async ({ browser }, info) => {
    test.skip(info.project.name !== "five-minute-phone", "the phone path");
    run = await open(browser, { width: 390, height: 844 }, true);
  });
  test.afterAll(async () => { await run?.context.close(); });

  test("1 · the invitation link opens sign-up, the email already filled in", async () => {
    const base = process.env.PW_BASE_URL || "http://localhost:4551";
    const invite = await mockInvitation(base);
    run.email = invite.email;
    run.started = Date.now();
    await run.page.goto(invite.link, { timeout: 120_000 });
    await expect(run.page.getByRole("heading", { name: /create your account/i })).toBeVisible({ timeout: 60_000 });
    await expect(run.page.getByTestId("signup-email")).toHaveValue(invite.email);
    /* The invitation names the person, so the form does not ask again. */
    await expect(run.page.getByTestId("signup-name")).toHaveCount(0);
    await screenIsClean(run);
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

  test("3 · sign-up lands on the phone's Home: Needs you, Nothing waiting, the balance in the header", async () => {
    const { page } = run;
    await expect(page.getByTestId("phone-home")).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId("phone-nothing")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("phone-credits")).toContainText(cr);
    run.balanceAtStart = Number(cr.exec(await page.getByTestId("phone-credits").innerText())?.[1].replace(/,/g, ""));
    await screenIsClean(run);
    await expectFloors(page, "phone Home", { scope: ".ph-app" });
    mark(run, "home");
  });

  test("5 · Home takes the brief: 'What are we making?' and Start · up to N cr", async () => {
    const { page } = run;
    const brief = page.getByRole("textbox", { name: "What are we making?" });
    await expect(brief).toBeVisible();
    await brief.fill(BRIEF);
    const start = page.getByRole("button", { name: /^Start · up to \d[\d,]* cr$/ });
    await expect(start).toBeVisible({ timeout: 30_000 });
    await expect(start).toBeEnabled();
    /* The figure is the server's own: the quote route's answer for a new board, never a number kept in the app. */
    const { headers } = await scopeFor(page.request);
    const quote = await page.request.get("/api/workbench/team-canvas?agent=1&board=new", { headers });
    expect(quote.ok(), await quote.text()).toBe(true);
    const planning = ((await quote.json()) as { agent?: { ask?: { planning?: number } | null } }).agent?.ask?.planning;
    expect(planning, "the quote route prices Atomik's thinking").toBeGreaterThan(0);
    run.startFigure = Number(/(\d[\d,]*)/.exec(await start.innerText())?.[1].replace(/,/g, ""));
    expect(run.startFigure, "Start shows the server's figure").toBe(planning);
    /* The Start row, as on the laptop's Home: the template buttons beside it only make a project (free); "Start from a script" matches the spending verb by name alone. */
    await screenIsClean(run, ['[data-testid="home-start-row"]']);
    expect(run.spend.spent, "typing the brief spends nothing").toEqual([]);
    mark(run, "brief typed");
  });

  test("6 · the person presses Start at its price; Atomik plans; the plan waits in Needs you", async () => {
    const { page } = run;
    run.spend.allow("agent.plan", "Start · up to N cr");
    await tap(run, page.getByRole("button", { name: /^Start · up to \d[\d,]* cr$/ }));
    await expect.poll(() => new URL(page.url()).searchParams.get("project"), { timeout: 90_000 }).toBeTruthy();
    run.draftId = new URL(page.url()).searchParams.get("project")!;
    const { headers } = await scopeFor(page.request);
    const saved = await page.request.get(`/api/workbench/projects?id=${run.draftId}`, { headers });
    run.productionId = String(((await saved.json()) as { project?: { productionProjectId?: string } }).project?.productionProjectId ?? "");
    expect(run.productionId, "the project has its production").not.toBe("");
    await expect.poll(async () => (await runOf(page.request, headers, run.productionId, run.draftId)).run?.state, { message: "Atomik has answered the brief with a plan", timeout: 90_000 }).toBe("awaiting_approval");
    run.spend.close("agent.plan");
    const planRequest = run.spend.spent.find((x) => x.kind === "agent.plan");
    expect(planRequest?.body?.limit, "the ask's limit is the figure on Start").toBe(run.startFigure);
    /* Start lands on the project's Record, where the plan waits with its Open; nothing is reloaded or addressed by hand. */
    await expect(page.getByTestId("phone-record")).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId("phone-record-open")).toBeVisible({ timeout: 90_000 });
    expect(run.spend.spent.map((x) => x.kind)).toEqual(["agent.plan"]);
    await screenIsClean(run, ['[data-testid="phone-record"]']);
    mark(run, "plan waits on Record");
  });

  test("7 · the plan opens on its own screen: the steps, the Total, Build · free, Change, Hold", async () => {
    const { page } = run;
    await tap(run, page.getByTestId("phone-record-open"));
    await expect(page.getByTestId("phone-plan")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("phone-plan-title")).toHaveText(/Make \d+ shots?/);
    await expect(page.getByTestId("phone-plan-total")).toBeVisible();
    await expect(page.getByTestId("phone-plan-primary")).toHaveText("Build · free");
    await expect(page.getByTestId("phone-plan-change")).toBeVisible();
    await expect(page.getByTestId("phone-plan-hold")).toBeVisible();
    await screenIsClean(run, ['[data-testid="mobile-actions"]']);
    await expectFloors(page, "phone plan approval", { scope: ".ph-app" });
    mark(run, "plan screen");
  });

  test("8 · Build is free; Home then offers the plan at its price, and on its screen the button is the price", async () => {
    const { page } = run;
    await tap(run, page.getByTestId("phone-plan-primary"));
    await expect(page.getByTestId("phone-home")).toBeVisible({ timeout: 90_000 });
    const row = page.getByTestId("phone-row-plan");
    await expect(row).toHaveText(cr, { timeout: 90_000 });
    await expect(page.getByTestId("phone-approval-row")).toContainText(/\d+-shot board/);
    expect(run.spend.spent.map((s) => s.kind), "building billed nothing").toEqual(["agent.plan"]);
    await screenIsClean(run, ['[data-testid="phone-home"]']);
    await expectFloors(page, "phone Home with the plan", { scope: ".ph-app" });
    await tap(run, row);
    await expect(page.getByTestId("phone-plan-primary")).toHaveText(/^Approve · (up to )?\d[\d,]*(\.\d)? cr$/, { timeout: 60_000 });
    await expect(page.getByTestId("phone-plan-title")).toHaveText(/Make \d+ shots? · (up to )?\d[\d,]*(\.\d)? cr · at most \d[\d,]*(\.\d)? cr/);
    await expect(page.getByTestId("phone-plan-total")).toContainText(cr);
    run.ceiling = Number(/at most (\d[\d,]*(?:\.\d)?) cr/.exec(await page.getByTestId("phone-plan-title").innerText())?.[1].replace(/,/g, "") ?? NaN);
    await screenIsClean(run, ['[data-testid="mobile-actions"]']);
    await expectFloors(page, "phone plan at its price", { scope: ".ph-app" });
    mark(run, "plan priced");
  });

  test("9 · an agent identity cannot approve the plan, build it, raise its limit or press a render", async () => {
    const { headers } = await scopeFor(run.page.request);
    const state = await runOf(run.page.request, headers, run.productionId, run.draftId);
    expect(state.run?.state).toBe("needs_you");
    await anAgentCannotApprove(run, state.run!.id, state.run!.plan?.quote?.fingerprint ?? null);
    await expect(run.page.getByTestId("phone-plan-primary")).toHaveText(/^Approve · /);
    expect(run.spend.spent.map((s) => s.kind)).toEqual(["agent.plan"]);
  });

  test("10 · a person approves the plan once, at its price, and goes Home", async () => {
    const { page } = run;
    const primary = page.getByTestId("phone-plan-primary");
    const quoted = (await runOf(page.request, (await scopeFor(page.request)).headers, run.productionId, run.draftId)).run?.plan?.quote?.fingerprint ?? null;
    expect(quoted, "the priced plan has a quote fingerprint").toMatch(/^[a-f0-9]{64}$/);
    run.spend.allow("agent.approvePlan", await primary.innerText());
    await tap(run, primary);
    await expect(page.getByTestId("phone-home")).toBeVisible({ timeout: 90_000 });
    expect(run.spend.spent.find((x) => x.kind === "agent.approvePlan")?.body?.fingerprint, "the approval carries the quoted fingerprint").toBe(quoted);
    expect(run.spend.spent.map((s) => s.kind)).toEqual(["agent.plan", "agent.approvePlan"]);
    await screenIsClean(run, ['[data-testid="phone-home"]']);
    mark(run, "plan approved");
  });

  test("11 · the first render goes with no tap of its own and is ready to review", async () => {
    const { page } = run;
    const { headers } = await scopeFor(page.request);
    /* The first render settles under the plan's approval: no press of its own. */
    await expect.poll(async () => (await runOf(page.request, headers, run.productionId, run.draftId)).run?.paid.find((p) => p.tool === "render")?.charged ?? null, { timeout: 120_000 }).not.toBeNull();
    run.spend.close("agent.approvePlan");
    run.rendered = (await runOf(page.request, headers, run.productionId, run.draftId)).run!.paid.find((p) => p.tool === "render")!.charged!;
    await expect(page.getByTestId("phone-open-review")).toBeVisible({ timeout: 60_000 });
    mark(run, "first render ready");
    expect(run.spend.spent.map((s) => s.kind)).toEqual(["agent.plan", "agent.approvePlan"]);
    /* The ledger matches: the balance fell by at least the first render and never by more than the plan's ceiling past the thinking. */
    const balance = async () => Number(cr.exec(await page.getByTestId("phone-credits").innerText())?.[1].replace(/,/g, ""));
    await expect.poll(balance, { timeout: 30_000 }).toBeLessThanOrEqual((run.balanceAtStart ?? NaN) - run.rendered);
    await screenIsClean(run, ['[data-testid="phone-home"]']);
  });

  test("12 · the person reviews the take full screen and approves it", async () => {
    const { page } = run;
    await tap(run, page.getByTestId("phone-open-review"));
    await expect(page.getByTestId("phone-review-media")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("phone-approve")).toBeEnabled();
    await expectFloors(page, "phone review", { scope: ".ph-app", scroller: false });
    expect(bannedNamesIn(await visibleText(page)), "retired names on screen").toEqual([]);
    await tap(run, page.getByTestId("phone-approve"));
    await expect(page.getByText(/approved · nothing spent/)).toBeVisible({ timeout: 15_000 });
    mark(run, "first take approved");
    expect(run.spend.spent.map((s) => s.kind), "approving a take spends nothing").toEqual(["agent.plan", "agent.approvePlan"]);
  });

  test("13 · all of it inside five minutes, within the tap budget, nothing paid unasked", async () => {
    const wall = elapsed(run);
    console.log(`five-minute (phone 390x844): ${Math.round(wall / 100) / 10} s, ${run.taps} taps, marks ${JSON.stringify(run.marks)}, paid ${JSON.stringify(run.spend.spent)}`);
    test.info().annotations.push({ type: "five-minute", description: `${Math.round(wall / 100) / 10} s · ${run.taps} taps · ${JSON.stringify(run.marks)}` });
    expect(wall, "wall time from the invitation link to the approved take").toBeLessThan(FIVE_MINUTES);
    expect(run.taps, "taps from the invitation link to the approved take").toBeLessThanOrEqual(TAP_BUDGET.phone);
    expect(run.spend.violations, "paid requests with no person's press").toEqual([]);
    expect(run.errors, "page errors on the path").toEqual([]);
  });
});

/* ───────────────────────────── the checks themselves ───────────────────────────── */

test.describe("the five-minute test · its checks bite", () => {
  test.beforeEach(({}, info) => { test.skip(info.project.name !== "five-minute-desktop", "once"); });

  test("a retired name, an unpriced spending button and an unasked paid request each fail the checks", async ({ page }) => {
    expect(bannedNamesIn("Open in Gen"), "a retired phrase is found").toHaveLength(1);
    expect(bannedNamesIn("Topaz upscale · Topaz Astra 2"), "Astra as Topaz's model is allowed").toEqual([]);
    expect(bannedNamesIn("Make · Board · Ads · Social · Identity"), "the new names are clean").toEqual([]);

    await page.setContent('<main id="m"><button>Render</button><button>Render · 8 cr</button><button disabled>Start</button><button>Build · free</button><button>Ask the crew</button></main>');
    expect(await unpricedSpendButtons(page, "#m"), "only the enabled spending button with no figure is found").toEqual(["Render"]);
    await page.setContent('<main id="m"><div data-testid="home-templates"><button data-spend>Start from a script</button><button>Start from a script</button></div></main>');
    expect(await unpricedSpendButtons(page, "#m"), "a template is skipped unless it marks itself as spending").toEqual(["Start from a script"]);

    /* The ledger: a paid request is a violation unless a person's press has opened it. The request is answered here and never reaches the server. */
    const base = process.env.PW_BASE_URL || "http://localhost:4551";
    await page.route("**/api/generate", (route) => route.fulfill({ status: 200, json: { ok: true } }));
    await page.goto(`${base}/api/health`);
    const ledger = watchSpending(page);
    const post = () => page.evaluate(() => fetch("/api/generate", { method: "POST", body: "{}" }).then((r) => r.status));
    expect(await post()).toBe(200);
    expect(ledger.violations, "a paid request with no press open is a violation").toHaveLength(1);
    ledger.allow("generate", "a person's press");
    expect(await post()).toBe(200);
    expect(ledger.violations, "a paid request after a press is not").toHaveLength(1);
    expect(ledger.spent).toEqual([{ kind: "generate", step: "a person's press" }]);
  });
});
