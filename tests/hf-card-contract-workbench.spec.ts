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
 * Held / Failed · not billed / Picked / Approved) and one line on why it
 * failed or waits; a finished take whose stored copy is missing says
 * "Preview unavailable" with Refresh; a take in flight settles on its own.
 * A failed project list says so instead of "No project".
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const WIDE = ["workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const SHOTS = process.env.CARD_SHOTS_DIR;

const fixture = (): Project => ({ ...newProject("Harbour takes"), id: "ws-cards", productionProjectId: "prod-cards", shotMappings: {}, aspect: "16:9" });

type Mode = "ok" | "fail" | "hold";

/** The project library, with the read's outcome under the test's control. */
async function controlledLibrary(page: Page) {
  const state = {
    mode: "ok" as Mode,
    release: () => {},
    gate: Promise.resolve(),
    /** The running take finishes; the missing copy lands. */
    landed: false, restored: false,
    reads: 0,
  };
  const hold = () => { state.mode = "hold"; state.gate = new Promise<void>((resolve) => { state.release = () => { state.mode = "ok"; resolve(); }; }); };
  const generations = (): Generation[] => [
    generation({ id: "gen_run", title: "Lantern walk", kind: "image", status: state.landed ? "succeeded" : "running", storedUrl: state.landed ? "/api/media/gen_run" : null, creditsBilled: state.landed ? 1 : null, projectId: "prod-cards" }),
    generation({ id: "gen_queue", title: "Tide timelapse", kind: "video", status: "queued", storedUrl: null, creditsBilled: null, projectId: "prod-cards" }),
    generation({ id: "gen_held", title: "Storm front", kind: "video", status: "held", storedUrl: null, creditsBilled: null, params: { held: { why: "credits", needs: 12 } }, projectId: "prod-cards" }),
    generation({ id: "gen_fail", title: "Night swim", kind: "video", status: "failed", storedUrl: null, creditsBilled: 0, error: "Refused: the prompt was flagged by moderation.", projectId: "prod-cards" }),
    generation({ id: "gen_gone", title: "Harbour at dusk", kind: "image", storedUrl: state.restored ? "/api/media/gen_gone" : null, creditsBilled: 1, projectId: "prod-cards" }),
    generation({ id: "gen_pick", title: "Gull over the breakwater", kind: "image", reviewState: "picked", creditsBilled: 1, projectId: "prod-cards" }),
    generation({ id: "gen_ok", title: "Pier at first light", kind: "image", reviewState: "approved", creditsBilled: 1, projectId: "prod-cards" }),
  ];
  await page.route("**/api/workbench/library**", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") return route.fulfill({ json: { ok: true } });
    state.reads++;
    if (state.mode === "fail") return route.fulfill({ status: 503, json: { error: "The library is offline for a moment." } });
    if (state.mode === "hold") await state.gate;
    const source = new URL(request.url()).searchParams.get("source");
    return route.fulfill({ json: source === "uploads" ? { uploads: [], nextCursor: null } : { generations: generations(), nextPageCursor: null } });
  });
  return { state, hold };
}

async function open(page: Page, url: string, mode: Mode = "ok") {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  const library = await controlledLibrary(page);
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
  await expect(banner).toContainText("The library is offline for a moment.");
  await expect(banner).toHaveAttribute("role", "alert");
  await expect(page.getByTestId("gen-results-empty")).toHaveCount(0);
  await expect(results.getByTestId("take-tile")).toHaveCount(0);
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
  await expect(results.getByTestId("take-tile")).toHaveCount(7);

  /* Every take says what it is doing. */
  await expect(tile(results, "Lantern walk").getByTestId("take-chip")).toHaveText("Rendering");
  await expect(tile(results, "Tide timelapse").getByTestId("take-chip")).toHaveText("Queued");
  await expect(tile(results, "Storm front").getByTestId("take-chip")).toHaveText("Held");
  await expect(tile(results, "Storm front").getByTestId("take-reason")).toHaveText("Needs 12 cr");
  await expect(tile(results, "Night swim").getByTestId("take-chip")).toHaveText("Failed · not billed");
  await expect(tile(results, "Night swim").getByTestId("take-reason")).toHaveText("Refused by the content filter");
  await expect(tile(results, "Night swim").getByTestId("take-reason")).toHaveAttribute("title", "Refused: the prompt was flagged by moderation.");
  await expect(tile(results, "Gull over the breakwater").getByTestId("take-chip")).toHaveText("Picked");
  await expect(tile(results, "Pier at first light").getByTestId("take-chip")).toHaveText("Approved");
  /* The same card at the same frame whether it rendered or not. */
  const failedThumb = (await tile(results, "Night swim").locator(".gx-asset-thumb").boundingBox())!;
  const okThumb = (await tile(results, "Pier at first light").locator(".gx-asset-thumb").boundingBox())!;
  expect(Math.abs(failedThumb.height - okThumb.height)).toBeLessThan(1);
  /* Filed by what it is: the failed clip is under Video with the other clips. */
  await results.getByRole("button", { name: "Video", exact: true }).click();
  await expect(results.getByTestId("take-tile")).toHaveCount(3);
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
  state.restored = true;
  const before = state.reads;
  await refresh.click();
  await expect(gone).toHaveAttribute("data-face", "media");
  await expect(gone.getByTestId("take-reason")).toHaveCount(0);
  expect(state.reads).toBeGreaterThan(before);

  /* A take in flight settles on its own: no reload, no click. */
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
  await expect(takesBanner).toContainText("The library is offline for a moment.");
  await expect(page.getByTestId("edit-takes")).not.toContainText("Nothing generated yet");
  if (PHONES.includes(info.project.name)) expect(await smallTargets(page, '[data-testid="takes-error"]'), "Try again under 44×44").toEqual([]);
  await shot(page, info, "takes-error", takesBanner);
  state.mode = "ok";
  await takesBanner.getByRole("button", { name: "Try again" }).click();
  await expect(takesBanner).toHaveCount(0);

  const takes = page.getByTestId("edit-takes");
  await expect(takes.getByTestId("take-tile")).toHaveCount(7);
  await expect(tile(takes, "Night swim").getByTestId("take-chip")).toHaveText("Failed · not billed");
  await expect(tile(takes, "Night swim").getByTestId("take-reason")).toHaveText("Refused by the content filter");
  await expect(tile(takes, "Storm front").getByTestId("take-chip")).toHaveText("Held");
  await expect(tile(takes, "Harbour at dusk").getByTestId("take-reason")).toHaveText("Preview unavailable");
  await shot(page, info, "takes-cards", tile(takes, "Storm front"));
  /* A take that did not render says why instead of opening an empty editor. */
  await tile(takes, "Night swim").getByTestId("edit-take").click();
  await expect(page.getByTestId("toast")).toHaveText("Night swim did not render · Refused by the content filter.");
  await tile(takes, "Tide timelapse").getByTestId("edit-take").click();
  await expect(page.getByTestId("toast")).toHaveText("Tide timelapse is still queued; it opens here when it lands.");

  /* Library › Assets: the 2-up tile shortens the chip and moves the billing note under the name. */
  if (!wide) await page.getByTestId("toggle-library").click();
  const library = page.getByTestId("library");
  await library.getByRole("tab", { name: /Assets/ }).click();
  const assets = page.getByTestId("library-assets");
  await expect(tile(assets, "Night swim").getByTestId("take-chip")).toHaveText("Failed");
  await expect(tile(assets, "Night swim").getByTestId("take-reason")).toHaveText("Not billed · Refused by the content filter");
  await expect(tile(assets, "Storm front").getByTestId("take-reason")).toHaveText("Needs 12 cr");
  await expect(tile(assets, "Pier at first light").getByTestId("take-chip")).toHaveText("Approved");
  await library.getByRole("button", { name: "Video", exact: true }).click();
  await expect(assets.getByTestId("take-tile")).toHaveCount(3);
  await shot(page, info, "library-cards");
  await noSideScroll(page);
  expect(errors).toEqual([]);
});

test("a project list that will not load says so, and Try again opens the project", async ({ page }, info) => {
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
  await expect(page.getByTestId("project-name")).toHaveText("Not loaded");
  /* Not "Open a project": nothing is known about the projects yet. */
  await expect(page.getByTestId("gen-results-empty")).toHaveCount(0);
  if (PHONES.includes(info.project.name)) expect(await smallTargets(page, '[data-testid="projects-error"]'), "Try again under 44×44").toEqual([]);
  await noSideScroll(page);
  await shot(page, info, "projects-error");
  fail = false;
  await banner.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("project-name")).toHaveText("Harbour takes");
  await expect(banner).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Results" }).getByTestId("take-tile")).toHaveCount(7);
  expect(errors).toEqual([]);
});
