import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { smallTargets } from "./phoneFloors";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, upload } from "./helpers/workspaceFixtures";
import { openAdvanced } from "./helpers/makeAdvanced";

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
  const name = (await page.locator(".gx-make-engine .gx-model-name").textContent())!;
  const listed = (await engines(page)).models.find((m) => m.label === name || name.startsWith(String(m.label)));
  if (listed?.rate) expect(credits(await line.textContent())).toBe(listed.rate.credits);
  /* Dollars on hover, at the server's credit rate. */
  await expect(button).toHaveAttribute("title", /^\$\d+\.\d\d$/);
  await expect(button).toHaveAccessibleName(/^Make · \d+(\.\d)? cr$/);

  await page.getByRole("tab", { name: "Images" }).click();
  await expect(page.getByTestId("gen-blocked")).toHaveText("Say what to make.");
  await expect(button).toHaveText(/^Make · \d+(\.\d)? cr$/, { timeout: 30_000 });
  await expect(line).toHaveText(/^\d+(\.\d)? cr$/);
  expect(credits(await button.textContent())).toBe(credits(await line.textContent()));
  /* Typing words changes nothing about the price of a still: it is priced by its settings. */
  const before = await button.textContent();
  await page.getByTestId("gen-prompt").fill("A fox crossing a frozen harbour at dawn");
  await expect(button).toBeEnabled({ timeout: 30_000 });
  expect(await button.textContent()).toBe(before);
  expect(await noOverflow(page)).toBe(true);
  expect(errors).toEqual([]);
});

test("a sound shows its price from the start; speech, which is priced by its words, shows one once there are words", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  const errors = await open(page, "/suites?make=audio");
  const button = page.getByTestId("gen-generate");
  await expect(button).toBeDisabled();
  await expect(button).toHaveText(/^Make · \d+(\.\d)? cr$/, { timeout: 30_000 });
  await expect(page.getByTestId("make-engine-price")).toHaveText(/^\d+(\.\d)? cr$/);
  expect(credits(await button.textContent())).toBe(credits(await page.getByTestId("make-engine-price").textContent()));
  expect(errors).toEqual([]);
});

test("the engine sheet quotes every row at the size and length the composer holds, and says so", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const errors = await open(page, "/suites?make=video");
  const line = page.getByTestId("make-engine-price");
  await expect(line).toHaveText(/cr$/, { timeout: 30_000 });
  await openAdvanced(page);
  await page.getByRole("group", { name: "Resolution" }).getByRole("button", { name: "1080p", exact: true }).click();
  await page.getByTestId("gen-length").selectOption("5");
  await expect(page.getByTestId("gen-generate")).toHaveText(/^Make · \d+(\.\d)? cr$/, { timeout: 30_000 });
  const engine = page.locator(".gx-make-engine .gx-model-name");
  await expect(engine).toBeVisible();
  const held = credits(await line.textContent());
  await page.getByTestId("gen-model").click();
  const sheet = page.getByRole("dialog", { name: "Choose a model" });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('[data-testid="gen-sheet-price"][data-kind="loading"]')).toHaveCount(0, { timeout: 30_000 });
  /* The basis is said once, and it is the composer's own size and length. */
  await expect(sheet.getByTestId("gen-sheet-basis")).toHaveText("Prices at 1080p · 5 s · one take");
  /* Every row's figure names its settings; a row's size chip reads "up to", never a bare size beside a different figure. */
  for (const row of await sheet.getByRole("option").all()) {
    await expect(row.locator('[data-spec="resolution"]')).toHaveText(/^up to \d+(p|K)$/);
  }
  /* The ticked row is the engine line's figure at 1080p, and is the server's own quote at those settings. */
  const selected = sheet.locator('[role="option"][aria-selected="true"]');
  const price = selected.getByTestId("gen-sheet-price");
  await expect(price.locator("span").first()).toHaveText(/^5 s · 1080p( · \S+)?$/);
  expect(credits(await price.locator("b").textContent())).toBe(held);
  const id = (await selected.getAttribute("data-model"))!;
  const detail = (await price.locator("span").first().textContent())!.split(" · ");
  const ratio = detail[2] ?? "16:9";
  expect(await quote(page, id, "1080p", ratio, 5)).toBe(held);
  /* The dollars are on the row's hover. */
  await expect(price).toHaveAttribute("title", /^\$\d+\.\d\d · /);
  if (PHONES.includes(info.project.name)) expect(await smallTargets(page, ".gx-sheet"), "sheet targets under 44x44").toEqual([]);
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
  const chips = page.getByTestId("make-recent-chips");
  await expect(chips.getByRole("button")).toHaveText(["All", "Takes", "Unfiled", "Filed"]);
  const cards = page.getByTestId("make-panel").getByTestId("take-tile");
  await expect(cards).toHaveCount(3, { timeout: 30_000 });
  /* Full engine names with the figure each settled at, never the Rig column's "NB 2". */
  const meta = page.getByTestId("make-take-meta");
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
  await expect(page.getByTestId("make-take-meta")).toContainText("Seedance 2.0");
  await chips.getByRole("button", { name: "Filed", exact: true }).click();
  await expect(cards).toHaveCount(1);
  await expect(page.getByTestId("make-take-meta")).toContainText("Nano Banana 2");
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
  const card = page.getByTestId("make-panel").getByTestId("take-tile").filter({ hasText: "Pier still" });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByTestId("make-use-reference").click();
  await expect(page.getByTestId("make-tab-make")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("gen-well")).toContainText("Pier still");
  await page.getByTestId("make-tab-recent").click();
  const clip = page.getByTestId("make-panel").getByTestId("take-tile").filter({ hasText: "Harbour dusk" });
  const again = clip.getByTestId("make-again");
  await expect(again).toHaveText(/^Again · \d+(\.\d)? cr$/, { timeout: 30_000 });
  const figure = credits(await again.textContent());
  await again.click();
  await expect(page.getByTestId("make-tab-make")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("gen-recipe")).toBeVisible();
  await expect(page.getByTestId("gen-generate")).toHaveText(new RegExp(`^Make · ${figure} cr$`), { timeout: 30_000 });
  expect(errors).toEqual([]);
});
