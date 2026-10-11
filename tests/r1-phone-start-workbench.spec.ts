import { test, expect, type Page, type Route } from "@playwright/test";
import { createClient } from "@libsql/client";
import { localPlatformDbUrl } from "./helpers/workbenchLocal";
import { signInWithNewInterface } from "./helpers/newInterface";
import { forbidPaidWork } from "./helpers/workspaceFixtures";
import { expectFloors } from "./phoneFloors";
import type { Project } from "../lib/workbench/studio";

/**
 * Release 1 must-have: the phone's Home can start a project. The signed-in phone Home is not drawn with a box (frame A is
 * "Needs you" and the projects); the signed-out one is (README § 3.7, P1), so this is the desktop Home's own box, Start and
 * templates, run by the same hook (components/graphite/home/use-home-start.ts), in P1's layout.
 *
 * Every paid route is answered here, and nothing is pressed that spends: Atomik's thinking (agent.plan) is answered by a
 * fixture and counted. "Start · up to N cr" carries the server's figure; nothing is asked before the press.
 */
const HOME = "/suites?view=home";
/** The viewports where the shell mounts the phone app (lib/shell/use-compact.ts): narrower than 768 px, or a touch screen no taller than 500 px. */
const onPhone = (info: { project: { name: string } }) => ["workbench-360x640", "workbench-390x844", "workbench-844x390"].includes(info.project.name);

async function account(page: Page) {
  const signed = await signInWithNewInterface(page.request);
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try { await db.execute({ sql: "UPDATE workspaces SET plan_id='studio' WHERE id=?", args: [signed.workspace.id] }); } finally { db.close(); }
  const me = await page.request.get("/api/me").then((r) => r.json());
  return { headers: { "X-Workbench-Scope": `particl-active-${me.workspace.id}-${me.id}` } };
}

async function quiet(page: Page) {
  await page.route((url) => url.pathname === "/api/jobs" && url.searchParams.get("view") === "tray", (route) => route.fulfill({ json: { jobs: [], pollAfterSeconds: 60 } }));
  await page.route((url) => url.pathname === "/api/control-room/approvals", (route) => route.fulfill({ json: { items: [], decided: [], inCredits: true } }));
}

/** The server's figure for a new board: read, never spent. */
async function figureOf(page: Page, headers: Record<string, string>): Promise<number> {
  const reply = await page.request.get("/api/workbench/team-canvas?agent=1&board=new", { headers }).then((r) => r.json());
  expect(reply.agent).toMatchObject({ enabled: true, run: null });
  expect(reply.agent.ask.planning).toBeGreaterThan(0);
  return reply.agent.ask.planning as number;
}

/** Nothing that generates or spends is called; every POST is listed so a test can say what was sent. */
function watch(page: Page) {
  const paid: string[] = [];
  const asks: Record<string, unknown>[] = [];
  const puts: Project[] = [];
  page.on("request", (r) => {
    const path = new URL(r.url()).pathname;
    if (r.method() === "PUT" && path === "/api/workbench/projects") puts.push((r.postDataJSON() as { project: Project }).project);
    if (r.method() !== "GET" && /^\/api\/(generate|audio|soul|jobs)/.test(path)) paid.push(`${r.method()} ${path}`);
  });
  return { paid, asks, puts };
}

async function openPhoneHome(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(HOME);
  await expect(page.getByTestId("phone-home")).toBeVisible({ timeout: 60_000 });
  return errors;
}

test.beforeEach(({}, info) => { test.skip(!onPhone(info), "the phone's Home; the desktop Home has its own specs (demo-s02-*)"); });

test("phone Home: the box, the four templates and Start at the server's figure, and nothing is paid before the press", async ({ page }) => {
  const { headers } = await account(page);
  await forbidPaidWork(page);
  await quiet(page);
  const figure = await figureOf(page, headers);
  const sent = watch(page);
  const errors = await openPhoneHome(page);

  const start = page.getByTestId("phone-start");
  await expect(start).toBeVisible();
  await expect(page.getByTestId("phone-start-title")).toHaveText("What are we making?");
  await expect(page.getByTestId("home-templates").getByRole("button")).toHaveText(["Film", "Ad campaign", "Social clips", "Start from a script"]);
  const go = page.getByTestId("home-start");
  await expect(go).toHaveText(`Start · up to ${figure} cr`);
  await expect(go).toHaveAttribute("data-spend-price", `up to ${figure} cr`);
  await expect(go).toHaveAttribute("title", /^up to \$\d+\.\d\d$/);
  await expect(go).toBeEnabled();

  /* Typing a brief, a frame and a length ask nothing and spend nothing. */
  await page.getByTestId("home-brief").fill("A lighthouse keeper's last night. Wind on the glass.");
  await page.locator('[data-testid="home-aspect"][data-value="9:16"]').click();
  await page.locator('[data-testid="home-length"][data-value="30 s"]').click();
  await expect(page.locator('[data-testid="home-aspect"][data-value="9:16"]')).toHaveAttribute("aria-pressed", "true");
  await expect(go).toHaveText(`Start · up to ${figure} cr`);
  expect(sent.paid, "nothing paid, nothing asked").toEqual([]);
  expect(sent.puts, "no project made by typing").toEqual([]);

  await go.scrollIntoViewIfNeeded();
  if (process.env.R1_PHONE_SHOTS) await page.screenshot({ path: `${process.env.R1_PHONE_SHOTS}/start-${test.info().project.name}.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), "horizontal overflow").toBeLessThanOrEqual(0);
  await expectFloors(page, "phone Home with the box", { scope: ".ph-app" });
  expect(errors).toEqual([]);
});

test("phone Home: Start makes the project, asks Atomik once at the pressed limit, and lands in the new project's Record", async ({ page }) => {
  const { headers } = await account(page);
  await forbidPaidWork(page);
  await quiet(page);
  const figure = await figureOf(page, headers);
  const sent = watch(page);
  await page.route((url) => url.pathname === "/api/workbench/team-canvas", (route: Route) => {
    const request = route.request();
    if (request.method() === "POST" && (request.postDataJSON() as { action?: string }).action === "agent.plan") {
      sent.asks.push(request.postDataJSON());
      return route.fulfill({ status: 202, json: { agent: { enabled: true, run: null, ask: null } } });
    }
    return route.fallback();
  });
  await openPhoneHome(page);

  /* No words: it says so and asks nothing. */
  await page.getByTestId("home-start").click();
  await expect(page.getByTestId("home-start-problem")).toHaveText("Say what we are making, or pick a template.");
  expect(sent.asks).toEqual([]);

  await page.getByTestId("home-brief").fill("A lighthouse keeper's last night. Wind on the glass.");
  await page.locator('[data-testid="home-length"][data-value="30 s"]').click();
  await page.getByTestId("home-start").click();

  await expect(page.getByTestId("phone-app")).toHaveAttribute("data-screen", "record", { timeout: 60_000 });
  await expect(page.getByTestId("phone-title")).toHaveText("A lighthouse keeper's last night", { timeout: 30_000 });
  expect(sent.puts).toHaveLength(1);
  expect(sent.puts[0]).toMatchObject({ name: "A lighthouse keeper's last night", boardKind: "studio", deliverables: "30 s" });
  expect(sent.asks).toHaveLength(1);
  expect(sent.asks[0]).toMatchObject({ action: "agent.plan", projectId: sent.puts[0].id, limit: figure, mode: "ask", goal: "A lighthouse keeper's last night. Wind on the glass. · 16:9 · 30 s" });
  expect(sent.paid, "no generation, only Atomik's thinking at the pressed limit").toEqual([]);
  expect(new URL(page.url()).searchParams.get("atomik")).toBeNull();
  await expectFloors(page, "phone Record of the new project", { scope: ".ph-app" });
});

test("phone Home: a template makes the project free, with what the box holds, and lands in its Record", async ({ page }) => {
  await account(page);
  await forbidPaidWork(page);
  await quiet(page);
  const sent = watch(page);
  await openPhoneHome(page);

  await page.getByTestId("home-brief").fill("A launch film for a ceramic kettle.");
  await page.getByTestId("home-template-ads").click();
  await expect(page.getByTestId("phone-app")).toHaveAttribute("data-screen", "record", { timeout: 60_000 });
  await expect(page.getByTestId("phone-title")).toHaveText("A launch film for a ceramic kettle", { timeout: 30_000 });
  expect(sent.puts).toHaveLength(1);
  expect(sent.puts[0]).toMatchObject({ name: "A launch film for a ceramic kettle", boardKind: "ads" });
  expect(sent.paid, "a template spends nothing").toEqual([]);

  /* Back on Home the box is empty (the draft was cleared) and the Film template makes a studio project. */
  await page.getByTestId("phone-back").click();
  await expect(page.getByTestId("phone-home")).toBeVisible();
  await expect(page.getByTestId("home-brief")).toHaveValue("");
  await page.getByTestId("home-template-script").click();
  await expect(page.getByTestId("phone-app")).toHaveAttribute("data-screen", "record", { timeout: 60_000 });
  expect(sent.puts).toHaveLength(2);
  expect(sent.puts[1]).toMatchObject({ name: "Untitled script", boardKind: "studio" });
  expect(sent.paid).toEqual([]);
});
