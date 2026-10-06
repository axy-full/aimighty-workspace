import { test, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject } from "../lib/workbench/studio";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";

/**
 * Make approves Cinema Studio's hold (owner's decision, 5 October 2026): the
 * engine row and the button say "about N cr, at most 3N cr", whole and on
 * screen at every size (Make's panel on a desktop, the phone's Make screen on a
 * phone), and a press sends the hold, 3N, as each take's approval
 * (`maxCredits`), the figure admission reserves. Every paid route here is a
 * mock that records what it was sent; nothing is billed.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const SHOTS = ["workbench-390x844", "workbench-1440x900"];
const CINEMA = "higgsfield-cinema-studio-4.0";
const N = 31;
const DRAFT = "ws-hold";
const WORDS = "a lighthouse keeper climbs the spiral stairs";

/** Make's Advanced: folded under Change (the engine list); opened here, and again after a pick closes the list. */
async function openAdvanced(page: Page) {
  const list = page.getByTestId("make-engines");
  if (!(await list.isVisible())) {
    const change = page.getByTestId("gen-model");
    await change.scrollIntoViewIfNeeded();
    await change.click();
  }
  await expect(list).toBeVisible();
  const toggle = page.getByTestId("make-advanced-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(page.getByTestId("make-advanced")).toBeVisible();
}

/** More takes, from Make's Advanced, once the button is priced. */
async function moreTakes(page: Page, presses: number) {
  await expect(page.getByTestId("gen-generate")).toHaveText(/\d cr/, { timeout: 60_000 });
  await openAdvanced(page);
  const more = page.getByTestId("gen-takes").getByRole("button", { name: "More", exact: true });
  for (let i = 0; i < presses; i++) await more.click();
}

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

const HELD = /^about \d[\d,.]* cr, at most \d[\d,.]* cr$/;
/** A held figure's two numbers: the ceiling is three times the estimate. */
function heldPair(words: string) {
  const [, about, most] = words.trim().match(/^about (\d[\d,.]*) cr, at most (\d[\d,.]*) cr$/) ?? [];
  return { about: Number(about?.replace(/,/g, "")), most: Number(most?.replace(/,/g, "")) };
}

async function open(page: Page, info: TestInfo, admit: (take: number) => "running" | "held" = () => "running") {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: { ...newProject("Lighthouse hold"), id: DRAFT, productionProjectId: "prod-hold", shotMappings: {} } });
  await mockLibrary(page, { uploads: [], generations: [] });
  await page.route("**/api/prompt/enhance", (route) => route.fulfill({ json: { model: "m", effort: "auto", estimateCredits: 1 } }));
  /* The composer's price read (free): Cinema Studio's figure is approximate. */
  await page.route(/\/api\/workbench\/engines\?.*model=/, (route) =>
    route.fulfill({ json: new URL(route.request().url()).searchParams.get("model") === CINEMA ? { credits: N, approximate: true } : { credits: 12 } }));
  /* The server's quote for the exact body: the estimate, and the hold a person approves. */
  const quotes: Record<string, unknown>[] = [];
  await page.route("**/api/generate/quote", (route) => {
    quotes.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ json: { estimatedCredits: N, price: N, unit: "cr", approximate: true, ceilingCredits: 3 * N, fingerprint: "a".repeat(64) } });
  });
  const sent: Record<string, unknown>[] = [];
  await page.route(/\/api\/generate$/, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    sent.push(body);
    const id = `gen_hold_${sent.length}`;
    return admit(sent.length) === "held"
      ? route.fulfill({ status: 202, json: { id, status: "held", held: true, needs: 3 * N, notices: [`Held: this needs ${3 * N} credits and 40 are left. Top up to release it — nothing is lost.`] }, headers: { "Idempotency-Status": "complete" } })
      : route.fulfill({ status: 202, json: { id, status: "queued" }, headers: { "Idempotency-Status": "complete" } });
  });
  await page.route(/\/api\/jobs\/gen_hold_\d+(\?.*)?$/, (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop()!;
    const held = admit(Number(id.split("_").pop())) === "held";
    return route.fulfill({ json: { generation: generation({ id, kind: "video", model: CINEMA, status: held ? "held" : "running", prompt: WORDS,
      params: held ? { held: { why: "credits", needs: 3 * N } } : {} }) } });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  if (PHONES.includes(info.project.name)) {
    /* The phone's Make: Change opens the engines, each priced; Cinema Studio's row says what approving it holds. */
    await page.goto("/suites?screen=make");
    await expect(page.getByTestId("phone-make-prompt")).toBeVisible({ timeout: 60_000 });
    await page.getByTestId("phone-make-change").click();
    const row = page.getByTestId("phone-make-engine-row").filter({ hasText: "Cinema Studio 4.0" });
    await expect(row.getByTestId("phone-make-engine-row-price")).toHaveText(HELD, { timeout: 60_000 });
    const pair = heldPair((await row.getByTestId("phone-make-engine-row-price").textContent())!);
    expect(pair.most).toBeCloseTo(3 * pair.about, 1);
    await shot(page, info, "make-engines-hold");
    await row.click();
    await expect(page.getByTestId("phone-make-engines")).toHaveCount(0);
    await expect(page.getByTestId("phone-make-engine-line")).toContainText("Cinema Studio 4.0");
    await page.getByTestId("phone-make-prompt").fill(WORDS);
    return { quotes, sent, errors, go: page.getByTestId("phone-make-go") };
  }
  await page.goto("/suites?make=video");
  await expect(page.getByTestId("gen-view")).toBeVisible({ timeout: 60_000 });
  /* Make names the project its take lands in. */
  await expect(page.getByTestId("make-dest")).toContainText("To Lighthouse hold · Library");
  /* Cinema Studio, from Make's engine list: its row says what approving it holds. */
  const change = page.getByTestId("gen-model");
  await change.scrollIntoViewIfNeeded();
  await change.click();
  const row = page.locator(`[data-testid="make-engine-row"][data-engine="${CINEMA}"]`);
  await expect(row.getByTestId("make-engine-row-price")).toHaveText(HELD, { timeout: 60_000 });
  const pair = heldPair((await row.getByTestId("make-engine-row-price").textContent())!);
  expect(pair.most).toBeCloseTo(3 * pair.about, 1);
  await expect(row).not.toContainText(/quoted/);
  await shot(page, info, "make-engines-hold");
  await row.click();
  await expect(page.getByTestId("make-engine-line")).toContainText("Cinema Studio 4.0");
  await page.getByTestId("gen-prompt").fill(WORDS);
  return { quotes, sent, errors, go: page.getByTestId("gen-generate") };
}

/** The button's price on screen, whole, never cut, and legible. */
async function priceFits(page: Page, go: Locator) {
  await go.scrollIntoViewIfNeeded();
  const fit = await go.evaluate((el) => {
    const price = el.querySelector(".gx-price")!;
    const box = el.getBoundingClientRect(), p = price.getBoundingClientRect();
    const px = parseFloat(getComputedStyle(price).fontSize);
    return { inside: box.left >= 0 && box.right <= innerWidth + 1, uncut: el.scrollWidth <= el.clientWidth + 1 && p.left >= box.left - 1 && p.right <= box.right + 1,
      legible: px >= 12 };
  });
  expect(fit).toEqual({ inside: true, uncut: true, legible: true });
  expect(await noOverflow(page)).toBe(true);
}

async function shot(page: Page, info: TestInfo, name: string) {
  if (!SHOTS.includes(info.project.name)) return;
  await page.screenshot({ path: info.outputPath(`${name}-${info.project.name.replace("workbench-", "")}.png`), animations: "disabled" });
}

test("Make approves Cinema Studio's hold: about N cr, at most 3N cr on its row and its button, whole at every size, and the press sends 3N", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.setTimeout(180_000);
  const { quotes, sent, errors, go } = await open(page, info);
  await expect(go).toHaveText(`Make · about ${N} cr, at most ${3 * N} cr`, { timeout: 60_000 });
  await priceFits(page, go);
  await shot(page, info, "make-hold");
  await go.click();
  await expect.poll(() => sent.length).toBe(1);
  /* The approval sent is the hold the server quoted: what admission reserves, never the estimate. */
  expect(quotes[0]).toMatchObject({ model: CINEMA });
  expect(sent[0]).toMatchObject({ model: CINEMA, maxCredits: 3 * N, quoteFingerprint: "a".repeat(64) });
  expect(errors).toEqual([]);
});

test("a batch approves each take's hold: Make 3 takes says about 3N cr, at most 9N cr, and every take goes at 3N", async ({ page }, info) => {
  /* Takes are in Make's Advanced on a desktop; the phone's Make sends one take. */
  test.skip(!SIZES.includes(info.project.name) || PHONES.includes(info.project.name), "Make's panel, every desktop viewport");
  test.setTimeout(180_000);
  const { sent, errors, go } = await open(page, info);
  await moreTakes(page, 2);
  await expect(go).toHaveText(`Make 3 takes · about ${3 * N} cr, at most ${9 * N} cr`);
  await priceFits(page, go);
  await shot(page, info, "make-hold-batch");
  await go.click();
  await expect.poll(() => sent.length).toBe(3);
  for (const body of sent) expect(body).toMatchObject({ model: CINEMA, maxCredits: 3 * N });
  expect(errors).toEqual([]);
});

test("the Jobs tray: a held Cinema Studio take's Release says about N cr, at most 3N cr, whole, and a take past its hold says so in words", async ({ page }, info) => {
  /* The Jobs tray is the desktop's; a phone has its own States screen. */
  test.skip(!SIZES.includes(info.project.name) || PHONES.includes(info.project.name), "the desktop's Jobs tray, every desktop viewport");
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: { ...newProject("Lighthouse hold"), id: DRAFT, productionProjectId: "prod-hold", shotMappings: {} } });
  await mockLibrary(page, { uploads: [], generations: [] });
  const now = Date.now();
  const row = (fields: Record<string, unknown>) => ({ source: "engine", kind: "video", mediaUrl: null, reason: null, progress: null, createdAt: now - 60_000, settledAt: null,
    price: null, draftId: DRAFT, projectName: "Lighthouse hold", action: null, ...fields });
  /* What GET /api/jobs?view=tray answers for these two takes (lib/jobsTray.ts engineTrayJob). */
  const jobs = [
    row({ id: "gen_hold_held", name: "Keeper on the stairs", stage: "held", label: `Held · needs ${3 * N} cr`, tone: "amber", action: "release", releaseCredits: 3 * N, releaseBand: 3 }),
    row({ id: "gen_hold_over", name: "Lamp room at dusk", stage: "complete", label: "Complete", tone: "green", action: "open", takeId: "generation:gen_hold_over",
      reason: "The engine charged more than you approved; nothing above that was charged.", price: { amount: 3 * N, unit: "cr" }, settledAt: now - 30_000 }),
  ];
  await page.route(/\/api\/jobs\?view=tray/, (route) => route.fulfill({ json: { jobs, pollAfterSeconds: 60 } }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  /* The header's Jobs pill, on any desktop screen: Make's here. */
  await page.goto("/suites?make=video");
  await expect(page.getByTestId("gen-view")).toBeVisible({ timeout: 60_000 });
  const pill = page.getByTestId("running-jobs");
  await expect(pill).toHaveAccessibleName(/1 held/, { timeout: 30_000 });
  await pill.click();
  const panel = page.getByRole("dialog", { name: "Jobs" });
  await expect(panel).toBeVisible();
  const rows = panel.getByTestId("jobs-row");
  await expect(rows).toHaveCount(2);
  const release = rows.nth(0).getByTestId("jobs-action");
  await expect(release).toHaveText(`Release · about ${N} cr, at most ${3 * N} cr`);
  await expect(rows.nth(1).getByTestId("jobs-reason")).toHaveText("The engine charged more than you approved; nothing above that was charged.");
  /* The price is whole: inside the row and the screen, never cut, at least 12 px. */
  const fit = await release.evaluate((el) => {
    const box = el.getBoundingClientRect(), rowBox = el.closest("[data-testid=jobs-row]")!.getBoundingClientRect();
    return { uncut: el.scrollWidth <= el.clientWidth + 1, inside: box.left >= rowBox.left - 0.5 && box.right <= rowBox.right + 0.5 && box.right <= innerWidth + 1,
      legible: parseFloat(getComputedStyle(el).fontSize) >= 12 };
  });
  expect(fit).toEqual({ uncut: true, inside: true, legible: true });
  expect(await noOverflow(page)).toBe(true);
  await shot(page, info, "tray-hold");
  expect(errors).toEqual([]);
});
