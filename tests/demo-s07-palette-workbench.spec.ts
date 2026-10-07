import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { signInWithNewInterface } from "./helpers/newInterface";
import { forbidPaidWork } from "./helpers/workspaceFixtures";
import { smallTargets } from "./phoneFloors";
import { isCompact } from "./helpers/shellMode";
import { smallTextIn } from "./helpers/s07Floors";
import { newProject } from "../lib/workbench/studio";
import type { ApprovalsReply, QueueItem } from "../lib/control-room/queue";

/*
 * Stream 7 · ⌘K in the new interface (design/particl-graphite README § 3.4; Atomik frames a–e): search and Atomik in
 * one box. Real local ENGINE_MOCK=1 server. The approvals queue is stream 8's route, answered here by a fixture so the
 * approve card's own behaviour is what is tested: it lists, leaves admin items out, never approves on Enter, and its
 * one button sends each item through that item's own route, in order, stopping at the first refusal. No paid work is
 * sent anywhere (forbidPaidWork). Neutral names only.
 */
const SHOTS = process.env.S07_SHOTS || join(tmpdir(), "claude-s07-shots");
const shot = async (page: Page, name: string, info: { project: { name: string } }) => {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}-${info.project.name.replace(/^workbench-/, "")}.png` });
};
const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1280;
const phone = (page: Page) => (page.viewportSize()?.width ?? 0) < 768;

async function setUp(page: Page) {
  const workspaceId = (await signInWithNewInterface(page.request, "Palette Tester")).workspace.id;
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const scope = `particl-active-${workspaceId}-${me.id}`;
  const project = { ...newProject("Palette fixture"), brief: "A short film about a morning market opening." };
  const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.addInitScript(({ scope, id }) => { try { localStorage.setItem(scope, id); } catch { /* storage off */ } }, { scope, id: project.id });
  await forbidPaidWork(page);
  return { project };
}

async function noSideways(page: Page) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(over, "no horizontal overflow").toBeLessThanOrEqual(1);
}

async function floors(page: Page, where: string) {
  expect(await smallTextIn(page, ".gx-palette"), `${where}: text under 12 px`).toEqual([]);
  if (phone(page)) expect(await smallTargets(page, ".gx-palette"), `${where}: targets under 44 px`).toEqual([]);
}

test("⌘K opened by a link lists Home, the board's places, Make's types and tools, Atomik and Settings", async ({ page }, info) => {
  const { project } = await setUp(page);
  await page.goto(`/suites?project=${project.id}&palette=1`);
  const palette = page.getByTestId("atomik-palette");
  await expect(palette).toBeVisible();
  await expect(palette.getByRole("textbox", { name: "Search" })).toHaveAttribute("placeholder", "Search, or tell Atomik what to do");
  const rows = palette.getByTestId("palette-row");
  await expect(rows.first()).toContainText("Home");
  for (const label of ["Brief", "Looks", "Storyboard", "Shots", "Cast", "Cut", "Deliver", "Video", "Image", "Audio", "Motion transfer", "Object swap", "Atomik"]) await expect(palette.getByRole("option", { name: new RegExp(label) }).first()).toBeVisible();
  /* Settings' five sections are in the list too, below the fold of the scrolling list. */
  for (const label of ["Team", "Plan & credits", "Spending rules", "Connections", "Advanced"]) await expect(palette.getByRole("option", { name: new RegExp(label) }).first()).toBeAttached();
  await expect(rows).toHaveCount(21);
  await noSideways(page);
  await floors(page, "⌘K empty");
  await shot(page, "palette-empty", info);
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
});

test("go to cast: the place comes first; Enter takes the board there", async ({ page }, info) => {
  const { project } = await setUp(page);
  await page.goto(`/suites?project=${project.id}&palette=1&q=${encodeURIComponent("go to cast")}`);
  const palette = page.getByTestId("atomik-palette");
  await expect(palette.getByRole("textbox", { name: "Search" })).toHaveValue("go to cast");
  const first = palette.getByTestId("palette-row").first();
  await expect(first).toContainText("Go to Cast");
  await expect(first).toContainText("On the Studio board");
  await floors(page, "⌘K go to");
  await shot(page, "palette-go-to-cast", info);
  test.skip(!desktop(page), "the board canvas is desktop only (phones open the project's Record, stream 10)");
  await page.keyboard.press("Enter");
  await expect(palette).toBeHidden();
  await expect(page).toHaveURL(/view=board/);
  await expect(page.getByTestId("board")).toBeVisible();
  /* The board opens at that region (the address names it for the board to read). */
  await expect(page).toHaveURL(/region=cast/);
});

test("make …: Make opens filled with the words; nothing is made", async ({ page }, info) => {
  const { project } = await setUp(page);
  const posts: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && /\/api\/(generate|atomik)/.test(new URL(r.url()).pathname)) posts.push(new URL(r.url()).pathname); });
  await page.goto(`/suites?project=${project.id}&palette=1&q=${encodeURIComponent("make a slow push on the first stall")}`);
  const card = page.getByTestId("palette-make-card");
  await expect(card).toContainText("Make “a slow push on the first stall”");
  await expect(card).not.toContainText(/thinking/i);
  await floors(page, "⌘K make");
  await shot(page, "palette-make", info);
  await card.getByTestId("palette-open-make").click();
  /* Make opens filled with the words, and a person presses it: the panel's box on a desktop, the phone's own Make (its box is phone-make-prompt) at compact widths. */
  await expect(page.getByTestId(isCompact(info) ? "phone-make-prompt" : "gen-prompt")).toHaveValue("a slow push on the first stall");
  expect(posts, "nothing is made or asked").toEqual([]);
});

const item = (id: string, title: string, credits: number, more: Partial<QueueItem> = {}): QueueItem => ({
  id: `held:${id}`, source: "held", title, where: "Make", at: Number(id.replace(/\D/g, "")) || 1,
  project: { productionId: "prod-a", draftId: null, name: "Market film" }, price: { kind: "exact", credits },
  needsAdmin: false, canApprove: true, why: null, shortBy: null, note: null, step: null, sample: false,
  approve: { kind: "release", genId: `gen-${id}`, credits }, decline: { kind: "discard", genId: `gen-${id}` }, open: { kind: "take", genId: `gen-${id}`, draftId: null }, ...more,
});
const QUEUE: ApprovalsReply = {
  inCredits: true, decided: [],
  items: [
    item("1", "Keyframe · retake", 3),
    item("2", "Dialogue line", 1, { price: { kind: "up-to", credits: 1 }, project: { productionId: "prod-b", draftId: null, name: "Station spot" } }),
    item("3", "Hero take", 43, { needsAdmin: true, project: { productionId: "prod-b", draftId: null, name: "Station spot" } }),
  ],
};

async function approvalsFixture(page: Page, refuse: string | null = null) {
  const released: { id: string; body: unknown }[] = [];
  await page.route("**/api/control-room/approvals", (route) => route.fulfill({ json: QUEUE }));
  await page.route(/\/api\/jobs\/[^/]+\/release$/, async (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[3];
    released.push({ id, body: route.request().postDataJSON() });
    if (id === refuse) return route.fulfill({ status: 409, json: { error: "The balance changed. Nothing was charged." } });
    return route.fulfill({ json: { ok: true } });
  });
  return released;
}

test("approve everything under 10 cr: the list and its total; Enter only shows it; the button approves each in turn", async ({ page }, info) => {
  const { project } = await setUp(page);
  const released = await approvalsFixture(page);
  await page.goto(`/suites?project=${project.id}&palette=1&q=${encodeURIComponent("approve everything under 10 cr")}`);
  const card = page.getByTestId("palette-approve-card");
  await expect(card).toContainText("Approve everything under 10 cr");
  await expect(card.getByTestId("palette-approve-row")).toHaveCount(2);
  await expect(card.getByTestId("palette-approve-rows")).toContainText("Market film");
  await expect(card.getByTestId("palette-approve-rows")).toContainText("up to 1 cr");
  await expect(card.getByTestId("palette-approve-total")).toHaveText("Total · up to 4 cr");
  await expect(card).toContainText("Only you approve spend. Enter shows this list; the button approves.");
  const confirm = card.getByTestId("palette-approve-confirm");
  await expect(confirm).toHaveText("Approve 2 items · up to 4 cr");
  await expect(confirm).toHaveAttribute("data-spend", "priced");
  await expect(confirm).toHaveAttribute("data-spend-price", "up to 4 cr");
  await expect(card.getByTestId("palette-approve-admin")).toHaveCount(0);
  await floors(page, "⌘K approve under 10");
  await shot(page, "palette-approve-10", info);
  await page.getByRole("textbox", { name: "Search" }).press("Enter");
  await page.waitForTimeout(400);
  expect(released, "Enter never approves").toEqual([]);
  await confirm.click();
  await expect(page.getByTestId("palette-approve-card")).toBeHidden();
  expect(released).toEqual([{ id: "gen-1", body: { credits: 3 } }, { id: "gen-2", body: { credits: 1 } }]);
  await expect(page.getByTestId("toast")).toContainText("Approved 2 items · up to 4 cr");
});

test("approve everything under 50 cr: an item an admin must press is listed apart and left out", async ({ page }, info) => {
  const { project } = await setUp(page);
  const released = await approvalsFixture(page, "gen-2");
  await page.goto(`/suites?project=${project.id}&palette=1&q=${encodeURIComponent("approve everything under 50 cr")}`);
  const card = page.getByTestId("palette-approve-card");
  const admin = card.getByTestId("palette-approve-admin");
  await expect(admin).toContainText("Needs an admin");
  await expect(admin).toContainText("Hero take");
  await expect(admin).toContainText("43 cr");
  await expect(card.getByTestId("palette-approve-confirm")).toHaveText("Approve 2 items · up to 4 cr");
  await floors(page, "⌘K approve under 50");
  await shot(page, "palette-approve-50", info);
  /* The second is refused: the first stays approved, the card says where it stopped, nothing after it is sent. */
  await card.getByTestId("palette-approve-confirm").click();
  await expect(card.getByTestId("palette-approve-refusal")).toHaveText("Approved 1 of 2 · Dialogue line: The balance changed. Nothing was charged.");
  expect(released.map((r) => r.id)).toEqual(["gen-1", "gen-2"]);
});

test("a question is free; a request shows what thinking may cost, from the server", async ({ page }, info) => {
  const { project } = await setUp(page);
  await page.goto(`/suites?project=${project.id}&palette=1&q=${encodeURIComponent("how do I add a reference to a shot?")}`);
  const card = page.getByTestId("palette-atomik-card");
  await expect(card).toContainText("Ask Atomik: how do I add a reference to a shot?");
  await expect(card.getByTestId("palette-thinking-line")).toHaveText("A question about Particl · answered free");
  await expect(card.getByTestId("palette-ask")).toHaveText("Ask · free");
  await floors(page, "⌘K how");
  await shot(page, "palette-how", info);
  const input = page.getByRole("textbox", { name: "Search" });
  await input.fill("plan a short film about the market at dawn");
  await expect(card.getByTestId("palette-ask")).toHaveText(/^Ask · up to \d+ cr$/, { timeout: 15_000 });
  await expect(card.getByTestId("palette-ask")).toHaveAttribute("data-spend", "priced");
  await expect(card.getByTestId("palette-ask")).toHaveAttribute("data-spend-price", /^up to \d+ cr$/);
  await expect(card.getByTestId("palette-thinking-line")).toHaveText(/^Atomik’s thinking may cost up to \d+ cr · it plans and prices first; nothing is spent without your approval$/);
  await noSideways(page);
  await shot(page, "palette-ask", info);
});
