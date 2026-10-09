import { test, expect, type Page } from "@playwright/test";
import type { QueueItem } from "../lib/control-room/queue";
import { HOME_BOARDS, seedHome, signInSwitchedOn } from "./helpers/v12Home";

/**
 * Home, signed in, in the new interface (redesign C2; docs/redesign/inventory.md § 5.9). With the switch on at desktop
 * sizes: Waiting for you, the wall of the workspace's own work (pick, Remix), Your boards with kind filters, and the bar
 * whose Start carries the server's price. At phone sizes the phone app is unchanged with the switch on (rule 7).
 * Local ENGINE_MOCK server; the approvals queue is answered here, so nothing is approved for real.
 */
const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const PHONE = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];

const item = (over: Partial<QueueItem> & Pick<QueueItem, "id" | "title">): QueueItem => ({
  source: "held", where: "Make", at: Date.now() - 5 * 60_000,
  project: { productionId: "prod-x", draftId: null, name: "Harbour film" },
  price: { kind: "exact", credits: 3 }, needsAdmin: false, canApprove: true, why: null, shortBy: null, note: null, step: null, sample: false,
  approve: { kind: "release", genId: "gen_held_1", credits: 3 }, decline: { kind: "discard", genId: "gen_held_1" },
  open: { kind: "take", genId: "gen_held_1", draftId: null },
  ...over,
});

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "no horizontal overflow").toBe(true);
}

test("desktop: the new Home — waiting strip, the wall, boards by kind, and the bar's priced Start", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop sizes");
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const seeded = await seedHome(page);

  /* The boards list says what kind each board is, read from its own draft. */
  const listed = await page.request.get("/api/workbench/projects", { headers: seeded.headers }).then((r) => r.json()) as { projects: { name: string; kind: string | null }[] };
  for (const board of HOME_BOARDS) expect(listed.projects.find((p) => p.name === board.name)?.kind).toBe(board.kind);

  let items = [
    item({ id: "held:gen_held_1", title: "Keyframe · retake" }),
    item({ id: "held:gen_held_2", title: "Hero take", price: { kind: "free" }, approve: { kind: "release", genId: "gen_held_2", credits: 0 } }),
    item({ id: "held:gen_held_3", title: "Wide shot", shortBy: 4 }),
  ];
  await page.route((url) => url.pathname === "/api/control-room/approvals", (route) => route.fulfill({ json: { items, decided: [], inCredits: true } }));
  const releases: string[] = [];
  await page.route(/\/api\/jobs\/[^/]+\/release$/, (route) => {
    releases.push(route.request().url());
    items = items.filter((i) => i.id !== "held:gen_held_1");
    return route.fulfill({ json: { ok: true } });
  });
  /* Start would ask Atomik to plan (paid): this spec never presses it for real. */
  const asks: string[] = [];
  await page.route((url) => url.pathname === "/api/workbench/team-canvas", (route) => {
    if (route.request().method() === "POST") { asks.push(route.request().postData() ?? ""); return route.fulfill({ status: 409, json: { error: "Not in this test." } }); }
    return route.fallback();
  });

  await page.goto("/suites?view=home");
  const home = page.getByTestId("v12-home");
  await expect(home).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("phone-app")).toHaveCount(0);

  /* 1 · Waiting for you: the count, one item (two from 1400 px), its own price on its action, "+N more", hide. */
  const strip = page.getByTestId("v12-home-waiting");
  await expect(strip).toContainText("Waiting for you");
  await expect(page.getByTestId("v12-home-waiting-count")).toHaveText("3");
  /* Two items inline from 1400 px wide, else one. */
  const inline = (page.viewportSize()?.width ?? 0) >= 1400 ? 2 : 1;
  await expect(page.getByTestId("v12-home-waiting-item")).toHaveCount(inline);
  await expect(page.getByTestId("v12-home-waiting-more")).toHaveText(`+${3 - inline} more`);
  const first = page.locator('[data-item="held:gen_held_1"]');
  await expect(first).toContainText("Keyframe · retake");
  await expect(first).toContainText("· Harbour film · Make");
  await expect(first.getByTestId("v12-home-waiting-approve")).toHaveText("Approve · 3 cr");
  await expect(first.getByTestId("v12-home-waiting-approve")).toHaveAttribute("data-spend-price", "3 cr");
  if (inline === 2) await expect(page.locator('[data-item="held:gen_held_2"]').getByTestId("v12-home-waiting-approve")).toHaveText("Approve · free");

  /* 2 · The wall: the workspace's own six stills on the mosaic, labelled; pick one and the bar opens its sheet. */
  const tiles = page.getByTestId("v12-home-tile");
  await expect(tiles).toHaveCount(6, { timeout: 60_000 });
  await expect(tiles.first()).toContainText("Still");
  await expect(page.getByTestId("v12-home-wall")).toContainText("A cyclist on a ridge at noon");
  const start = page.getByTestId("v12-home-start");
  await expect(start).toHaveText(/^Start · up to \d[\d,]* cr$/, { timeout: 60_000 });
  await expect(start).toHaveAttribute("data-spend", "priced");
  await expect(start).toBeEnabled();
  await expect(page.getByTestId("v12-home-bar-input")).toHaveAttribute("placeholder", "Describe a film, ad or idea, or pick one above");

  await tiles.first().hover();
  await expect(tiles.first().getByTestId("v12-home-tile-remix")).toBeVisible();
  await expect(tiles.first()).toContainText("Make one like this");
  await tiles.first().getByTestId("v12-home-tile-pick").click();
  await expect(tiles.first().getByTestId("v12-home-tile-picked")).toHaveText("Picked");
  await expect(tiles.nth(1)).toHaveAttribute("data-faded", "");
  await expect(page.getByTestId("v12-home-sheet")).toBeVisible();
  await expect(page.getByTestId("v12-home-picked-chip")).toContainText("Still");
  await expect(page.getByTestId("v12-home-bar-input")).toHaveAttribute("placeholder", "Anything to add (optional)");
  await page.getByTestId("v12-home-sheet-aspect").filter({ hasText: "9:16" }).click();
  await expect(page.getByTestId("v12-home-sheet-aspect").filter({ hasText: "9:16" })).toHaveAttribute("aria-pressed", "true");
  await expect(start).toHaveText(/^Start · up to \d[\d,]* cr$/);
  await noOverflow(page);
  /* Escape unpicks; × on the chip does too. */
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("v12-home-sheet")).toHaveCount(0);

  /* The bar: @ lists this workspace's own work and puts "@Name " into the words; Enter with nothing said asks for words. */
  const input = page.getByTestId("v12-home-bar-input");
  await page.getByTestId("v12-home-bar-mention-button").click();
  await expect(page.getByTestId("v12-home-bar-mentions")).toContainText("From your work");
  await page.getByTestId("v12-home-bar-mention").first().click();
  await expect(input).toHaveValue(/^@.+ $/);
  await input.fill("");
  await input.press("Enter");
  await expect(page.getByTestId("v12-home-bar-note")).toHaveText("Describe a film, ad or idea, or pick one above.");
  expect(asks).toEqual([]);

  /* 3 · Your boards: newest first, filtered by kind. */
  const boards = page.getByTestId("v12-home-board");
  await expect(boards).toHaveCount(3);
  await page.getByTestId("v12-home-board-filter").filter({ hasText: "Campaigns" }).click();
  await expect(boards).toHaveCount(1);
  await expect(boards.first()).toContainText("Spring launch");
  await page.getByTestId("v12-home-board-filter").filter({ hasText: "Social" }).click();
  await expect(boards).toHaveText([/Ridge clips/]);
  await page.getByTestId("v12-home-board-filter").filter({ hasText: "Films" }).click();
  await expect(boards).toHaveText([/Harbour film/]);
  await page.getByTestId("v12-home-board-filter").filter({ hasText: "All" }).click();
  await expect(boards).toHaveCount(3);
  await noOverflow(page);

  /* Approve sends that item alone through its own release route, at its own figure. */
  await first.getByTestId("v12-home-waiting-approve").click();
  await expect(first).toHaveCount(0);
  expect(releases).toHaveLength(1);
  expect(releases[0]).toMatch(/\/api\/jobs\/gen_held_1\/release$/);
  /* Hide for now: the strip goes, the wall's rows grow. */
  await page.getByTestId("v12-home-waiting-hide").click();
  await expect(strip).toHaveCount(0);

  /* A board opens on its board. */
  await boards.filter({ hasText: "Spring launch" }).click();
  await expect(page).toHaveURL(/view=board/, { timeout: 30_000 });
  expect(errors).toEqual([]);
});

test("desktop: an empty workspace's Home says where its work will show, and nothing from samples", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop sizes");
  await signInSwitchedOn(page);
  await page.route((url) => url.pathname === "/api/control-room/approvals", (route) => route.fulfill({ json: { items: [], decided: [], inCredits: true } }));
  await page.goto("/suites?view=home");
  await expect(page.getByTestId("v12-home")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("v12-home-waiting")).toHaveCount(0);
  await expect(page.getByTestId("v12-home-wall-empty")).toHaveText("What you make shows here. Describe a film, ad or idea below to start.", { timeout: 60_000 });
  await expect(page.getByTestId("v12-home-tile")).toHaveCount(0);
  await expect(page.getByTestId("v12-home-bar-mention-button")).toBeDisabled();
  /* The prototype's sample names never show (plan decision 4). */
  const text = await page.getByTestId("v12-home").innerText();
  for (const sample of ["Mirror at noon", "Aqua, carried far", "Walk the ridge", "Bleached gold", "Dune Studies", "Maggi"]) expect(text).not.toContain(sample);
  await noOverflow(page);
});

test("phone sizes: the phone app is unchanged with the switch on", async ({ page }, info) => {
  test.skip(!PHONE.includes(info.project.name), "phone sizes");
  await signInSwitchedOn(page);
  await page.goto("/suites?view=home");
  await expect(page.getByTestId("phone-app")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("v12-home")).toHaveCount(0);
  await noOverflow(page);
});
