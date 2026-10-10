import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { smallTargets } from "./phoneFloors";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, upload } from "./helpers/workspaceFixtures";
import { openAdvanced } from "./helpers/makeAdvanced";
import { isCompact } from "./helpers/shellMode";

/* Release 1: the phone app draws its own simple Make (type, words, engine line with Change, References, Make at its price: demo-s10-phone-make-workbench), not this panel's composer; the desktop keeps every assertion here */
test.beforeEach(async ({}, info) => { test.skip(isCompact(info), "the phone app draws its own simple Make (type, words, engine line with Change, References, Make at its price: demo-s10-phone-make-workbench), not this panel's composer; the desktop keeps every assertion here"); });

/**
 * D0 review items 6-8: every paid control in Make wears the server's price, the engine sheet quotes at the size and
 * length the composer holds, and Recent says which engine made a take, what it cost, and what Again would cost.
 * Every figure below is compared with the server's own read (GET /api/workbench/engines), never a number typed here.
 * Nothing submits: paid routes fail the test.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];

const fixture = (): Project => ({ ...newProject("Harbour price study"), id: "ws-price", productionProjectId: "prod-ws", shotMappings: {} });

async function open(page: Page, url: string, library: { uploads?: ReturnType<typeof upload>[]; generations?: ReturnType<typeof generation>[] } = {}) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, { uploads: library.uploads ?? [], generations: library.generations ?? [] });
  await page.route("**/api/prompt/enhance", (route) => route.fulfill({ json: { model: "m", effort: "auto", estimateCredits: 1 } }));
  /* The audio price is the route's quoteOnly read: allowed through, and nothing else. */
  await page.route(/\/api\/audio$/, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    if ((route.request().postDataJSON() as { quoteOnly?: boolean }).quoteOnly !== true) throw new Error("Workspace tests must not submit paid work without a mock.");
    return route.continue();
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  return errors;
}

type Rate = { credits: number; resolution: string; ratio: string; duration: number | null };
const engines = async (page: Page, query = "") => (await page.request.get(`/api/workbench/engines${query}`).then((r) => r.json())) as { models: { id: string; label?: string; rate: Rate | null }[] };
/** The server's quote for one take, as the composer asks for it. */
async function quote(page: Page, model: string, resolution: string, ratio: string, duration: number): Promise<number> {
  const q = new URLSearchParams({ model, resolution, ratio, duration: String(duration) });
  return (await page.request.get(`/api/workbench/engines?${q}`).then((r) => r.json()) as { credits: number }).credits;
}
const credits = (text: string | null) => Number((text ?? "").replace(/[^\d.]/g, ""));
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

test("Make wears its price before a word is typed: on the button and the engine line, for video and for images", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const errors = await open(page, "/suites?make=video");
  const button = page.getByTestId("gen-generate");
  const line = page.getByTestId("make-engine-price");
  await expect(button).toBeDisabled();
  await expect(button).toHaveText(/^Make · \d+(\.\d)? cr$/, { timeout: 30_000 });
  await expect(line).toHaveText(/^\d+(\.\d)? cr$/);
  expect(credits(await button.textContent())).toBe(credits(await line.textContent()));
  /* The figure is the server's: the engines list's own rate for the engine the line names, at the settings the composer holds. */
  const name = (await page.getByTestId("make-engine-line").locator(".gx-mk-part").first().textContent())!;
  const listed = (await engines(page)).models.find((m) => m.label === name || name.startsWith(String(m.label)));
  expect(listed, `the engine line names "${name}", which the engines list offers`).toBeTruthy();
  /* The line's figure is the server's own quote for that engine at the size and length the line itself names ("Seedance 2.5 · 1080p · 5 s"). */
  const [, size, length] = (await page.getByTestId("make-engine-line").locator(".gx-mk-part").allTextContents()).map((t) => t.replace(/^ · /, ""));
  expect(await quote(page, listed!.id, size, fixture().aspect ?? "16:9", parseInt(length, 10))).toBe(credits(await line.textContent()));
  await expect(button).toHaveAccessibleName(/^Make · \d+(\.\d)? cr$/);
  /* While it waits for words its hover says why (the reason, said again under it once pressed); the dollars come on hover once it can run, below. */
  await expect(button).toHaveAttribute("title", "Say what to make.");
  /* The button waits with aria-disabled (it stays pressable, to say why), so Playwright's actionability check is skipped. */
  await button.click({ force: true });
  await expect(page.getByTestId("gen-blocked")).toHaveText("Say what to make.");

  await page.getByTestId("make-type-image").click();
  await expect(button).toHaveText(/^Make · \d+(\.\d)? cr$/, { timeout: 30_000 });
  await expect(line).toHaveText(/^\d+(\.\d)? cr$/);
  expect(credits(await button.textContent())).toBe(credits(await line.textContent()));
  /* Typing words changes nothing about the price of a still: it is priced by its settings. */
  const before = await button.textContent();
  await page.getByTestId("gen-prompt").fill("A fox crossing a frozen harbour at dawn");
  await expect(button).toBeEnabled({ timeout: 30_000 });
  expect(await button.textContent()).toBe(before);
  /* Dollars on hover, at the server's credit rate (the button's title is the reason while it waits, the dollars once it can run). */
  await expect(button).toHaveAttribute("title", /^\$\d+\.\d\d$/);
  expect(await noOverflow(page)).toBe(true);
  expect(errors).toEqual([]);
});

test("a sound is priced by its words: no figure until there are some, then the same figure on the button and the engine line; speech and effects alike", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  const errors = await open(page, "/suites?make=audio");
  const button = page.getByTestId("gen-generate");
  const line = page.getByTestId("make-engine-price");
  /* A sound's price is a live estimate, "up to N cr" (lib/shell/make-price.ts), the same on the button and on the engine line. */
  const figure = /^(up to )?\d+(\.\d)? cr$/;
  /* Since Make became a panel (use-composer.ts: "Sound is priced by its words"), no sound is priced before there are words: Make then waits, unpriced, with its reason. */
  await expect(page.getByTestId("make-engine-line")).toContainText(/\S/, { timeout: 30_000 });
  await expect(button).toHaveText("Make");
  await expect(button).toHaveAttribute("data-spend", "unpriced");
  await expect(line).toHaveCount(0);
  await openAdvanced(page);
  for (const kind of ["speech", "sound"]) {
    await page.getByTestId(`make-sound-${kind}`).click();
    await page.getByTestId("gen-prompt").fill("");
    await expect(button).toHaveText("Make");
    await expect(button).toHaveAttribute("data-spend", "unpriced");
    await page.getByTestId("gen-prompt").fill("Welcome to the harbour.");
    await expect(button).toHaveText(/^Make · (up to )?\d+(\.\d)? cr$/, { timeout: 30_000 });
    await expect(button).toHaveAttribute("data-spend", "priced");
    await expect(line).toHaveText(figure);
    expect(credits(await button.textContent())).toBe(credits(await line.textContent()));
  }
  expect(errors).toEqual([]);
});

test("the engine list quotes every row at the size and length the composer holds, and says so", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const errors = await open(page, "/suites?make=video");
  const line = page.getByTestId("make-engine-price");
  await expect(line).toHaveText(/cr$/, { timeout: 30_000 });
  /* The list is under Change (the engine line's button), Advanced under it; both are closed whenever Make opens. */
  await openAdvanced(page);
  await page.getByRole("group", { name: "Resolution" }).getByRole("button", { name: /1080p/ }).click();
  await page.getByTestId("gen-length").selectOption("5");
  await expect(page.getByTestId("gen-generate")).toHaveText(/^Make · \d+(\.\d)? cr$/, { timeout: 30_000 });
  await expect(page.getByTestId("make-engine-line")).toContainText("1080p · 5 s");
  const held = credits(await line.textContent());
  const list = page.getByTestId("make-engines");
  await expect(list).toBeVisible();
  await expect(list).not.toHaveAttribute("aria-busy", "true", { timeout: 30_000 });
  /* Every priced row's figure names its settings ("52 cr · 1080p · 6 s"): the size and length the engine renders with here, never a bare figure. */
  const rows = list.getByTestId("make-engine-row");
  expect(await rows.count()).toBeGreaterThan(0);
  for (const row of await rows.all()) {
    const cell = row.getByTestId("make-engine-row-price");
    await expect(cell).toHaveText(/^(\d+(\.\d)? cr · \d+(p|K)( · \d+ s)?|about \d+(\.\d)? cr, at most \d+(\.\d)? cr)$/);
    /* Cinema Studio's row (if the workspace offers it) keeps its own words: what approving it holds is exactly three times what it is about. */
    const about = (await cell.textContent())!.match(/^about (\d+(?:\.\d)?) cr, at most (\d+(?:\.\d)?) cr$/);
    if (about) expect(Number(about[2])).toBeCloseTo(3 * Number(about[1]), 5);
  }
  /* The ticked row is the engine line's figure at 1080p, and is the server's own quote at those settings. */
  const selected = list.locator('[data-testid="make-engine-row"][aria-pressed="true"]');
  await expect(selected).toHaveCount(1);
  const price = selected.getByTestId("make-engine-row-price");
  await expect(price).toHaveText(/^\d+(\.\d)? cr · 1080p · 5 s$/);
  expect(credits(await price.locator(".gx-price").textContent())).toBe(held);
  const id = (await selected.getAttribute("data-engine"))!;
  expect(await quote(page, id, "1080p", fixture().aspect ?? "16:9", 5)).toBe(held);
  /* The dollars are on the figure's hover. */
  await expect(price.locator(".gx-price")).toHaveAttribute("title", /^\$\d+\.\d\d$/);
  if (PHONES.includes(info.project.name)) expect(await smallTargets(page, ".gx-make"), "Make targets under 44x44").toEqual([]);
  expect(await noOverflow(page)).toBe(true);
  expect(errors).toEqual([]);
});

/* Recent: a take on no shot (a video), a take on a shot (a still), and an upload. */
const video = () => generation({ id: "gen_clip", kind: "video", model: "dreamina-seedance-2-0-260128", title: "Harbour dusk", prompt: "Harbour at dusk", creditsBilled: 43,
  params: { ratio: "16:9", resolution: "480p", duration: 5 }, durationS: 5 });
const still = () => generation({ id: "gen_still", kind: "image", model: "gemini-3.1-flash-image", title: "Pier still", prompt: "A pier at dusk", creditsBilled: 1, shotId: "shot_1",
  params: { ratio: "16:9", resolution: "1K" } });
const file = () => upload({ id: "up_plate", filename: "plate.webp" });

test("Recent: All, Takes, Unfiled and Filed; every card names its engine in full with its price, and offers Again and Use as reference", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const errors = await open(page, "/suites?make=recent", { generations: [video(), still()], uploads: [file()] });
  const chips = page.getByRole("group", { name: "Show" });
  await expect(chips.getByRole("button")).toHaveText(["All", "Takes", "Unfiled", "Filed"]);
  const cards = page.getByTestId("make-panel").getByTestId("take-tile");
  await expect(cards).toHaveCount(3, { timeout: 30_000 });
  /* Full engine names with the figure each settled at, never the Rig column's "NB 2". */
  const meta = page.getByTestId("make-panel").locator(".gx-asset-meta");
  await expect(meta.filter({ hasText: "Nano Banana 2" })).toHaveText(/^Nano Banana 2 · 1K · 1 cr$/);
  await expect(meta.filter({ hasText: "Seedance 2.0" })).toHaveText(/^Seedance 2\.0 · 5 s · 43 cr$/);
  await expect(page.locator("body")).not.toContainText(/\bNB 2\b/);
  /* Again carries the live price of running it again: the server's quote at the take's own settings. */
  const again = page.getByTestId("make-again");
  await expect(again).toHaveCount(2);
  const videoAgain = await quote(page, "dreamina-seedance-2-0-260128", "480p", "16:9", 5);
  const stillAgain = await quote(page, "gemini-3.1-flash-image", "1K", "16:9", 5);
  await expect(again.filter({ hasText: /\d+ cr/ })).toHaveCount(2, { timeout: 30_000 });
  const figures = (await again.allTextContents()).map(credits).sort((a, b) => a - b);
  expect(figures).toEqual([videoAgain, stillAgain].sort((a, b) => a - b));
  for (const button of await again.all()) await expect(button).toHaveText(/^Again · \d+(\.\d)? cr$/);
  /* Use as reference on every card that is a picture or a clip, uploads included. */
  await expect(page.getByTestId("make-use-reference")).toHaveCount(3);

  await chips.getByRole("button", { name: "Takes", exact: true }).click();
  await expect(cards).toHaveCount(2);
  await chips.getByRole("button", { name: "Unfiled", exact: true }).click();
  await expect(cards).toHaveCount(1);
  await expect(page.getByTestId("make-panel").locator(".gx-asset-meta")).toContainText("Seedance 2.0");
  await chips.getByRole("button", { name: "Filed", exact: true }).click();
  await expect(cards).toHaveCount(1);
  await expect(page.getByTestId("make-panel").locator(".gx-asset-meta")).toContainText("Nano Banana 2");
  await chips.getByRole("button", { name: "All", exact: true }).click();
  await expect(cards).toHaveCount(3);
  if (PHONES.includes(info.project.name)) expect(await smallTargets(page, ".gx-make"), "Make targets under 44x44").toEqual([]);
  expect(await noOverflow(page)).toBe(true);
  expect(errors).toEqual([]);
});

test("Again puts the take's recipe in Make, whose button then shows the same figure; Use as reference adds it to the well", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  const errors = await open(page, "/suites?make=recent", { generations: [video(), still()] });
  /* A reference is read again in this workspace before it joins the well. */
  await page.route(/\/api\/jobs\/gen_still(\?.*)?$/, (route) => route.fulfill({ json: { generation: still() } }));
  const card = page.getByTestId("make-recent-card").filter({ hasText: "Pier still" });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByTestId("make-use-reference").click();
  await expect(page.getByTestId("make-tab-make")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("gen-well")).toContainText("Pier still");
  await page.getByTestId("make-tab-recent").click();
  const clip = page.getByTestId("make-recent-card").filter({ hasText: "Harbour dusk" });
  const again = clip.getByTestId("make-again");
  await expect(again).toHaveText(/^Again · \d+(\.\d)? cr$/, { timeout: 30_000 });
  const figure = credits(await again.textContent());
  await again.click();
  await expect(page.getByTestId("make-tab-make")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("gen-recipe")).toBeVisible();
  await expect(page.getByTestId("gen-generate")).toHaveText(new RegExp(`^Make · ${figure} cr$`), { timeout: 30_000 });
  expect(errors).toEqual([]);
});
