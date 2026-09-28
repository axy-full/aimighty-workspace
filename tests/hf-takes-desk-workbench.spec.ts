import { test, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type CanvasNode, type Project } from "../lib/workbench/studio";
import type { Generation } from "../lib/jobs";
import type { LibraryUpload } from "../lib/genLibrary";
import { dimLabels, smallTargets } from "./phoneFloors";
import { forbidPaidWork, generation, mockMedia, mockProjects, upload } from "./helpers/workspaceFixtures";

/**
 * Studio › Takes as the review desk every "Filed in Takes for review" points
 * at: every take once, grouped by shot (the Rig's order) and then by the batch
 * it was rendered in; status chips (All / Needs review / Picked / Approved /
 * Changes / Held / Failed), kind chips and a search narrow it; the selected
 * take is picked, approved or sent back through PATCH /api/jobs/:id, and a
 * second press clears it; a sound opens its transcript, priced first; a long
 * project is windowed and reads its next page as the end comes into view, and
 * on a phone the last row and Load more end above the tab bar. Every reply is
 * route-mocked; nothing paid is sent.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const WIDE = ["workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const SHOTS = process.env.DESK_SHOTS_DIR;
const BASE = 1_790_000_000_000;
const at = (i: number) => BASE - i * 60_000;

const node = (id: string, title: string): CanvasNode => ({ id, title, type: "scene", x: 0, y: 0, width: 238, linked: [] });
/* The Rig lists the storm first, so its shot comes first; the Rig's name for a shot is the one shown. */
const fixture = (): Project => ({
  ...newProject("Harbour review"), id: "ws-desk", productionProjectId: "prod-desk", aspect: "16:9",
  nodes: [node("n_storm", "Storm over the harbour"), node("n_dusk", "Harbour at dusk")],
  shotMappings: { n_storm: "shot_storm", n_dusk: "shot_dusk" },
});
const onShot = (shot: "dusk" | "storm") => shot === "dusk"
  ? { shotId: "shot_dusk", shotCode: "SH010", shotTitle: "Dusk" }
  : { shotId: "shot_storm", shotCode: "SH020", shotTitle: "Storm" };
const row = (i: number, fields: Partial<Generation> & { id: string }) => generation({ projectId: "prod-desk", createdAt: at(i), updatedAt: at(i), ...fields });

/** Nine takes and an upload: a batch of three on one shot (one picked), an approved single, a held and a failed take on another, and loose takes. */
function desk(): { generations: Generation[]; uploads: LibraryUpload[] } {
  return {
    generations: [
      row(0, { id: "gen_b1", title: "Lantern walk", prompt: "the keeper walks the pier with a lantern", ...onShot("dusk"), params: { batchId: "b_lantern1" } }),
      row(1, { id: "gen_b2", title: "Lantern walk, closer", ...onShot("dusk"), params: { batchId: "b_lantern1" }, reviewState: "picked", reviewBy: "Studio lead", pickedBy: "Studio lead", pickedAt: at(1) }),
      row(2, { id: "gen_b3", title: "Lantern walk, wide", ...onShot("dusk"), params: { batchId: "b_lantern1" } }),
      row(3, { id: "gen_gull", title: "Gull over the breakwater", ...onShot("dusk"), reviewState: "approved", reviewBy: "Director", approvedBy: "Director", approvedAt: at(3) }),
      row(4, { id: "gen_held", title: "Storm front", kind: "video", status: "held", storedUrl: null, ...onShot("storm"), params: { held: { why: "credits", needs: 12 } } }),
      row(5, { id: "gen_fail", title: "Night swim", status: "failed", storedUrl: null, creditsBilled: 0, error: "Refused: the prompt was flagged by moderation.", ...onShot("storm") }),
      row(6, { id: "gen_changes", title: "Pier at first light", reviewState: "changes", reviewBy: "Director" }),
      row(7, { id: "gen_voice", title: "Keeper's line", kind: "audio", model: "eleven_v3", prompt: "the keeper says the storm is coming" }),
      row(8, { id: "gen_still", title: "Ferry at the quay", prompt: "a ferry turns at the quay" }),
    ],
    uploads: [upload({ id: "up_plate", filename: "Harbour plate.webp", createdAt: at(9) })],
  };
}

type Library = { generations: Generation[]; uploads: LibraryUpload[] };

/** The project library, paged by cursor like the route; a held Load more waits for release(). An `id` asks for one take, as the route answers a link. */
async function mockDeskLibrary(page: Page, store: Library, opts: { pageSize?: number } = {}) {
  const state = { reads: 0, pages: 0, lookups: [] as string[], hold: false, release: () => {}, gate: Promise.resolve(), lookupGate: Promise.resolve(), releaseLookup: () => {} };
  const hold = () => { state.hold = true; state.gate = new Promise<void>((resolve) => { state.release = () => { state.hold = false; resolve(); }; }); };
  const holdLookups = () => { state.lookupGate = new Promise<void>((resolve) => { state.releaseLookup = resolve; }); };
  await page.route("**/api/workbench/library**", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") return route.fulfill({ json: { ok: true } });
    state.reads++;
    const url = new URL(request.url());
    const id = url.searchParams.get("id");
    if (id !== null) {
      state.lookups.push(`${url.searchParams.get("source")}:${id}`);
      await state.lookupGate;
      return route.fulfill({ json: url.searchParams.get("source") === "uploads"
        ? { uploads: store.uploads.filter((u) => u.id === id), nextCursor: null }
        : { generations: store.generations.filter((g) => g.id === id), nextPageCursor: null } });
    }
    const cursor = url.searchParams.get("cursor");
    if (cursor) { state.pages++; if (state.hold) await state.gate; }
    const size = opts.pageSize ?? 60, offset = Number(cursor ?? 0);
    if (url.searchParams.get("source") === "uploads") {
      const items = store.uploads.slice(offset, offset + size);
      return route.fulfill({ json: { uploads: items, nextCursor: offset + size < store.uploads.length ? String(offset + size) : null } });
    }
    return route.fulfill({ json: { generations: store.generations.slice(offset, offset + size), nextPageCursor: offset + size < store.generations.length ? String(offset + size) : null } });
  });
  return { state, hold, holdLookups };
}

type Review = { id: string; body: { reviewState?: string }; scope: string | null };
/** PATCH /api/jobs/:id as the route answers a review (it records the reviewer); `fail` answers the next one with a refusal. */
async function mockReviews(page: Page, store: Library) {
  const sent: Review[] = [];
  const control = { fail: null as null | { status: number; error: string } };
  await page.route(/\/api\/jobs\/[^/?]+$/, async (route) => {
    const request = route.request();
    if (request.method() !== "PATCH") return route.fallback();
    const id = decodeURIComponent(new URL(request.url()).pathname.split("/").pop()!);
    const body = request.postDataJSON() as { reviewState?: string };
    sent.push({ id, body, scope: await request.headerValue("x-workbench-scope") });
    if (control.fail) { const { status, error } = control.fail; control.fail = null; return route.fulfill({ status, json: { error } }); }
    const g = store.generations.find((x) => x.id === id)!;
    const state = (body.reviewState ?? "") as Generation["reviewState"];
    const now = Date.now();
    Object.assign(g, {
      reviewState: state, reviewBy: state ? "Workbench Tester" : null, updatedAt: now,
      ...(state === "picked" ? { pickedBy: "Workbench Tester", pickedAt: now } : {}),
      ...(state === "approved" ? { approvedBy: "Workbench Tester", approvedAt: now } : {}),
    });
    const { reviewState, reviewBy, pickedBy, pickedAt, approvedBy, approvedAt, updatedAt } = g;
    return route.fulfill({ json: { ok: true, review: { reviewState, reviewBy, pickedBy, pickedAt, approvedBy, approvedAt, updatedAt } } });
  });
  return { sent, control };
}

async function open(page: Page, store: Library = desk(), opts: { pageSize?: number; url?: string } = {}) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  const library = await mockDeskLibrary(page, store, opts);
  const reviews = await mockReviews(page, store);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(opts.url ?? "/suites?suite=studio&page=takes");
  await expect(page.getByTestId("project-name")).toHaveText("Harbour review");
  return { errors, store, ...library, ...reviews };
}

const grid = (page: Page) => page.getByTestId("takes-grid");
const tile = (scope: Locator, name: string) => scope.getByTestId("take-tile").filter({ has: scope.page().getByText(name, { exact: true }) });
const filterChip = (page: Page, label: string) => page.getByTestId("takes-filter").filter({ hasText: new RegExp(`^${label}`) });
const kindChip = (page: Page, label: string) => page.getByTestId("takes-kind").filter({ hasText: label });
const names = (scope: Locator) => scope.locator(".pd-take-name").allTextContents();

async function noSideScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), "no horizontal page scroll").toBeLessThanOrEqual(1);
}

/** With DESK_SHOTS_DIR set, a picture of the state under test, `focus` scrolled to the middle first. */
async function shot(page: Page, info: TestInfo, name: string, focus?: Locator) {
  if (!SHOTS) return;
  if (focus) await focus.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/${name}-${info.project.name.replace("workbench-", "")}.png` });
}

/** Scroll the stage to its very end: a windowed grid measures the rows it brings in, so its end can move once or twice. */
async function toEnd(page: Page) {
  const stage = page.getByTestId("content");
  for (let i = 0, last = -1; i < 8; i++) {
    const top = await stage.evaluate((el) => { el.scrollTop = el.scrollHeight; return el.scrollTop; });
    await page.waitForTimeout(150);
    if (top === last) return;
    last = top;
  }
}

/** The stage scrolled to its end; every part of `el` then ends above the phone's tab bar (when there is one). */
async function clearsTabBar(page: Page, el: Locator, what: string) {
  await toEnd(page);
  await page.waitForTimeout(100);
  const bar = page.getByTestId("tabbar");
  if (!(await bar.isVisible())) return;
  const [box, barBox] = [(await el.boundingBox())!, (await bar.boundingBox())!];
  expect(box, `${what} is on the page`).not.toBeNull();
  expect(box.y + box.height, `${what} ends above the tab bar`).toBeLessThanOrEqual(barBox.y);
}

test("every take once, grouped by shot and batch; status and kind chips and a search narrow it", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors } = await open(page);
  const takes = grid(page);
  /* Once each: nine takes and an upload, not a Generations list and an All assets list. */
  await expect(takes.getByTestId("take-tile")).toHaveCount(10);
  await expect(page.getByTestId("takes-assets")).toHaveCount(0);
  await expect(page.getByTestId("takes-count")).toHaveText("10 in this project · 0 in the cut");
  /* By shot, in the Rig's order and by the Rig's name; loose takes, then uploads, last. */
  await expect(takes.getByTestId("takes-shot")).toHaveText([/^SH020 · Storm over the harbour\s*2$/, /^SH010 · Harbour at dusk\s*4$/, /^Not on a shot\s*3$/, /^Uploads\s*1$/]);
  /* A batch is one strip, at its newest take's place; picking one of them is done. */
  await expect(takes.getByTestId("takes-strip")).toHaveText(["Batch of 3"]);
  expect(await names(takes)).toEqual(["Storm front", "Night swim", "Lantern walk", "Lantern walk, closer", "Lantern walk, wide", "Gull over the breakwater", "Pier at first light", "Keeper's line", "Ferry at the quay", "Harbour plate.webp"]);
  /* A batch's takes start their own row; the single after them starts the next. */
  const [first, single] = [(await tile(takes, "Lantern walk").boundingBox())!, (await tile(takes, "Gull over the breakwater").boundingBox())!];
  expect(Math.abs(single.x - first.x), "the single after a batch starts a row").toBeLessThan(2);
  expect(single.y).toBeGreaterThan(first.y + 10);
  await shot(page, info, "desk", takes);

  /* The status chips count what they would show; the words are the cards' own. */
  await expect(page.getByTestId("takes-filter")).toHaveText([/^All\s*10$/, /^Needs review\s*4$/, /^Picked\s*1$/, /^Approved\s*1$/, /^Changes\s*1$/, /^Held\s*1$/, /^Failed\s*1$/]);
  await filterChip(page, "Needs review").click();
  expect(await names(takes)).toEqual(["Lantern walk", "Lantern walk, wide", "Keeper's line", "Ferry at the quay"]);
  await expect(page.getByTestId("takes-count")).toHaveText("4 of 10 · 0 in the cut");
  await filterChip(page, "Held").click();
  expect(await names(takes)).toEqual(["Storm front"]);
  /* Held for credits: the need rides on the card's chip, and the way out is Release at that price (the card contract). */
  await expect(tile(takes, "Storm front").getByTestId("take-chip")).toHaveText("Held · needs 12 cr");
  await expect(tile(takes, "Storm front").getByTestId("take-release")).toContainText("12 cr");
  await filterChip(page, "Failed").click();
  await expect(tile(takes, "Night swim").getByTestId("take-chip")).toHaveText("Failed");
  expect(await names(takes)).toEqual(["Night swim"]);
  await filterChip(page, "Changes").click();
  expect(await names(takes)).toEqual(["Pier at first light"]);
  await filterChip(page, "All").click();

  /* Kind chips: by what a take is, whether or not it rendered; pressed again, every kind. */
  await kindChip(page, "Video").click();
  expect(await names(takes)).toEqual(["Storm front"]);
  await kindChip(page, "Audio").click();
  expect(await names(takes)).toEqual(["Keeper's line"]);
  await kindChip(page, "Uploads").click();
  expect(await names(takes)).toEqual(["Harbour plate.webp"]);
  await kindChip(page, "Uploads").click();
  await expect(takes.getByTestId("take-tile")).toHaveCount(10);

  /* Search: a name, a prompt, a shot code. */
  const search = page.getByTestId("takes-search");
  await search.fill("storm is coming");
  await expect(takes.getByTestId("take-tile")).toHaveCount(1);
  expect(await names(takes)).toEqual(["Keeper's line"]);
  await search.fill("sh010");
  await expect(takes.getByTestId("take-tile")).toHaveCount(4);
  await expect(page.getByTestId("takes-filter").first()).toHaveText(/^All\s*4$/);
  /* Nothing matches: said, with the way back. */
  await filterChip(page, "Failed").click();
  await expect(page.getByTestId("takes-empty")).toContainText("Nothing matches “sh010” under Failed.");
  await shot(page, info, "desk-empty", page.getByTestId("takes-empty"));
  await page.getByTestId("takes-clear").click();
  await expect(search).toHaveValue("");
  await expect(takes.getByTestId("take-tile")).toHaveCount(10);

  /* Phones: the chips and the search are thumb-sized and nothing runs off the side. */
  if (PHONES.includes(info.project.name)) expect(await smallTargets(page, '[data-testid="takes-filters"]'), "filters under 44×44").toEqual([]);
  for (const el of await page.locator('[data-testid="takes-filters"] .gx-chip, [data-testid="takes-search"]').all()) {
    const box = (await el.boundingBox())!;
    expect(box.x + box.width, "a filter inside the screen").toBeLessThanOrEqual(page.viewportSize()!.width);
  }
  await noSideScroll(page);
  expect(errors).toEqual([]);
});

test("the selected take is picked, approved or sent back through the review route, and a second press clears it", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, sent, control, store } = await open(page);
  const takes = grid(page);
  /* Nothing opens by itself: the desk is the first thing on the page. */
  await expect(page.getByTestId("takes-selected")).toHaveCount(0);
  await filterChip(page, "Needs review").click();
  await tile(takes, "Lantern walk").getByTestId("edit-take").click();
  const selected = page.getByTestId("takes-selected");
  await expect(selected).toContainText("Selected · Lantern walk");
  await expect(tile(takes, "Lantern walk").getByTestId("edit-take")).toHaveAttribute("aria-checked", "true");
  const review = page.getByTestId("takes-review");
  await expect(review.getByRole("button")).toHaveText(["Pick", "Approve", "Request changes"]);
  await expect(page.getByTestId("review-trail")).toHaveCount(0);
  if (PHONES.includes(info.project.name)) expect(await smallTargets(page, '[data-testid="takes-selected"]'), "review and tools under 44×44").toEqual([]);
  await shot(page, info, "desk-selected", selected);

  /* Pick: the route records who; the card and the trail say so at once. */
  const toast = page.getByTestId("toast");
  await page.getByTestId("review-picked").click();
  await expect(toast).toHaveText("Lantern walk is picked. It waits under Picked for approval.");
  expect(sent.at(-1)).toMatchObject({ id: "gen_b1", body: { reviewState: "picked" } });
  expect(sent.at(-1)!.scope, "the review carries the page's workspace scope").toMatch(/^particl-active-/);
  await expect(page.getByTestId("review-picked")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("review-picked")).toHaveText("Picked");
  await expect(page.getByTestId("review-trail")).toHaveText(/^Picked by Workbench Tester/);
  await expect(selected.getByTestId("take-chip")).toHaveText("Picked");
  /* It left Needs review, and stays open here. */
  await expect(tile(takes, "Lantern walk")).toHaveCount(0);
  await expect(page.getByTestId("takes-filter").nth(1)).toHaveText(/^Needs review\s*3$/);

  /* Approve, then a second press takes it back to Needs review. */
  await page.getByTestId("review-approved").click();
  await expect(toast).toHaveText("Lantern walk is approved.");
  await expect(page.getByTestId("review-trail")).toHaveText(/^Picked by Workbench Tester .* · approved by Workbench Tester/);
  await page.getByTestId("review-approved").click();
  await expect(toast).toHaveText("Lantern walk is back in Needs review.");
  expect(sent.at(-1)!.body).toEqual({ reviewState: "" });
  await expect(selected.getByTestId("take-chip")).toHaveCount(0);
  await expect(tile(takes, "Lantern walk")).toHaveCount(1);

  /* Request changes. Next walks on through the takes shown; Previous comes back. */
  await page.getByTestId("review-changes").click();
  await expect(toast).toHaveText("Changes requested on Lantern walk. It waits under Changes.");
  await expect(page.getByTestId("review-trail")).toHaveText(/^Changes requested by Workbench Tester/);
  await page.getByTestId("takes-next").click();
  await expect(selected).toContainText("Selected · Lantern walk, wide");
  /* Walking the takes that need review: the one just sent back is no longer among them. */
  await expect(page.getByTestId("takes-prev")).toBeDisabled();
  expect(store.generations.find((g) => g.id === "gen_b1")!.reviewState).toBe("changes");
  await page.getByTestId("takes-next").click();
  await expect(selected).toContainText("Selected · Keeper's line");

  /* A refusal says why, beside the buttons, and nothing changes. */
  control.fail = { status: 409, error: "Only a finished take can be picked, approved or sent back." };
  await page.getByTestId("review-approved").click();
  await expect(page.getByTestId("review-error")).toHaveText("Only a finished take can be picked, approved or sent back.");
  await expect(page.getByTestId("review-approved")).toHaveAttribute("aria-pressed", "false");

  /* An upload is a source: it opens, but carries no review. */
  await filterChip(page, "All").click();
  await tile(takes, "Harbour plate.webp").getByTestId("edit-take").click();
  await expect(selected).toContainText("Selected · Harbour plate.webp");
  await expect(page.getByTestId("takes-review")).toHaveCount(0);
  await expect(page.getByTestId("review-none")).toHaveText("An upload is a source: it is used, not reviewed.");

  /* A take that did not render cannot be judged, and says why. */
  await tile(takes, "Night swim").getByTestId("edit-take").click();
  await expect(toast).toHaveText("Night swim did not render · Refused by the content filter.");

  /* Back to the takes closes the take and brings its card into view. */
  await page.getByTestId("takes-back").click();
  await expect(page.getByTestId("takes-selected")).toHaveCount(0);
  await expect(tile(takes, "Harbour plate.webp")).toBeInViewport();
  await noSideScroll(page);
  expect(errors).toEqual([]);
});

test("a sound take opens its transcript: priced first, then run at exactly that price", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors } = await open(page);
  const bodies: Record<string, unknown>[] = [];
  /* The price read is held until the unpriced action has been seen: nothing can be pressed before its price is on it. */
  let releaseQuote: () => void = () => undefined;
  const quoteHeld = new Promise<void>((resolve) => { releaseQuote = resolve; });
  await page.route("**/api/audio/transcribe", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    bodies.push(body);
    if (body.quoteOnly) await quoteHeld;
    return route.fulfill({ json: body.quoteOnly ? { estimatedCredits: 3 } : { text: "The storm is coming.", language: "en", seconds: 4, words: [{ text: "The", start: 0, end: 0.3, speaker: 0 }, { text: "storm", start: 0.3, end: 0.8, speaker: 0 }], srt: "1\n", credits: 3 } });
  });
  await kindChip(page, "Audio").click();
  await tile(grid(page), "Keeper's line").getByTestId("edit-take").click();
  await expect(page.getByTestId("takes-selected")).toContainText("Selected · Keeper's line");
  /* A finished sound is a take like any other: it can be picked. The picture tools stay with pictures. */
  await expect(page.getByTestId("review-picked")).toBeVisible();
  await expect(page.getByTestId("edit-to-timeline")).toHaveCount(0);
  await expect(page.getByTestId("edit-image")).toHaveCount(0);
  const panel = page.getByTestId("transcribe");
  /* Opening the sound reads its price on its own — a quote only — and the priced action waits for it. */
  await expect.poll(() => bodies.length).toBe(1);
  await expect(panel.getByTestId("transcribe-run")).toHaveText("Pricing transcript…");
  await expect(panel.getByTestId("transcribe-run")).toBeDisabled();
  releaseQuote();
  await expect(panel.getByTestId("transcribe-run")).toHaveText("Transcribe · 3 credits");
  expect(bodies).toEqual([{ sourceGenId: "gen_voice", projectId: "prod-desk", diarize: true, quoteOnly: true }]);
  await panel.getByTestId("transcribe-run").click();
  await expect(panel.getByTestId("transcript")).toContainText("The storm");
  expect(bodies[1]).toEqual({ sourceGenId: "gen_voice", projectId: "prod-desk", diarize: true, maxCredits: 3 });
  if (PHONES.includes(info.project.name)) expect(await smallTargets(page, '[data-testid="transcribe"]'), "transcript buttons under 44×44").toEqual([]);
  await noSideScroll(page);
  expect(errors).toEqual([]);
});

test("a long project is windowed and reads on as its end comes into view; the last row and Load more end above the tab bar", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const shots = ["dusk", "storm"] as const;
  const store: Library = {
    uploads: [],
    generations: Array.from({ length: 300 }, (_, i) => row(i, { id: `gen_${i}`, title: `Take ${String(i + 1).padStart(3, "0")}`, ...(i < 40 ? onShot(shots[i % 2]) : {}) })),
  };
  const { errors, state, hold } = await open(page, store, { pageSize: 120 });
  const takes = grid(page);
  await expect(page.getByTestId("takes-count")).toHaveText("120+ in this project · 0 in the cut");
  /* Windowed: a slice of the takes is on the page, not all of them. */
  await expect(takes).toHaveAttribute("data-virtual", "on");
  expect(await takes.getByTestId("take-tile").count()).toBeLessThan(80);
  await expect(page.getByTestId("takes-filter").nth(1)).toHaveText(/^Needs review\s*120\+$/);

  /* The end of the list comes into view: the next page is read with nothing pressed. On a phone, it is clear of the tab bar. */
  hold();
  const more = page.getByTestId("takes-more");
  await clearsTabBar(page, more, "Load more");
  await expect(more.getByTestId("takes-more-button")).toHaveText("Loading…");
  await shot(page, info, "desk-more", more);
  state.release();
  await expect(page.getByTestId("takes-count")).toHaveText("240+ in this project · 0 in the cut");
  expect(state.pages).toBe(1);
  /* Scrolled to the end again: the last page. */
  await toEnd(page);
  await expect(page.getByTestId("takes-count")).toHaveText("300 in this project · 0 in the cut");
  expect(state.pages).toBe(2);
  await expect(more).toHaveCount(0);
  /* The last take, at the very end: whole, and above the tab bar. */
  const last = tile(takes, "Take 300");
  await toEnd(page);
  await expect(last).toBeVisible();
  await clearsTabBar(page, last, "the last row");
  /* Opened from the end of a windowed grid, the editor above comes into view: the grid holds its scroll corrections
     until the smooth move is over (outside iOS, one made on the way stops it at the grid's end). Then Back: its card,
     not mounted meanwhile, is brought back into view. */
  await last.getByTestId("edit-take").click();
  await expect(page.getByTestId("takes-selected")).toContainText("Selected · Take 300");
  await expect(page.getByTestId("takes-selected")).toBeInViewport();
  await expect(last).toHaveCount(0);
  await page.getByTestId("takes-back").click();
  await expect(page.getByTestId("takes-selected")).toHaveCount(0);
  await expect(last).toBeInViewport();
  await noSideScroll(page);
  expect(errors).toEqual([]);
});

test("the Library panel reads its next page as its end comes into view, and a sparse filter waits for Load more", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const store: Library = { uploads: [], generations: Array.from({ length: 130 }, (_, i) => row(i, { id: `gen_${i}`, title: `Take ${String(i + 1).padStart(3, "0")}`, ...(i === 125 ? { reviewState: "approved" as const } : {}) })) };
  const { errors, state } = await open(page, store, { pageSize: 60 });
  if (!WIDE.includes(info.project.name)) await page.getByTestId("toggle-library").click();
  const library = page.getByTestId("library");
  await library.getByRole("tab", { name: /Assets/ }).click();
  await expect(library.getByRole("tab", { name: /Assets/ })).toContainText("60+");
  /* On a landscape phone the panel scrolls to its list first; the list keeps a height to scroll in. */
  const list = library.getByTestId("library-assets");
  expect((await list.boundingBox())!.height, "the asset list has room to scroll in").toBeGreaterThan(100);
  await library.evaluate((panel) => { panel.scrollTop = panel.scrollHeight; });
  await list.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(library.getByRole("tab", { name: /Assets/ })).toContainText("120+");
  expect(state.pages).toBe(1);
  if (!WIDE.includes(info.project.name)) await page.getByTestId("close-library").click();

  /* Takes under Approved: none loaded yet. The list's end is on screen, so it waits to be asked, and says where to look. */
  await filterChip(page, "Approved").click();
  await expect(page.getByTestId("takes-empty")).toContainText("No approved takes in the 120 loaded.");
  await page.waitForTimeout(600);
  expect(state.pages).toBe(1);
  await page.getByTestId("takes-more-button").click();
  await expect(tile(grid(page), "Take 126")).toBeVisible();
  await expect(page.getByTestId("takes-more")).toHaveCount(0);
  await noSideScroll(page);
  expect(errors).toEqual([]);
});

test("long names stay inside the desk: a shot, a batch, a selected take and a search that finds nothing", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const name = "Harbour at dusk from the far breakwater with gulls crossing the lamp line while the ferry turns ".repeat(2).trim();
  const store: Library = {
    uploads: [],
    generations: [
      row(0, { id: "gen_long1", title: name, shotId: "shot_long", shotCode: "SH030", shotTitle: `${name} (shot)`, params: { batchId: "b_longone" } }),
      row(1, { id: "gen_long2", title: `${name} (take two)`, shotId: "shot_long", shotCode: "SH030", shotTitle: `${name} (shot)`, params: { batchId: "b_longone" } }),
    ],
  };
  const { errors } = await open(page, store);
  const takes = grid(page);
  await expect(takes.getByTestId("take-tile")).toHaveCount(2);
  await tile(takes, name).getByTestId("edit-take").click();
  const selected = page.getByTestId("takes-selected");
  await expect(selected).toContainText(`Selected · ${name}`);
  /* One line each, cut short inside their card: the selected name, the shot. */
  const inside = async (el: Locator, card: Locator, what: string) => {
    const [box, cardBox] = [(await el.boundingBox())!, (await card.boundingBox())!];
    expect(box.x + box.width, `${what} inside its card`).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
    const line = await el.evaluate((node) => ({ h: node.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(node).lineHeight) || 18 }));
    expect(line.h, `${what} on one line`).toBeLessThan(line.lh * 1.6);
  };
  await inside(selected.locator(".pd-selected-name"), selected, "the selected name");
  await inside(takes.getByTestId("takes-shot").locator(".pd-desk-head-name"), page.getByTestId("edit-takes"), "the shot");
  /* CI and phone fonts can be wider than the local UI font: keep the same fit assertions under that constraint. */
  await page.addStyleTag({ content: '[data-testid="edit-stage"], [data-testid="edit-stage"] * { font-family: Verdana, "DejaVu Sans", sans-serif !important; }' });
  await inside(selected.locator(".pd-selected-name"), selected, "the selected name in a wider font");
  await inside(takes.getByTestId("takes-shot").locator(".pd-desk-head-name"), page.getByTestId("edit-takes"), "the shot in a wider font");
  await page.getByTestId("takes-search").fill("unbrokensearchwordwithoutanyspaces".repeat(4));
  await expect(page.getByTestId("takes-empty")).toContainText("Nothing matches");
  const empty = (await page.getByTestId("takes-empty").boundingBox())!;
  expect(empty.x + empty.width, "the empty note inside the screen").toBeLessThanOrEqual(page.viewportSize()!.width);
  if (PHONES.includes(info.project.name)) expect(await dimLabels(page, '[data-testid="edit-stage"]'), "labels dimmer than #7C7C84").toEqual([]);
  await shot(page, info, "desk-long", selected);
  await noSideScroll(page);
  expect(errors).toEqual([]);
});

/* ── Idea 26: one selected take for the desk, the Inspector and the address bar; links to a take ── */

const assetParam = (page: Page) => new URL(page.url()).searchParams.get("asset");
const selParam = (page: Page) => new URL(page.url()).searchParams.get("sel");

test("a tile, Previous and Next move the one selected take: the desk, the Inspector and the address bar agree, Back leaves the take, and a phone's Inspector opens only when asked", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const wide = WIDE.includes(info.project.name);
  const { errors } = await open(page);
  const takes = grid(page), selected = page.getByTestId("takes-selected");
  const before = await page.evaluate(() => history.length);
  await tile(takes, "Lantern walk").getByTestId("edit-take").click();
  await expect(selected).toContainText("Selected · Lantern walk");
  await expect.poll(() => assetParam(page)).toBe("generation:gen_b1");
  expect(selParam(page)).toBe("take:generation:gen_b1");
  /* Opening a take is a place Back returns from. */
  expect(await page.evaluate(() => history.length)).toBe(before + 1);
  if (wide) await expect(page.getByTestId("inspector-title")).toHaveText("Lantern walk");
  else await expect(page.getByTestId("inspector")).toHaveCount(0);

  /* Next and Previous rewrite that entry; the Inspector follows. */
  await page.getByTestId("takes-next").click();
  await expect(selected).toContainText("Selected · Lantern walk, closer");
  await expect.poll(() => assetParam(page)).toBe("generation:gen_b2");
  if (wide) await expect(page.getByTestId("inspector-title")).toHaveText("Lantern walk, closer");
  else await expect(page.getByTestId("inspector")).toHaveCount(0);
  await page.getByTestId("takes-prev").click();
  await expect(selected).toContainText("Selected · Lantern walk");
  expect(await page.evaluate(() => history.length)).toBe(before + 1);

  /* On a phone the Inspector opens when asked, on the same take. */
  if (!wide) {
    await page.getByTestId("toggle-inspector").click();
    await expect(page.getByTestId("inspector-title")).toHaveText("Lantern walk");
    await page.getByTestId("close-inspector").click();
    await expect(page.getByTestId("inspector")).toHaveCount(0);
  }

  /* Back: the grid, and no take in the address bar; Forward: the take again. */
  await page.goBack();
  await expect(selected).toHaveCount(0);
  await expect.poll(() => assetParam(page)).toBeNull();
  expect(selParam(page)).toBeNull();
  await expect(tile(takes, "Lantern walk").getByTestId("edit-take")).toHaveAttribute("aria-checked", "false");
  await page.goForward();
  await expect(selected).toContainText("Selected · Lantern walk");
  await expect.poll(() => assetParam(page)).toBe("generation:gen_b1");

  /* Back to the takes clears it: its own history entry. */
  await page.getByTestId("takes-back").click();
  await expect(selected).toHaveCount(0);
  await expect.poll(() => assetParam(page)).toBeNull();
  if (wide) await expect(page.getByTestId("inspector-title")).toHaveCount(0);
  await noSideScroll(page);
  expect(errors).toEqual([]);
});

test("a Library tile opens its take in the desk too; Back to the takes leaves a take chosen since alone", async ({ page }, info) => {
  test.skip(!WIDE.includes(info.project.name), "desktops: the Library is a column beside the desk");
  const { errors } = await open(page);
  const library = page.getByTestId("library");
  await library.getByRole("tab", { name: /Assets/ }).click();
  await library.locator(".gx-asset-thumb[data-ctx='asset:generation:gen_gull']").click();
  await expect(page.getByTestId("takes-selected")).toContainText("Selected · Gull over the breakwater");
  await expect(page.getByTestId("inspector-title")).toHaveText("Gull over the breakwater");
  await expect(tile(grid(page), "Gull over the breakwater").getByTestId("edit-take")).toHaveAttribute("aria-checked", "true");
  /* The Library chooses another take in the same moment Back to the takes is pressed on this one: the newer choice stands. */
  await page.evaluate(() => {
    document.querySelector<HTMLElement>("[data-testid='library'] .gx-asset-thumb[data-ctx='asset:generation:gen_still']")!.click();
    document.querySelector<HTMLElement>("[data-testid='takes-back']")!.click();
  });
  await expect(page.getByTestId("takes-selected")).toContainText("Selected · Ferry at the quay");
  await expect.poll(() => assetParam(page)).toBe("generation:gen_still");
  expect(errors).toEqual([]);
});

test("a link to an older take opens that take — not the newest, and not before it is found — asking for it by id instead of paging back", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const store: Library = { uploads: [], generations: Array.from({ length: 300 }, (_, i) => row(i, { id: `gen_${i}`, title: `Take ${String(i + 1).padStart(3, "0")}` })) };
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  const library = await mockDeskLibrary(page, store, { pageSize: 60 });
  library.holdLookups();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/suites?page=takes&sp=takes&asset=generation%3Agen_250");
  await expect(page.getByTestId("project-name")).toHaveText("Harbour review");
  /* While it is being found: said, and no other take stands in for it — not in the desk, not in the Inspector. */
  await expect(page.getByTestId("edit-finding")).toContainText("Finding the take…");
  await expect(page.getByTestId("takes-selected")).toHaveCount(0);
  await expect(grid(page).locator('[data-testid="edit-take"][aria-checked="true"]')).toHaveCount(0);
  if (WIDE.includes(info.project.name)) await expect(page.getByTestId("asset-inspector")).toHaveCount(0);
  expect(assetParam(page)).toBe("generation:gen_250");
  library.state.releaseLookup();
  await expect(page.getByTestId("takes-selected")).toContainText("Selected · Take 251");
  if (WIDE.includes(info.project.name)) await expect(page.getByTestId("inspector-title")).toHaveText("Take 251");
  /* Asked for by id (the desk and the Inspector share one search), no paging back through four pages. */
  expect([...new Set(library.state.lookups)]).toEqual(["generations:gen_250"]);
  expect(library.state.pages).toBe(0);
  expect(assetParam(page)).toBe("generation:gen_250");
  if (PHONES.includes(info.project.name)) expect(await smallTargets(page, '[data-testid="takes-selected"]'), "the opened take's tools under 44×44").toEqual([]);
  await noSideScroll(page);
  expect(errors).toEqual([]);
});

test("a link to a take the project does not hold says so and selects nothing in its place", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, state } = await open(page, desk(), { url: "/suites?project=ws-desk&page=takes&sp=takes&asset=generation%3Agen_someone_elses" });
  await expect(page.getByTestId("edit-finding")).toContainText("That take is not in this project");
  expect([...new Set(state.lookups)]).toEqual(["generations:gen_someone_elses"]);
  await expect(page.getByTestId("takes-selected")).toHaveCount(0);
  if (WIDE.includes(info.project.name)) await expect(page.getByTestId("asset-inspector-missing")).toContainText("This asset is not in this project.");
  if (PHONES.includes(info.project.name)) expect(await smallTargets(page, '[data-testid="edit-finding"]'), "Show every take under 44×44").toEqual([]);
  await page.getByTestId("takes-show-all").click();
  await expect(page.getByTestId("edit-finding")).toHaveCount(0);
  await expect.poll(() => assetParam(page)).toBeNull();
  await expect(grid(page).getByTestId("take-tile")).toHaveCount(10);
  await noSideScroll(page);
  expect(errors).toEqual([]);
});

test("a malformed take in the address bar is never looked up and opens nothing", async ({ page }, info) => {
  test.skip(!WIDE.includes(info.project.name) && info.project.name !== "workbench-390x844", "one desktop and one phone");
  const { errors, state } = await open(page, desk(), { url: "/suites?project=ws-desk&page=takes&sp=takes&asset=generation%3A..%2Fgen_b1" });
  await expect(grid(page).getByTestId("take-tile")).toHaveCount(10);
  await expect(page.getByTestId("takes-selected")).toHaveCount(0);
  await expect(page.getByTestId("edit-finding")).toHaveCount(0);
  /* It does not stay in the address bar either. */
  await expect.poll(() => new URL(page.url()).searchParams.has("asset")).toBe(false);
  expect(state.lookups).toEqual([]);
  expect(errors).toEqual([]);
});
