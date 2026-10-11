import { test, expect, type Page, type Request } from "@playwright/test";
import { signInWithNewInterface } from "./helpers/newInterface";
import { newProject, type Project } from "../lib/workbench/studio";
import type { QueueItem } from "../lib/control-room/queue";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";
import { dimLabels, lastRowClearsPinned, smallTargets, smallText } from "./phoneFloors";

/**
 * Stream 10, PR 1: the phone's shell, Home and the full-screen review (design/particl-graphite/README.md § 3.6;
 * "Phone frames.dc.html" A and C), behind the new-interface switch.
 *
 * Home lists what needs you from the one approvals queue (lib/control-room/queue.ts) with the price as the
 * button, takes rendering with Notify me, and the open project's takes to review; then the projects. The review
 * fills the screen, judges with a swipe (right approves, left rejects as the trail's "changes"), offers Undo, and
 * never spends; with no connection the judgement waits and is sent when the phone is back. The floors hold at
 * every phone size, and `device=phone` frames it at 390 px on a desktop.
 *
 * The switch: these run with it on (`signInWithNewInterface`).
 */
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
/* Screenshots are opt-in: S10_SHOTS names a folder outside the repo. CI writes none. */
const SHOTS = process.env.S10_SHOTS;
const shot = async (page: Page, project: string, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${project.replace("workbench-", "")}-${name}.png` }); };
const PORTRAIT = ["workbench-360x640", "workbench-390x844"];

const fixture = (): Project => ({
  ...newProject("Harbour at dusk"), id: "ws-phone", productionProjectId: "prod-ws", shotMappings: {},
  brief: "A fox crosses a frozen harbour at dusk",
} as Project);
const TAKES = [
  generation({ id: "gen_a1", title: "The approach", prompt: "The approach", shotId: "shot_a", shotCode: "SH01", version: 1, createdAt: 1_000, params: { ratio: "16:9" }, creditsBilled: 3 }),
  generation({ id: "gen_a2", title: "The approach", prompt: "The approach", shotId: "shot_a", shotCode: "SH01", version: 2, createdAt: 2_000, params: { ratio: "16:9" }, creditsBilled: 3 }),
  generation({ id: "gen_b1", title: "The keeper", prompt: "The keeper", shotId: "shot_b", shotCode: "SH02", version: 1, createdAt: 3_000, params: { ratio: "16:9" }, creditsBilled: 3 }),
  generation({ id: "gen_done", title: "Wide", prompt: "Wide", reviewState: "approved", createdAt: 500 }),
];

const item = (over: Partial<QueueItem> & { id: string; title: string }): QueueItem => ({
  source: "held", where: "Make", at: Date.UTC(2026, 9, 5, 9, 40), project: { productionId: "prod-ws", draftId: "ws-phone", name: "Harbour at dusk" },
  price: { kind: "exact", credits: 3 }, needsAdmin: false, canApprove: true, why: null, shortBy: null, note: null, step: null, sample: false,
  approve: { kind: "release", genId: "gen_held", credits: 3 }, decline: { kind: "discard", genId: "gen_held" },
  open: { kind: "take", genId: "gen_held", draftId: "ws-phone" }, ...over,
});
const QUEUE: QueueItem[] = [
  item({ id: "held:gen_held", title: "Keyframe · Shot 3 · retake" }),
  item({ id: "board-render:r1:2", source: "board-render", where: "Board", title: "Hero take · Shot 4", at: Date.UTC(2026, 9, 5, 9, 51), price: { kind: "exact", credits: 43 }, needsAdmin: true, canApprove: false, why: "Over the per-shot rule: an admin presses this one.",
    approve: { kind: "board-render", productionId: "prod-ws", runId: "rar_aaaaaaaaaaaaaaaaaaaaaaaa", seq: 2, fingerprint: "a".repeat(64) }, decline: null }),
];
const TRAY = [{ id: "gen_live", source: "engine", kind: "video", name: "Shot 4 · the encounter", mediaUrl: null, stage: "rendering", label: "Rendering", tone: "blue", reason: null,
  progress: null, createdAt: Date.now(), settledAt: null, price: { amount: 43, unit: "cr" }, draftId: "ws-phone", projectName: "Harbour at dusk", action: null }];

type Opened = { reviews: { id: string; state: string }[]; releases: { id: string; credits: unknown }[]; paid: string[]; errors: string[] };

async function open(page: Page, path: string, queue: QueueItem[] = QUEUE): Promise<Opened> {
  const seen: Opened = { reviews: [], releases: [], paid: [], errors: [] };
  await signInWithNewInterface(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, { uploads: [], generations: TAKES.map((t) => ({ ...t })) });
  await page.route("**/api/control-room/approvals", (route) => route.fulfill({ json: { items: queue, decided: [], inCredits: true } }));
  await page.route(/\/api\/jobs\?view=tray/, (route) => route.fulfill({ json: { jobs: TRAY, pollAfterSeconds: 60 } }));
  await page.route(/\/api\/jobs\/[A-Za-z0-9_-]+(\/release)?$/, async (route) => {
    const request = route.request();
    const id = new URL(request.url()).pathname.split("/")[3];
    if (request.method() === "PATCH") {
      const state = String((request.postDataJSON() as { reviewState?: unknown }).reviewState ?? "");
      seen.reviews.push({ id, state });
      return route.fulfill({ json: { review: { reviewState: state } } });
    }
    if (request.method() === "POST" && request.url().endsWith("/release")) {
      seen.releases.push({ id, credits: (request.postDataJSON() as { credits?: unknown }).credits });
      return route.fulfill({ json: { released: true, id } });
    }
    return route.fallback();
  });
  page.on("request", (request: Request) => {
    if (request.method() !== "GET" && /\/api\/(generate|workbench\/team-canvas|pipelines|atomik)/.test(request.url())) seen.paid.push(request.url());
  });
  page.on("pageerror", (error) => seen.errors.push(error.message));
  await page.goto(path);
  await expect(page.getByTestId("phone-app")).toBeVisible();
  return seen;
}

/** Nothing scrolls sideways, at any size. */
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

async function floors(page: Page, where: string) {
  expect(await smallText(page), `${where}: text under 12px`).toEqual([]);
  expect(await smallTargets(page, ".ph-app"), `${where}: targets under 44×44`).toEqual([]);
  expect(await dimLabels(page, ".ph-app"), `${where}: labels under the floor`).toEqual([]);
  expect(await noOverflow(page), `${where}: sideways overflow`).toBe(true);
}

test("phone Home: what needs you first, with the price as the button; renders with Notify me; takes to review; then projects", async ({ page }, info) => {
  test.skip(!PHONES.includes(info.project.name), "phone widths");
  const seen = await open(page, "/suites?view=home");
  const rows = page.getByTestId("phone-approval-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("Keyframe · Shot 3 · retake");
  await expect(rows.first().getByTestId("phone-row-approve")).toHaveText("3 cr");
  await expect(rows.first().getByTestId("phone-row-approve")).toHaveAttribute("data-spend-price", "3 cr");
  /* Over the per-shot rule: a member sees who presses it, never a button. */
  await expect(rows.nth(1)).toContainText("Needs an admin");
  await expect(rows.nth(1).getByRole("button")).toHaveCount(0);
  await expect(page.getByTestId("phone-render-row")).toContainText("Shot 4 · the encounter");
  await expect(page.getByTestId("phone-render-row").getByTestId("phone-notify")).toHaveText("Notify me");
  await expect(page.getByTestId("phone-review-row")).toContainText("3 takes to review");
  await expect(page.getByTestId("phone-project")).toHaveCount(1);
  await expect(page.getByTestId("phone-needs-badge")).toHaveText("4");
  await expect(page.getByTestId("phone-tab-record")).toBeEnabled();
  await floors(page, "Home");
  await shot(page, info.project.name, "home");
  expect(await lastRowClearsPinned(page), "Home: the last row clears the tabs").toEqual([]);
  await shot(page, info.project.name, "home-scrolled");
  expect(seen.paid).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test("phone Home: a single item approves from Home through its own route, at its price", async ({ page }, info) => {
  test.skip(!PORTRAIT.includes(info.project.name), "portrait phones");
  const seen = await open(page, "/suites?view=home");
  await page.getByTestId("phone-approval-row").first().getByTestId("phone-row-approve").click();
  await expect(page.getByTestId("toast")).toContainText("Keyframe · Shot 3 · retake approved · 3 cr held");
  expect(seen.releases).toEqual([{ id: "gen_held", credits: 3 }]);
  expect(seen.paid).toEqual([]);
});

test("phone Home: a short balance offers Top up, which opens Settings › Plan & credits under the phone header", async ({ page }, info) => {
  test.skip(!PORTRAIT.includes(info.project.name), "portrait phones");
  await open(page, "/suites?view=home", [item({ id: "held:gen_held", title: "Hero take · Shot 4", price: { kind: "exact", credits: 43 }, shortBy: 3 })]);
  const row = page.getByTestId("phone-approval-row");
  await expect(row).toContainText("Short by 3 cr");
  await row.getByTestId("phone-row-topup").click();
  await expect(page).toHaveURL(/view=workspace/);
  await expect(page).toHaveURL(/tab=credits/);
  await expect(page.getByTestId("phone-title")).toHaveText("Settings");
  await page.getByTestId("phone-back").click();
  await expect(page.getByTestId("phone-home")).toBeVisible();
});

test("phone review: swipe right approves, Undo puts it back, left rejects; it never spends; the floors hold", async ({ page }, info) => {
  test.skip(!PHONES.includes(info.project.name), "phone widths");
  const seen = await open(page, "/suites?screen=review");
  await expect(page.getByTestId("phone-review-title")).toHaveText("Shot 1 · v1");
  await expect(page.getByTestId("mobile-dock")).toHaveCount(0);
  await floors(page, "Review");
  await shot(page, info.project.name, "review");
  /* The panel and its last line sit inside the screen, clear of the home indicator. */
  const panel = await page.getByTestId("mobile-actions").boundingBox();
  expect(panel!.y + panel!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 0.5);

  const media = page.getByTestId("phone-review-media");
  const box = (await media.boundingBox())!;
  const swipe = async (dx: number) => {
    const y = box.y + box.height / 2, x = box.x + box.width / 2 - dx / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx / 2, y, { steps: 4 });
    await page.mouse.move(x + dx, y, { steps: 4 });
    await page.mouse.up();
  };
  await swipe(Math.min(160, box.width * 0.5));
  await expect(page.getByTestId("toast")).toContainText("Shot 1 · v1 approved · nothing spent");
  await shot(page, info.project.name, "review-approved-undo");
  expect(seen.reviews).toEqual([{ id: "gen_a1", state: "approved" }]);
  await expect(page.getByTestId("phone-review-title")).toHaveText("Shot 1 · v2");
  await page.getByTestId("toast-undo").click();
  await expect(page.getByTestId("phone-review-title")).toHaveText("Shot 1 · v1");
  expect(seen.reviews.at(-1)).toEqual({ id: "gen_a1", state: "" });

  /* A short drag or a tap judges nothing. */
  await swipe(20);
  await page.waitForTimeout(300);
  expect(seen.reviews).toHaveLength(2);

  await swipe(-Math.min(160, box.width * 0.5));
  await expect(page.getByTestId("toast")).toContainText("Shot 1 · v1 rejected · nothing spent");
  expect(seen.reviews.at(-1)).toEqual({ id: "gen_a1", state: "changes" });

  /* The buttons judge the same way. */
  await page.getByTestId("phone-approve").click();
  await expect(page.getByTestId("toast")).toContainText("Shot 1 · v2 approved");
  expect(seen.reviews.at(-1)).toEqual({ id: "gen_a2", state: "approved" });
  expect(seen.paid).toEqual([]);
  expect(seen.releases).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test("phone review: versions of a shot switch in place, and Done goes Home", async ({ page }, info) => {
  test.skip(!PORTRAIT.includes(info.project.name), "portrait phones");
  await open(page, "/suites?screen=review");
  const versions = page.getByRole("group", { name: "Versions" }).getByRole("button");
  await expect(versions).toHaveText(["v1", "v2"]);
  await versions.nth(1).click();
  await expect(page.getByTestId("phone-review-title")).toHaveText("Shot 1 · v2");
  await page.getByTestId("phone-review-done").click();
  await expect(page.getByTestId("phone-home")).toBeVisible();
});

test("phone review offline: the judgement waits on the phone and is sent when it is back", async ({ page, context }, info) => {
  test.skip(!PORTRAIT.includes(info.project.name), "portrait phones");
  const seen = await open(page, "/suites?screen=review");
  await expect(page.getByTestId("phone-review-title")).toHaveText("Shot 1 · v1");
  await context.setOffline(true);
  await page.getByTestId("phone-approve").click();
  await expect(page.getByTestId("toast")).toContainText("Shot 1 · v1 approved · sent when you're back online");
  expect(seen.reviews).toEqual([]);
  await context.setOffline(false);
  await expect.poll(() => seen.reviews).toEqual([{ id: "gen_a1", state: "approved" }]);
});

test("device=phone frames the phone at 390 px on a desktop; without it a desktop keeps its own screens", async ({ page }, info) => {
  test.skip(PHONES.includes(info.project.name), "desktop widths");
  await open(page, "/suites?device=phone&screen=home");
  const frame = (await page.getByTestId("phone-app").boundingBox())!;
  expect(Math.round(frame.width)).toBe(390);
  expect(Math.abs(frame.x + frame.width / 2 - page.viewportSize()!.width / 2)).toBeLessThanOrEqual(1);
  await floors(page, "Framed Home");
  await shot(page, info.project.name, "framed-home");
  await page.goto("/suites?view=home");
  await expect(page.getByTestId("phone-app")).toHaveCount(0);
});
