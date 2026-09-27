import { test, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import type { Generation } from "../lib/jobs";
import { smallTargets } from "./phoneFloors";
import { forbidPaidWork, generation, mockMedia, mockProjects } from "./helpers/workspaceFixtures";

/**
 * One card contract for every grid of takes — Gen › Results, Library ›
 * Assets and Studio › Takes. While the library is read the grid holds
 * aspect-true skeletons and never says "nothing here"; a failed read is a
 * banner with Try again; every take carries its status (Queued / Rendering /
 * Held / Failed · not billed / Cancelled / Picked / Approved) and one line on
 * why it failed or waits; a finished take whose stored copy is missing says
 * "Preview unavailable" with Refresh; a take in flight settles on its own.
 * A failed project list says so once, with one Try again. A re-read that
 * fails with cards on screen says they were not refreshed; a failed Load
 * more stays at the list's end. Every reply is route-mocked; nothing paid.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const WIDE = ["workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const SHOTS = process.env.CARD_SHOTS_DIR;

const fixture = (): Project => ({ ...newProject("Harbour takes"), id: "ws-cards", productionProjectId: "prod-cards", shotMappings: {}, aspect: "16:9" });

type Mode = "ok" | "fail" | "hold";
const BASE = 1_790_000_000_000;
const OFFLINE = "The library is offline for a moment.";

/** The project library, with the read's outcome under the test's control. Rows keep their times across reads. */
async function controlledLibrary(page: Page, opts: { pageSize?: number; rows?: () => Generation[] } = {}) {
  const state = {
    mode: "ok" as Mode,
    release: () => {},
    gate: Promise.resolve(),
    /** The running take finishes; the missing copy lands. */
    landed: false, restored: false,
    /** Only a Load more (a read with a cursor) fails. */
    failMore: false,
    reads: 0,
  };
  const hold = () => { state.mode = "hold"; state.gate = new Promise<void>((resolve) => { state.release = () => { state.mode = "ok"; resolve(); }; }); };
  const row = (i: number, fields: Partial<Generation> & { id: string }) => generation({ projectId: "prod-cards", createdAt: BASE - i * 60_000, updatedAt: BASE - i * 60_000, ...fields });
  const takes = (): Generation[] => [
    row(0, { id: "gen_run", title: "Lantern walk", kind: "image", status: state.landed ? "succeeded" : "running", storedUrl: state.landed ? "/api/media/gen_run" : null, creditsBilled: state.landed ? 1 : null, ...(state.landed ? { updatedAt: BASE + 1 } : {}) }),
    row(1, { id: "gen_queue", title: "Tide timelapse", kind: "video", status: "queued", storedUrl: null, creditsBilled: null }),
    row(2, { id: "gen_held", title: "Storm front", kind: "video", status: "held", storedUrl: null, creditsBilled: null, params: { held: { why: "credits", needs: 12 } } }),
    row(3, { id: "gen_fail", title: "Night swim", kind: "video", status: "failed", storedUrl: null, creditsBilled: 0, error: "Refused: the prompt was flagged by moderation." }),
    row(4, { id: "gen_stop", title: "Pier in fog", kind: "video", status: "cancelled", storedUrl: null, creditsBilled: null, costUsd: 0, error: "Discarded before it started. Nothing was charged.", params: { held: { why: "credits", needs: 9 }, discardedAt: 1 } }),
    row(5, { id: "gen_gone", title: "Harbour at dusk", kind: "image", storedUrl: state.restored ? "/api/media/gen_gone" : null, creditsBilled: 1, ...(state.restored ? { updatedAt: BASE + 2 } : {}) }),
    row(6, { id: "gen_pick", title: "Gull over the breakwater", kind: "image", reviewState: "picked", creditsBilled: 1 }),
    row(7, { id: "gen_ok", title: "Pier at first light", kind: "image", reviewState: "approved", creditsBilled: 1 }),
  ];
  await page.route("**/api/workbench/library**", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") return route.fulfill({ json: { ok: true } });
    state.reads++;
    const url = new URL(request.url());
    const cursor = url.searchParams.get("cursor");
    if (state.mode === "fail" || (cursor && state.failMore)) return route.fulfill({ status: 503, json: { error: cursor && state.failMore ? "More takes could not be read." : OFFLINE } });
    if (state.mode === "hold") await state.gate;
    if (url.searchParams.get("source") === "uploads") return route.fulfill({ json: { uploads: [], nextCursor: null } });
    const all = (opts.rows ?? takes)();
    const size = opts.pageSize ?? 60, offset = Number(cursor ?? 0);
    return route.fulfill({ json: { generations: all.slice(offset, offset + size), nextPageCursor: offset + size < all.length ? String(offset + size) : null } });
  });
  return { state, hold };
}

async function open(page: Page, url: string, mode: Mode = "ok", opts: Parameters<typeof controlledLibrary>[1] = {}) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  const library = await controlledLibrary(page, opts);
  if (mode === "hold") library.hold();
  else library.state.mode = mode;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await expect(page.getByTestId("project-name")).toHaveText("Harbour takes");
  return { errors, ...library };
}

const tile = (scope: Locator, name: string) => scope.getByTestId("take-tile").filter({ hasText: name });

async function noSideScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
}

/** With CARD_SHOTS_DIR set, a picture of the state under test, `focus` scrolled to the middle first. */
async function shot(page: Page, info: TestInfo, name: string, focus?: Locator) {
  if (!SHOTS) return;
  if (focus) await focus.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/${name}-${info.project.name.replace("workbench-", "")}.png` });
}

test("Gen › Results: skeletons while reading, a failed read with Try again, a status on every take, Refresh, and takes that settle", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, state, hold } = await open(page, "/suites?view=gen", "fail");
  const results = page.getByRole("region", { name: "Results" });

  /* A failed read is a banner, never "nothing generated". */
  const banner = page.getByTestId("gen-results-error");
  await expect(banner).toContainText(OFFLINE);
  await expect(banner).toHaveAttribute("role", "alert");
  await expect(page.getByTestId("gen-results-empty")).toHaveCount(0);
  await expect(results.getByTestId("take-tile")).toHaveCount(0);
  if (PHONES.includes(info.project.name)) expect(await smallTargets(page, '[data-testid="gen-results-error"]'), "Try again under 44×44").toEqual([]);
  await shot(page, info, "gen-error", banner);

  /* Try again: skeletons at the project's frame while the read is in flight. */
  hold();
  await banner.getByRole("button", { name: "Try again" }).click();
  await expect(banner).toHaveCount(0);
  const skeletons = results.getByTestId("take-skeleton");
  await expect(skeletons).toHaveCount(6);
  await expect(page.getByTestId("gen-results-empty")).toHaveCount(0);
  const box = (await skeletons.first().locator(".gx-skel-thumb").boundingBox())!;
  expect(Math.abs(box.width / box.height - 16 / 9)).toBeLessThan(0.05);
  await shot(page, info, "gen-skeletons", skeletons.nth(1));
  state.release();
  await expect(skeletons).toHaveCount(0);
  await expect(results.getByTestId("take-tile")).toHaveCount(8);

  /* Every take says what it is doing. */
  await expect(tile(results, "Lantern walk").getByTestId("take-chip")).toHaveText("Rendering");
  await expect(tile(results, "Tide timelapse").getByTestId("take-chip")).toHaveText("Queued");
  /* Held for credits (idea 4): the need rides on the chip, and the way out is Release at that price. */
  await expect(tile(results, "Storm front").getByTestId("take-chip")).toHaveText("Held · needs 12 cr");
  await expect(tile(results, "Storm front").getByTestId("take-reason")).toHaveCount(0);
  await expect(tile(results, "Storm front").getByTestId("take-release")).toContainText("12 cr");
  await expect(tile(results, "Night swim").getByTestId("take-chip")).toHaveText("Failed · not billed");
  await expect(tile(results, "Night swim").getByTestId("take-reason")).toHaveText("Refused by the content filter");
  await expect(tile(results, "Night swim").getByTestId("take-reason")).toHaveAttribute("title", "Refused: the prompt was flagged by moderation.");
  /* Discarded on purpose is not a failure: its own words, and no red. */
  await expect(tile(results, "Pier in fog").getByTestId("take-chip")).toHaveText("Cancelled · not billed");
  await expect(tile(results, "Pier in fog").getByTestId("take-chip")).toHaveAttribute("data-tone", "idle");
  await expect(tile(results, "Pier in fog").getByTestId("take-reason")).toHaveText("Discarded before it started.");
  await expect(tile(results, "Gull over the breakwater").getByTestId("take-chip")).toHaveText("Picked");
  await expect(tile(results, "Pier at first light").getByTestId("take-chip")).toHaveText("Approved");
  /* A screen reader hears the take and its state, not the badge inside the picture. */
  await expect(results.getByRole("button", { name: "Night swim · Failed · not billed", exact: true })).toBeVisible();
  /* The same card at the same frame whether it rendered or not. */
  const failedThumb = (await tile(results, "Night swim").locator(".gx-asset-thumb").boundingBox())!;
  const okThumb = (await tile(results, "Pier at first light").locator(".gx-asset-thumb").boundingBox())!;
  expect(Math.abs(failedThumb.height - okThumb.height)).toBeLessThan(1);
  /* Filed by what it is: the failed and the cancelled clip are under Video with the other clips. */
  await results.getByRole("button", { name: "Video", exact: true }).click();
  await expect(results.getByTestId("take-tile")).toHaveCount(4);
  await results.getByRole("button", { name: "All", exact: true }).click();

  /* A finished take with no stored copy: Preview unavailable, and Refresh reads it again. */
  const gone = tile(results, "Harbour at dusk");
  await expect(gone).toHaveAttribute("data-face", "unavailable");
  await expect(gone.getByTestId("take-reason")).toHaveText("Preview unavailable");
  await shot(page, info, "gen-cards", tile(results, "Night swim"));
  const refresh = gone.getByTestId("take-refresh");
  if (PHONES.includes(info.project.name)) {
    expect(await smallTargets(page, ".gx-gen-results .gx-tile-over"), "Refresh under 44×44").toEqual([]);
    expect(await smallTargets(page, ".gx-gen-results"), "targets under 44×44").toEqual([]);
  }
  /* Refresh is the corner's; a press on the picture still opens the take. */
  await gone.locator(".gx-asset-thumb").click();
  await expect(page.getByTestId("inspector-title")).toHaveText("Harbour at dusk");
  await expect(gone).toHaveAttribute("data-face", "unavailable");
  if (!WIDE.includes(info.project.name)) await page.getByTestId("close-inspector").click();
  state.restored = true;
  const before = state.reads;
  await refresh.click();
  await expect(gone).toHaveAttribute("data-face", "media");
  await expect(gone.getByTestId("take-reason")).toHaveCount(0);
  expect(state.reads).toBeGreaterThan(before);

  /* A take in flight settles on its own: no reload, no click. A full read just landed, so the next look is soon. */
  state.landed = true;
  await expect(tile(results, "Lantern walk")).toHaveAttribute("data-face", "media", { timeout: 15_000 });
  await expect(tile(results, "Lantern walk").getByTestId("take-chip")).toHaveCount(0);
  await expect(tile(results, "Tide timelapse").getByTestId("take-chip")).toHaveText("Queued");

  /* The Inspector names the status and the reason. */
  await tile(results, "Night swim").locator(".gx-asset-thumb").click();
  const facts = page.getByTestId("asset-facts");
  await expect(facts).toContainText("Failed · not billed");
  await expect(facts).toContainText("Refused by the content filter · Refused: the prompt was flagged by moderation.");
  await noSideScroll(page);
  expect(errors).toEqual([]);
});

test("Library › Assets and Studio › Takes wear the same card; their failed reads say so", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const wide = WIDE.includes(info.project.name);
  const { errors, state } = await open(page, "/suites?suite=studio&page=takes", "fail");

  /* Takes: the failed read is a banner, not "Nothing generated yet". */
  const takesBanner = page.getByTestId("takes-error");
  await expect(takesBanner).toContainText(OFFLINE);
  await expect(page.getByTestId("edit-takes")).not.toContainText("Nothing generated yet");
  /* Said once: the list's end does not repeat it. */
  await expect(page.getByTestId("takes-more-error")).toHaveCount(0);
  if (PHONES.includes(info.project.name)) expect(await smallTargets(page, '[data-testid="takes-error"]'), "Try again under 44×44").toEqual([]);
  await shot(page, info, "takes-error", takesBanner);

  /* The Library says it too, above its filters: on a phone, never behind the tab bar. */
  if (!wide) await page.getByTestId("toggle-library").click();
  const library = page.getByTestId("library");
  await library.getByRole("tab", { name: /Assets/ }).click();
  const libraryBanner = library.getByTestId("library-error");
  await expect(libraryBanner).toContainText(OFFLINE);
  await expect(library.getByTestId("library-more-error")).toHaveCount(0);
  const tabbar = page.getByTestId("tabbar");
  if (await tabbar.isVisible()) {
    const [bannerBox, barBox] = [(await libraryBanner.boundingBox())!, (await tabbar.boundingBox())!];
    expect(bannerBox.y + bannerBox.height, "the Library's banner clears the tab bar").toBeLessThanOrEqual(barBox.y);
  }
  await shot(page, info, "library-error", libraryBanner);
  if (!wide) await page.getByTestId("close-library").click();

  state.mode = "ok";
  await takesBanner.getByRole("button", { name: "Try again" }).click();
  await expect(takesBanner).toHaveCount(0);

  const takes = page.getByTestId("edit-takes");
  await expect(takes.getByTestId("take-tile")).toHaveCount(8);
  await expect(tile(takes, "Night swim").getByTestId("take-chip")).toHaveText("Failed · not billed");
  await expect(tile(takes, "Night swim").getByTestId("take-reason")).toHaveText("Refused by the content filter");
  await expect(tile(takes, "Storm front").getByTestId("take-chip")).toHaveText("Held · needs 12 cr");
  await expect(tile(takes, "Harbour at dusk").getByTestId("take-reason")).toHaveText("Preview unavailable");
  await shot(page, info, "takes-cards", tile(takes, "Storm front"));
  /* A take that did not render, waits or has no copy says why and what happens next, instead of opening an empty editor. */
  const toast = page.getByTestId("toast");
  await tile(takes, "Night swim").getByTestId("edit-take").click();
  await expect(toast).toHaveText("Night swim did not render · Refused by the content filter.");
  await tile(takes, "Tide timelapse").getByTestId("edit-take").click();
  await expect(toast).toHaveText("Tide timelapse is still queued; it opens here when it lands.");
  await tile(takes, "Storm front").getByTestId("edit-take").click();
  await expect(toast).toHaveText("Storm front is held · Needs 12 cr. It starts on its own when credits arrive.");
  await tile(takes, "Harbour at dusk").getByTestId("edit-take").click();
  await expect(toast).toHaveText("Harbour at dusk rendered, but its stored copy is not here yet. Refresh on its card reads it again.");
  if (PHONES.includes(info.project.name)) expect(await smallTargets(page, '[data-testid="edit-takes"] .gx-tile-over'), "Refresh under 44×44").toEqual([]);

  /* Library › Assets: the 2-up tile shortens the chip and moves the billing note under the name. */
  if (!wide) await page.getByTestId("toggle-library").click();
  await expect(library.getByTestId("library-error")).toHaveCount(0);
  const assets = page.getByTestId("library-assets");
  await expect(tile(assets, "Night swim").getByTestId("take-chip")).toHaveText("Failed");
  await expect(tile(assets, "Night swim").getByTestId("take-reason")).toHaveText("Not billed · Refused by the content filter");
  await expect(tile(assets, "Pier in fog").getByTestId("take-chip")).toHaveText("Cancelled");
  await expect(tile(assets, "Storm front").getByTestId("take-reason")).toHaveText("Needs 12 cr");
  await expect(tile(assets, "Pier at first light").getByTestId("take-chip")).toHaveText("Approved");
  await library.getByRole("button", { name: "Video", exact: true }).click();
  await expect(assets.getByTestId("take-tile")).toHaveCount(4);
  await shot(page, info, "library-cards");
  /* The smallest tile still opens from its middle: Refresh keeps to its corner. */
  await library.getByRole("button", { name: "All", exact: true }).click();
  const gone = tile(assets, "Harbour at dusk");
  if (PHONES.includes(info.project.name)) expect(await smallTargets(page, '[data-testid="library-assets"] .gx-tile-over'), "Refresh under 44×44").toEqual([]);
  await gone.locator(".gx-asset-thumb").click();
  await expect(page.getByTestId("inspector-title")).toHaveText("Harbour at dusk");
  await noSideScroll(page);
  expect(errors).toEqual([]);
});

test("a project list that will not load says so once, with one Try again, and Try again opens the project", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await controlledLibrary(page);
  let fail = true;
  /* Registered after mockProjects so it runs first. */
  await page.route("**/api/workbench/projects**", (route) => (fail && route.request().method() === "GET"
    ? route.fulfill({ status: 503, json: { error: "Projects are not answering right now." } })
    : route.fallback()));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/suites?view=gen");
  const banner = page.getByTestId("projects-error");
  await expect(banner).toContainText("Projects are not answering right now.");
  await expect(page.getByTestId("project-name")).toHaveText("Projects didn’t load");
  /* One way back, in the banner: the head names the state, it does not repeat the button. */
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(1);
  /* Not "Open a project": nothing is known about the projects yet. */
  await expect(page.getByTestId("gen-results-empty")).toHaveCount(0);
  if (PHONES.includes(info.project.name)) expect(await smallTargets(page, '[data-testid="projects-error"]'), "Try again under 44×44").toEqual([]);
  await noSideScroll(page);
  await shot(page, info, "projects-error");
  fail = false;
  await banner.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("project-name")).toHaveText("Harbour takes");
  await expect(banner).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Results" }).getByTestId("take-tile")).toHaveCount(8);
  expect(errors).toEqual([]);
});

test("a failed Load more stays at the list's end; a re-read that fails with cards on screen says they were not refreshed", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const wide = WIDE.includes(info.project.name);
  const { errors, state } = await open(page, "/suites?view=gen", "ok", { pageSize: 5 });
  const results = page.getByRole("region", { name: "Results" });
  await expect(results.getByTestId("take-tile")).toHaveCount(5);
  const library = page.getByTestId("library");
  /* Gen's Library has no Tools tab: it is the assets list itself. */
  const openLibrary = async () => {
    if (!wide) await page.getByTestId("toggle-library").click();
    await expect(library.getByTestId("library-assets")).toBeVisible();
  };
  const closeLibrary = async () => { if (!wide) await page.getByTestId("close-library").click(); };

  /* Load more fails: said beside Load more, and Load more tries again. Gen says nothing about it. */
  await openLibrary();
  const more = library.getByTestId("library-more");
  await expect(more.getByTestId("library-more-button")).toHaveText("Load more · 5 shown");
  state.failMore = true;
  await more.getByTestId("library-more-button").click();
  await expect(more).toContainText("More takes could not be read.");
  await expect(more).not.toContainText("Not refreshed");
  await expect(page.getByTestId("gen-results-error")).toHaveCount(0);
  await shot(page, info, "library-more-error", more);
  state.failMore = false;
  await more.getByTestId("library-more-button").click();
  await expect(library.getByTestId("library-assets").getByTestId("take-tile")).toHaveCount(8);
  await expect(library.getByTestId("library-more")).toHaveCount(0);
  await closeLibrary();

  /* A re-read fails with every card on screen: they stay, and Gen says they were not refreshed. */
  state.mode = "fail";
  await tile(results, "Harbour at dusk").getByTestId("take-refresh").click();
  const stale = page.getByTestId("gen-results-error");
  await expect(stale).toHaveText(/Not refreshed · The library is offline for a moment\./);
  await expect(stale).toHaveAttribute("data-tone", "stale");
  await expect(stale).toHaveAttribute("role", "status");
  await expect(results.getByTestId("take-tile")).toHaveCount(8);
  await expect(page.getByTestId("gen-results-empty")).toHaveCount(0);
  if (PHONES.includes(info.project.name)) expect(await smallTargets(page, '[data-testid="gen-results-error"]'), "Try again under 44×44").toEqual([]);
  await shot(page, info, "gen-stale", stale);

  /* The Library says it at the list's end, with its own Try again, which clears both. */
  await openLibrary();
  await expect(library.getByTestId("library-more")).toContainText("Not refreshed · The library is offline for a moment.");
  await expect(library.getByTestId("library-error")).toHaveCount(0);
  state.mode = "ok";
  await library.getByTestId("library-more-retry").click();
  await expect(library.getByTestId("library-more")).toHaveCount(0);
  await expect(stale).toHaveCount(0);
  await noSideScroll(page);
  expect(errors).toEqual([]);
});

test("long names and long messages stay inside their cards and banners", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const name = "Harbour at dusk from the far breakwater with gulls crossing the lamp line while the ferry turns ".repeat(2).trim();
  const words = "This reference is too large: " + "unbrokenreferencefilenamewithoutanyspaces".repeat(6) + " was bigger than it accepts.";
  const rows = () => [
    generation({ id: "gen_long_fail", title: name, kind: "image", status: "failed", storedUrl: null, creditsBilled: 0, error: words, projectId: "prod-cards", createdAt: BASE, updatedAt: BASE }),
    generation({ id: "gen_long_ok", title: `${name} (take two)`, kind: "image", creditsBilled: 1, projectId: "prod-cards", createdAt: BASE - 1, updatedAt: BASE - 1 }),
  ];
  const { errors, state } = await open(page, "/suites?view=gen", "ok", { rows });
  const results = page.getByRole("region", { name: "Results" });
  await expect(results.getByTestId("take-tile")).toHaveCount(2);
  const card = results.getByTestId("take-tile").first();
  await expect(card.getByTestId("take-reason")).toContainText("This reference is too large");
  /* One line under the name: the full words ride in the tooltip. */
  const line = await card.getByTestId("take-reason").evaluate((el) => ({ h: el.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(el).lineHeight) || 16 }));
  expect(line.h).toBeLessThan(line.lh * 1.6);
  for (const el of await results.getByTestId("take-tile").all()) {
    const [cardBox, resultsBox] = [(await el.boundingBox())!, (await results.boundingBox())!];
    expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(resultsBox.x + resultsBox.width + 1);
  }
  await shot(page, info, "long-cards", card);

  /* A long failure message wraps inside its banner. */
  state.mode = "fail";
  await page.route("**/api/workbench/library**", (route) => route.fulfill({ status: 503, json: { error: words } }));
  await page.reload();
  const banner = page.getByTestId("gen-results-error");
  await expect(banner).toContainText("This reference is too large");
  const [bannerBox, viewport] = [(await banner.boundingBox())!, page.viewportSize()!];
  expect(bannerBox.x + bannerBox.width).toBeLessThanOrEqual(viewport.width + 1);
  await noSideScroll(page);
  await shot(page, info, "long-banner", banner);
  expect(errors).toEqual([]);
});
