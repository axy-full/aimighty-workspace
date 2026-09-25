import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { createClient } from "@libsql/client";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { smallTargets, smallText } from "./phoneFloors";
import { forbidPaidWork, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";

/**
 * Gen's model sheet: a search field, a Recent group, spec chips and a price on
 * every row before anything is spent. Studio engines are priced by the engines
 * route at the composer's untouched settings (the same figure Generate then
 * shows); connected models are never quoted from the sheet and show only the
 * last quote this browser was given; members never see the connected switch.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const WIDE = ["workbench-1440x900", "workbench-1920x1080"];
/* The two sizes the review looks at; PICKER_SHOTS=all captures every size. */
const SHOTS = process.env.PICKER_SHOTS === "all" ? SIZES : ["workbench-390x844", "workbench-1440x900"];

/* Test fixtures only. */
const fixture = (): Project => ({ ...newProject("Harbour picker study"), id: "ws-picker", productionProjectId: "prod-ws", shotMappings: {} });
const CATALOGUE = [
  { id: "seedance_2_5", name: "Seedance 2.5", outputType: "video", description: "Text-to-video and omni-reference", aspectRatios: ["16:9", "9:16"], durationRange: { min: 4, max: 30 }, medias: [{ name: "medias", roles: ["start_image", "end_image", "image_references"] }], parameters: [{ name: "resolution", options: ["480p", "720p", "1080p"] }] },
  { id: "veo_3_1", name: "Veo 3.1", outputType: "video", aspectRatios: ["16:9", "9:16"], durations: [4, 6, 8], medias: [{ name: "start_image", roles: ["start_image"], max: 1 }], parameters: [{ name: "enhance_prompt", type: "bool" }, { name: "generate_audio", type: "bool" }] },
];

type Options = { owner?: boolean; member?: boolean; engines?: (page: Page) => Promise<unknown> };

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
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, { uploads: [], generations: [] });
  await page.route("**/api/prompt/enhance", (route) => route.fulfill({ json: { model: "m", effort: "auto", estimateCredits: 1 } }));
  const consumer: Record<string, unknown>[] = [];
  const quotes: Record<string, unknown>[] = [];
  if (options.owner) {
    const me = await page.request.get("/api/me").then((r) => r.json());
    await page.route("**/api/me", (route) => route.fulfill({ json: { ...me, owner: true } }));
  }
  await page.route("**/api/higgsfield/consumer/**", async (route) => {
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    consumer.push({ url: route.request().url(), ...body });
    if (!options.owner) return route.fulfill({ status: 403, json: { error: "The workspace owner only." } });
    if (new URL(route.request().url()).pathname.endsWith("/connection")) return route.fulfill({ json: { connected: true, requiresReconnect: false } });
    if (body.action === "catalogue") return route.fulfill({ json: { catalogue: { models: CATALOGUE, unlim: { available: false, remaining: null, expiresAt: null }, complete: true, fetchedAt: Date.now() } } });
    if (body.action === "quote") {
      quotes.push(body);
      const input = body.input as { model: string };
      return route.fulfill({ json: { job: { id: "9d2b3c4e-5f60-4a7b-8c9d-0e1f2a3b4c5d", draftId: "ws-picker", status: "quoted", model: CATALOGUE.find((m) => m.id === input.model), input: body.input, workspaceId: "1f2e3d4c-5b6a-4798-8a9b-0c1d2e3f4a5b", workspaceName: "Test wallet", quoteCredits: 43, creditUnit: "higgsfield_credits", quoteExpiresAt: Date.now() + 300_000, createdAt: Date.now(), providerJobId: null, tool: null, sources: [] } } });
    }
    return route.fulfill({ status: 400, json: { error: "unexpected" } });
  });
  await options.engines?.(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/suites?view=gen");
  await expect(page.getByTestId("gen-view")).toBeVisible();
  await expect(page.getByTestId("project-name")).toHaveText("Harbour picker study");
  return { errors, quotes, consumer };
}

const sheetOf = (page: Page) => page.getByRole("dialog", { name: "Choose a model" });

async function openSheet(page: Page) {
  const button = page.getByTestId("gen-model");
  await button.scrollIntoViewIfNeeded();
  await button.click();
  const sheet = sheetOf(page);
  await expect(sheet).toBeVisible();
  await sheet.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).filter((a) => a.effect && Number(a.effect.getTiming().iterations) !== Infinity).map((a) => a.finished)));
  return sheet;
}

async function closeSheet(page: Page) {
  await sheetOf(page).getByRole("button", { name: "Close", exact: true }).click();
  await expect(sheetOf(page)).toHaveCount(0);
}

const names = (page: Page, testId: string) => sheetOf(page).getByTestId(testId).locator(".gx-model-name").allTextContents();
/* Retrying: after a reload the list is read again before the group can draw. */
const group = (page: Page, testId: string) => sheetOf(page).getByTestId(testId).locator(".gx-model-name");
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

async function shot(page: Page, info: TestInfo, name: string) {
  if (!SHOTS.includes(info.project.name)) return;
  await page.screenshot({ path: info.outputPath(`${name}-${info.project.name.replace("workbench-", "")}.png`), animations: "disabled" });
}

test("every Studio engine wears spec chips and a price; the picked row's price is the figure Generate shows", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, consumer } = await open(page);
  const sheet = await openSheet(page);
  const rows = sheet.getByRole("option");
  await expect(rows.first()).toBeVisible();
  const count = await rows.count();
  expect(count).toBeGreaterThanOrEqual(5);
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    await expect(row.getByTestId("gen-sheet-price")).toHaveAttribute("data-kind", "rate");
    await expect(row.getByTestId("gen-sheet-price").locator("b")).toHaveText(/^\d+ cr$/);
    await expect(row.getByTestId("gen-sheet-price").locator("span")).toHaveText(/^\d+ s · \S+$/);
    await expect(row.locator('[data-spec="resolution"]')).toHaveText(/^\d+(p|K)$/);
    await expect(row.locator('[data-spec="length"]')).toHaveText(/^\d+(–|\/)\d+ s$/);
    await expect(row.locator('[data-spec="refs"]')).toHaveText(/refs$|^Prompt only$/);
  }
  /* The default engine is the selected row; its price is what the button asks for, once there is a prompt. */
  const selected = sheet.locator('[role="option"][aria-selected="true"]');
  await expect(selected).toHaveCount(1);
  const figure = (await selected.getByTestId("gen-sheet-price").locator("b").textContent())!;
  await expect(selected.getByTestId("gen-sheet-price")).toHaveText(/5 s · /);
  await shot(page, info, "studio-sheet");
  if (PHONES.includes(info.project.name)) {
    await expect(sheet).toBeInViewport({ ratio: 0.9 });
    expect(await smallTargets(page, ".gx-sheet"), "sheet targets under 44×44").toEqual([]);
    expect(await smallText(page, ".gx-legacy"), "text under 12px").toEqual([]);
  }
  expect(await noOverflow(page)).toBe(true);
  expect(await sheet.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await closeSheet(page);
  await page.getByTestId("gen-prompt").fill("A fox crossing a frozen harbour at dawn");
  /* The live quote is a real route read; give a busy dev server room. */
  await expect(page.getByTestId("gen-generate")).toHaveText(`Generate · ${figure}`, { timeout: 30_000 });
  /* A Studio pick never reads the connected account. */
  expect(consumer).toEqual([]);
  expect(errors).toEqual([]);
});

test("search narrows by name, one-liner or chip, says when nothing matches, and the keyboard picks", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const wide = WIDE.includes(info.project.name);
  const { errors } = await open(page);
  let sheet = await openSheet(page);
  const search = sheet.getByTestId("gen-model-search");
  const all = await sheet.getByRole("option").count();
  await expect(search).toHaveAttribute("placeholder", `Search ${all} models`);
  /* A pointer can type straight away; a phone keeps its keyboard down until the field is tapped. */
  if (wide) await expect(search).toBeFocused();
  else await expect(search).not.toBeFocused();

  await search.fill("kling");
  const kling = await sheet.locator(".gx-model-name").allTextContents();
  expect(kling.length).toBeGreaterThan(0);
  expect(kling.length).toBeLessThan(all);
  for (const name of kling) expect(name).toMatch(/kling/i);
  await search.fill("audio 1080p");
  const loud = sheet.getByRole("option");
  expect(await loud.count()).toBeGreaterThan(0);
  expect(await loud.count()).toBeLessThan(all);
  /* Every match says it on the row, in a chip or the one-liner; the Audio chip itself only where the take carries sound. */
  for (const row of await loud.all()) await expect(row).toContainText(/audio/i);
  await expect(loud.filter({ has: page.locator('[data-spec="audio"]') }).first()).toBeVisible();
  for (const chip of await sheet.locator('[data-spec="audio"]').all()) await expect(chip).toHaveAttribute("title", "Takes carry sound");

  await search.fill("no engine is called this");
  await expect(sheet.getByTestId("gen-model-none")).toContainText("No model matches “no engine is called this”.");
  await expect(sheet.getByRole("option")).toHaveCount(0);
  await sheet.getByRole("button", { name: "Clear search" }).click();
  await expect(search).toHaveValue("");
  await expect(sheet.getByRole("option")).toHaveCount(all);
  await shot(page, info, "search-cleared");

  /* Enter takes the first match; the sheet closes and the composer carries it. */
  await search.fill("kling pro");
  const first = (await sheet.locator(".gx-model-name").first().textContent())!;
  await search.press("Enter");
  await expect(sheetOf(page)).toHaveCount(0);
  await expect(page.getByTestId("gen-model").locator(".gx-model-name")).toHaveText(first);
  if (wide) {
    await expect(page.getByTestId("gen-model")).toBeFocused();
    /* Arrow keys walk the rows from the field; Enter on a row picks it. */
    sheet = await openSheet(page);
    await page.keyboard.press("ArrowDown");
    await expect(sheet.getByRole("option").first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    const second = sheet.getByRole("option").nth(1);
    await expect(second).toBeFocused();
    const picked = (await second.locator(".gx-model-name").textContent())!;
    await page.keyboard.press("Enter");
    await expect(sheetOf(page)).toHaveCount(0);
    await expect(page.getByTestId("gen-model").locator(".gx-model-name")).toHaveText(picked);
    /* Escape closes from anywhere inside. */
    await openSheet(page);
    await page.keyboard.press("Escape");
    await expect(sheetOf(page)).toHaveCount(0);
  }
  expect(await noOverflow(page)).toBe(true);
  expect(errors).toEqual([]);
});

test("Recent leads with the last three models used for this output, never repeated, and survives a reload", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors } = await open(page);
  let sheet = await openSheet(page);
  const order = await sheet.locator(".gx-model-name").allTextContents();
  expect(order.length).toBeGreaterThanOrEqual(5);
  /* Nothing used yet: one list, no Recent. */
  await expect(sheet.getByTestId("gen-model-recent")).toHaveCount(0);
  const pick = async (name: string) => {
    sheet = await openSheet(page);
    await sheet.getByRole("option").filter({ has: page.locator(".gx-model-name", { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) }).click();
    await expect(sheetOf(page)).toHaveCount(0);
  };
  await closeSheet(page);
  for (const name of [order[3], order[4], order[1], order[0]]) await pick(name);
  sheet = await openSheet(page);
  await expect(group(page, "gen-model-recent")).toHaveText([order[0], order[1], order[4]]);
  const rest = await names(page, "gen-model-all");
  expect(rest).toEqual(order.filter((n) => ![order[0], order[1], order[4]].includes(n)));
  await expect(sheet.getByRole("group", { name: "Recent" })).toBeVisible();
  await expect(sheet.getByRole("option")).toHaveCount(order.length);
  await shot(page, info, "recent");
  /* A query searches everything and drops the group. */
  await sheet.getByTestId("gen-model-search").fill(order[4].split(" ")[0]);
  await expect(sheet.getByTestId("gen-model-recent")).toHaveCount(0);
  await closeSheet(page);

  /* Generating with a model makes it recent too. */
  /* The save before any submit is refused here, so nothing is ever sent to an engine. */
  let paused = true;
  await page.route("**/api/workbench/projects**", (route) => (paused ? route.fulfill({ status: 503, json: { error: "Saving is paused in this test." } }) : route.fallback()));
  await page.getByTestId("gen-prompt").fill("A fox crossing a frozen harbour");
  await pick(order[2]);
  await expect(page.getByTestId("gen-generate")).toHaveText(/^Generate · \d+ cr$/, { timeout: 30_000 });
  await page.getByTestId("gen-generate").click();
  await expect(page.locator(".gx-gen-note[role='status']").filter({ hasText: "Saving is paused in this test." })).toBeVisible();
  paused = false;

  await page.reload();
  await expect(page.getByTestId("gen-view")).toBeVisible();
  sheet = await openSheet(page);
  await expect(group(page, "gen-model-recent")).toHaveText([order[2], order[0], order[1]]);
  /* Recent is per output: Images has its own, and nothing is used there yet. */
  await closeSheet(page);
  await page.getByRole("tab", { name: "Images" }).click();
  sheet = await openSheet(page);
  await expect(sheet.getByRole("option").first()).toBeVisible();
  await expect(sheet.getByTestId("gen-model-recent")).toHaveCount(0);
  expect(await noOverflow(page)).toBe(true);
  expect(errors).toEqual([]);
});

test("the connected catalogue is never quoted from the sheet; a quote the composer was given becomes that row's last quote", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, quotes } = await open(page, { owner: true });
  let sheet = await openSheet(page);
  await expect(sheet.getByRole("tab")).toHaveText(["Studio engines", "Higgsfield catalogue"]);
  await sheet.getByRole("tab", { name: "Higgsfield catalogue" }).click();
  await expect(sheet.getByRole("option")).toHaveCount(2);
  for (const row of await sheet.getByRole("option").all()) {
    await expect(row.getByTestId("gen-sheet-price")).toHaveAttribute("data-kind", "none");
    await expect(row.getByTestId("gen-sheet-price")).toHaveText("priced on Generate");
  }
  const veo = sheet.getByRole("option", { name: /^Veo 3\.1/ });
  await expect(veo.locator(".gx-spec")).toHaveText(["4/6/8 s", "1 image ref", "Audio", "Enhance"]);
  expect(quotes).toEqual([]);
  await veo.click();
  await expect(sheetOf(page)).toHaveCount(0);
  expect(quotes).toEqual([]);

  await page.getByTestId("gen-prompt").fill("A fox crossing a frozen harbour");
  await expect(page.getByTestId("gen-generate")).toHaveText("Generate · 43 connected cr");
  const asked = quotes.length;
  expect(asked).toBeGreaterThan(0);
  sheet = await openSheet(page);
  const price = sheet.getByRole("option", { name: /^Veo 3\.1/ }).getByTestId("gen-sheet-price");
  await expect(price).toHaveAttribute("data-kind", "last");
  await expect(price.locator("b")).toHaveText("43 cr");
  await expect(price.locator("span")).toHaveText("last quote");
  await expect(price).toHaveAttribute("title", "Last quoted in this browser: 43 connected cr at 4 s");
  await expect(sheet.getByRole("option", { name: /^Seedance 2\.5/ }).getByTestId("gen-sheet-price")).toHaveText("priced on Generate");
  await shot(page, info, "connected-last-quote");
  /* Opening the sheet and browsing asked for nothing. */
  await sheet.getByRole("tab", { name: "Studio engines" }).click();
  await sheet.getByRole("tab", { name: "Higgsfield catalogue" }).click();
  await closeSheet(page);
  expect(quotes.length).toBe(asked);
  expect(await noOverflow(page)).toBe(true);
  expect(errors).toEqual([]);
});

test("a member sees only this workspace's engines: no connected switch, and the account is never read", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  const { errors, consumer } = await open(page, { member: true });
  const sheet = await openSheet(page);
  await expect(sheet.getByRole("option").first()).toBeVisible();
  await expect(sheet.getByRole("tablist", { name: "Catalogue" })).toHaveCount(0);
  await expect(sheet.getByRole("tab")).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: "Close", exact: true })).toBeVisible();
  await expect(sheet.getByTestId("gen-sheet-price").first()).toHaveAttribute("data-kind", "rate");
  await expect(page.getByTestId("gen-model").locator(".gx-model-sub")).toHaveText("Studio engine");
  await shot(page, info, "member-sheet");
  await closeSheet(page);
  expect(consumer).toEqual([]);
  expect(errors).toEqual([]);
});

test("the sheet shows it is reading, then the list; a failed read says why instead of an empty list", async ({ page }, info) => {
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
  let sheet = await openSheet(page);
  await expect(sheet.getByTestId("gen-model-loading")).toContainText("Reading the available models…");
  await expect(sheet.getByRole("option")).toHaveCount(0);
  await shot(page, info, "loading");
  release();
  await expect(sheet.getByRole("option").first()).toBeVisible();
  await expect(sheet.getByTestId("gen-model-loading")).toHaveCount(0);
  await closeSheet(page);

  failing = true;
  await page.reload();
  await expect(page.getByTestId("gen-view")).toBeVisible();
  sheet = await openSheet(page);
  await expect(sheet.getByTestId("gen-model-empty")).toHaveText("The engine list is unavailable right now.");
  await expect(sheet.getByRole("option")).toHaveCount(0);
  await expect(page.getByTestId("gen-blocked")).toHaveText("The engine list is unavailable right now.");
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
    expect(Object.keys(model.rate!).sort()).toEqual(["credits", "duration", "ratio", "resolution"]);
    const q = new URLSearchParams({ model: model.id, resolution: model.rate!.resolution, ratio: model.rate!.ratio, duration: String(model.rate!.duration ?? 5) });
    const quote = await page.request.get(`/api/workbench/engines?${q}`).then((r) => r.json()) as { credits: number };
    expect(quote.credits, model.id).toBe(model.rate!.credits);
    priced++;
  }
  expect(priced).toBeGreaterThanOrEqual(5);
});
