import { test, expect, type Page } from "@playwright/test";
import { openShotsBoard, ROUND_ROWS } from "./helpers/shotsV12";

/**
 * Client rounds in the new interface (redesign P2-c; lib/v12/rounds.ts; docs/redesign/inventory.md § 6.7, § 11): a client's reply
 * pasted into the board's bar is asked of Atomik by today's ask (`agent.plan`, the figure on the button as its limit); the plan
 * lists its renders at the server's own prices, with the client's words only as "Asked: …" context, and is approved once by a
 * person ("Approve all · N cr", today's `agent.approvePlan`). A round is kept in the board's draft only for shots whose own cards
 * the plan renders again, recorded as what Atomik did (never the client's words as if applied), with its "What changed" list,
 * Compare R1 / R2 in Cut and the words to copy. The planner is the local scripted one (ENGINE_MOCK=1), which renders none of the
 * client's shots, so the live run keeps no round; the round's display is tested on a seeded board. Renders are the mock's.
 * Desktop with the switch on; phones keep today's phone board.
 */
const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const PHONE = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const REPLY = "Loving it. Shot 2 — sphere bigger in the wide. Shot 4: bottle fuller, label to camera. Shot 7 lose the second figure. Rest approved";
const shots = (page: Page) => page.locator('.bd-node[data-card-kind="take"]');
const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

async function closeDock(page: Page) {
  const collapse = page.getByTestId("agent-collapse");
  await collapse.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
  let quiet = 0;
  await expect.poll(async () => {
    if (await collapse.isVisible().catch(() => false)) { await collapse.click({ timeout: 2_000 }).catch(() => {}); quiet = 0; return false; }
    quiet = (await page.getByTestId("board-agent-panel").count()) === 0 ? quiet + 1 : 0;
    return quiet >= 8;
  }, { timeout: 30_000, intervals: [250] }).toBe(true);
}

test.describe("desktop, switch on", () => {
  test.beforeEach(({}, info) => test.skip(!DESKTOP.includes(info.project.name), "desktop sizes"));

  test("the reply is asked as a client round, planned and priced by the server, approved once; no round is kept for renders that are not the client's shots", async ({ page }) => {
    test.setTimeout(420_000);
    const posts: Record<string, unknown>[] = [];
    /* The server's own answer about the plan, as the board last read it: its quote before the approval, its record after. */
    const planNow: { plan: { quote: { total: number; fingerprint: string } | null; approval: { total: number } | null } | null } = { plan: null };
    await page.route("**/api/workbench/team-canvas**", async (route) => {
      const request = route.request();
      if (request.method() === "POST") { posts.push(request.postDataJSON() as Record<string, unknown>); return route.fallback(); }
      const response = await route.fetch();
      const body = await response.json().catch(() => null) as { agent?: { run?: { plan?: typeof planNow.plan; paid?: unknown[] } | null } } | null;
      if (body?.agent?.run?.plan) planNow.plan = body.agent.run.plan;
      return route.fulfill({ response, json: body });
    });
    const { errors } = await openShotsBoard(page, "/suites?view=board&stage=shots");
    await expect(shots(page)).toHaveCount(8, { timeout: 90_000 });
    await closeDock(page);

    /* Pasted into the bar: recognised, with a change per shot. */
    const input = page.getByTestId("v12-board-bar-inner-input");
    await input.fill(REPLY);
    await expect(page.getByTestId("v12-board-bar-feedback")).toHaveText(/^Client feedback · 3 changes/);
    const price = page.getByTestId("v12-board-bar-price");
    await expect(price).toHaveAttribute("data-price-state", "ready", { timeout: 30_000 });
    const limit = Number((await price.innerText()).replace(/[^\d]/g, ""));

    /* Asked as today's ask, with the figure on the button as its limit, in words that say what it is. */
    await page.getByTestId("v12-board-bar-ask").click();
    await expect.poll(() => posts.find((p) => p.action === "agent.plan")).toBeTruthy();
    const ask = posts.find((p) => p.action === "agent.plan")!;
    expect(ask.limit).toBe(limit);
    expect(String(ask.goal)).toMatch(/^Client feedback, one change per shot; the rest stay as they are: Loving it\. Shot 2/);

    /* The plan: a client round, a step per shot, the one approval. */
    const plan = page.locator('[data-card-id="plan:run"]').getByTestId("board-plan");
    await expect(plan).toBeVisible({ timeout: 90_000 });
    await expect(plan).toContainText("Client round");
    /* No step is one of the client's shots here, so the card does not promise a round's list. */
    await expect(plan).not.toContainText("The rest stay approved");
    await expect(page.getByTestId("v12-round-badge")).toHaveCount(0);
    /* Building the board is free; then the server prices every render and the card is the plan gate. */
    await plan.getByTestId("board-plan-primary").click();
    const approve = plan.getByTestId("board-plan-primary");
    await expect(approve).toHaveText(/^Approve all · \d[\d,.]* cr$/, { timeout: 120_000 });
    await expect(plan.getByTestId("board-plan-step")).toHaveCount(3);
    /* The scripted planner builds its own starter shots: none of its renders is a card of the client's shots, so no step is matched to
       a shot, none is labelled with the client's words, and the title counts no changes. A step is never matched by title or place. */
    await expect(plan).toContainText("Client round");
    await expect(plan).not.toContainText("Asked:");
    await expect(plan).not.toContainText(/\d+ changes?/);
    /* Every step carries the server's own price. */
    for (const step of await plan.getByTestId("board-plan-step").all()) await expect(step).toContainText(/\d[\d,.]* cr|priced when it runs/);
    expect(await noSideways(page)).toBe(true);

    /* A person approves it, once: today's plan approval, at the server's quote. */
    const shown = Number((await approve.innerText()).replace(/[^\d]/g, ""));
    const quoted = planNow.plan?.quote;
    expect(quoted, "the server's quote was read before the approval").toBeTruthy();
    expect(quoted!.total, "the button shows the server's own total").toBe(shown);
    await approve.click();
    await expect.poll(() => posts.find((p) => p.action === "agent.approvePlan")).toBeTruthy();
    expect(posts.filter((p) => p.action === "agent.approvePlan")).toHaveLength(1);
    /* What was approved is what was shown: the fingerprint sent is the server's quote's, and its record holds the same total. */
    expect(posts.find((p) => p.action === "agent.approvePlan")!.fingerprint).toBe(quoted!.fingerprint);
    await expect.poll(() => planNow.plan?.approval?.total, { timeout: 60_000 }).toBe(shown);

    /* A render makes the card's prompt again: nothing the client asked was applied, so the round is kept only for the shots whose
       own cards the plan re-renders. Here none is, so no round is recorded and nothing is offered to copy to the client.
       (The round with its list, Compare and words to copy is the next test, on a board that has one.) */
    await expect(plan.getByTestId("board-plan-step").first()).toBeVisible();
    await page.waitForTimeout(4_000);
    await expect(page.getByTestId("v12-round-badge")).toHaveCount(0);
    expect(await noSideways(page)).toBe(true);
    expect(errors).toEqual([]);
  });

  test("a board with a round: R2 on the shots it changed, the list on Storyboard, Compare R1 / R2 in Cut, the words to copy from Deliver and ⋯", async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __copied: string[] };
      w.__copied = [];
      Object.defineProperty(navigator, "clipboard", { value: { writeText: (text: string) => { w.__copied.push(text); return Promise.resolve(); } }, configurable: true });
    });
    const { errors } = await openShotsBoard(page, "/suites?view=board&stage=shots", { rows: ROUND_ROWS, round: true });
    await expect(shots(page)).toHaveCount(8, { timeout: 90_000 });
    await closeDock(page);
    await expect(page.getByTestId("v12-round-badge")).toHaveText("Round 2 · 3 changed");
    /* R2 on the shots the round changed, and no others. */
    await expect(page.getByTestId("take-round")).toHaveCount(3);
    for (const n of [1, 3, 6]) await expect(shots(page).nth(n)).toBeVisible();
    await expect(shots(page).nth(1).getByTestId("take-round")).toHaveText("R2");
    await expect(shots(page).nth(0).getByTestId("take-round")).toHaveCount(0);
    /* The stage header says it once, the badge: the stage's meta does not repeat it. */
    await expect(page.getByTestId("v12-stage-meta")).not.toContainText("Round 2");

    await page.getByTestId("v12-stage-rail").getByText("Storyboard", { exact: true }).click();
    const changed = page.locator('[data-card-id="round:changed"]');
    await expect(changed.getByTestId("v12-round-line")).toHaveText([/Shot 2: Wide/, /Shot 4: Close/, /Shot 7: Reveal/], { timeout: 60_000 });
    await expect(changed).toContainText("3 shots redrawn in Round 2; the other 5 are untouched. R1 is kept.");
    await changed.getByTestId("v12-round-copy-card").click();
    const first = (await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied))[0];
    expect(first).toMatch(/^Harbour film · R2 · \d{1,2} \w{3} \d{4}\nWhat changed in round 2:\n• Shot 2: Wide\n• Shot 4: .+\n• Shot 7: .+\nThe other 5 shots are unchanged\.$/);

    await page.getByTestId("v12-stage-rail").getByText("Cut", { exact: true }).click();
    await page.locator('[data-card-id="round:cut"]').getByTestId("v12-round-compare").click();
    const compare = page.getByTestId("v12-compare");
    await expect(compare).toBeVisible();
    await expect(compare.getByTestId("v12-compare-shot")).toHaveText(["Shot 2", "Shot 4", "Shot 7"]);
    const sides = compare.getByTestId("v12-compare-side");
    await expect(sides).toHaveCount(2);
    await expect(sides.nth(0)).toContainText("R1");
    await expect(sides.nth(0)).toContainText("v1");
    await expect(sides.nth(1)).toContainText("R2");
    await expect(sides.nth(1)).toContainText("v2");
    await expect(sides.nth(0).locator("img")).toHaveCount(1);
    await expect(sides.nth(1).locator("img")).toHaveCount(1);
    await compare.getByTestId("v12-compare-shot").nth(1).click();
    await expect(compare.getByTestId("v12-compare-shot").nth(1)).toHaveAttribute("aria-pressed", "true");
    /* Esc closes it and nothing else. */
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("v12-compare")).toHaveCount(0);

    await page.getByTestId("v12-stage-rail").getByText("Deliver", { exact: true }).click();
    const share = page.locator('[data-card-id="round:deliver"]');
    await expect(share).toContainText("Share round 2");
    await share.getByTestId("v12-round-copy-card").click();
    await expect(page.getByTestId("v12-toast")).toContainText("Copied · paste it into WhatsApp or email");
    await page.getByTestId("v12-board-menu").click();
    await expect(page.getByRole("menuitem", { name: "Share R2 · copy what changed" })).toBeVisible();
    await page.keyboard.press("Escape");
    /* Nothing offers an MP4 or a Send: neither is built. */
    await expect(page.getByText(/MP4|Send via/)).toHaveCount(0);
    expect(await noSideways(page)).toBe(true);
    expect(errors).toEqual([]);
  });

  test("an ordinary ask is not a client round", async ({ page }) => {
    const { errors } = await openShotsBoard(page, "/suites?view=board&stage=shots");
    await expect(shots(page)).toHaveCount(8, { timeout: 90_000 });
    await closeDock(page);
    await page.getByTestId("v12-board-bar-inner-input").fill("Warmer light on the whole board");
    await expect(page.getByTestId("v12-board-bar-feedback")).toHaveCount(0);
    await page.getByTestId("v12-board-bar-inner-input").fill("Shot 3 needs more light");
    await expect(page.getByTestId("v12-board-bar-feedback")).toHaveCount(0);
    await page.getByTestId("v12-board-bar-inner-input").fill("The client says shot 3 needs more light");
    await expect(page.getByTestId("v12-board-bar-feedback")).toHaveText(/^Client feedback · 1 change/);
    expect(errors).toEqual([]);
  });

  test("switch off: today's board, with no round and no bar", async ({ page }) => {
    /* Even a draft that holds a round (saved on the new interface) shows none of it on today's board. */
    await openShotsBoard(page, "/suites?view=board", { on: false, round: true, rows: ROUND_ROWS });
    await expect(shots(page)).toHaveCount(8, { timeout: 90_000 });
    await expect(page.getByTestId("v12-round-badge")).toHaveCount(0);
    await expect(page.getByTestId("v12-round-card")).toHaveCount(0);
    await expect(page.getByText(/Compare R1 \/ R2|Share round|what changed/i)).toHaveCount(0);
    await expect(page.getByTestId("v12-board-bar")).toHaveCount(0);
  });
});

test.describe("phones, switch on", () => {
  test.beforeEach(({}, info) => test.skip(!PHONE.includes(info.project.name), "phone sizes"));
  test("today's phone board: no round, no bar, no sideways scroll", async ({ page }) => {
    const { errors } = await openShotsBoard(page, "/suites?view=board", { round: true, rows: ROUND_ROWS });
    await expect(page.locator("[data-phone], [data-testid='phone-app']").first()).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId("v12-round-badge")).toHaveCount(0);
    await expect(page.getByTestId("v12-round-card")).toHaveCount(0);
    expect(await noSideways(page)).toBe(true);
    expect(errors).toEqual([]);
  });
});
