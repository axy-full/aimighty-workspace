import { test, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { createClient } from "@libsql/client";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { smallTargets } from "./phoneFloors";
import { forbidPaidWork, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";
import { moreTakes } from "./helpers/genTakes";
import { CINEMA_STUDIO_MODEL_ID } from "../lib/cinemaStudioTypes";
import { MAKE_SHOWS_CINEMA } from "../lib/shell/make-price";
import { openAdvanced } from "./helpers/makeAdvanced";
import { projectName } from "./helpers/projectName";
import { isCompact } from "./helpers/shellMode";

/* Release 1: the phone app draws its own simple Make (type, words, engine line with Change, References, Make at its price: demo-s10-phone-make-workbench), not this panel's composer; the desktop keeps every assertion here */
test.beforeEach(async ({}, info) => { test.skip(isCompact(info), "the phone app draws its own simple Make (type, words, engine line with Change, References, Make at its price: demo-s10-phone-make-workbench), not this panel's composer; the desktop keeps every assertion here"); });

/**
 * Make's Change list (the engine line's button): a price on every row before anything is spent. Studio engines are priced
 * by the engines route where the composer stands, its picks, the project's aspect, its references, one take, so the ticked
 * row is the figure Make shows. Cinema Studio 4.0 reads "about N cr, at most 3N cr". The connected catalogue went with the
 * sign-in (lib/higgsfield-consumer/retired.ts): nobody, the workspace owner included, sees a connected switch, and the
 * account is never read. (The old model sheet's search, Recent group and spec chips are gone: docs/old-shells.md.)
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const WIDE = ["workbench-1440x900", "workbench-1920x1080"];
/* The two sizes the review looks at; PICKER_SHOTS=all captures every size. */
const SHOTS = process.env.PICKER_SHOTS === "all" ? SIZES : ["workbench-390x844", "workbench-1440x900"];

/* Test fixtures only. */
const fixture = (): Project => ({ ...newProject("Harbour picker study"), id: "ws-picker", productionProjectId: "prod-ws", shotMappings: {} });
type Options = { member?: boolean; aspect?: string; engines?: (page: Page) => Promise<unknown> };

async function open(page: Page, options: Options = {}) {
  const { workspace } = await signInLocally(page.request);
  if (options.member) {
    /* The session's role is read per request: this account is now a member of its own workspace. */
    const db = createClient({ url: localPlatformDbUrl(), timeout: 2_000 });
    try { await db.execute({ sql: "UPDATE memberships SET role='member' WHERE workspace_id=?", args: [workspace.id] }); }
    finally { db.close(); }
  }
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: { ...fixture(), ...(options.aspect ? { aspect: options.aspect } : {}) } });
  await mockLibrary(page, { uploads: [], generations: [] });
  await page.route("**/api/prompt/enhance", (route) => route.fulfill({ json: { model: "m", effort: "auto", estimateCredits: 1 } }));
  const consumer: Record<string, unknown>[] = [];
  const quotes: Record<string, unknown>[] = [];
  await page.route("**/api/higgsfield/consumer/**", async (route) => {
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    /* The shell lists the open project's saved connected jobs (GET ?draftId=, lib/shell/connected-collector) whenever
       a project opens, on any page, so a render left mid-way still reaches Takes: not the composer reading the account. */
    const listing = route.request().method() === "GET" && new URL(route.request().url()).searchParams.has("draftId");
    if (listing) return route.fulfill({ json: { jobs: [] } });
    consumer.push({ url: route.request().url(), ...body });
    return route.fulfill({ status: 410, json: { code: "retired", error: "The connected account is no longer used. Past results stay in your Library." } });
  });
  await options.engines?.(page);
  /* The sheet's own reads of the engine list, priced where the composer stands (never a quote: no `model`). */
  const priced: URLSearchParams[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/workbench/engines" && url.search && !url.searchParams.has("model")) priced.push(url.searchParams);
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/suites?make=video");
  await expect(page.getByTestId("gen-view")).toBeVisible();
  await openAdvanced(page);
  await expect(projectName(page)).toHaveText("Harbour picker study");
  return { errors, quotes, consumer, priced };
}

/** Make's engine list, under Change (the engine line's button); `open()` leaves it open with Advanced under it. */
const sheetOf = (page: Page) => page.getByTestId("make-engines");
const rowsOf = (page: Page) => sheetOf(page).getByTestId("make-engine-row");
const rowPrice = (row: Locator) => row.getByTestId("make-engine-row-price");

/** Opens the list when it is closed (Done closes it, and the Advanced fold with it). */
async function openSheet(page: Page) {
  const change = page.getByTestId("gen-model");
  await change.scrollIntoViewIfNeeded();
  if ((await change.getAttribute("aria-expanded")) !== "true") await change.click();
  const sheet = sheetOf(page);
  await expect(sheet).toBeVisible();
  return sheet;
}

async function closeSheet(page: Page) {
  const change = page.getByTestId("gen-model");
  if ((await change.getAttribute("aria-expanded")) === "true") await change.click();
  await expect(sheetOf(page)).toHaveCount(0);
}

/** Every row has its figure (none still being read where the composer stands). */
async function priced(page: Page) {
  const sheet = sheetOf(page);
  await expect(rowsOf(page).first()).toBeVisible({ timeout: 30_000 });
  await expect(sheet).not.toHaveAttribute("aria-busy", "true", { timeout: 30_000 });
  return sheet;
}
const selectedRow = (page: Page) => sheetOf(page).locator('[data-testid="make-engine-row"][aria-pressed="true"]');
const figureOf = async (row: Locator) => Number(((await rowPrice(row).locator(".gx-price").textContent()) ?? "").replace(/[^\d.]/g, ""));
/** The server's own quote for one take (the engines route, as the composer asks for it). */
async function quote(page: Page, model: string, resolution: string, ratio: string, duration: number): Promise<number> {
  const q = new URLSearchParams({ model, resolution, ratio, duration: String(duration) });
  return (await page.request.get(`/api/workbench/engines?${q}`).then((r) => r.json()) as { credits: number }).credits;
}
/** The size and length a priced row names ("52 cr · 1080p · 6 s"). */
const settingsOf = async (row: Locator) => {
  const m = ((await rowPrice(row).textContent()) ?? "").match(/ · (\d+(?:p|K)|adaptive)(?: · (\d+) s)?$/);
  return { resolution: m?.[1] ?? "", duration: m?.[2] ? Number(m[2]) : 5 };
};
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

async function shot(page: Page, info: TestInfo, name: string) {
  if (!SHOTS.includes(info.project.name)) return;
  await page.screenshot({ path: info.outputPath(`${name}-${info.project.name.replace("workbench-", "")}.png`), animations: "disabled" });
}

const credits = (text: string | null) => Number((text ?? "").replace(/[^\d.]/g, ""));
const WORDS = "A fox crossing a frozen harbour at dawn";
const ASPECT = (project: Project) => project.aspect;

test("every Studio engine wears a price at its own size and length — Cinema Studio 4.0 reads about N, at most 3N; the picked row's price is the figure Make shows", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, consumer } = await open(page);
  const sheet = await priced(page);
  const rows = rowsOf(page);
  const count = await rows.count();
  expect(count).toBeGreaterThanOrEqual(5);
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    if (await row.getAttribute("data-engine") === CINEMA_STUDIO_MODEL_ID) continue;
    /* A 16:9 project and an untouched composer: the figure, then the size and length this engine renders with here. */
    await expect(rowPrice(row)).toHaveText(/^\d+ cr · \S+( · \d+ s)?$/);
    await expect(rowPrice(row).locator(".gx-price")).toHaveAttribute("title", /^\$\d+\.\d\d$/);
  }
  /* Cinema Studio 4.0 is in the list at what approving it holds, "about N cr, at most 3N cr", never "quoted", and no vendor's name. */
  const cinema = rows.filter({ has: page.locator(".gx-mk-row-name", { hasText: /^Cinema Studio 4\.0$/ }) });
  if (MAKE_SHOWS_CINEMA) {
    await expect(cinema).toHaveCount(1);
    await expect(rowPrice(cinema)).toHaveText(/^about \d+ cr, at most \d+ cr$/);
    await expect(rowPrice(cinema)).not.toContainText("quoted");
    await expect(cinema).not.toContainText(/Higgsfield/i);
    const [about, most] = ((await rowPrice(cinema).textContent())!.match(/\d+/g) ?? []).map(Number);
    expect(most).toBe(3 * about);
  } else {
    /* Not offered in Make until #523's hold is merged (lib/shell/make-price.ts › MAKE_SHOWS_CINEMA). */
    await expect(cinema).toHaveCount(0);
  }
  /* The default engine is the ticked row; its price is what the button asks for, and the server's own quote at the settings it names. */
  const selected = selectedRow(page);
  await expect(selected).toHaveCount(1);
  const figure = await figureOf(selected);
  await expect(rowPrice(selected)).toHaveText(/ · 5 s$/);
  const at = await settingsOf(selected);
  expect(await quote(page, (await selected.getAttribute("data-engine"))!, at.resolution, ASPECT(fixture()), at.duration)).toBe(figure);
  await shot(page, info, "studio-sheet");
  if (PHONES.includes(info.project.name)) expect(await smallTargets(page, ".gx-make"), "Make targets under 44x44").toEqual([]);
  expect(await noOverflow(page)).toBe(true);
  expect(await sheet.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await closeSheet(page);
  await page.getByTestId("gen-prompt").fill(WORDS);
  /* The live quote is a real route read; give a busy dev server room. */
  await expect(page.getByTestId("gen-generate")).toHaveText(`Make · ${figure} cr`, { timeout: 30_000 });
  /* A Studio pick never reads the connected account; an untouched composer needs no priced read either. */
  expect(consumer).toEqual([]);
  expect(errors).toEqual([]);
});

/* The review's cases: Seedance is billed on the frame, so the project's aspect moves its price. */
for (const aspect of ["21:9", "1:1"]) {
  test(`a ${aspect} project: every row is priced at that aspect where the engine offers it, and the ticked row is Make's figure`, async ({ page }, info) => {
    test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
    const { errors, priced: reads } = await open(page, { aspect });
    await priced(page);
    const selected = selectedRow(page);
    const figure = await figureOf(selected);
    /* The list's own read was asked at the project's aspect, and the ticked row is the server's quote at that aspect and the settings the row names. */
    expect(reads.some((q) => q.get("aspect") === aspect)).toBe(true);
    const at = await settingsOf(selected);
    expect(await quote(page, (await selected.getAttribute("data-engine"))!, at.resolution, aspect, at.duration)).toBe(figure);
    await shot(page, info, `aspect-${aspect.replace(":", "x")}`);
    /* An engine that does not offer the aspect is priced at its own default. Every row still carries a figure; Cinema Studio 4.0 its own words. */
    for (const row of await rowsOf(page).all())
      await expect(rowPrice(row)).toHaveText(await row.getAttribute("data-engine") === CINEMA_STUDIO_MODEL_ID ? /^about \d+ cr, at most \d+ cr$/ : /^\d+ cr · /);
    await closeSheet(page);
    await page.getByTestId("gen-prompt").fill(WORDS);
    await expect(page.getByTestId("gen-generate")).toHaveText(`Make · ${figure} cr`, { timeout: 30_000 });
    expect(errors).toEqual([]);
  });
}

test("the rows follow the composer: the aspect chip, a bigger size and a longer take, several takes; picking another row keeps Make equal to it", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  const { errors, priced: reads, consumer } = await open(page);
  await page.getByTestId("gen-prompt").fill(WORDS);
  await priced(page);
  const start = await figureOf(selectedRow(page));
  const engine = (await selectedRow(page).locator(".gx-mk-row-name").textContent())!;
  await expect(page.getByTestId("gen-generate")).toHaveText(`Make · ${start} cr`, { timeout: 30_000 });

  /* The aspect chip at 21:9: the list is read again at it, and Make settles on the ticked row's figure. */
  await page.getByRole("group", { name: "Aspect" }).getByRole("button", { name: /21:9/ }).click();
  await priced(page);
  const wide = await figureOf(selectedRow(page));
  expect(reads.some((q) => q.get("pickRatio") === "21:9")).toBe(true);
  await expect(page.getByTestId("gen-generate")).toHaveText(`Make · ${wide} cr`, { timeout: 30_000 });
  const at = await settingsOf(selectedRow(page));
  expect(await quote(page, (await selectedRow(page).getAttribute("data-engine"))!, at.resolution, "21:9", at.duration)).toBe(wide);

  /* A bigger size, a longer take and three takes: the row is one take at those settings, the button three. */
  await page.getByRole("group", { name: "Resolution" }).getByRole("button", { name: /1080p/ }).click();
  await page.getByTestId("gen-length").selectOption("10");
  await moreTakes(page, 2);
  await expect(page.getByTestId("gen-takes-count")).toHaveText("3");
  await priced(page);
  await expect(rowPrice(selectedRow(page))).toHaveText(/ · 1080p · 10 s$/);
  const take = await figureOf(selectedRow(page));
  expect(take).toBeGreaterThan(wide);
  expect(await quote(page, (await selectedRow(page).getAttribute("data-engine"))!, "1080p", "21:9", 10)).toBe(take);
  await shot(page, info, "touched");
  await expect(page.getByTestId("gen-generate")).toHaveText(`Make 3 takes · ${(take * 3).toLocaleString("en-US")} cr`, { timeout: 30_000 });
  /* The takes chip's own total is the same three takes. */
  await expect(page.getByTestId("gen-takes-3")).toContainText(`${(take * 3).toLocaleString("en-US")} cr`);

  /* Another engine: its row, times three, is what Make then asks for. */
  await openSheet(page);
  await priced(page);
  const other = rowsOf(page).filter({ hasNot: page.locator(".gx-mk-row-name", { hasText: new RegExp(`^${engine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) }).first();
  const otherFigure = await figureOf(other);
  await other.click();
  await expect(sheetOf(page)).toHaveCount(0);
  await expect(page.getByTestId("gen-generate")).toHaveText(`Make 3 takes · ${(otherFigure * 3).toLocaleString("en-US")} cr`, { timeout: 30_000 });
  expect(consumer).toEqual([]);
  expect(errors).toEqual([]);
});

for (const member of [false, true])
test(`${member ? "a member" : "the owner"} sees only this workspace's engines: no connected switch, and the account is never read`, async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  const { errors, consumer } = await open(page, { member });
  const sheet = await priced(page);
  await expect(sheet.getByRole("tablist", { name: "Catalogue" })).toHaveCount(0);
  await expect(sheet.getByRole("tab")).toHaveCount(0);
  /* One source, not offered as a switch. */
  await expect(sheet).not.toContainText(/Higgsfield|connected cr/);
  await expect(page.getByTestId("make-panel")).not.toContainText(/Higgsfield|connected cr/);
  await expect(rowPrice(rowsOf(page).first())).toHaveText(/^\d+ cr · /);
  await shot(page, info, member ? "member-sheet" : "owner-sheet");
  await closeSheet(page);
  expect(consumer).toEqual([]);
  expect(errors).toEqual([]);
});

test("the list shows it is reading, then the rows; a failed read says why instead of an empty list", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let failing = false;
  const { errors } = await open(page, {
    engines: (p) => p.route(/\/api\/workbench\/engines$/, async (route) => {
      if (failing) return route.fulfill({ status: 503, json: { error: "The engine list is unavailable right now." } });
      await gate;
      return route.fallback();
    }),
  });
  const sheet = await openSheet(page);
  await expect(sheet.getByRole("status")).toContainText("Reading the engines…");
  await expect(rowsOf(page)).toHaveCount(0);
  await shot(page, info, "loading");
  release();
  await expect(rowsOf(page).first()).toBeVisible({ timeout: 30_000 });
  await expect(sheet.getByRole("status").filter({ hasText: "Reading the engines…" })).toHaveCount(0);
  await closeSheet(page);

  failing = true;
  await page.reload();
  await expect(page.getByTestId("gen-view")).toBeVisible();
  await openAdvanced(page);
  await expect(sheetOf(page).getByRole("status")).toHaveText("The engine list is unavailable right now.");
  await expect(rowsOf(page)).toHaveCount(0);
  /* Make waits, unpriced, and says why. */
  await expect(page.getByTestId("gen-blocked")).toHaveText("The engine list is unavailable right now.");
  await expect(page.getByTestId("gen-generate")).toHaveAttribute("data-spend", "unpriced");
  await shot(page, info, "error");
  expect(await noOverflow(page)).toBe(true);
  /* Once the list answers again (a reload reads it afresh), the rows are there and the reason is gone. */
  failing = false;
  await page.reload();
  await expect(page.getByTestId("gen-view")).toBeVisible();
  await openAdvanced(page);
  await expect(rowsOf(page).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("gen-blocked").filter({ hasText: "The engine list is unavailable right now." })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("the Audio output: sound effects and music carry a price; Make asks for the same figure", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  const { errors } = await open(page);
  /* The composer's sound price is the audio admission's quoteOnly read: allowed through, and nothing else. */
  await page.route(/\/api\/audio$/, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as { quoteOnly?: boolean };
    if (body.quoteOnly !== true) throw new Error("Workspace tests must not submit paid work without a mock.");
    return route.continue();
  });
  await page.getByTestId("make-type-audio").click();
  await openSheet(page);
  await priced(page);
  const row = (name: RegExp) => rowsOf(page).filter({ has: page.locator(".gx-mk-row-name", { hasText: name }) }).first();
  for (const name of [/^Sound effects|^Eleven.*(SFX|Sound)/i, /Music/i]) {
    await expect(row(name)).toBeVisible();
    await expect(row(name).locator(".gx-mk-row-sub")).not.toHaveText("");
    /* The engines route's own audio read: a figure, with the length it is for ("10 s", or "any length"), never a made-up one. */
    await expect(rowPrice(row(name))).toHaveText(/^(up to )?\d+(\.\d)? cr · (\d+ s|any length)$/, { timeout: 30_000 });
  }
  await expect(rowPrice(row(/Music/i))).toHaveText(/ · 10 s$/);
  await shot(page, info, "audio");
  await page.getByTestId("gen-prompt").fill("A slow cello over rain on a tin roof");
  await row(/Music/i).click();
  await expect(page.getByTestId("gen-generate")).toHaveText(/^Make · (up to )?\d+(\.\d)? cr$/, { timeout: 30_000 });
  const asked = credits(await page.getByTestId("gen-generate").textContent());
  /* The line carries that same figure. */
  expect(credits(await page.getByTestId("make-engine-price").textContent())).toBe(asked);
  /* With words in, the Music row is priced, and it is the button's figure. */
  await openSheet(page);
  await priced(page);
  await expect(rowPrice(row(/Music/i))).toHaveText(/^(up to )?\d+(\.\d)? cr/);
  expect(credits(await rowPrice(row(/Music/i)).locator(".gx-price").textContent())).toBe(asked);
  expect(await noOverflow(page)).toBe(true);
  expect(errors).toEqual([]);
});

test("the engines route prices every Studio engine in credits only, and each figure is the route's own quote", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "a route check, once");
  await signInLocally(page.request);
  const response = await page.request.get("/api/workbench/engines");
  expect(response.ok()).toBe(true);
  const text = await response.text();
  /* Vendor dollars and the margin never reach the browser. */
  expect(text).not.toMatch(/usd|margin|"net"|cost/i);
  const { models } = JSON.parse(text) as { models: { id: string; marketing?: boolean; soulIdentity?: boolean; rate: { credits: number; resolution: string; ratio: string; duration: number | null } | null }[] };
  let priced = 0;
  for (const model of models) {
    if (model.marketing || model.soulIdentity) { expect(model.rate).toBeNull(); continue; }
    expect(model.rate, model.id).not.toBeNull();
    /* Cinema Studio's rate is approximate (published pricing, settled on the delivered take), and says so. */
    expect(Object.keys(model.rate!).sort()).toEqual(model.id === "higgsfield-cinema-studio-4.0"
      ? ["approximate", "credits", "duration", "ratio", "resolution"] : ["credits", "duration", "ratio", "resolution"]);
    const q = new URLSearchParams({ model: model.id, resolution: model.rate!.resolution, ratio: model.rate!.ratio, duration: String(model.rate!.duration ?? 5) });
    const quote = await page.request.get(`/api/workbench/engines?${q}`).then((r) => r.json()) as { credits: number };
    expect(quote.credits, model.id).toBe(model.rate!.credits);
    priced++;
  }
  expect(priced).toBeGreaterThanOrEqual(5);

  /* Priced where a composer stands: every engine at its own composerSettings of those picks, the same figure its quote gives. */
  const at = new URLSearchParams({ aspect: "21:9", pickResolution: "1080p", pickDuration: "10", seconds: "10" });
  const moved = await page.request.get(`/api/workbench/engines?${at}`).then((r) => r.json()) as { models: typeof models; audio: { sound: { credits: number; seconds: null }; music: { credits: number; seconds: number } } | null };
  let followed = 0;
  for (const model of moved.models) {
    if (!model.rate) continue;
    const q = new URLSearchParams({ model: model.id, resolution: model.rate.resolution, ratio: model.rate.ratio, duration: String(model.rate.duration ?? 5) });
    const quote = await page.request.get(`/api/workbench/engines?${q}`).then((r) => r.json()) as { credits: number };
    expect(quote.credits, model.id).toBe(model.rate.credits);
    const listed = models.find((m) => m.id === model.id)!;
    if ((listed as { ratios?: string[] }).ratios?.includes("21:9")) expect(model.rate.ratio, model.id).toBe("21:9");
    followed++;
  }
  expect(followed).toBeGreaterThanOrEqual(5);
  /* Sound and music: the figure the audio admission's own quoteOnly read gives. */
  expect(moved.audio).not.toBeNull();
  const sound = await page.request.post("/api/audio", { data: { task: "sound", text: "Rain on a tin roof", durationSeconds: 10, quoteOnly: true } }).then((r) => r.json()) as { estimatedCredits: number };
  const music = await page.request.post("/api/audio", { data: { task: "music", text: "A slow cello", lengthMs: 10_000, instrumental: true, quoteOnly: true } }).then((r) => r.json()) as { estimatedCredits: number };
  expect(moved.audio!.sound.credits).toBe(sound.estimatedCredits);
  expect(moved.audio!.music).toEqual({ credits: music.estimatedCredits, seconds: 10 });
});
