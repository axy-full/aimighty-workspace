import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { signInWithNewInterface } from "./helpers/newInterface";
import { forbidPaidWork } from "./helpers/workspaceFixtures";
import { smallTextIn } from "./helpers/s07Floors";
import { newProject } from "../lib/workbench/studio";

/*
 * Stream 7 · Atomik's panel over any screen and "Ask Atomik how" (design/particl-graphite README § 1, § 3.4; Atomik
 * frames f and p). Real local ENGINE_MOCK=1 server: a question is answered free from the table (no request reaches
 * Atomik's paid routes), its offer does the thing, commands never spend, and a request is a turn in the project's
 * Atomik thread sent with the very figure its button showed as its ceiling (the mocked planner answers; no provider).
 * Nothing renders: forbidPaidWork. Below 768 px the phone's sheet (stream 10) answers the address, so the panel is
 * not drawn there. Neutral names only.
 */
const SHOTS = process.env.S07_SHOTS || "/private/tmp/claude-s07-shots";
const shot = async (page: Page, name: string, info: { project: { name: string } }) => {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}-${info.project.name.replace(/^workbench-/, "")}.png` });
};
const wide = (page: Page) => (page.viewportSize()?.width ?? 0) >= 768;

async function setUp(page: Page) {
  const workspaceId = (await signInWithNewInterface(page.request, "Panel Tester")).workspace.id;
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const scope = `particl-active-${workspaceId}-${me.id}`;
  const project = { ...newProject("Panel fixture"), brief: "A short film about a morning market opening." };
  const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.addInitScript(({ scope, id }) => { try { localStorage.setItem(scope, id); } catch { /* storage off */ } }, { scope, id: project.id });
  await forbidPaidWork(page);
  /* Atomik's paid routes: a turn (POST /api/atomik/:id) is the only one a person can send from the panel. */
  const paid: { path: string; body: Record<string, unknown> | null }[] = [];
  page.on("request", (r) => {
    const path = new URL(r.url()).pathname;
    if (r.method() === "POST" && /^\/api\/atomik\/[^/]+$/.test(path) && !["memory", "skills", "threads", "ideas", "treatment"].includes(path.split("/")[3])) {
      const body = r.postDataJSON() as Record<string, unknown> | null;
      if (body?.quoteOnly !== true) paid.push({ path, body });
    }
  });
  return { project, paid };
}

async function noSideways(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), "no horizontal overflow").toBeLessThanOrEqual(1);
}

test("the panel over a page: the control room's places, Ask Atomik how, and Ask · free", async ({ page }, info) => {
  const { project } = await setUp(page);
  await page.goto(`/suites?project=${project.id}&atomik=1`);
  const panel = page.getByTestId("atomik-panel-global");
  if (!wide(page)) {
    await page.waitForTimeout(800);
    await expect(panel, "phones answer with stream 10's sheet").toHaveCount(0);
    await noSideways(page);
    return;
  }
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("navigation", { name: "Control room" }).getByRole("button")).toHaveText(["Approvals", "Activity", "Skills", "Memory"]);
  const hints = panel.getByTestId("atomik-hints");
  await expect(hints).toContainText("Ask Atomik how");
  await expect(hints.getByRole("button")).toHaveText(["How do I add a reference to a shot?", "What does a hero take cost?", "Approve everything under 10 cr"]);
  await expect(panel.getByTestId("atomik-input")).toHaveAttribute("placeholder", "How do I…? Or tell Atomik what to do.");
  await expect(panel.getByTestId("atomik-send")).toHaveText("Ask · free");
  await expect(panel.getByTestId("atomik-send")).toHaveAttribute("title", "How-to answers are free");
  expect(await smallTextIn(page, ".ak-panel"), "text under 12 px").toEqual([]);
  await noSideways(page);
  await shot(page, "panel", info);
  /* Esc closes it, and the address forgets it. */
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(page).not.toHaveURL(/atomik=/);
});

test("Ask Atomik how: answered free, and the offer does the thing", async ({ page }, info) => {
  test.skip(!wide(page), "phones answer with stream 10's sheet");
  const { project, paid } = await setUp(page);
  await page.goto(`/suites?project=${project.id}&atomik=how`);
  const panel = page.getByTestId("atomik-panel-global");
  const lines = panel.getByTestId("atomik-line");
  await expect(lines.nth(0)).toContainText("How do I add a reference to a shot?");
  await expect(lines.nth(1)).toContainText("Drag anything from the Library onto the shot, or press + in Make’s references tray. I can open the Library for you.");
  await shot(page, "panel-how", info);
  await panel.getByTestId("atomik-offer").click();
  await expect(page.getByTestId("library")).toBeVisible();

  /* Another question, typed: free, and its offer goes where the screen's own control goes. */
  await panel.getByTestId("atomik-input").fill("how do I see what each run cost?");
  await expect(panel.getByTestId("atomik-send")).toHaveText("Ask · free");
  await panel.getByTestId("atomik-input").press("Enter");
  await expect(lines.last()).toContainText("Activity shows what each run settled at.");
  await lines.last().getByTestId("atomik-offer").click();
  await expect(page).toHaveURL(/suite=atomik/);
  await expect(page).toHaveURL(/page=runs/);
  await expect(panel).toBeVisible();
  expect(paid, "no paid Atomik request").toEqual([]);
});

test("commands never spend: approve opens ⌘K's list, remember keeps a line once a person confirms", async ({ page }) => {
  test.skip(!wide(page), "phones answer with stream 10's sheet");
  const { project, paid } = await setUp(page);
  await page.goto(`/suites?project=${project.id}&atomik=1`);
  const panel = page.getByTestId("atomik-panel-global");
  await panel.getByRole("button", { name: "Approve everything under 10 cr" }).click();
  await expect(page.getByTestId("atomik-palette")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Search" })).toHaveValue("Approve everything under 10 cr");
  await page.keyboard.press("Escape");
  await expect(panel.getByTestId("atomik-line").last()).toContainText("you confirm with one tap");

  await panel.getByTestId("atomik-input").fill("remember our films open on a detail");
  await expect(panel.getByTestId("atomik-send")).toHaveText("Ask · free");
  await panel.getByTestId("atomik-send").click();
  const remember = panel.getByTestId("atomik-remember");
  await expect(remember).toContainText("our films open on a detail");
  const added = page.waitForResponse((r) => r.url().endsWith("/api/atomik/memory") && r.request().method() === "POST");
  await remember.getByTestId("atomik-remember-save").click();
  expect((await added).ok()).toBe(true);
  await expect(panel.getByTestId("atomik-line").last()).toContainText("Atomik will remember that.");
  expect(paid, "no paid Atomik request").toEqual([]);
});

test("a request: Ask · up to N cr from the server, sent with N as its ceiling, answered in the project's thread", async ({ page }, info) => {
  test.skip(!wide(page), "phones answer with stream 10's sheet");
  const { project, paid } = await setUp(page);
  await page.goto(`/suites?project=${project.id}&atomik=1`);
  const panel = page.getByTestId("atomik-panel-global");
  await panel.getByTestId("atomik-input").fill("plan a short film about the market at dawn");
  const send = panel.getByTestId("atomik-send");
  await expect(send).toHaveText(/^Ask · up to \d+ cr$/, { timeout: 20_000 });
  const shown = Number((await send.textContent())!.match(/up to (\d+) cr/)![1]);
  await shot(page, "panel-ask-priced", info);
  await send.click();
  await expect(panel.getByTestId("atomik-thread-line").first()).toContainText("plan a short film about the market at dawn", { timeout: 30_000 });
  await expect(panel.getByTestId("atomik-thread-line").nth(1)).toBeVisible({ timeout: 30_000 });
  expect(paid).toHaveLength(1);
  /* The figure on the button is the ceiling the turn was sent with: nothing above it can be charged. */
  expect(paid[0].body?.maxCredits).toBeLessThanOrEqual(shown);
  expect(Math.ceil(Number(paid[0].body?.maxCredits))).toBe(shown);
  await noSideways(page);
  await shot(page, "panel-thread", info);
});

test("the header's Atomik opens and closes the panel; × closes it", async ({ page }) => {
  test.skip(!wide(page) || (page.viewportSize()?.width ?? 0) < 1280, "the header's segment is a desktop control");
  const { project } = await setUp(page);
  await page.goto(`/suites?project=${project.id}`);
  const panel = page.getByTestId("atomik-panel-global");
  const segment = page.locator('[data-suite-tab="atomik"]');
  await segment.click();
  await expect(panel).toBeVisible();
  await expect(page).toHaveURL(/atomik=1/);
  await expect(segment).toHaveAttribute("aria-selected", "true");
  await panel.getByTestId("atomik-panel-close").click();
  await expect(panel).toBeHidden();
  await expect(segment).toHaveAttribute("aria-selected", "false");
});
