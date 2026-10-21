import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { isCompact } from "./helpers/shellMode";

/*
 * v25 PR 7: Director on Shots (components/v12/board/DirectorColumn.tsx, DirectorBar.tsx, use-director-render.ts), on the test-only page app/(test)/v25-board-parts
 * (a 404 outside a local ENGINE_MOCK=1 development server). The shots are mock; the batch press route (POST /api/generate/batch, #815) and the job reads are
 * answered here, so what is checked is what the bar asks of the real route: a multi-shot press is ONE job with one approval for the total. The price is the
 * server's quote for the whole press; a press the workspace's monthly cap would not cover is refused at the quote and nothing can be pressed; a press quotes
 * again and sends nothing if the total moved; it is sent once, the total as its ceiling with the quote's fingerprint, under one Idempotency-Key that a lost
 * reply reuses; never shot by shot. "Making…" until the takes settle, "Cancel" (the press's own cancel) only while one is still queued, then "Next: Edit →".
 * Nothing real is spent.
 */
/* The test page's stand-in pick, centred first. Below 1000 px the test page puts the bar in the page's flow, after the column; on the board, the wiring PR keeps the bar clear of the column and the home indicator. */
async function pickEngine(page: Page) {
  const button = page.getByTestId("v25-parts-pick-engine");
  await button.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await button.click();
}
type Sent = { body: Record<string, unknown>; key: string | undefined };
type Member = { index: number; id?: string; status?: string; error?: string; code?: number; charged?: number };
/** A synthetic refusal, as the batch route answers a press over the workspace's monthly cap (429, in the cap's own words). Test text, not the product's. */
const CAP_WORDS = "Synthetic test refusal: this press would pass the monthly spending limit.";
/** A synthetic failed take's failure, as the jobs route sends it, with the ledger's charge: `credits` 0 is known free. */
const failure = (credits: number) => ({ provider: null, stage: null, code: "unknown", kind: "unknown", message: null, billing: null, payer: null, charge: { credits, settled: true } });
type Opts = {
  credits?: (body: Record<string, unknown>) => number; engine?: boolean; capAtQuote?: boolean;
  /** The first N presses reach the server, which starts them, and their replies are lost. */
  lose?: number;
  /** From the first press on, a quote is refused at the cap (it counts the running shots a second time). */
  capAfterPress?: boolean;
  /** A refusal at the quote: its status and words. */
  quoteRefusal?: { status: number; error: string };
  /** The server's answer to the Nth press (1-based) instead of starting every shot: a status and a body, or "partial" (the last shot refused at no charge). */
  answer?: (n: number) => { status: number; json: Record<string, unknown> } | "partial" | "starting" | null;
  /** The server does not start a failed take again (it does not know it to be free): an ask brings back the same takes. */
  noRestart?: boolean;
  /**
   * The batch route after fix/batch-press-claims-first: a quote under the press's key adds `toStart` (the shots left), `approval` and `pressed`; a press reply
   * adds `approval` and, when shots did not start, `toStart`; a 409 for a moved total carries the press's next quote. Without it, today's route.
   */
  keyed?: boolean;
};
async function routes(page: Page, opts: Opts = {}) {
  const quotes: Record<string, unknown>[] = [], sent: Sent[] = [], cancels: string[] = [], single: string[] = [], fingerprints: string[] = [];
  /* Each quote's Idempotency-Key (undefined: a quote of a new press). */
  const quoteKeys: (string | undefined)[] = [];
  /* The total each press was approved at (keyed route only). */
  const approved = new Map<string, number>();
  /* The server's own record of each press, by its Idempotency-Key: asked again, a shot that started is that take and never starts twice. */
  const presses = new Map<string, (string | null)[]>();
  const started: string[] = [];
  const state = { phase: "queued" as "queued" | "running" | "succeeded", bump: 0, lose: opts.lose ?? 0, capAtQuote: Boolean(opts.capAtQuote), pressed: false,
    /** A settled take's own answer, by its id (a failure, with what it cost). */
    takes: {} as Record<string, Record<string, unknown>> };
  const priceOf = opts.credits ?? ((b) => (b.resolution === "480p" ? 7 : 43));
  const sha = (b: unknown) => createHash("sha256").update(JSON.stringify(b)).digest("hex");
  /* Never shot by shot: a per-shot quote or send is recorded, and every test below expects none. */
  await page.route("**/api/generate/quote", async (route) => { single.push("quote"); await route.fulfill({ status: 500, json: { error: "not this route" } }); });
  await page.route("**/api/generate", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    single.push("send");
    await route.fulfill({ status: 500, json: { error: "not this route" } });
  });
  await page.route("**/api/generate/batch", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    const key = route.request().headers()["idempotency-key"];
    if (body.cancel === true) {
      cancels.push(String(key));
      const ids = presses.get(String(key)) ?? [];
      return route.fulfill({ json: { status: "cancelled", members: ids.map((id, index) => (id ? { index, id, status: "cancelled", charged: 0 } : { index, status: "cancelled", charged: 0 })) } });
    }
    const members = body.members as Record<string, unknown>[];
    const total = members.reduce((n, m) => n + priceOf(m) + state.bump, 0);
    const fingerprint = sha({ members, total });
    /* The keyed route's view of a press: the shots left (never started, or failed at no charge) at today's price, and the approval it holds. */
    const isFree = (id: string | null) => !opts.noRestart && Boolean(id) && (state.takes[id!]?.failure as { charge?: { credits: number } } | undefined)?.charge?.credits === 0;
    const keyedOf = (k: string | undefined) => {
      if (!opts.keyed || !k || !presses.has(k)) return {};
      const ids = presses.get(k)!;
      const left = members.flatMap((m, i) => (!ids[i] || isFree(ids[i]) ? [priceOf(m) + state.bump] : []));
      const credits = left.reduce((n, c) => n + c, 0);
      const max = approved.get(k);
      return { toStart: { members: left.length, estimatedCredits: credits, price: credits, unit: "cr" }, approval: max == null ? null : { maxCredits: max, expiresAt: Date.now() + 6 * 86_400_000, expired: false, covers: !left.length || total <= max }, pressed: ids.map((id, index) => (id ? { index, id, status: "queued" } : { index })) };
    };
    if (body.quoteOnly === true) {
      quotes.push(body);
      quoteKeys.push(key);
      if (opts.quoteRefusal) return route.fulfill({ status: opts.quoteRefusal.status, json: { error: opts.quoteRefusal.error } });
      if (state.capAtQuote || (opts.capAfterPress && state.pressed)) return route.fulfill({ status: 429, json: { error: CAP_WORDS } });
      fingerprints.push(fingerprint);
      return route.fulfill({ json: { estimatedCredits: total, price: total, unit: "cr", members: members.length, batchId: `bt_${fingerprint.slice(0, 24)}`, fingerprint, ...keyedOf(key) } });
    }
    sent.push({ body, key });
    /* The route's own checks, as lib/batchPress.ts makes them: the approval is the quote's fingerprint and covers the total. */
    if (body.fingerprint !== fingerprint) {
      if (opts.keyed) fingerprints.push(fingerprint);
      return route.fulfill({ status: 409, json: { error: "The shots or their prices changed. Look at the total again before approving.", quoteChanged: true, ...(opts.keyed ? { quote: { estimatedCredits: total, price: total, unit: "cr", members: members.length, fingerprint, ...keyedOf(key) } } : {}) } });
    }
    if (body.maxCredits !== total) return route.fulfill({ status: 409, json: { error: "Approve the price first: the total is above the approved credit amount." } });
    state.pressed = true;
    const answer = opts.answer?.(sent.length) ?? null;
    if (answer && answer !== "partial" && answer !== "starting") {
      /* The keyed route records a press's shots and its approval before the first shot is tried, so a press refused whole is still read under its key. */
      if (opts.keyed && !presses.has(String(key))) { presses.set(String(key), members.map(() => null)); approved.set(String(key), total); }
      return route.fulfill(answer);
    }
    /* Each shot not yet started under this key starts now (a free failure starts again, as the server's failedFree allows); one already started is that take. */
    const ids = presses.get(String(key)) ?? members.map(() => null);
    const out: Member[] = members.map((_, index) => {
      if (answer === "partial" && index === members.length - 1) return { index, error: "Synthetic test refusal: the hour's renders are used.", code: 429, charged: 0 };
      if (answer === "starting" && index === members.length - 1) return { index, status: "starting" };
      const was = ids[index];
      const freeFailure = !opts.noRestart && was && (state.takes[was]?.failure as { charge?: { credits: number } } | undefined)?.charge?.credits === 0;
      if (!was || freeFailure) { ids[index] = `gen_dir_${started.length + 1}`; started.push(ids[index]!); }
      return { index, id: ids[index]!, status: "queued" };
    });
    presses.set(String(key), ids);
    if (!approved.has(String(key)) || body.maxCredits !== approved.get(String(key))) approved.set(String(key), total);
    if (state.lose > 0) { state.lose -= 1; return route.abort("connectionreset"); }
    const refused = out.filter((m) => m.error).length;
    const leftOver = members.flatMap((m, i) => (out[i].error ? [priceOf(m) + state.bump] : [])).reduce((n, c) => n + c, 0);
    await route.fulfill({ json: { id: `bt_${fingerprint.slice(0, 24)}`, batchId: `bt_${fingerprint.slice(0, 24)}`, status: refused ? "partial" : "started", estimatedCredits: total, members: out,
      ...(opts.keyed ? { approval: { maxCredits: approved.get(String(key)), expiresAt: Date.now() + 7 * 86_400_000 }, ...(refused ? { toStart: { members: refused, estimatedCredits: leftOver, price: leftOver, unit: "cr" } } : {}) } : {}) } });
  });
  await page.route("**/api/jobs/gen_dir_*", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const id = new URL(route.request().url()).pathname.split("/").pop()!;
    await route.fulfill({ json: { generation: state.takes[id] ?? { id, status: state.phase } } });
  });
  /* Director opens with no engine (owner, 16 Oct 2026, 2a); the test page's stand-in pick sets one, as PR 9's pop-up will. */
  if (opts.engine !== false) await pickEngine(page);
  return { quotes, quoteKeys, sent, cancels, single, fingerprints, started, state };
}
/** The newest press claim this browser keeps until the server has settled the press (components/v12/board/use-director-render.ts: one per exact set of shots). */
const claimOf = (page: Page) => page.evaluate(() => {
  const key = Object.keys(localStorage).find((k) => k.startsWith("particl:director-press:"));
  const claims = key ? (JSON.parse(localStorage.getItem(key)!) as { claims?: { key: string; quote: { fingerprint: string } | null; answered: boolean }[] }).claims ?? [] : [];
  return claims.at(-1) ?? null;
});

test.beforeEach(async ({ page }) => {
  const res = await page.goto("/v25-board-parts");
  test.skip(res?.status() === 404, "requires a local ENGINE_MOCK=1 development server");
  await expect(page.getByTestId("v25-board-director")).toBeVisible();
});

const board = (page: Page) => page.getByTestId("v25-board-director");
const card = (page: Page, id: string) => board(page).locator(`[data-card="${id}"]`);
const go = (page: Page) => page.getByTestId("v12-director-go");
const pill = (page: Page) => page.getByTestId("v12-director-scope");
const colHead = (page: Page) => page.getByTestId("v12-director-column-scope");
async function pick(page: Page, setting: string, choice: string) {
  await page.getByTestId(`v12-director-${setting}`).click();
  await page.getByTestId("v12-director-popup").getByRole("radio", { name: choice, exact: true }).click();
}

test("Director opens with no engine: the model line reads None, nothing is priced, and Render is off until one is picked", async ({ page }) => {
  const net = await routes(page, { engine: false });
  await expect(page.getByTestId("v12-director-model")).toContainText("None");
  await expect(page.getByTestId("v12-director-model")).toHaveAttribute("data-empty", "");
  await expect(page.getByTestId("v12-director-model")).not.toContainText("Auto");
  await expect(go(page)).toHaveText("Render 4 shots");
  await expect(go(page)).toBeDisabled();
  await expect(go(page)).toHaveAttribute("data-spend", "unpriced");
  await expect(page.getByTestId("v12-director-note")).toHaveText("Pick an engine first.");
  await page.waitForTimeout(1500);
  expect(net.quotes, "nothing is priced before an engine is picked").toEqual([]);
  expect(net.single).toEqual([]);
  /* A press on the disabled button sends nothing. */
  await go(page).click({ force: true });
  expect(net.sent).toEqual([]);
  /* Picked: the model line names it, the price is read and Render turns on. */
  await pickEngine(page);
  await expect(page.getByTestId("v12-director-model")).toContainText("Seedance 2.5");
  await expect(page.getByTestId("v12-director-model")).not.toHaveAttribute("data-empty", /.*/);
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
  await expect(go(page)).toBeEnabled();
  await expect(page.getByTestId("v12-director-note")).toHaveCount(0);
});

test("the column, the pill and the button say the same words; the price is the server's quote for the whole press; one filled button", async ({ page }) => {
  const net = await routes(page);
  await expect(pill(page)).toHaveText("All 4 shots");
  await expect(colHead(page)).toHaveText("All 4 shots");
  await expect(page.getByTestId("v12-director-model")).toContainText("Seedance 2.5");
  await expect(page.getByTestId("v12-director-quality")).toContainText("Final");
  await expect(page.getByTestId("v12-director-length")).toContainText("5 s");
  await expect(page.getByTestId("v12-director-ratio")).toContainText("16:9");
  await expect(page.getByTestId("v12-director-sound")).toContainText("Off");
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
  await expect(go(page)).toHaveAttribute("data-spend", "priced");
  await expect(go(page)).toHaveAttribute("data-spend-price", "172 cr");
  /* Selecting a card narrows all three to it. */
  await card(page, "d4").click();
  await expect(pill(page)).toHaveText("Shot 4");
  await expect(colHead(page)).toHaveText("Shot 4");
  await expect(go(page)).toHaveText(/^Render Shot 4 · 43 cr$/, { timeout: 30_000 });
  /* One filled button on the screen's bar. */
  await expect(page.getByTestId("v12-director-bar").locator("button.v12-dirbar-go")).toHaveCount(1);
  /* The price was the press's quote, never a shot's own. */
  expect(net.quotes.at(-1)?.members).toHaveLength(1);
  expect(net.single).toEqual([]);
});

test("a setting for the selected shot is a chip on that card only, changes its price, and the others keep the step's", async ({ page }) => {
  await routes(page);
  await card(page, "d4").click();
  await pick(page, "quality", "Draft");
  await expect(card(page, "d4").locator(".v12-card-chip")).toHaveText(["Draft"]);
  await expect(card(page, "d1").locator(".v12-card-chip")).toHaveCount(0);
  await expect(go(page)).toHaveText(/^Render Shot 4 · 7 cr$/, { timeout: 30_000 });
  await expect(page.getByTestId("v12-director-quality")).toContainText("Draft");
  /* Back on every shot: the step's own (Final), with Shot 4's draft kept as its own. */
  await card(page, "d4").click();
  await expect(pill(page)).toHaveText("All 4 shots");
  await expect(page.getByTestId("v12-director-quality")).toContainText("Final");
  await expect(go(page)).toHaveText(/^Render 4 shots · 136 cr$/, { timeout: 30_000 });
  /* Setting a step's value for all moves every card without its own override. */
  await pick(page, "length", "8 s");
  await expect(page.getByTestId("v12-director-length")).toContainText("8 s");
  await expect(card(page, "d1").locator(".v12-card-chip")).toHaveCount(0);
  /* Hovering a row outlines the cards that set it differently and sets the rest back. */
  await page.getByTestId("v12-director-quality").hover();
  await expect(card(page, "d4")).toHaveAttribute("data-differs", "");
  await expect(card(page, "d1")).toHaveAttribute("data-dimmed", "");
  /* Several selected that disagree read "Mixed". */
  await card(page, "d1").click();
  await card(page, "d4").click({ modifiers: ["Shift"] });
  await expect(pill(page)).toHaveText("2 shots");
  await expect(page.getByTestId("v12-director-quality")).toContainText("Mixed");
});

test("a press is one job: quoted again, then sent once with the total as its ceiling and the quote's fingerprint under one key; Making…, Cancel only while queued, Next: Edit →", async ({ page }) => {
  const net = await routes(page);
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
  const quoted = net.quotes.length;
  await go(page).click();
  await expect(go(page)).toHaveText(/^Making…/, { timeout: 30_000 });
  await expect(go(page)).toBeDisabled();
  await expect.poll(() => net.sent.length).toBe(1);
  /* Priced again, the whole press, before it was sent; sent once, the total as its ceiling and that quote's fingerprint, under one key. */
  expect(net.quotes.length - quoted).toBeGreaterThanOrEqual(1);
  const [press] = net.sent;
  expect(press.body).toMatchObject({ maxCredits: 172 });
  expect(press.body.fingerprint).toBe(net.fingerprints.at(-1));
  expect(String(press.body.fingerprint)).toMatch(/^[a-f0-9]{64}$/);
  expect(press.key).toBeTruthy();
  const members = press.body.members as Record<string, unknown>[];
  expect(members).toHaveLength(4);
  for (const m of members) {
    expect(m).toMatchObject({ resolution: "1080p", duration: 5, ratio: "16:9", model: "dreamina-seedance-2-5-260628" });
    /* A member carries no approval of its own: the press's is the one. */
    expect(m.maxCredits).toBeUndefined();
    expect(m.quoteFingerprint).toBeUndefined();
  }
  expect(new Set(members.map((m) => m.shotId)).size).toBe(4);
  expect(net.single, "never shot by shot").toEqual([]);
  /* While a take is still queued at the provider: Cancel. */
  await expect(page.getByTestId("v12-director-cancel")).toBeVisible({ timeout: 15_000 });
  net.state.phase = "running";
  await expect(page.getByTestId("v12-director-cancel")).toHaveCount(0, { timeout: 15_000 });
  net.state.phase = "succeeded";
  await expect(go(page)).toHaveText("Next: Edit →", { timeout: 20_000 });
  await expect(go(page)).toBeEnabled();
  await expect(go(page)).not.toHaveAttribute("data-spend", /.*/);
  expect(net.sent).toHaveLength(1);
  /* Next hands the bar back to the next press. */
  await go(page).click();
  await expect(go(page)).toHaveText(/^Render 4 shots/, { timeout: 30_000 });
});

test("Cancel cancels the press under its own key, once, and says what it did", async ({ page }) => {
  const net = await routes(page);
  await expect(go(page)).toHaveText(/^Render 4 shots/, { timeout: 30_000 });
  await go(page).click();
  await expect(page.getByTestId("v12-director-cancel")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("v12-director-cancel").click();
  await expect.poll(() => net.cancels.length).toBe(1);
  expect(net.cancels[0]).toBe(net.sent[0].key);
  await expect(page.getByTestId("v12-director-note")).toContainText("Cancelled. The take says what it cost.");
});

test("a total that moved between the button and the press sends nothing: the new figure is shown and the person presses again", async ({ page }) => {
  const net = await routes(page);
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
  net.state.bump = 5;
  await go(page).click();
  await expect(page.getByTestId("v12-director-note")).toContainText("The price is now 192 cr. Press it again to approve it.", { timeout: 30_000 });
  expect(net.sent).toEqual([]);
  await expect(go(page)).toHaveText(/^Render 4 shots · 192 cr$/, { timeout: 30_000 });
  await go(page).click();
  await expect.poll(() => net.sent.length).toBe(1);
  expect(net.sent[0].body).toMatchObject({ maxCredits: 192 });
});

test("a press the workspace's monthly cap would not cover is refused at the quote: the cap's words, Render off, nothing sent", async ({ page }) => {
  const net = await routes(page, { capAtQuote: true });
  await expect(page.getByTestId("v12-director-note")).toContainText(CAP_WORDS, { timeout: 30_000 });
  await expect(go(page)).toHaveText("Render 4 shots");
  await expect(go(page)).toBeDisabled();
  await expect(go(page)).toHaveAttribute("data-spend", "unpriced");
  await go(page).click({ force: true });
  await page.waitForTimeout(800);
  expect(net.sent).toEqual([]);
  expect(net.single).toEqual([]);
});

test("a press whose reply was lost is asked again under the same key, so nothing is sent twice", async ({ page }) => {
  const net = await routes(page, { lose: 1 });
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
  await go(page).click();
  await expect(page.getByTestId("v12-director-note")).toContainText("The connection dropped before the server answered.", { timeout: 30_000 });
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/);
  await go(page).click();
  await expect.poll(() => net.sent.length).toBe(2);
  expect(net.sent[1].key).toBe(net.sent[0].key);
  await expect(go(page)).toHaveText(/^Making…/, { timeout: 30_000 });
  /* The server had started the four shots under the first ask: the second returned those takes and started none. */
  expect(net.started).toHaveLength(4);
});

/*
 * A CLIENT test. Its mock answers the second ask with the press's own takes, as the server would once the proposed admitBatch fix lands (read the press's claims
 * before pricing; owner question). Today's server refuses that ask with 429 while the cap is full (tests/unit/batchPress.spec.ts); the case after this one
 * covers that answer. What is checked here is the client: no new quote in the way, the same key, fingerprint and total.
 */
test("client: a lost reply near the cap is asked again under its key and approval with no new quote in the way (one would now be refused); a mock of the proposed server fix answers with the press's own takes", async ({ page }) => {
  const net = await routes(page, { lose: 1, capAfterPress: true });
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
  await go(page).click();
  await expect(page.getByTestId("v12-director-note")).toContainText("The connection dropped before the server answered.", { timeout: 30_000 });
  /* A quote now counts the running shots twice and is refused at the cap; the press already approved is still the one to ask again. */
  expect((await claimOf(page))?.key).toBe(net.sent[0].key);
  await expect(go(page)).toBeEnabled();
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/);
  const quoted = net.quotes.length;
  await go(page).click();
  await expect.poll(() => net.sent.length).toBe(2);
  expect(net.quotes.length, "no new quote stands in the way").toBe(quoted);
  expect(net.sent[1].key).toBe(net.sent[0].key);
  expect(net.sent[1].body.fingerprint).toBe(net.sent[0].body.fingerprint);
  expect(net.sent[1].body.maxCredits).toBe(172);
  await expect(go(page)).toHaveText(/^Making…/, { timeout: 30_000 });
  expect(net.started, "nothing started twice").toHaveLength(4);
  expect(net.single).toEqual([]);
});

test("a lost reply asked again while the cap is full: the server's cap words, the claim is kept with its key, and a later ask under it returns the same takes", async ({ page }) => {
  const net = await routes(page, { lose: 1, answer: (n) => (n === 2 ? { status: 429, json: { error: CAP_WORDS, shot: 1 } } : null) });
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
  await go(page).click();
  await expect(page.getByTestId("v12-director-note")).toContainText("The connection dropped before the server answered.", { timeout: 30_000 });
  await go(page).click();
  await expect(page.getByTestId("v12-director-note")).toContainText(CAP_WORDS, { timeout: 30_000 });
  expect((await claimOf(page))?.key, "a press asked before keeps its key").toBe(net.sent[0].key);
  await expect(go(page)).toBeEnabled();
  await go(page).click();
  await expect.poll(() => net.sent.length).toBe(3);
  expect(net.sent[2].key).toBe(net.sent[0].key);
  await expect(go(page)).toHaveText(/^Making…/, { timeout: 30_000 });
  expect(net.started, "nothing started twice").toHaveLength(4);
});

test("a 5xx listing every shot as not started at no charge says Nothing billed; Retry asks again under the same key and approval", async ({ page }) => {
  const net = await routes(page, { answer: (n) => (n === 1 ? { status: 502, json: { status: "refused", members: [0, 1, 2, 3].map((index) => ({ index, error: "Synthetic test refusal: the engine is busy.", code: 502, charged: 0 })) } } : null) });
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
  await go(page).click();
  await expect(page.getByTestId("v12-director-note")).toContainText("Nothing billed. Synthetic test refusal: the engine is busy.", { timeout: 30_000 });
  expect(net.started).toEqual([]);
  /* One button for one ask: Retry takes Render's place, and is not offered twice. */
  const retry = go(page);
  await expect(retry).toHaveText("Retry · up to 172 cr");
  await expect(retry).toHaveAttribute("data-retry", "");
  await expect(retry).toHaveAttribute("data-spend", "priced");
  await expect(page.getByTestId("v12-director-retry")).toHaveCount(0);
  await expect(page.getByTestId("v12-director-bar").locator("button.v12-dirbar-go")).toHaveCount(1);
  await retry.click();
  await expect.poll(() => net.sent.length).toBe(2);
  expect(net.sent[1].key).toBe(net.sent[0].key);
  expect(net.sent[1].body.fingerprint).toBe(net.sent[0].body.fingerprint);
  await expect(go(page)).toHaveText(/^Making…/, { timeout: 30_000 });
  expect(net.started).toHaveLength(4);
});

test("partial: the shots that did not start say Nothing billed, the key is kept, and Retry starts only them under the same approval", async ({ page }) => {
  const net = await routes(page, { answer: (n) => (n === 1 ? "partial" : null) });
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
  await go(page).click();
  await expect(page.getByTestId("v12-director-note")).toContainText("Nothing billed for 1 shot that did not start. Synthetic test refusal: the hour's renders are used.", { timeout: 30_000 });
  expect(net.started).toHaveLength(3);
  expect((await claimOf(page))?.key, "the key is kept for Retry").toBe(net.sent[0].key);
  await page.getByTestId("v12-director-retry").click();
  await expect.poll(() => net.sent.length).toBe(2);
  expect(net.sent[1].key).toBe(net.sent[0].key);
  expect(net.sent[1].body.fingerprint).toBe(net.sent[0].body.fingerprint);
  /* The three that started are those takes; only the fourth starts. Every shot started, so the browser lets the key go. */
  await expect.poll(() => net.started.length).toBe(4);
  await expect.poll(() => claimOf(page)).toBeNull();
  await expect(page.getByTestId("v12-director-note")).toHaveCount(0);
});

test("after the takes settle, a failed one says what happened and what it cost; Retry starts again only the one that cost nothing, under the same approval", async ({ page }) => {
  const net = await routes(page);
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
  await go(page).click();
  await expect.poll(() => net.started.length).toBe(4);
  const [a, b, c, d] = net.started;
  net.state.takes[a] = { id: a, status: "succeeded" };
  net.state.takes[b] = { id: b, status: "failed", failure: failure(0) };
  net.state.takes[c] = { id: c, status: "failed", failure: failure(43) };
  net.state.takes[d] = { id: d, status: "succeeded" };
  await expect(go(page)).toHaveText("Next: Edit →", { timeout: 20_000 });
  const note = page.getByTestId("v12-director-note");
  await expect(note).toContainText("Shot 2:");
  await expect(note).toContainText("Nothing billed");
  await expect(note).not.toContainText("Not billed");
  await expect(note).toContainText("Shot 3:");
  await expect(note).toContainText("43 cr charged");
  await page.getByTestId("v12-director-retry").click();
  await expect.poll(() => net.sent.length).toBe(2);
  expect(net.sent[1].key).toBe(net.sent[0].key);
  /* Only the free failure starts again (the server's rule); the charged one and the two that succeeded are those takes. */
  await expect.poll(() => net.started.length).toBe(5);
  await expect(go(page)).toHaveText(/^Making…/, { timeout: 30_000 });
});

test("partial, then the started takes settle before Retry: the shots that did not start keep their Retry, beside each failed take's own line", async ({ page }) => {
  const net = await routes(page, { answer: (n) => (n === 1 ? "partial" : null) });
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
  await go(page).click();
  await expect.poll(() => net.started.length).toBe(3);
  const [a, b, c] = net.started;
  net.state.takes[a] = { id: a, status: "succeeded" };
  net.state.takes[b] = { id: b, status: "failed", failure: failure(43) };
  net.state.takes[c] = { id: c, status: "succeeded" };
  await expect(go(page)).toHaveText("Next: Edit →", { timeout: 20_000 });
  const note = page.getByTestId("v12-director-note");
  await expect(note).toContainText("Nothing billed for 1 shot that did not start.");
  await expect(note).toContainText("Shot 2:");
  await expect(note).toContainText("43 cr charged");
  await page.getByTestId("v12-director-retry").click();
  await expect.poll(() => net.sent.length).toBe(2);
  expect(net.sent[1].key).toBe(net.sent[0].key);
  /* Only the shot that never started starts; the charged failure is that take. */
  await expect.poll(() => net.started.length).toBe(4);
});

test("at Next a press the server answered is let go; one it never answered (a shot still being accepted) is kept for the next press of those shots", async ({ page }) => {
  const answeredNet = await routes(page, { answer: (n) => (n === 1 ? "partial" : null) });
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
  await go(page).click();
  await expect.poll(() => answeredNet.started.length).toBe(3);
  expect((await claimOf(page))?.key).toBe(answeredNet.sent[0].key);
  answeredNet.state.phase = "succeeded";
  await expect(go(page)).toHaveText("Next: Edit →", { timeout: 20_000 });
  await go(page).click();
  await expect.poll(() => claimOf(page)).toBeNull();
});

test("a shot still being accepted: the claim is kept through Next, and the next press of those shots asks under it", async ({ page }) => {
  const net = await routes(page, { answer: (n) => (n === 1 ? "starting" : null) });
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
  await go(page).click();
  await expect.poll(() => net.started.length).toBe(3);
  await expect(page.getByTestId("v12-director-note")).toContainText("A shot is still being accepted.");
  net.state.phase = "succeeded";
  await expect(go(page)).toHaveText("Next: Edit →", { timeout: 20_000 });
  await go(page).click();
  expect((await claimOf(page))?.key, "never answered: kept").toBe(net.sent[0].key);
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
  await go(page).click();
  await expect.poll(() => net.sent.length).toBe(2);
  expect(net.sent[1].key).toBe(net.sent[0].key);
  await expect.poll(() => net.started.length).toBe(4);
});

test("partial, then a Retry the server answers \"still being accepted\": that ask is unanswered, so its claim stays through Next and the next press reuses its key", async ({ page }) => {
  const net = await routes(page, { answer: (n) => (n === 1 ? "partial" : n === 2 ? "starting" : null) });
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
  await go(page).click();
  await expect.poll(() => net.started.length).toBe(3);
  await page.getByTestId("v12-director-retry").click();
  await expect.poll(() => net.sent.length).toBe(2);
  await expect(page.getByTestId("v12-director-note")).toContainText("A shot is still being accepted.");
  /* Not a loop: the note says to press Retry, and Retry is there. */
  await expect(page.getByTestId("v12-director-retry")).toBeVisible();
  expect(net.started).toHaveLength(3);
  net.state.phase = "succeeded";
  await expect(go(page)).toHaveText("Next: Edit →", { timeout: 20_000 });
  await go(page).click();
  const kept = await claimOf(page);
  expect(kept?.key, "a shot still being accepted: kept through Next").toBe(net.sent[0].key);
  expect(kept?.answered).toBe(false);
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
  await go(page).click();
  await expect.poll(() => net.sent.length).toBe(3);
  expect(net.sent[2].key).toBe(net.sent[0].key);
  await expect.poll(() => net.started.length).toBe(4);
  expect(net.started, "nothing started twice").toHaveLength(4);
});

test("a press of other shots never takes the place of a lost reply's claim: back on those shots, the next press asks under the lost one's key", async ({ page }) => {
  const net = await routes(page, { lose: 1 });
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
  await go(page).click();
  await expect(page.getByTestId("v12-director-note")).toContainText("The connection dropped before the server answered.", { timeout: 30_000 });
  const lost = net.sent[0].key;
  /* Shot 4 alone: a press of its own, which settles. */
  net.state.phase = "succeeded";
  await card(page, "d4").click();
  await expect(go(page)).toHaveText(/^Render Shot 4 · 43 cr$/, { timeout: 30_000 });
  await go(page).click();
  await expect.poll(() => net.sent.length).toBe(2);
  expect(net.sent[1].key).not.toBe(lost);
  await expect(go(page)).toHaveText("Next: Edit →", { timeout: 20_000 });
  await go(page).click();
  /* Every shot again: the lost press's claim is still there, and the press asks under it. */
  await card(page, "d4").click();
  await expect(pill(page)).toHaveText("All 4 shots");
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
  await go(page).click();
  await expect.poll(() => net.sent.length).toBe(3);
  expect(net.sent[2].key).toBe(lost);
  expect(net.started, "the four from the lost press and Shot 4's own; none twice").toHaveLength(5);
});

test("a Retry that brings back the same takes (the server did not start the failure again) is not offered again", async ({ page }) => {
  const net = await routes(page, { noRestart: true });
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
  await go(page).click();
  await expect.poll(() => net.started.length).toBe(4);
  const [a, b, c, d] = net.started;
  for (const id of [a, c, d]) net.state.takes[id] = { id, status: "succeeded" };
  net.state.takes[b] = { id: b, status: "failed", failure: failure(0) };
  await expect(go(page)).toHaveText("Next: Edit →", { timeout: 20_000 });
  await page.getByTestId("v12-director-retry").click();
  await expect.poll(() => net.sent.length).toBe(2);
  await expect(go(page)).toHaveText("Next: Edit →", { timeout: 20_000 });
  await expect(page.getByTestId("v12-director-note")).toContainText("Shot 2:");
  await expect(page.getByTestId("v12-director-retry")).toHaveCount(0);
  expect(net.started).toHaveLength(4);
});

test("a refusal at the press's own re-quote turns Render off, in the server's words, and sends nothing", async ({ page }) => {
  const net = await routes(page);
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
  net.state.capAtQuote = true;
  await go(page).click();
  await expect(page.getByTestId("v12-director-note")).toContainText(CAP_WORDS, { timeout: 30_000 });
  await expect(go(page)).toBeDisabled();
  await expect(go(page)).toHaveAttribute("data-spend", "unpriced");
  expect(net.sent).toEqual([]);
});

test("short of credits (402): the server's words and Top up, which opens the top-up path; nothing started and the key is let go", async ({ page }, info) => {
  const SHORT = "Short by 72 cr. Top up, then approve. Nothing is spent until you do.";
  const net = await routes(page, { answer: (n) => (n === 1 ? { status: 402, json: { error: SHORT, short: true } } : null) });
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
  await go(page).click();
  await expect(page.getByTestId("v12-director-note")).toContainText(SHORT, { timeout: 30_000 });
  expect(net.started).toEqual([]);
  expect(await claimOf(page)).toBeNull();
  const topUp = page.getByTestId("v12-director-top-up");
  await expect(topUp).toBeVisible();
  if (isCompact(info)) expect((await topUp.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
  await topUp.click();
  await expect(page.getByTestId("v25-parts-topped-up")).toBeVisible();
});

test("a confirmed cancel lets the press's key go: the next press is a new one", async ({ page }) => {
  const net = await routes(page, { answer: (n) => (n === 1 ? "partial" : null) });
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
  await go(page).click();
  await expect(page.getByTestId("v12-director-cancel")).toBeVisible({ timeout: 30_000 });
  expect((await claimOf(page))?.key).toBe(net.sent[0].key);
  await page.getByTestId("v12-director-cancel").click();
  await expect.poll(() => net.cancels.length).toBe(1);
  await expect.poll(() => claimOf(page)).toBeNull();
  await expect(page.getByTestId("v12-director-retry")).toHaveCount(0);
});

test("a press over the route's 24 shots is refused at the quote (400): its words, Render off, Try again, nothing sent", async ({ page }, info) => {
  const OVER = "A press takes up to 24 shots at a time.";
  const net = await routes(page, { quoteRefusal: { status: 400, error: OVER } });
  await expect(page.getByTestId("v12-director-note")).toContainText(OVER, { timeout: 30_000 });
  await expect(go(page)).toBeDisabled();
  await expect(go(page)).toHaveAttribute("data-spend", "unpriced");
  const tryAgain = page.getByTestId("v12-director-try-again");
  await expect(tryAgain).toBeVisible();
  if (isCompact(info)) {
    const box = (await tryAgain.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(43.5);
    expect(box.width).toBeGreaterThanOrEqual(43.5);
  }
  await go(page).click({ force: true });
  await page.waitForTimeout(800);
  expect(net.sent).toEqual([]);
  expect(net.single).toEqual([]);
});

/* ── Owner's answers, 21 Oct 2026 ── */

test("more shots than a press takes: the plan's line \"Up to 24 shots at a time. Pick some.\", Render off, nothing priced or sent; a pick of some is priced", async ({ page }) => {
  const net = await routes(page, { engine: false });
  await page.getByTestId("v25-parts-many-shots").click();
  await pickEngine(page);
  await expect(pill(page)).toHaveText("All 26 shots");
  await expect(page.getByTestId("v12-director-note")).toHaveText("Up to 24 shots at a time. Pick some.");
  await expect(go(page)).toHaveText("Render 26 shots");
  await expect(go(page)).toBeDisabled();
  await expect(go(page)).toHaveAttribute("data-spend", "unpriced");
  await page.waitForTimeout(1500);
  expect(net.quotes, "nothing is priced past the press's bound").toEqual([]);
  await go(page).click({ force: true });
  await page.waitForTimeout(500);
  expect(net.sent).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), "horizontal overflow").toBeLessThanOrEqual(0);
  /* Picked: one shot is priced, and the line goes. */
  await card(page, "d4").click();
  await expect(go(page)).toHaveText(/^Render Shot 4 · 43 cr$/, { timeout: 30_000 });
  await expect(page.getByTestId("v12-director-note")).toHaveCount(0);
  expect(net.quotes.at(-1)?.members).toHaveLength(1);
});

test("Retry's price is only the shots still to start, as the route quotes them under the press's key: partial reads the one shot left, still under the same approval", async ({ page }) => {
  const net = await routes(page, { keyed: true, answer: (n) => (n === 1 ? "partial" : null) });
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
  await go(page).click();
  await expect(page.getByTestId("v12-director-note")).toContainText("Nothing billed for 1 shot that did not start.", { timeout: 30_000 });
  const retry = page.getByTestId("v12-director-retry");
  await expect(retry).toHaveText("Retry · 43 cr");
  await expect(retry).toHaveAttribute("data-spend", "priced");
  /* Retry's own quote went under the press's key. */
  await expect.poll(() => net.quoteKeys.includes(net.sent[0].key)).toBe(true);
  await retry.click();
  await expect.poll(() => net.sent.length).toBe(2);
  /* Still the same approval: the same key, fingerprint and ceiling; the price only says what is left to start. */
  expect(net.sent[1].key).toBe(net.sent[0].key);
  expect(net.sent[1].body.fingerprint).toBe(net.sent[0].body.fingerprint);
  expect(net.sent[1].body.maxCredits).toBe(172);
  await expect.poll(() => net.started.length).toBe(4);
});

test("Retry's price after a 5xx that started nothing: every shot is still to start, so it reads all four", async ({ page }) => {
  await routes(page, { keyed: true, answer: (n) => (n === 1 ? { status: 502, json: { status: "refused", members: [0, 1, 2, 3].map((index) => ({ index, error: "Synthetic test refusal: the engine is busy.", code: 502, charged: 0 })) } } : null) });
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
  await go(page).click();
  await expect(page.getByTestId("v12-director-note")).toContainText("Nothing billed.", { timeout: 30_000 });
  await expect(go(page)).toHaveText("Retry · 172 cr", { timeout: 30_000 });
  await expect(go(page)).toHaveAttribute("data-retry", "");
});

test("Retry's price without the route's toStart (today's route): the whole approval, as before", async ({ page }) => {
  await routes(page, { answer: (n) => (n === 1 ? "partial" : null) });
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
  await go(page).click();
  await expect(page.getByTestId("v12-director-retry")).toHaveText("Retry · up to 172 cr", { timeout: 30_000 });
});

test("Retry when the approval no longer covers the shots left (the total moved above it): the person's press approves the press's next total, under the same key", async ({ page }) => {
  const net = await routes(page, { keyed: true, answer: (n) => (n === 1 ? "partial" : null) });
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
  await go(page).click();
  await expect(page.getByTestId("v12-director-retry")).toHaveText("Retry · 43 cr", { timeout: 30_000 });
  /* Prices move: the shot left now costs 48 cr, and the whole press 192 cr, above the 172 cr approved. Retry's quote is read again once the takes move on. */
  net.state.bump = 5;
  net.state.phase = "succeeded";
  await expect(go(page)).toHaveText("Next: Edit →", { timeout: 20_000 });
  await expect(page.getByTestId("v12-director-retry")).toHaveText("Retry · 48 cr", { timeout: 30_000 });
  await page.getByTestId("v12-director-retry").click();
  await expect.poll(() => net.sent.length).toBe(2);
  expect(net.sent[1].key, "the same press").toBe(net.sent[0].key);
  expect(net.sent[1].body.maxCredits).toBe(192);
  expect(net.sent[1].body.fingerprint).toBe(net.fingerprints.at(-1));
  await expect.poll(() => net.started.length).toBe(4);
});

test("a press refused as out of date (409) shows the press's next total from the refusal, and is then quoted and sent under its own key", async ({ page }) => {
  const net = await routes(page, { keyed: true, lose: 1 });
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
  await go(page).click();
  await expect(page.getByTestId("v12-director-note")).toContainText("The connection dropped before the server answered.", { timeout: 30_000 });
  net.state.bump = 5;
  await go(page).click();
  await expect(page.getByTestId("v12-director-note")).toContainText("The shots or their prices changed.", { timeout: 30_000 });
  await expect(go(page)).toHaveText(/^Render 4 shots · 192 cr$/, { timeout: 30_000 });
  const before = net.quoteKeys.length;
  await go(page).click();
  await expect.poll(() => net.sent.length).toBe(3);
  /* Every quote after the press is under its key: started shots are never priced as new. */
  expect(net.quoteKeys.slice(before).length).toBeGreaterThan(0);
  expect(new Set(net.quoteKeys.slice(before))).toEqual(new Set([net.sent[0].key]));
  expect(net.sent[2].key).toBe(net.sent[0].key);
  expect(net.sent[2].body.maxCredits).toBe(192);
  expect(net.started, "nothing started twice").toHaveLength(4);
});

test("settled: Retry is priced at the free failure alone; the charged one is offered Render again, a new press of that shot with a new quote and key, and its line keeps what it cost", async ({ page }, info) => {
  const net = await routes(page, { keyed: true });
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
  await go(page).click();
  await expect.poll(() => net.started.length).toBe(4);
  const [a, b, c, d] = net.started;
  net.state.takes[a] = { id: a, status: "succeeded" };
  net.state.takes[b] = { id: b, status: "failed", failure: failure(0) };
  net.state.takes[c] = { id: c, status: "failed", failure: failure(43) };
  net.state.takes[d] = { id: d, status: "succeeded" };
  await expect(go(page)).toHaveText("Next: Edit →", { timeout: 20_000 });
  const note = page.getByTestId("v12-director-note");
  await expect(note).toContainText("Shot 3:");
  await expect(note).toContainText("43 cr charged");
  /* The free failure (Shot 2) under the same approval, at its own figure; the charged one (Shot 3) is not in it. */
  await expect(page.getByTestId("v12-director-retry")).toHaveText("Retry · 43 cr", { timeout: 30_000 });
  /* Render again: Shot 3 alone, priced afresh, the person's press. Nothing is sent before it. */
  const anew = page.getByTestId("v12-director-render-again");
  await expect(anew).toHaveText(/^Render again · 43 cr$/, { timeout: 30_000 });
  await expect(anew).toHaveAttribute("data-spend", "priced");
  if (isCompact(info)) expect((await anew.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
  expect(net.quotes.some((q) => (q.members as unknown[]).length === 1), "Render again is quoted for the charged shot alone").toBe(true);
  expect(net.sent).toHaveLength(1);
  await expect(page.getByTestId("v12-director-bar").locator("button.v12-dirbar-go")).toHaveCount(1);
  await anew.click();
  await expect.poll(() => net.sent.length).toBe(2);
  const again = net.sent[1];
  expect(again.key, "a new press: a new key").not.toBe(net.sent[0].key);
  const members = again.body.members as Record<string, unknown>[];
  expect(members).toHaveLength(1);
  expect(members[0].shotId).toBe("d3");
  expect(again.body.maxCredits).toBe(43);
  /* Its own quote, of that shot alone, as a new press: no key. */
  const single = net.quotes.map((q, i) => ((q.members as unknown[]).length === 1 ? i : -1)).filter((i) => i >= 0);
  expect(single.map((i) => net.quoteKeys[i])).toEqual(single.map(() => undefined));
  await expect.poll(() => net.started.length).toBe(5);
  await expect(go(page)).toHaveText(/^Making…/, { timeout: 30_000 });
  /* The line keeps what the failed take cost through the new press. */
  await expect(note).toContainText("Shot 3:");
  await expect(note).toContainText("43 cr charged");
  net.state.phase = "succeeded";
  await expect(go(page)).toHaveText("Next: Edit →", { timeout: 20_000 });
  await expect(note).toContainText("43 cr charged");
  await expect(page.getByTestId("v12-director-render-again")).toHaveCount(0);
  expect(net.sent, "nothing else was sent").toHaveLength(2);
  await go(page).click();
  await expect(page.getByTestId("v12-director-note")).toHaveCount(0);
});

test("Render again whose price moved sends nothing: the new figure is shown on it, and the person presses again", async ({ page }) => {
  const net = await routes(page);
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
  await go(page).click();
  await expect.poll(() => net.started.length).toBe(4);
  for (const id of net.started) net.state.takes[id] = { id, status: "succeeded" };
  net.state.takes[net.started[2]] = { id: net.started[2], status: "failed", failure: failure(43) };
  const anew = page.getByTestId("v12-director-render-again");
  await expect(anew).toHaveText(/^Render again · 43 cr$/, { timeout: 30_000 });
  net.state.bump = 5;
  await anew.click();
  await expect(page.getByTestId("v12-director-note")).toContainText("The price is now 48 cr. Press it again to approve it.", { timeout: 30_000 });
  expect(net.sent).toHaveLength(1);
  await expect(anew).toHaveText(/^Render again · 48 cr$/);
  await expect(page.getByTestId("v12-director-note")).toContainText("43 cr charged");
  await anew.click();
  await expect.poll(() => net.sent.length).toBe(2);
  expect(net.sent[1].body.maxCredits).toBe(48);
  expect(net.sent[1].key).not.toBe(net.sent[0].key);
});

/** Moves every kept claim's approval this far into the past, as if it had been given then. */
const ageClaims = (page: Page, ms: number) => page.evaluate((by) => {
  for (const key of Object.keys(localStorage).filter((k) => k.startsWith("particl:director-press:"))) {
    const v = JSON.parse(localStorage.getItem(key)!) as { claims: { at: number }[] };
    localStorage.setItem(key, JSON.stringify({ claims: v.claims.map((c) => ({ ...c, at: c.at - by })) }));
  }
}, ms);
const DAY = 24 * 60 * 60 * 1000;

test("a held approval expires as a plan's does (the keyed route): after 7 days the lost reply's key stays, the next press asks at today's price under it, and a shot that started is not started again", async ({ page }) => {
  const net = await routes(page, { lose: 1, keyed: true });
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
  await go(page).click();
  await expect(page.getByTestId("v12-director-note")).toContainText("The connection dropped before the server answered.", { timeout: 30_000 });
  expect(net.started, "the lost reply's press started its shots").toHaveLength(4);
  await ageClaims(page, 7 * DAY);
  net.state.bump = 5;
  await page.reload();
  await pickEngine(page);
  /* Today's price, not the approval that ran out. */
  await expect(go(page)).toHaveText(/^Render 4 shots · 192 cr$/, { timeout: 30_000 });
  const quoted = net.quotes.length;
  await go(page).click();
  await expect.poll(() => net.sent.length).toBe(2);
  expect(net.quotes.length, "quoted afresh before it was sent").toBeGreaterThan(quoted);
  expect(net.quoteKeys.slice(quoted), "quoted under the press's own key").toContain(net.sent[0].key);
  expect(net.sent[1].key, "the same press").toBe(net.sent[0].key);
  expect(net.sent[1].body.maxCredits).toBe(192);
  await expect(go(page)).toHaveText(/^Making…/, { timeout: 30_000 });
  expect(net.started, "nothing started twice").toHaveLength(4);
  /* Every shot reported as started: the press is answered whole, and the browser lets its key go. */
  await expect.poll(() => claimOf(page)).toBeNull();
});

test("a held approval expires as a plan's does (today's route): after 7 days the lost reply's key stays, the next press asks at today's price under it, and a shot that started is not started again", async ({ page }) => {
  const net = await routes(page, { lose: 1 });
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
  await go(page).click();
  await expect(page.getByTestId("v12-director-note")).toContainText("The connection dropped before the server answered.", { timeout: 30_000 });
  expect(net.started, "the lost reply's press started its shots").toHaveLength(4);
  await ageClaims(page, 7 * DAY);
  net.state.bump = 5;
  await page.reload();
  await pickEngine(page);
  /* Today's price, not the approval that ran out. */
  await expect(go(page)).toHaveText(/^Render 4 shots · 192 cr$/, { timeout: 30_000 });
  const quoted = net.quotes.length;
  await go(page).click();
  await expect.poll(() => net.sent.length).toBe(2);
  expect(net.quotes.length, "quoted afresh before it was sent").toBeGreaterThan(quoted);
  expect(net.quoteKeys.slice(quoted), "quoted under the press's own key").toContain(net.sent[0].key);
  expect(net.sent[1].key, "the same press").toBe(net.sent[0].key);
  expect(net.sent[1].body.maxCredits).toBe(192);
  await expect(go(page)).toHaveText(/^Making…/, { timeout: 30_000 });
  expect(net.started, "nothing started twice").toHaveLength(4);
  /* Every shot reported as started: the press is answered whole, and the browser lets its key go. */
  await expect.poll(() => claimOf(page)).toBeNull();
});

test("a held approval younger than 7 days is still the one asked again: the same key and approval, nothing started twice", async ({ page }) => {
  const net = await routes(page, { lose: 1 });
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
  await go(page).click();
  await expect(page.getByTestId("v12-director-note")).toContainText("The connection dropped before the server answered.", { timeout: 30_000 });
  await ageClaims(page, 6 * DAY);
  await page.reload();
  await pickEngine(page);
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
  await go(page).click();
  await expect.poll(() => net.sent.length).toBe(2);
  expect(net.sent[1].key).toBe(net.sent[0].key);
  expect(net.sent[1].body.fingerprint).toBe(net.sent[0].body.fingerprint);
  expect(net.started, "nothing started twice").toHaveLength(4);
});

test("the bar and the column fit the window at every size: no sideways scroll, text 12 px or more, 44 px controls on a touch screen", async ({ page }, info) => {
  await routes(page);
  await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
  await card(page, "d4").click();
  const view = page.viewportSize()!;
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), "horizontal overflow").toBeLessThanOrEqual(0);
  for (const id of ["v12-director-column", "v12-director-bar", "v12-director-go"]) {
    await page.getByTestId(id).scrollIntoViewIfNeeded();
    const box = (await page.getByTestId(id).boundingBox())!;
    expect(box.x >= -0.5 && box.x + box.width <= view.width + 0.5, `${id} inside ${view.width}px`).toBe(true);
  }
  const small = await board(page).evaluate((root) => {
    const out: string[] = [];
    for (const el of root.querySelectorAll<HTMLElement>("*")) {
      if (![...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? "").trim())) continue;
      const px = parseFloat(getComputedStyle(el).fontSize);
      if (px < 12) out.push(`${el.className} ${px}px`);
    }
    return out;
  });
  expect(small, "text under 12 px").toEqual([]);
  if (isCompact(info)) {
    const tiny = await page.getByTestId("v12-director-column").evaluate((el) => [...el.querySelectorAll<HTMLElement>("button")].filter((b) => b.getBoundingClientRect().height < 43.5).map((b) => b.textContent));
    expect(tiny, "column rows under 44 px").toEqual([]);
    const goBox = (await go(page).boundingBox())!;
    expect(goBox.height).toBeGreaterThanOrEqual(43.5);
  }
});

test("the large screens: the column and the bar sit inside the window", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1920x1080", "the large sizes are set here, once");
  await routes(page);
  for (const [width, height] of [[1728, 1117], [2560, 1440]]) {
    await page.setViewportSize({ width, height });
    await expect(go(page)).toHaveText(/^Render 4 shots · 172 cr$/, { timeout: 30_000 });
    for (const id of ["v12-director-column", "v12-director-go"]) {
      await page.getByTestId(id).scrollIntoViewIfNeeded();
      const box = (await page.getByTestId(id).boundingBox())!;
      expect(box.x >= 0 && box.x + box.width <= width, `${id} inside ${width}px`).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${width}: horizontal overflow`).toBeLessThanOrEqual(0);
  }
});
