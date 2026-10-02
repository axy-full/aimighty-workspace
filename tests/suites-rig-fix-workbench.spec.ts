import { test, expect, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import sharp from "sharp";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { forbidPaidWork } from "./helpers/workspaceFixtures";
import { dimLabels, smallTargets } from "./phoneFloors";
import { newProject, type Asset, type Project } from "../lib/workbench/studio";
import type { TakeVerification } from "../lib/workbench/verify";

/**
 * Atomik checks each take and fixes a failed check (plan PR 11). On the Suites
 * Rig a person asks Atomik for a board; in Auto its drafts render on their own;
 * each take is then checked against the production's masters. A clip is checked
 * from frames a browser samples, so its check waits for a person on the board
 * (the owner's choice) while the run carries on with the other shots. A failed
 * check gets a targeted fix — an edit of the take, priced on it, which asks for
 * a tap even in Auto — at most twice; then the shot is the person's: accept it
 * as is (never "verified"), try another fix, render it again, or skip it.
 *
 * Real local ENGINE_MOCK=1 server throughout: the planner, the fix writer and
 * the judge are the mocks (the judge compares average colours and calls no
 * provider), renders are the mock engine, and the run's own requests are
 * server-side. The masters are plain colour squares far from every frame of the
 * mock clip, so the judge fails them, and every fix (the same clip) fails too.
 */
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const DESKS = ["workbench-1440x900", "workbench-1920x1080"];
const PERSON = "Workbench Tester";
type Rgb = { r: number; g: number; b: number };
const MAGENTA: Rgb = { r: 250, g: 0, b: 250 }, DEEP_MAGENTA: Rgb = { r: 235, g: 10, b: 235 };
type Receipt = { id: string; url: string; mime: string };

type Paid = {
  seq: number; tool: string; label: string; title: string; state: string; quote: number | null; charged: number | null; pause: string | null;
  reason: string | null; canRender: boolean; fingerprint: string | null; verdict: string | null; edit: string | null; card: string | null;
  note: { credits: number | null; settled: boolean } | null; choices: string[]; prices: Record<string, number>; takeKind: string | null;
  resolution: { choice: string } | null; scorecard: { line: string; checks: { check: string; verdict: string }[] } | null;
};
type Run = {
  id: string; state: string; reason: string | null;
  money: { limit: number; spent: number; inFlight: number; planning: { state: string; credits: number | null } | null } | null; paid: Paid[];
};
type Agent = { agent: { enabled: boolean; run: Run | null } };

const picture = (id: string, name: string, category: string, receipt: Receipt): Asset => ({
  id, name, kind: "image", category, url: receipt.url, uploadId: receipt.id, mime: receipt.mime,
  description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [],
});

/** A new workspace with credits and a production whose cast and place each have a master picture (test fixtures only). */
async function setUp(page: Page, info: TestInfo, name: string) {
  const account = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${account.workspace.id}-${me.id}` };
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await platform.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), account.workspace.id, 5000, "Local mock Rig fix test", "admin", "test", Date.now()] });
  } finally { platform.close(); }
  const upload = async (file: string, rgb: Rgb): Promise<Receipt> => {
    const buffer = await sharp({ create: { width: 512, height: 512, channels: 3, background: rgb } }).png().toBuffer();
    const response = await page.request.post("/api/uploads", { headers, multipart: { file: { name: file, mimeType: "image/png", buffer } } });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const face = await upload("mira-master.png", MAGENTA);
  const plate = await upload("pier-plate.png", DEEP_MAGENTA);
  const project: Project = {
    ...newProject(name), id: `fix-${Date.now().toString(36)}-${info.project.name.replace(/\D/g, "")}`,
    assets: [picture("face", "Mira master", "Character", face), picture("plate", "The pier", "Environment", plate)],
    production: {
      cast: { entries: [{ id: "c1", name: "Mira", kind: "character", description: "", prompt: "", takes: [], selected: "face" }] },
      environment: { world: "", model: "gemini-3.1-flash-image", entries: [{ id: "e1", name: "The pier", notes: "", prompt: "", references: [], plates: [], selected: "plate" }] },
    },
  };
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const { productionProjectId } = (await saved.json()) as { productionProjectId: string };
  return { project, headers, productionId: productionProjectId };
}

/** One Rig window on the project, joined to its team canvas; any paid request from the browser but a person's own Verify fails the test. */
async function openRig(tab: Page, draftId: string, errors: string[], paid: string[]) {
  await forbidPaidWork(tab);
  tab.on("pageerror", (error) => errors.push(error.message));
  tab.on("request", (request) => {
    const url = new URL(request.url());
    /* A person's Verify files its sampled stills (free) and starts its check (watched apart, below). */
    if (url.pathname === "/api/workbench/atomik/frames") return;
    if (request.method() !== "GET" && /^\/api\/(generate|jobs|workbench\/atomik|atomik)(\/|$)/.test(url.pathname)) paid.push(`${request.method()} ${url.pathname}`);
  });
  await tab.goto(`/suites?suite=studio&page=rig&project=${draftId}`);
  await expect(tab.getByTestId("rig-team")).toContainText("Team canvas");
}
/** Every start of a check this page sends (a person's Verify on the board): quotes and resumes are not starts. */
function watchChecks(tab: Page) {
  const starts: { kind?: string; maxCredits?: number }[] = [];
  tab.on("request", (request) => {
    if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/workbench/development") return;
    const body = request.postDataJSON() as { quoteOnly?: boolean; resume?: boolean; kind?: string; maxCredits?: number };
    if (!body.quoteOnly && !body.resume) starts.push(body);
  });
  return starts;
}

const agentOf = async (api: APIRequestContext, headers: Record<string, string>, productionId: string) =>
  (await api.get(`/api/workbench/team-canvas?productionId=${productionId}&agent=1`, { headers }).then((r) => r.json())) as Agent;
const balanceOf = async (api: APIRequestContext) => Number((await (await api.get("/api/me")).json()).credits.balance);
const tenths = (n: number) => Math.round(n * 10) / 10;
const cr = (n: number) => `${Math.round(n * 10) % 10 ? (Math.round(n * 10) / 10).toLocaleString("en-US", { minimumFractionDigits: 1 }) : Math.round(n).toLocaleString("en-US")} cr`;
const noSideways = (tab: Page) => tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 0.5);
/** Every text in the run card at 12px or more. */
const smallInCard = (tab: Page) => tab.evaluate(() => {
  const out: string[] = [];
  const root = document.querySelector('[data-testid="rig-agent"]');
  if (!root) return ["no card"];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (!(node.textContent ?? "").trim() || !el || !el.getClientRects().length) continue;
    const size = Number.parseFloat(getComputedStyle(el).fontSize);
    if (size < 12) out.push(`${size}px: ${(node.textContent ?? "").trim().slice(0, 30)}`);
  }
  return out;
});
/** No price in the card is cut short: nothing that shows credits is ellipsized or clipped. */
const clippedPrices = (tab: Page) => tab.evaluate(() => {
  const out: string[] = [];
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-testid="rig-agent"] *'))) {
    if (!/\d\s?cr\b/.test(el.textContent ?? "") || el.children.length) continue;
    const style = getComputedStyle(el);
    if (style.textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth + 0.5) out.push(`ellipsized: ${el.textContent}`);
    if (el.scrollWidth > el.clientWidth + 0.5 && ["hidden", "clip"].includes(style.overflowX)) out.push(`clipped: ${el.textContent}`);
  }
  return out;
});

/** Scrolls the stage until a control sits above a phone's fixed tab bar, then answers it. */
async function reach(tab: Page, testId: string, within?: string) {
  const control = within ? tab.getByTestId(within).getByTestId(testId) : tab.getByTestId(testId);
  await control.scrollIntoViewIfNeeded();
  await tab.evaluate(({ id, within }) => {
    const scope = within ? document.querySelector(`[data-testid="${within}"]`) : document;
    const el = scope?.querySelector(`[data-testid="${id}"]`);
    if (!el) return;
    const bar = document.querySelector<HTMLElement>(".gx-tabbar");
    const floor = bar && bar.getClientRects().length && getComputedStyle(bar).position === "fixed" ? bar.getBoundingClientRect().top : innerHeight;
    const box = el.getBoundingClientRect();
    if (box.bottom <= floor - 8) return;
    let pane = el.parentElement;
    while (pane && !(["auto", "scroll"].includes(getComputedStyle(pane).overflowY) && pane.scrollHeight > pane.clientHeight + 1)) pane = pane.parentElement;
    (pane ?? document.scrollingElement!).scrollTop += box.bottom - (floor - 8);
  }, { id: testId, within });
  return control;
}
const row = (seq: number) => `rig-agent-render-${seq}`;

async function floors(tab: Page, where: string, phone: boolean) {
  expect(await noSideways(tab), `${where}: no sideways scroll`).toBe(true);
  expect(await smallInCard(tab), `${where}: text under 12px`).toEqual([]);
  expect(await dimLabels(tab, '[data-testid="rig-agent"]'), `${where}: labels under #7C7C84`).toEqual([]);
  expect(await clippedPrices(tab), `${where}: prices cut short`).toEqual([]);
  if (phone) expect(await smallTargets(tab, '[data-testid="rig-agent"]'), `${where}: targets under 44×44`).toEqual([]);
}

/** Ask for a board in the card (Auto, with this limit); approve the proposal, which says the checks and fixes come after. */
async function askAndBuild(page: Page, input: { goal: string; limit: number; phone: boolean; name: string }) {
  const card = page.getByTestId("rig-agent");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("rig-agent-terms")).toContainText("Every render, check and fix is priced before it runs, and nothing passes the limit.");
  await (await reach(page, "rig-agent-goal")).fill(input.goal);
  await (await reach(page, "rig-agent-limit")).fill(String(input.limit));
  await (await reach(page, "rig-agent-mode-auto")).click();
  await (await reach(page, "rig-agent-propose")).click();
  await expect(card.getByTestId("rig-agent-proposal")).toBeVisible({ timeout: 30_000 });
  await expect(card.getByTestId("rig-agent-next")).toHaveText([
    /^Next: render \d shots? · priced; drafts up to about [\d.,]+ cr each run on their own$/,
    /^Then each take is checked against its masters · priced; checks up to about [\d.,]+ cr run on their own$/,
    "A failed check gets at most 2 fixes · each priced and approved first",
  ]);
  await floors(page, `${input.name}: proposal`, input.phone);
  await (await reach(page, "rig-agent-approve")).click();
}

/** The Card Inspector over a phone's stage is closed again, so the run card is reachable. */
async function closeOverlay(page: Page) {
  if (await page.getByTestId("panel-scrim").isVisible()) await page.getByTestId("close-inspector").click();
  await expect(page.getByTestId("panel-scrim")).toHaveCount(0);
}

test("a clip's check waits for the board while the run carries on with its other shots; the person decides for each shot — skip it, render it again, accept it as is — and nothing is charged for a check the run did not run", async ({ page }, info) => {
  test.setTimeout(300_000);
  const phone = PHONES.includes(info.project.name);
  const s = await setUp(page, info, "Harbour checks");
  const errors: string[] = [], paid: string[] = [];
  await openRig(page, s.project.id, errors, paid);
  const starts = watchChecks(page);
  const start = await balanceOf(page.request);
  await askAndBuild(page, { goal: "Mira on the pier at dawn, two shots.", limit: 500, phone, name: "board" });
  const card = page.getByTestId("rig-agent");
  const read = async () => (await agentOf(page.request, s.headers, s.productionId)).agent.run!;

  /* Both drafts render on their own; each clip's check then waits for a person on the board, shot by shot, and the run carries on meanwhile. */
  await expect.poll(async () => (await read()).paid.map((p) => [p.tool, p.state, p.pause]), { timeout: 150_000 }).toEqual([
    ["render", "done", null], ["verify", "paused", "check"], ["render", "done", null], ["verify", "paused", "check"],
  ]);
  await expect(card.getByTestId("rig-agent-state")).toHaveText("Needs you");
  let run = await read();
  const [take1, check1, , check2] = run.paid;
  const board = (title: string) => `Open the board to check ${title}: a clip is checked from frames sampled on the board, and Atomik reads that check as soon as it is done.`;
  expect(check1).toMatchObject({ label: "Check · 01 — Opening", reason: board("01 — Opening"), charged: null, verdict: null, takeKind: "video", choices: ["accept", "rerender", "recheck", "skip"], prices: { rerender: take1.quote } });
  expect(check2).toMatchObject({ label: "Check · 02 — The turn", reason: board("02 — The turn"), choices: ["accept", "rerender", "recheck", "skip"] });
  expect(check1.card).toBeTruthy();
  expect(run.reason).toBe(check1.reason);
  await expect(card.getByTestId("rig-agent-needs")).toHaveText(check1.reason!);
  const first = card.getByTestId(row(check1.seq));
  await expect(first).toHaveAttribute("data-flagged", "");
  await expect(first.getByTestId("rig-agent-render-price")).toHaveText("Not charged");
  await expect(first.getByTestId("rig-agent-render-state")).toHaveText(check1.reason!);
  await expect(first.getByTestId("rig-agent-choices").locator("button")).toHaveText(["Open its Verify card", "Accept as is", `Render again · about ${cr(take1.quote!)}`, "Check again", "Skip"]);
  await floors(page, "board: clips wait for the board", phone);
  if (info.project.name === "workbench-1440x900") await card.screenshot({ path: info.outputPath("clips-wait-1440x900.png"), animations: "disabled" });
  if (info.project.name === "workbench-390x844") await card.screenshot({ path: info.outputPath("clips-wait-390x844.png"), animations: "disabled" });

  /* Its Verify card is on the board, made by the run: the run card opens it in the Card Inspector. */
  await (await reach(page, "rig-agent-open-card", row(check1.seq))).click();
  const inspector = page.locator('[data-inspector-body="node"]');
  await expect(inspector.getByTestId("card-verify")).toBeVisible();
  await expect(inspector.getByTestId("card-verify-take")).toContainText("01 — Opening");
  await expect(inspector.getByTestId("card-verify-masters")).toContainText("Mira");
  await closeOverlay(page);

  /* Skip the second shot: its take keeps no check, and nothing is charged. */
  await (await reach(page, "rig-agent-choice-skip", row(check2.seq))).click();
  await expect(card.getByTestId(row(check2.seq))).toHaveAttribute("data-state", "skipped");
  await expect(card.getByTestId(row(check2.seq)).getByTestId("rig-agent-render-state")).toHaveText(`Skipped by ${PERSON}. The take keeps no check.`);
  /* Render the first again: a new take through the run (a draft, on its own in Auto), whose check then waits for the board in turn. */
  await (await reach(page, "rig-agent-choice-rerender", row(check1.seq))).click();
  await expect.poll(async () => (await read()).paid.slice(4).map((p) => [p.tool, p.label, p.state, p.pause]), { timeout: 120_000 }).toEqual([
    ["render", "Render again · 01 — Opening", "done", null], ["verify", "Check again · 01 — Opening", "paused", "check"],
  ]);
  run = await read();
  expect(run.paid[1]).toMatchObject({ state: "done", reason: `${PERSON} asked to render it again.`, resolution: { choice: "rerender" } });
  const again = run.paid[5];
  expect(again.reason).toBe(board("01 — Opening"));
  await floors(page, "board: rendered again", phone);

  /* Accept it as is: who decided, never "verified"; the run finishes. */
  await (await reach(page, "rig-agent-choice-accept", row(again.seq))).click();
  await expect(card.getByTestId("rig-agent-state")).toHaveText("Build the board", { timeout: 60_000 });
  run = await read();
  expect(run.state).toBe("done");
  expect(run.paid[5]).toMatchObject({ state: "done", reason: `Accepted by ${PERSON} without its check.`, resolution: { choice: "accept" } });
  expect(JSON.stringify(run.paid)).not.toMatch(/verified/i);
  /* Three drafts; no check was charged (a clip is checked on the board, and none was); the balance moved by exactly what settled. */
  const renders = run.paid.filter((p) => p.tool === "render");
  expect(renders.map((p) => p.state)).toEqual(["done", "done", "done"]);
  expect(run.paid.filter((p) => p.tool === "verify").map((p) => p.charged)).toEqual([null, null, null]);
  expect(run.money!.spent).toBe(tenths(run.money!.planning!.credits! + renders.reduce((sum, p) => sum + p.charged!, 0)));
  expect(tenths(start - (await balanceOf(page.request)))).toBe(run.money!.spent);
  await expect(card.getByTestId("rig-agent-total")).toContainText(`3 drafts rendered · ${cr(run.money!.spent)} spent of ${cr(run.money!.limit)}`);
  await floors(page, "board: done", phone);
  if (DESKS.includes(info.project.name)) await card.screenshot({ path: info.outputPath(`decided-${info.project.name}.png`), animations: "disabled" });
  expect(starts).toEqual([]);
  expect(paid).toEqual([]);
  expect(errors).toEqual([]);
});

test("a clip checked on the board fails: Atomik writes fix 1, an edit of the clip priced on it that asks for a tap even in Auto; after two fixes that still fail the shot is handed back, and the person accepts it as is", async ({ page }, info) => {
  test.skip(!["workbench-1440x900", "workbench-390x844"].includes(info.project.name), "one desktop and one phone decode the clip; the other sizes are covered by the hand-off above");
  test.setTimeout(480_000);
  const phone = PHONES.includes(info.project.name);
  const s = await setUp(page, info, "Harbour fixes");
  const errors: string[] = [], paid: string[] = [];
  await openRig(page, s.project.id, errors, paid);
  const starts = watchChecks(page);
  const start = await balanceOf(page.request);
  await askAndBuild(page, { goal: "Mira on the pier at dawn, one shot.", limit: 500, phone, name: "fixes" });
  const card = page.getByTestId("rig-agent");
  const read = async () => (await agentOf(page.request, s.headers, s.productionId)).agent.run!;
  const shape = async () => (await read()).paid.map((p) => [p.tool, p.state]);
  const inspector = page.locator('[data-inspector-body="node"]');
  /* A person checks the clip on its Verify card, opened from the run card: the shot's newest take (the n-th: the draft, then each
     fix) once this window has filed it, priced first, approved, then the scorecard lands. */
  const checkOnBoard = async (seq: number, n: number) => {
    await (await reach(page, "rig-agent-open-card", row(seq))).click();
    await expect(inspector.getByTestId("card-verify")).toBeVisible();
    await expect(inspector.getByTestId("card-verify-take")).toContainText(`01 — Opening · v${n} · video, three frames`, { timeout: 30_000 });
    await inspector.getByTestId("card-verify-estimate").click();
    const go = inspector.getByTestId("card-verify-start");
    await expect(go).toHaveText(/^Verify · about \d[\d,.]* cr$/, { timeout: 60_000 });
    await go.click();
    await expect.poll(() => starts.length, { timeout: 30_000 }).toBe(n);
    await expect(inspector.getByTestId("card-verify-verdict")).toContainText("Failed", { timeout: 60_000 });
    await closeOverlay(page);
  };

  await expect.poll(shape, { timeout: 120_000 }).toEqual([["render", "done"], ["verify", "paused"]]);
  let run = await read();
  const take = run.paid[0];
  await checkOnBoard(run.paid[1].seq, 1);

  /* The run reads that check (free to it) and writes fix 1: an edit of the clip, priced on the clip, waiting for a tap in Auto. */
  await expect.poll(shape, { timeout: 60_000 }).toEqual([["render", "done"], ["verify", "done"], ["fix", "waiting"], ["verify", "next"]]);
  run = await read();
  expect(run.paid[1]).toMatchObject({ verdict: "fail", charged: 0 });
  expect(run.paid[1].reason).toMatch(/^Identity(, \w+)* failed\. Fix 1 follows\.$/);
  const fix1 = run.paid[2];
  expect(fix1).toMatchObject({ label: "Fix 1 · 01 — Opening", canRender: true, takeKind: "video" });
  expect(fix1.edit).toMatch(/^Replace the person's face with Mira/);
  expect(fix1.quote).toBeGreaterThan(0);
  expect(run.reason).toBe(`Fix 1 for 01 — Opening is ready to render · about ${cr(fix1.quote!)}.`);
  const fixRow = card.getByTestId(row(fix1.seq));
  await expect(fixRow.getByTestId("rig-agent-render-price")).toHaveText(`about ${cr(fix1.quote!)}`);
  await expect(fixRow.getByTestId("rig-agent-render-state")).toHaveText(fix1.note?.settled && fix1.note.credits ? `Ready · written for ${cr(fix1.note.credits)}` : "Ready");
  await expect(fixRow.getByTestId("rig-agent-edit")).toHaveText(fix1.edit!);
  await expect(fixRow.getByTestId("rig-agent-fix-terms")).toHaveText("An edit has no draft: it renders at full quality, priced on the clip it edits.");
  await expect(fixRow.getByTestId("rig-agent-render")).toHaveText(`Render the fix · about ${cr(fix1.quote!)}`);
  await floors(page, "fixes: fix 1 asks", phone);
  if (info.project.name === "workbench-1440x900") await card.screenshot({ path: info.outputPath("fix-asks-1440x900.png"), animations: "disabled" });
  if (info.project.name === "workbench-390x844") await card.screenshot({ path: info.outputPath("fix-asks-390x844.png"), animations: "disabled" });

  /* One tap: fix 1 renders; its check waits for the board; checked there, it fails again, and fix 2 asks in turn. */
  await (await reach(page, "rig-agent-render", row(fix1.seq))).click();
  await expect.poll(shape, { timeout: 120_000 }).toEqual([["render", "done"], ["verify", "done"], ["fix", "done"], ["verify", "paused"]]);
  await checkOnBoard((await read()).paid[3].seq, 2);
  await expect.poll(async () => (await shape()).slice(4), { timeout: 60_000 }).toEqual([["fix", "waiting"], ["verify", "next"]]);
  const fix2 = (await read()).paid[4];
  expect(fix2.label).toBe("Fix 2 · 01 — Opening");
  await (await reach(page, "rig-agent-render", row(fix2.seq))).click();
  await expect.poll(async () => (await shape()).slice(4), { timeout: 120_000 }).toEqual([["fix", "done"], ["verify", "paused"]]);
  await checkOnBoard((await read()).paid[5].seq, 3);

  /* Two fixes and it still fails: no third on its own. The shot is the person's, with its scorecard and the choices. */
  await expect.poll(async () => (await read()).paid[5].verdict, { timeout: 60_000 }).toBe("fail");
  run = await read();
  expect(run.paid).toHaveLength(6);
  const flagged = run.paid[5];
  expect(flagged).toMatchObject({ label: "Check fix 2 · 01 — Opening", state: "paused", pause: "check", choices: ["accept", "fix", "rerender", "skip"] });
  /* The mock judge fails every check that has a master (the masters are far from every frame): each one is named. */
  expect(flagged.reason).toBe("Atomik made 2 fixes and the take still fails Identity, Wardrobe and Environment. Look at it and decide.");
  expect(run.state).toBe("needs_you");
  const handed = card.getByTestId(row(flagged.seq));
  await expect(handed).toHaveAttribute("data-flagged", "");
  const identity = handed.getByTestId("rig-agent-scorecard").locator("li[data-check='identity']");
  await expect(identity).toHaveAttribute("data-verdict", "fail");
  await expect(identity).toContainText(/^IdentityFail.+like the master's\.$/);
  await expect(handed.getByTestId("rig-agent-choices").locator("button")).toHaveText([
    "Open its Verify card", "Accept as is", `Try another fix · about ${cr(fix2.quote!)}`, `Render again · about ${cr(take.quote!)}`, "Skip",
  ]);
  await floors(page, "fixes: handed over", phone);
  if (info.project.name === "workbench-1440x900") await card.screenshot({ path: info.outputPath("handed-over-1440x900.png"), animations: "disabled" });
  if (info.project.name === "workbench-390x844") await card.screenshot({ path: info.outputPath("handed-over-390x844.png"), animations: "disabled" });

  /* Accept as is: who decided, never "verified"; the run finishes. */
  await (await reach(page, "rig-agent-choice-accept", row(flagged.seq))).click();
  await expect(card.getByTestId("rig-agent-state")).toHaveText("Build the board", { timeout: 60_000 });
  run = await read();
  expect(run.state).toBe("done");
  expect(run.paid[5]).toMatchObject({ state: "done", verdict: "fail", reason: `Accepted by ${PERSON} despite a failed check.` });
  expect(JSON.stringify(run.paid)).not.toMatch(/verified/i);
  await expect(card.getByTestId("rig-agent-total")).toContainText(`1 draft rendered · 2 fixes · ${cr(run.money!.spent)} spent of ${cr(run.money!.limit)}`);
  /* The money: the run spent on planning, its draft, the two fix notes and the two fixes; the three checks were the person's own, on the board. */
  expect(run.money!.inFlight).toBe(0);
  const fixes = run.paid.filter((p) => p.tool === "fix");
  const notes = fixes.reduce((sum, p) => sum + (p.note?.credits ?? 0), 0);
  expect(run.money!.spent).toBe(tenths(run.money!.planning!.credits! + take.charged! + fixes.reduce((sum, p) => sum + p.charged!, 0) + notes));
  const stored = await page.request.get(`/api/workbench/development?projectId=${s.project.id}&verifications=1`, { headers: s.headers }).then((r) => r.json()) as { verifications: TakeVerification[] };
  expect(stored.verifications).toHaveLength(3);
  const checks = stored.verifications.reduce((sum, v) => sum + v.credits, 0);
  expect(tenths(start - (await balanceOf(page.request)))).toBe(tenths(run.money!.spent + checks));
  await floors(page, "fixes: done", phone);
  expect(starts).toHaveLength(3);
  expect(paid).toEqual([]);
  expect(errors).toEqual([]);
});
