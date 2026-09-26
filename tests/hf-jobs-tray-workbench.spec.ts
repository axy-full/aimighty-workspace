import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";
import { smallTargets } from "./phoneFloors";
import type { TrayJob, TrayReply } from "../lib/jobsTray";

/**
 * The header's jobs tray. The pill counts every take this person has in
 * flight or held — from any page and either engine — and opens a tray (a
 * popover on desktop, a bottom sheet on a phone) whose rows say each job's
 * real stage, its age and approved price, and offer one thing to do: Open in
 * Takes, Release a held one (Top up when the balance is short), or Recreate a
 * failed one in Gen. The route is exercised for real against seeded rows; the
 * UI tests answer the tray's read from a route mock. Nothing is paid for.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844"];
const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const SHOTS: Record<string, string> = Object.fromEntries(SIZES.map((name) => [name, name.replace("workbench-", "")]));
const DRAFT = "ws-tray";
const MIN = 60_000;
const fixture = (): Project => ({ ...newProject("Harbour launch spot"), id: DRAFT, productionProjectId: "prod-tray", shotMappings: {} });

function job(fields: Partial<TrayJob> & Pick<TrayJob, "id" | "name" | "stage" | "label" | "tone">): TrayJob {
  const now = Date.now();
  return { source: "engine", kind: "video", mediaUrl: null, reason: null, progress: null, createdAt: now, updatedAt: now, price: null, draftId: DRAFT, projectName: "Harbour launch spot", action: null, recipe: null, ...fields };
}
function busyTray(): TrayJob[] {
  const now = Date.now();
  return [
    job({ id: "gen_held", name: "Harbour at dawn", stage: "held", label: "Held · needs 43 cr", tone: "amber", action: "release", price: { amount: 43, unit: "cr" }, createdAt: now - 12 * MIN }),
    job({ id: "gen_run", name: "S01 · Wide on the water", stage: "rendering", label: "Rendering", tone: "blue", price: { amount: 13, unit: "cr" }, createdAt: now - 4 * MIN }),
    job({ id: "3f7a1c2e-5b6d-4e8f-9a0b-1c2d3e4f5a6b", source: "account", name: "Product spins on a marble plinth", stage: "rendering", label: "Rendering", tone: "blue", price: { amount: 40, unit: "account-cr" }, createdAt: now - 2 * MIN, draftId: "ws-other", projectName: "Trail bottle ads" }),
    job({ id: "gen_fail", name: "Lighthouse at dusk", stage: "failed", label: "Failed · not billed", tone: "red", reason: "The engine refused this prompt.", action: "recreate", createdAt: now - 30 * MIN, updatedAt: now - 20 * MIN,
      recipe: { prompt: "A slow push-in on a lighthouse at dusk", model: "dreamina-seedance-2-5-260628", kind: "video", title: "Lighthouse at dusk", task: "generate", params: { ratio: "16:9", duration: 5 } } }),
    job({ id: "gen_done", kind: "image", name: "Gulls over the pier", stage: "complete", label: "Complete", tone: "green", mediaUrl: "/api/media/gen_done", action: "open", price: { amount: 3, unit: "cr" }, createdAt: now - 50 * MIN, updatedAt: now - 45 * MIN }),
  ];
}

type Tray = { reads: number; reply: () => { status?: number; json: unknown }; gate?: Promise<void> | null };
async function open(page: Page, tray: Tray, url = "/suites?suite=studio&page=rig") {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture(), list: [{ id: DRAFT, name: "Harbour launch spot" }, { id: "ws-other", name: "Trail bottle ads" }] });
  await mockLibrary(page, { uploads: [], generations: [] });
  await page.route(/\/api\/jobs\?view=tray/, async (route) => {
    tray.reads++;
    /* A spec can hold a read out, to see what is asked meanwhile. */
    if (tray.gate) await tray.gate;
    const { status, json } = tray.reply();
    return route.fulfill({ status: status ?? 200, json });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await expect(page.getByTestId("project-name").first()).toHaveText("Harbour launch spot");
  return errors;
}
const reply = (jobs: TrayJob[], pollAfterSeconds = 10): { json: TrayReply } => ({ json: { jobs, pollAfterSeconds } });

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
}
async function shoot(page: Page, project: string, name: string) {
  const size = SHOTS[project];
  const dir = process.env.HF_JOBS_SHOTS;
  if (!size || !dir) return;
  mkdirSync(dir, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(dir, `${name}-${size}.png`) });
}
/** The sheet rises and the popover pops in: measure it once it has arrived. */
async function arrived(page: Page) {
  await page.getByTestId("jobs-veil").evaluate((veil) => Promise.all(veil.getAnimations({ subtree: true }).filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished)));
}
async function setHidden(page: Page, hidden: boolean) {
  await page.evaluate((value) => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (value ? "hidden" : "visible") });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

test("the pill counts what renders and what is held, and opens a tray with each job's real stage, age, price and one action", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const phone = PHONES.includes(info.project.name);
  const tray: Tray = { reads: 0, reply: () => reply(busyTray()) };
  const errors = await open(page, tray);

  const pill = page.getByTestId("running-jobs");
  await expect(pill).toHaveAccessibleName("Jobs: 2 rendering · 1 held");
  await expect(pill).toHaveAttribute("aria-expanded", "false");
  await expect(pill.locator(phone ? ".gx-jobs-short" : ".gx-jobs-long")).toHaveText(phone ? "3" : "2 rendering · 1 held");
  await expect(pill.locator(phone ? ".gx-jobs-long" : ".gx-jobs-short")).toBeHidden();
  if (phone) {
    const target = (await pill.boundingBox())!;
    expect(target.height).toBeGreaterThanOrEqual(44);
    expect(target.width).toBeGreaterThanOrEqual(44);
    /* The header keeps one row: the pill never pushes the avatar onto a line of its own. */
    const [pillTop, avatarTop] = await Promise.all([pill, page.getByTestId("workspace-avatar")].map((l) => l.evaluate((el) => Math.round(el.getBoundingClientRect().top))));
    expect(avatarTop).toBe(pillTop);
  }
  await noOverflow(page);
  await shoot(page, info.project.name, "jobs-pill");

  await pill.click();
  const panel = page.getByRole("dialog", { name: "Jobs" });
  await expect(panel).toBeVisible();
  await expect(pill).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("jobs-summary")).toHaveText("2 rendering · 1 held");
  const rows = panel.getByTestId("jobs-row");
  await expect(rows).toHaveCount(5);
  /* Held first (it waits on you), then what renders newest first, then what finished. */
  await expect(rows.locator(".gx-jobs-name")).toHaveText(["Harbour at dawn", "Product spins on a marble plinth", "S01 · Wide on the water", "Lighthouse at dusk", "Gulls over the pier"]);
  await expect(rows.getByTestId("jobs-stage")).toHaveText(["Held · needs 43 cr", "Rendering", "Rendering", "Failed · not billed", "Complete"]);
  await expect(rows.nth(0).locator(".gx-jobs-meta")).toHaveText("Held · needs 43 cr · 12 min");
  await expect(rows.nth(2).locator(".gx-jobs-meta")).toHaveText("Rendering · 4 min · 13 cr");
  /* A connected job's figure is the account's own credits, and says so: never mistaken for the workspace's. */
  await expect(rows.nth(1).locator(".gx-jobs-meta")).toHaveText("Rendering · 2 min · 40 connected cr");
  /* Made in another project: named, so the row says where Open would go. */
  await expect(rows.nth(1).getByTestId("jobs-where")).toHaveText("Trail bottle ads");
  await expect(rows.nth(2).getByTestId("jobs-where")).toHaveCount(0);
  /* No engine reports a percentage: an indeterminate bar on what runs, and nothing on the rest. */
  await expect(panel.getByTestId("jobs-bar")).toHaveCount(2);
  await expect(panel.getByTestId("jobs-bar").first()).not.toHaveAttribute("aria-valuenow", /.*/);
  await expect(rows.nth(3).getByTestId("jobs-reason")).toHaveText("The engine refused this prompt.");
  await expect(rows.getByTestId("jobs-action")).toHaveText(["Release", "Recreate", "Open in Takes"]);
  await expect(rows.nth(4).locator(".gx-jobs-thumb img")).toBeVisible();
  expect(errors).toEqual([]);

  /* Geometry: a bottom sheet across a phone, a popover under the pill elsewhere; nothing spills. */
  await arrived(page);
  const box = (await panel.boundingBox())!;
  const view = page.viewportSize()!;
  if (phone) {
    expect(Math.round(box.width)).toBe(view.width);
    expect(Math.round(box.y + box.height)).toBe(view.height);
    expect(await smallTargets(page, ".gx-jobs-tray"), "targets under 44×44").toEqual([]);
  } else {
    const pillBox = (await pill.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(pillBox.y + pillBox.height);
    expect(box.x + box.width).toBeLessThanOrEqual(view.width);
    expect(box.y + box.height).toBeLessThanOrEqual(view.height);
    expect(Math.abs(box.x + box.width - (pillBox.x + pillBox.width))).toBeLessThanOrEqual(2);
  }
  await noOverflow(page);
  await shoot(page, info.project.name, "jobs-tray");

  /* Escape closes it and hands focus back to the pill. */
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(pill).toBeFocused();
});

test("Release starts a held take; when the balance is short it says so and offers Top up", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const tray: Tray = { reads: 0, reply: () => reply(busyTray()) };
  await open(page, tray);
  const releases: string[] = [];
  let short = true;
  await page.route(/\/api\/jobs\/[^/]+\/release$/, (route) => {
    releases.push(new URL(route.request().url()).pathname);
    if (short) return route.fulfill({ status: 402, json: { error: "Still short: this needs 43 credits and 5 are left." } });
    /* Released: from now on the read has it queued. */
    tray.reply = () => reply(busyTray().map((j) => (j.id === "gen_held" ? { ...j, stage: "queued", label: "Queued", tone: "blue", action: null } : j)));
    return route.fulfill({ json: { released: true, id: "gen_held" } });
  });
  await page.getByTestId("running-jobs").click();
  const held = page.getByTestId("jobs-row").filter({ hasText: "Harbour at dawn" });
  await held.getByRole("button", { name: "Release: Harbour at dawn" }).click();
  await expect(held.getByTestId("jobs-problem")).toHaveText("Still short: this needs 43 credits and 5 are left.");
  await expect(held.getByTestId("jobs-action")).toHaveText("Top up");
  expect(releases).toEqual(["/api/jobs/gen_held/release"]);
  await shoot(page, info.project.name, "jobs-tray-short");

  /* Top up goes where credits are bought; the tray closes. */
  await held.getByTestId("jobs-action").click();
  await expect(page.getByRole("dialog", { name: "Jobs" })).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.get("tab")).toBe("credits");
  await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("workspace");

  /* With the balance topped up, Release starts it and the tray reads again at once. */
  short = false;
  await page.getByTestId("running-jobs").click();
  await expect(page.getByRole("dialog", { name: "Jobs" })).toBeVisible();
  const before = tray.reads;
  await page.getByRole("button", { name: "Release: Harbour at dawn" }).click();
  await expect(page.getByTestId("toast")).toHaveText("Released. It renders now.");
  await expect.poll(() => tray.reads).toBeGreaterThan(before);
  expect(releases).toHaveLength(2);
  await expect(page.getByTestId("jobs-row").filter({ hasText: "Harbour at dawn" }).getByTestId("jobs-stage")).toHaveText("Queued");
  await expect(page.getByTestId("running-jobs")).toHaveAccessibleName("Jobs: 3 rendering");
});

test("Recreate hands a failed take's own recipe to Gen without sending anything, and Open lands in Takes", async ({ page }, info) => {
  test.skip(![...DESKTOP, "workbench-390x844", "workbench-844x390"].includes(info.project.name), "desktop, a phone, and a phone on its side");
  const tray: Tray = { reads: 0, reply: () => reply(busyTray()) };
  const errors = await open(page, tray);
  const paid: string[] = [];
  page.on("request", (request) => { if (request.method() === "POST" && /\/api\/(generate|audio|jobs\/[^/]+\/retry)(\?|$)/.test(new URL(request.url()).pathname)) paid.push(request.url()); });

  await page.getByTestId("running-jobs").click();
  await page.getByRole("button", { name: "Recreate: Lighthouse at dusk" }).click();
  await expect(page.getByRole("dialog", { name: "Jobs" })).toHaveCount(0);
  await expect(page.getByTestId("page-title")).toHaveText("Generate");
  await expect(page.getByTestId("gen-prompt")).toHaveValue("A slow push-in on a lighthouse at dusk");
  await expect(page.getByTestId("toast")).toHaveText("Retry Lighthouse at dusk — same inputs, new seed. Quoted before it runs.");
  await expect(page.getByTestId("gen-preset-note")).toContainText("Retry · Lighthouse at dusk");

  await page.getByTestId("running-jobs").click();
  await page.getByRole("button", { name: "Open in Takes: Gulls over the pier" }).click();
  await expect(page.getByTestId("page-title")).toHaveText("Takes");
  await expect(page.getByTestId("project-name").first()).toHaveText("Harbour launch spot");
  expect(paid).toEqual([]);
  expect(errors).toEqual([]);
});

test("the tray reads at the server's pace, not while the tab is hidden, and at once when a job starts or the tray opens", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "timing is the same at every size");
  await page.clock.install();
  const tray: Tray = { reads: 0, reply: () => reply(busyTray(), 10) };
  await open(page, tray);
  await expect.poll(() => tray.reads).toBe(1);
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(now + 50);
  await page.waitForTimeout(250);

  /* Never sooner than the 10 s the server asked for (plus the margin), nor much later. */
  await page.clock.runFor(9_000);
  await page.waitForTimeout(300);
  expect(tray.reads).toBe(1);
  await page.clock.runFor(4_000);
  await expect.poll(() => tray.reads).toBe(2);
  await page.waitForTimeout(250);

  /* Hidden: nothing is asked; back: the read that fell due is made at once. */
  await setHidden(page, true);
  await page.clock.runFor(60_000);
  await page.waitForTimeout(300);
  expect(tray.reads).toBe(2);
  await setHidden(page, false);
  await expect.poll(() => tray.reads).toBe(3);
  await page.waitForTimeout(250);

  /* A job started anywhere (the shared dispatch, Business, Viral) is read for at once. */
  const announce = (id: string) => page.evaluate((job) => window.dispatchEvent(new CustomEvent("particl:jobs", { detail: { id: job } })), id);
  await announce("gen_new");
  await expect.poll(() => tray.reads).toBe(4);
  await page.waitForTimeout(250);

  /* Another is announced while that read is still out: one more read the moment it is back, not on the next turn. */
  let letGo: () => void = () => {};
  tray.gate = new Promise<void>((resolve) => { letGo = resolve; });
  await announce("gen_a");
  await expect.poll(() => tray.reads).toBe(5);
  await announce("gen_b");
  await page.waitForTimeout(250);
  expect(tray.reads).toBe(5);
  tray.gate = null;
  letGo();
  await page.waitForTimeout(250);
  await page.clock.runFor(50);
  await expect.poll(() => tray.reads).toBe(6);
  await page.waitForTimeout(250);
  await page.clock.runFor(2_000);
  await page.waitForTimeout(250);
  expect(tray.reads).toBe(6);

  /* Opening the tray reads it fresh. */
  await page.getByTestId("running-jobs").click();
  await expect.poll(() => tray.reads).toBe(7);
  await page.waitForTimeout(250);

  /* Nothing left: the open tray says so plainly (the pill stays while it is open). */
  tray.reply = () => reply([], 60);
  await page.getByTestId("jobs-close").click();
  await page.getByTestId("running-jobs").click();
  await expect(page.getByTestId("jobs-empty").locator("p")).toHaveText("Nothing rendering. What you generate shows here until it lands in Takes.");
  await expect(page.getByTestId("jobs-summary")).toHaveText("Nothing running");
  await expect(page.getByTestId("running-jobs")).toHaveAccessibleName("Jobs");

  /* A failed read says so, keeps asking on its own, and Try now asks at once. */
  tray.reply = () => ({ status: 503, json: { error: "down" } });
  const failedAt = tray.reads;
  await page.clock.runFor(75_000);
  await expect.poll(() => tray.reads).toBe(failedAt + 1);
  await expect(page.getByTestId("jobs-error")).toContainText("Jobs could not be read. Trying again shortly.");
  await expect(page.getByTestId("jobs-empty")).toHaveCount(0);
  tray.reply = () => reply(busyTray());
  await page.getByTestId("jobs-retry").click();
  await expect.poll(() => tray.reads).toBe(failedAt + 2);
  await expect(page.getByTestId("jobs-error")).toHaveCount(0);
  await expect(page.getByTestId("jobs-row")).toHaveCount(5);

  await page.waitForTimeout(250);

  /* This tab is no longer the signed-in workspace: it stops asking and says why, keeping the rows. */
  tray.reply = () => ({ status: 409, json: { error: "Reload this page" } });
  const stoppedAt = tray.reads;
  await page.clock.runFor(13_000);
  await expect.poll(() => tray.reads).toBe(stoppedAt + 1);
  await expect(page.getByTestId("jobs-error")).toHaveText("Jobs stopped: this tab's account or workspace changed.");
  await expect(page.getByTestId("jobs-retry")).toHaveCount(0);
  await expect(page.getByTestId("jobs-row")).toHaveCount(5);
  await page.clock.runFor(5 * 60_000);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("particl:jobs", { detail: { id: "x" } })));
  await page.waitForTimeout(500);
  expect(tray.reads).toBe(stoppedAt + 1);
  /* Closed, the pill goes: the last count is not the changed account's. */
  await page.getByTestId("jobs-close").click();
  await expect(page.getByTestId("running-jobs")).toHaveCount(0);
  expect(tray.reads).toBe(stoppedAt + 1);
});

test("an open tray says when everything has cleared, and when a read fails, without dropping what it last read", async ({ page }, info) => {
  test.skip(![...DESKTOP, ...PHONES].includes(info.project.name), "desktop and phones");
  const tray: Tray = { reads: 0, reply: () => reply(busyTray()) };
  const errors = await open(page, tray);
  await page.getByTestId("running-jobs").click();
  const panel = page.getByRole("dialog", { name: "Jobs" });
  await expect(panel.getByTestId("jobs-row")).toHaveCount(5);
  const say = () => page.evaluate(() => window.dispatchEvent(new CustomEvent("particl:jobs", { detail: { id: "gen_new" } })));

  /* A failed read keeps the rows it had and says so, with Try now. */
  tray.reply = () => ({ status: 503, json: { error: "down" } });
  const failedAt = tray.reads;
  await say();
  await expect.poll(() => tray.reads).toBe(failedAt + 1);
  await expect(panel.getByTestId("jobs-error")).toContainText("Jobs could not be read. Trying again shortly.");
  await expect(panel.getByTestId("jobs-row")).toHaveCount(5);
  await expect(panel.getByTestId("jobs-retry")).toBeVisible();
  if (PHONES.includes(info.project.name)) expect(await smallTargets(page, ".gx-jobs-tray"), "targets under 44×44").toEqual([]);
  await noOverflow(page);
  await shoot(page, info.project.name, "jobs-tray-read-failed");

  /* Everything cleared: the open tray says so plainly, and the pill waits until it closes to go. */
  tray.reply = () => reply([], 60);
  await panel.getByTestId("jobs-retry").click();
  await expect(panel.getByTestId("jobs-error")).toHaveCount(0);
  await expect(panel.getByTestId("jobs-empty").locator("p")).toHaveText("Nothing rendering. What you generate shows here until it lands in Takes.");
  await expect(panel.getByTestId("jobs-summary")).toHaveText("Nothing running");
  if (PHONES.includes(info.project.name)) expect(await smallTargets(page, ".gx-jobs-tray"), "targets under 44×44").toEqual([]);
  await noOverflow(page);
  await shoot(page, info.project.name, "jobs-tray-empty");
  /* Its one way on is to make something: Generate opens Gen and the tray closes (and, empty, the pill goes). */
  await panel.getByTestId("jobs-generate").click();
  await expect(page.getByRole("dialog", { name: "Jobs" })).toHaveCount(0);
  await expect(page.getByTestId("page-title")).toHaveText("Generate");
  await expect(page.getByTestId("running-jobs")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("with nothing running, the pill says what finished since the tray was last opened, then goes", async ({ page }, info) => {
  test.skip(![...DESKTOP, ...PHONES].includes(info.project.name), "desktop and phones");
  const tray: Tray = { reads: 0, reply: () => reply([]) };
  await open(page, tray);
  await expect.poll(() => tray.reads).toBeGreaterThan(0);
  await expect(page.getByTestId("running-jobs")).toHaveCount(0);
  /* Two takes finish after the page opened. */
  const at = Date.now() + 1_000;
  tray.reply = () => reply([
    job({ id: "gen_a", name: "Gulls over the pier", stage: "complete", label: "Complete", tone: "green", action: "open", updatedAt: at }),
    job({ id: "gen_b", name: "Lighthouse at dusk", stage: "failed", label: "Failed · not billed", tone: "red", action: "recreate", updatedAt: at,
      recipe: { prompt: "Lighthouse", model: "m", kind: "video", title: null, task: "generate", params: {} } }),
  ], 60);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("particl:jobs", { detail: { id: "gen_a" } })));
  const pill = page.getByTestId("running-jobs");
  await expect(pill).toHaveAccessibleName("Jobs: 1 done · 1 failed");
  await expect(pill).toHaveAttribute("data-tone", "red");
  await page.waitForTimeout(1_200);
  await pill.click();
  await expect(page.getByTestId("jobs-row")).toHaveCount(2);
  await page.getByTestId("jobs-close").click();
  /* Seen: the pill goes, and stays gone after a reload. */
  await expect(page.getByTestId("running-jobs")).toHaveCount(0);
  const beforeReload = tray.reads;
  await page.reload();
  await expect(page.getByTestId("project-name").first()).toHaveText("Harbour launch spot");
  await expect.poll(() => tray.reads).toBeGreaterThan(beforeReload);
  await page.waitForTimeout(500);
  await expect(page.getByTestId("running-jobs")).toHaveCount(0);
});

test("GET /api/jobs?view=tray lists this person's own takes from both engines, priced in credits, and nothing of anyone else's", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one API run");
  const account = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json()) as { id: string; workspace: { id: string } };
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  const headers = { "X-Workbench-Scope": scope };
  /* The first read makes sure the connected-jobs table exists in this workspace. */
  const first = await page.request.get("/api/jobs?view=tray&sync=0", { headers });
  expect(first.ok(), await first.text()).toBeTruthy();
  expect(await first.json()).toEqual({ jobs: [], pollAfterSeconds: 60 });

  const platform = createClient({ url: localPlatformDbUrl() });
  const tenantUrl = String((await platform.execute({ sql: "SELECT db_url FROM workspaces WHERE id=?", args: [account.workspace.id] })).rows[0].db_url);
  platform.close();
  expect(tenantUrl).toMatch(/^file:/);
  const tenant = createClient({ url: tenantUrl });
  const now = Date.now();
  const ENGINE = "dreamina-seedance-2-5-260628";
  try {
    await tenant.execute({ sql: "INSERT INTO projects(id,name,created_at) VALUES(?,?,?)", args: ["prod-tray", "Harbour launch spot", now] });
    await tenant.execute({ sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,?,?)",
      args: [`${me.id}:${DRAFT}`, me.id, DRAFT, "Harbour launch spot", JSON.stringify({ id: DRAFT, name: "Harbour launch spot", productionProjectId: "prod-tray" }), 1, now] });
    const gen = (id: string, status: string, fields: { params?: object; createdBy?: string; updatedAt?: number; stored?: string | null; cost?: number | null; error?: string | null; deleted?: number; kind?: string } = {}) =>
      tenant.execute({
        sql: "INSERT INTO generations(id,project_id,kind,model,prompt,params,status,created_by,created_at,updated_at,stored_url,cost_usd,error,deleted) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        args: [id, "prod-tray", fields.kind ?? "video", ENGINE, `Prompt for ${id}`, JSON.stringify(fields.params ?? { resolution: "720p", ratio: "16:9", duration: 5 }), status,
          fields.createdBy ?? me.id, now - 5 * MIN, fields.updatedAt ?? now - MIN, fields.stored ?? null, fields.cost ?? null, fields.error ?? null, fields.deleted ?? 0],
      });
    await gen("gen_t_queued", "queued");
    await gen("gen_t_running", "running");
    await gen("gen_t_held", "held", { params: { resolution: "1080p", ratio: "16:9", duration: 5, held: { why: "credits", needs: 40, estUsd: 2.86, at: now } } });
    /* Held at a figure the terms have since moved from: far more than any local balance covers, so Release is refused and nothing starts. */
    await gen("gen_t_held_big", "held", { params: { resolution: "1080p", ratio: "16:9", duration: 5, held: { why: "credits", needs: 10, estUsd: 400, at: now } } });
    await gen("gen_t_done", "succeeded", { stored: "https://blob.invalid/x.mp4", cost: 1.16 });
    await gen("gen_t_failed", "failed", { error: "fal.ai returned 503 upstream", cost: 0 });
    await gen("gen_t_old", "succeeded", { stored: "https://blob.invalid/y.mp4", cost: 1.16, updatedAt: now - 10 * 3_600_000 });
    await gen("gen_t_theirs", "running", { createdBy: "someone-else" });
    await gen("gen_t_deleted", "running", { deleted: 1 });
    await gen(`gen_hfc_${"b".repeat(40)}`, "succeeded", { stored: "https://blob.invalid/z.mp4" });

    const consumer = (id: string, status: string, fields: { user?: string; claim?: boolean; manifest?: object | null; failure?: string | null; released?: number | null; updatedAt?: number; workflow?: string } = {}) =>
      tenant.execute({
        sql: `INSERT INTO higgsfield_consumer_jobs(id,user_id,draft_id,connected_owner_id,connection_generation,higgsfield_workspace_id,workflow,idempotency_key,payload_json,payload_hash,immutable_hash,
          quote_credits,quote_expires_at,original_asset_ids,status,provider_job_id,dispatch_claim_hash,result_manifest,provider_receipt,failure_code,created_at,updated_at,released_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [id, fields.user ?? me.id, DRAFT, fields.user ?? me.id, "g1", "w1", fields.workflow ?? "generation", `k-${id}`,
          JSON.stringify({ input: { type: "video", prompt: `Account prompt ${id}` }, model: { id: "seedance_2_0", name: "Seedance 2.0", outputType: "video" }, workspaceName: "Fixture wallet", params: {} }),
          "h", "i", 40, now + MIN, "[]", status, fields.claim === false ? null : `p-${id}`, fields.claim === false ? null : "claim", fields.manifest ? JSON.stringify(fields.manifest) : null, null,
          fields.failure ?? null, now - 3 * MIN, fields.updatedAt ?? now - MIN, fields.released ?? null],
      });
    await consumer("c-accepted", "accepted");
    await consumer("c-quoted", "quoted", { claim: false });
    await consumer("c-done", "completed", { manifest: { original: { generationId: `gen_hfc_${"b".repeat(40)}`, kind: "video" } } });
    await consumer("c-failed", "failed", { failure: "provider_failed" });
    await consumer("c-set-aside", "uncertain", { released: now - MIN, updatedAt: now - 7 * 3_600_000 });
    await consumer("c-theirs", "accepted", { user: "someone-else" });
  } finally {
    tenant.close();
  }

  const response = await page.request.get("/api/jobs?view=tray&sync=0", { headers });
  expect(response.ok(), await response.text()).toBeTruthy();
  expect(response.headers()["cache-control"]).toContain("no-store");
  const body = await response.json() as TrayReply;
  const text = JSON.stringify(body);
  expect(body.pollAfterSeconds).toBe(10);
  expect(body.partial).toBeUndefined();
  const byId = new Map(body.jobs.map((j) => [j.id, j]));
  expect([...byId.keys()].sort()).toEqual(["c-accepted", "c-done", "c-failed", "gen_t_done", "gen_t_failed", "gen_t_held", "gen_t_held_big", "gen_t_queued", "gen_t_running"]);
  expect(byId.get("gen_t_held")).toMatchObject({ stage: "held", tone: "amber", action: "release", label: expect.stringMatching(/^Held · needs \d+ cr$/), price: { unit: "cr" }, draftId: DRAFT });
  expect(byId.get("gen_t_held")!.label).toBe(`Held · needs ${byId.get("gen_t_held")!.price!.amount} cr`);
  expect(byId.get("gen_t_running")).toMatchObject({ stage: "rendering", price: { unit: "cr" } });
  expect(byId.get("gen_t_running")!.price!.amount).toBeGreaterThan(0);
  expect(byId.get("gen_t_queued")).toMatchObject({ stage: "queued" });
  expect(byId.get("gen_t_done")).toMatchObject({ stage: "complete", action: "open", mediaUrl: "/api/media/gen_t_done", price: { unit: "cr" }, draftId: DRAFT, projectName: "Harbour launch spot" });
  expect(byId.get("gen_t_failed")).toMatchObject({ stage: "failed", label: "Failed · not billed", price: null, action: "recreate", reason: "The engine hit an error; nothing was charged for a failure." });
  expect(byId.get("c-accepted")).toMatchObject({ source: "account", stage: "rendering", price: { amount: 40, unit: "account-cr" }, name: "Account prompt c-accepted", projectName: "Harbour launch spot" });
  expect(byId.get("c-done")).toMatchObject({ stage: "complete", mediaUrl: `/api/media/gen_hfc_${"b".repeat(40)}` });
  expect(byId.get("c-failed")).toMatchObject({ stage: "failed", label: "Failed · not billed", action: "recreate", recipe: { model: "seedance_2_0", connected: true } });
  /* Held first, then the running ones, then what finished. */
  expect(body.jobs[0].id).toBe("gen_t_held");
  /* Never a vendor dollar, a payload, a receipt or the account's own name. */
  for (const secret of ["estUsd", "costUsd", "cost_usd", "payload", "Receipt", "providerJobId", "Fixture wallet", "claim", "fal.ai"]) expect(text).not.toContain(secret);

  /* The list route's status filter takes a comma list. */
  const listed = await page.request.get("/api/jobs?status=queued,running,held&mine=1&sync=0", { headers }).then((r) => r.json()) as { generations: { id: string }[] };
  expect(listed.generations.map((g) => g.id).sort()).toEqual(["gen_t_held", "gen_t_held_big", "gen_t_queued", "gen_t_running"]);
  const single = await page.request.get("/api/jobs?status=held&sync=0", { headers }).then((r) => r.json()) as { generations: { id: string }[] };
  expect(single.generations.map((g) => g.id).sort()).toEqual(["gen_t_held", "gen_t_held_big"]);

  /* A refused Release names the figure the row's label says (what the release is measured against now), not the one told when it was held. */
  const big = byId.get("gen_t_held_big")!;
  expect(big.label).toBe(`Held · needs ${big.price!.amount.toLocaleString("en-US")} cr`);
  expect(big.price!.amount).toBeGreaterThan(1_000);
  const refused = await page.request.post("/api/jobs/gen_t_held_big/release", { headers });
  expect(refused.status()).toBe(402);
  const said = ((await refused.json()) as { error: string }).error;
  expect(said).toMatch(/^Still short: this needs [\d,]+ credits and [\d,]+ are left\.$/);
  expect(Number(/needs ([\d,]+) credits/.exec(said)![1].replace(/,/g, ""))).toBe(big.price!.amount);

  /* Another workspace sees none of it. */
  await signInLocally(page.request);
  const other = await page.request.get("/api/jobs?view=tray&sync=0").then((r) => r.json()) as TrayReply;
  expect(other.jobs).toEqual([]);
  expect(await page.request.get("/api/jobs?view=elsewhere&sync=0").then((r) => r.status())).toBe(400);
});
