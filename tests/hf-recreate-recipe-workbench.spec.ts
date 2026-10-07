import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";
import { composePrompt } from "../lib/studio";
import { openAdvanced } from "./helpers/makeAdvanced";
import { projectName } from "./helpers/projectName";
import { isCompact } from "./helpers/shellMode";

/* Release 1: the phone app draws its own simple Make (type, words, engine line with Change, References, Make at its price: demo-s10-phone-make-workbench), not this panel's composer; the desktop keeps every assertion here */
test.beforeEach(async ({}, info) => { test.skip(isCompact(info), "the phone app draws its own simple Make (type, words, engine line with Change, References, Make at its price: demo-s10-phone-make-workbench), not this panel's composer; the desktop keeps every assertion here"); });

/**
 * Recreate (idea 7): a take's whole recipe — the words as typed, the model,
 * its aspect, size and length, the references in order, the shot setup (on
 * the film vocabulary's chips, idea 13) —
 * lands in Gen even when Gen is already open, says what it could not keep,
 * and is priced again on the button before anything runs. Generate waits
 * while the take's references are still being read, and never sends an
 * enhancement of the words the recipe replaced. Undo puts the composer back;
 * Use settings only keeps the person's own words; Copy prompt copies the
 * words alone. Nothing here submits: paid routes fail the test, and the one
 * test that presses Generate stops at the price check.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];

/* Test fixtures only. */
const fixture = (): Project => ({ ...newProject("Harbour recreate study"), id: "ws-recreate", productionProjectId: "prod-ws", shotMappings: {} });
const RAW = "harbour at dusk, @Image1 walks the pier";
const harbour = () => generation({
  id: "gen_harbour", kind: "video", model: "dreamina-seedance-2-0-260128", title: "Harbour dusk", prompt: "Harbour at dusk, rewritten by the writer",
  params: {
    rawPrompt: RAW, ratio: "21:9", resolution: "1080p", duration: 8,
    references: [{ genId: "gen_plate", role: "reference_image", kind: "image" }, { uploadId: "up_gone", role: "reference_image", kind: "image" }],
    shotSpec: { shot: "cu", move: "push" },
  },
});
/* The same recipe with the gone upload first: the still moves up a number. */
const pier = () => generation({
  id: "gen_pier", kind: "video", model: "dreamina-seedance-2-0-260128", title: "Pier walk", prompt: "Pier walk, rewritten",
  params: {
    rawPrompt: "@Image2 walks the pier past @Image1", ratio: "16:9", resolution: "1080p", duration: 8,
    references: [{ uploadId: "up_gone", role: "reference_image", kind: "image" }, { genId: "gen_plate", role: "reference_image", kind: "image" }],
  },
});
const plate = () => generation({ id: "gen_plate", kind: "image", title: "Plate still", prompt: "a still of the pier" });
const edit = () => generation({ id: "gen_cut", kind: "video", title: "Trimmed cut", prompt: "trim the end", task: "edit", model: "dreamina-seedance-2-5-260628" });
/* A dub (lib/dubbing.ts): the task column says "generate"; params.task says what it really is. */
const dub = () => generation({
  id: "gen_dub", kind: "audio", title: "Harbour dusk · dubbed (French)", prompt: "Dub · clip.mp4 → French", model: "eleven_dubbing_v1", provider: "elevenlabs",
  params: { task: "dub", dubbingStatus: "dubbed", dubbingJobId: "dub_1", sourceUploadId: "up_clip", sourceName: "clip.mp4", targetLang: "fr" },
});

type Options = {
  member?: boolean; generations?: ReturnType<typeof generation>[]; url?: string; holdPlate?: boolean;
  /** The engines' quote differs with and without the take's references (17 cr without, 31 cr with the still bound), so the two prices can be told apart. */
  splitPrice?: boolean;
  /** Routes of the test's own, set once the session exists and before the page opens. */
  setup?: (page: Page) => Promise<void>;
};

async function open(page: Page, options: Options = {}) {
  const { workspace } = await signInLocally(page.request);
  if (options.member) {
    /* The session's role is read per request: this account is now a member of its own workspace. */
    const db = createClient({ url: localPlatformDbUrl(), timeout: 2_000 });
    try { await db.execute({ sql: "UPDATE memberships SET role='member' WHERE workspace_id=?", args: [workspace.id] }); }
    finally { db.close(); }
  }
  await options.setup?.(page);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, { uploads: [], generations: options.generations ?? [harbour(), plate(), edit(), dub()] });
  await page.route("**/api/prompt/enhance", (route) => route.fulfill({ json: { model: "m", effort: "auto", estimateCredits: 1 } }));
  /* The references are read again in this workspace: the still is there (held until the test lets it
     answer, when it asks to), the upload is gone. */
  let release = () => {};
  const held = options.holdPlate ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve();
  await page.route(/\/api\/jobs\/gen_plate(\?.*)?$/, async (route) => {
    await held;
    return route.fulfill({ json: { generation: plate() } });
  });
  await page.route(/\/api\/uploads\/up_gone\/metadata$/, (route) => route.fulfill({ status: 404, json: { error: "This asset is unavailable in the current workspace." } }));
  /* The composer's price reads (GET, never a charge) are answered here so the figure is known; the list itself is real. */
  const quotes: URLSearchParams[] = [];
  await page.route(/\/api\/workbench\/engines\?.*model=/, (route) => {
    const asked = new URL(route.request().url()).searchParams;
    quotes.push(asked);
    return route.fulfill({ json: { credits: options.splitPrice && !asked.has("genId") ? 17 : 31 } });
  });
  /* Generate's own re-quote is where a press would first spend: it is recorded and refused, so nothing runs. */
  const priced: Record<string, unknown>[] = [];
  await page.route("**/api/generate/quote", (route) => {
    priced.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ status: 409, json: { error: "Stopped by the test before anything ran." } });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(options.url ?? "/suites?make=video");
  if (!options.url) await expect(page.getByTestId("gen-view")).toBeVisible();
  if (!options.url) await openAdvanced(page);
  await expect(projectName(page)).toHaveText("Harbour recreate study");
  return { errors, quotes, priced, release: () => release() };
}

/**
 * Again (Retry, for a failed take) on a take's card in Make › Recent, at the price on its button: the take's whole recipe lands in
 * Make and Make is where it is priced and pressed. (The Inspector's Recreate, Use settings only and Copy prompt went with the old
 * Inspector; docs/old-shells.md.) Returns the card's Again button, and Make is on its Make tab with Advanced folded again.
 */
async function again(page: Page, id: string) {
  await page.getByTestId("make-tab-recent").click();
  const card = page.locator(`[data-testid="make-recent-card"][data-take*="${id}"]`);
  await expect(card).toBeVisible({ timeout: 60_000 });
  const button = card.getByTestId("make-again");
  return { card, button };
}
/** Presses a ready Again (it waits for the server's price of the recipe: the first engine read of a fresh dev server can take a while). */
async function recreate(page: Page, id: string) {
  const { button } = await again(page, id);
  await expect(button).toBeEnabled({ timeout: 90_000 });
  await button.click();
  await expect(page.getByTestId("make-tab-make")).toHaveAttribute("aria-selected", "true");
}
const reference = (page: Page, tag: string, name: string) => page.getByTestId("make-reference").and(page.locator(`[title="${tag} · ${name}"]`));

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

/** Advanced under Change, retried: Make redraws as a recipe's references are read, and a fold opened in that moment is closed with it. */
const advanced = (page: Page) => expect(async () => { await openAdvanced(page); }).toPass({ timeout: 20_000 });
const MISSING_READ = "Reading the take’s references…";

test("Again lands the whole recipe in a Make that is already open, waits for its references, names what is missing, and prices it again", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, quotes, priced, release } = await open(page, { holdPlate: true, splitPrice: true });
  const prompt = page.getByTestId("gen-prompt");
  await prompt.fill("my own words");
  await recreate(page, "gen_harbour");
  await expect(page.getByTestId("toast")).toHaveText("Harbour dusk’s recipe is in Make.");

  /* The words as typed, the model, and each setting, applied in the open composer. */
  const card = page.getByTestId("gen-recipe");
  await expect(card).toBeVisible();
  await expect(page.getByTestId("gen-recipe-name")).toHaveText("Harbour dusk");
  await expect(prompt).toHaveValue(RAW);
  await expect(page.getByTestId("make-engine-line")).toContainText("Seedance 2.0");
  await expect(page.getByTestId("make-engine-line")).toContainText("1080p · 8 s");
  /* Make redraws as the references are read, which folds Advanced again: open it and read it in one retried step. */
  await expect(async () => {
    await openAdvanced(page);
    await expect(page.getByTestId("make-panel").getByRole("group", { name: "Aspect" }).getByRole("button", { name: /21:9/ })).toHaveAttribute("aria-pressed", "true", { timeout: 3_000 });
    await expect(page.getByRole("group", { name: "Resolution" }).getByRole("button", { name: /1080p/ })).toHaveAttribute("aria-pressed", "true", { timeout: 3_000 });
    await expect(page.getByTestId("gen-length")).toHaveValue("8", { timeout: 3_000 });
  }).toPass({ timeout: 30_000 });

  /* The still has not answered yet: the recipe is half-read, and Make waits (it can be pressed only to say why), sending no price check. */
  const go = page.getByTestId("gen-generate");
  await expect(card).toContainText(MISSING_READ);
  await expect(page.getByTestId("gen-blocked")).toHaveText(MISSING_READ);
  /* Long enough for the composer's own debounced price of the reference-less state to have come back. */
  await expect.poll(() => quotes.length).toBeGreaterThan(0);
  await page.waitForTimeout(600);
  /* The only figure on hand is the quote without the references (17 cr): not what this take costs, so none shows, on the button or the line. */
  expect(quotes.some((q) => !q.has("genId"))).toBe(true);
  await expect(go).toHaveAttribute("aria-disabled", "true");
  await expect(go).toHaveText("Make");
  await expect(go).toHaveAttribute("data-spend", "unpriced");
  await expect(page.getByTestId("make-engine-price")).toHaveCount(0);
  await expect(card).toContainText(MISSING_READ);
  await go.click({ force: true });
  expect(priced).toEqual([]);

  /* Then the one still there, in order, and the one that is gone. */
  release();
  await expect(reference(page, "@Image1", "Plate still")).toHaveCount(1);
  await expect(card).not.toContainText(MISSING_READ);
  await expect(page.getByTestId("gen-recipe-missing")).toHaveText("Not found: @Image2");
  /* The words cite @Image1 only, which is the still: nothing to renumber, nothing to wait for. */
  await expect(prompt).toHaveValue(RAW);

  /* Priced again, exactly as recreated, before anything runs. */
  await expect(go).toHaveText("Make · 31 cr", { timeout: 30_000 });
  await expect(go).toHaveAttribute("data-spend", "priced");
  await expect(page.getByTestId("make-engine-price")).toHaveText("31 cr");
  await expect(go).not.toHaveAttribute("aria-disabled", "true");
  const asked = quotes.at(-1)!;
  expect(Object.fromEntries(["model", "ratio", "resolution", "duration", "genId"].map((k) => [k, asked.get(k)]))).toEqual({
    model: "dreamina-seedance-2-0-260128", ratio: "21:9", resolution: "1080p", duration: "8", genId: "gen_plate",
  });
  expect(asked.has("uploadId")).toBe(false);

  /* The shot setup lands on the film vocabulary's chips; the words stay the words as typed. */
  await advanced(page);
  await expect(page.getByTestId("gen-film-shot")).toHaveAttribute("aria-label", "Shot: Close-up");
  await expect(page.getByTestId("gen-film-camera")).toHaveAttribute("aria-label", "Camera: Push in");
  await expect(page.getByTestId("gen-film-lens")).toHaveAttribute("aria-label", "Lens: Auto");
  await expect(prompt).toHaveValue(RAW);

  expect(await noOverflow(page)).toBe(true);
  /* Undo puts the composer back exactly as it was. */
  await page.getByTestId("gen-recipe-undo").click();
  await expect(card).toHaveCount(0);
  await expect(prompt).toHaveValue("my own words");
  await expect(page.getByTestId("make-engine-line")).toContainText("Seedance 2.5");
  await expect(page.getByTestId("make-reference")).toHaveCount(0);
  await advanced(page);
  await expect(page.getByTestId("gen-film-shot")).toHaveAttribute("aria-label", "Shot: Auto");
  await expect(page.getByTestId("gen-film-camera")).toHaveAttribute("aria-label", "Camera: Auto");
  expect(priced).toEqual([]);
  expect(errors).toEqual([]);
});

test("× hides the card, and a recipe still being read keeps Make waiting all the same", async ({ page }, info) => {
  test.skip(!["workbench-1440x900"].includes(info.project.name), "one desktop width");
  const { errors, release, priced } = await open(page, { holdPlate: true });
  await recreate(page, "gen_harbour");
  await expect(page.getByTestId("gen-recipe")).toContainText(MISSING_READ);
  await page.getByTestId("gen-recipe-dismiss").click();
  await expect(page.getByTestId("gen-recipe")).toHaveCount(0);
  await expect(page.getByTestId("gen-blocked")).toHaveText(MISSING_READ);
  await expect(page.getByTestId("gen-generate")).toHaveAttribute("aria-disabled", "true");
  release();
  await expect(reference(page, "@Image1", "Plate still")).toHaveCount(1);
  await expect(page.getByTestId("gen-generate")).toHaveText("Make · 31 cr", { timeout: 30_000 });
  await expect(page.getByTestId("gen-recipe")).toHaveCount(0);
  expect(priced).toEqual([]);
  expect(errors).toEqual([]);
});

test("a model picked in the engine list while the recipe is still read keeps its card and its wait; Undo takes both back", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one desktop width");
  const { errors, release, priced } = await open(page, { holdPlate: true });
  await recreate(page, "gen_harbour");
  const card = page.getByTestId("gen-recipe");
  await expect(card).toContainText(MISSING_READ);
  /* A model picked in the list hands Make a model and no words: a change made here, not a new recipe. */
  if ((await page.getByTestId("gen-model").getAttribute("aria-expanded")) !== "true") await page.getByTestId("gen-model").click();
  const other = page.getByTestId("make-engines").locator('[data-testid="make-engine-row"][aria-pressed="false"]').first();
  const otherName = (await other.locator(".gx-mk-row-name").textContent())!;
  await other.click();
  await expect(page.getByTestId("make-engine-line")).toContainText(otherName);
  await expect(page.getByTestId("gen-prompt")).toHaveValue(RAW);
  await expect(card).toContainText("Model: Changed here");
  /* The take's references are still on their way: nothing is priced without them. */
  await expect(card).toContainText(MISSING_READ);
  await expect(page.getByTestId("gen-blocked")).toHaveText(MISSING_READ);
  await expect(page.getByTestId("gen-generate")).toHaveAttribute("aria-disabled", "true");
  release();
  await expect(reference(page, "@Image1", "Plate still")).toHaveCount(1);
  await expect(card).not.toContainText(MISSING_READ);
  /* Undo puts the composer back as it was before the recipe, the model picked since included. */
  await page.getByTestId("gen-recipe-undo").click();
  await expect(page.getByTestId("gen-recipe")).toHaveCount(0);
  await expect(page.getByTestId("make-engine-line")).toContainText("Seedance 2.5");
  await expect(page.getByTestId("make-reference")).toHaveCount(0);
  expect(priced).toEqual([]);
  expect(errors).toEqual([]);
});

test("a gone first reference: the words are renumbered to the well, the gap keeps its own citation, and Make waits for it", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors } = await open(page, { generations: [pier(), plate()] });
  await recreate(page, "gen_pier");
  const prompt = page.getByTestId("gen-prompt");
  /* The still was @Image2 in the take and is @Image1 in the well now; the words follow it. The gone
     upload's citation moves after it, so no citation lands on a different picture. */
  await expect(reference(page, "@Image1", "Plate still")).toHaveCount(1, { timeout: 30_000 });
  await expect(prompt).toHaveValue("@Image1 walks the pier past @Image2");
  await expect(page.getByTestId("gen-recipe-missing")).toHaveText("Not found: @Image2");
  /* The words still cite the gone reference: nothing is priced as if it were there. */
  await expect(page.getByTestId("gen-blocked")).toHaveText("The words cite @Image2, which is gone. Add a reference or change the words.");
  await expect(page.getByTestId("gen-generate")).toHaveAttribute("aria-disabled", "true");
  /* Dropping the citation is the person's call; then the take is priced. */
  await prompt.fill("@Image1 walks the pier");
  await expect(page.getByTestId("gen-generate")).toHaveText("Make · 31 cr", { timeout: 30_000 });
  await expect(page.getByTestId("gen-generate")).not.toHaveAttribute("aria-disabled", "true");
  expect(await noOverflow(page)).toBe(true);
  expect(errors).toEqual([]);
});

test("an enhancement of the words a Recreate replaced is cleared, and Make sends the take's words", async ({ page }, info) => {
  test.skip(!["workbench-1440x900"].includes(info.project.name), "one desktop width");
  const { errors, priced } = await open(page);
  /* The enhancer answers from the test: a quote, then the rewrite of whatever words it was sent. */
  await page.route("**/api/prompt/enhance", (route) => {
    const body = route.request().postDataJSON() as { prompt: string; quoteOnly?: boolean };
    return route.fulfill({ json: body.quoteOnly ? { model: "m", effort: "auto", estimateCredits: 1 } : { prompt: `ENHANCED ${body.prompt}`, provider: "claude" } });
  });
  const prompt = page.getByTestId("gen-prompt");
  await prompt.fill("my own words");
  await page.getByRole("switch", { name: "Auto" }).click();
  await expect(page.getByTestId("enhance")).toHaveText("Enhance now · 1 cr");
  await page.getByTestId("enhance").click();
  await expect(page.getByTestId("enhanced-card")).toContainText("ENHANCED my own words");

  await recreate(page, "gen_harbour");
  await expect(prompt).toHaveValue(RAW);
  await advanced(page);
  await expect(page.getByTestId("enhanced-card")).toHaveCount(0);
  await expect(reference(page, "@Image1", "Plate still")).toHaveCount(1, { timeout: 30_000 });
  const go = page.getByTestId("gen-generate");
  /* Auto is put off, so what is sent is the take's words exactly (with Auto on, Make enhances the words it holds first, and the figure includes that). */
  await page.getByTestId("enhance-auto").click();
  await expect(go).toHaveText("Make · 31 cr", { timeout: 30_000 });
  await go.click();
  /* The price check is where a press first spends: it carries the take's words, not the old enhancement,
     with its shot setup written in once and sent as data. */
  await expect.poll(() => priced.length).toBe(1);
  expect(priced[0]).toMatchObject({ prompt: composePrompt(RAW, { shot: "cu", move: "push" }), shotSpec: { shot: "cu", move: "push" } });
  expect(errors).toEqual([]);
});

test("a take from a tool Make does not have — an edit, a dub — cannot be recreated, and says why", async ({ page }, info) => {
  test.skip(!["workbench-1440x900"].includes(info.project.name), "one desktop width");
  const { errors } = await open(page);
  const why = "Made with a tool Make does not have. Run it again from that tool.";
  await page.getByTestId("make-tab-recent").click();
  const cut = await again(page, "gen_cut");
  await expect(cut.button).toBeDisabled();
  await expect(cut.card.getByTestId("make-again-reason")).toHaveText(why);
  await expect(cut.button).toHaveAttribute("data-spend", "unpriced");
  /* A dub is filed as an ordinary audio take; its params say what made it: the reason says where to run it again. */
  const dubbed = await again(page, "gen_dub");
  await expect(dubbed.button).toBeDisabled();
  await expect(dubbed.card.getByTestId("make-again-reason")).toHaveText(/^This take was made from a source clip\./);
  await expect(dubbed.button).toHaveAttribute("data-spend", "unpriced");
  expect(errors).toEqual([]);
});

for (const member of [false, true])
test(`${member ? "a member" : "the owner"} recreates a take made on the Higgsfield account on this workspace's engines, and the card says so`, async ({ page }, info) => {
  test.skip(!["workbench-1440x900"].includes(info.project.name), "one desktop width");
  const connected = generation({
    id: "gen_account", kind: "video", model: "seedance_2_5", title: "Account take", prompt: "a gull over the breakwater", provider: "higgsfield",
    params: { task: "connected-generation", consumerCreditUnit: "higgsfield_credits", outputType: "video", duration: 5.04, settings: { aspect_ratio: "9:16", resolution: "720p", duration: 6 } },
  });
  const asked: string[] = [];
  const setup = async (page: Page) => {
    await page.route("**/api/higgsfield/consumer/**", (route) => {
      const listing = route.request().method() === "GET" && new URL(route.request().url()).searchParams.has("draftId");
      if (listing) return route.fulfill({ json: { jobs: [] } });
      asked.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
      return route.fulfill({ status: 410, json: { code: "retired", error: "The connected account is no longer used. Past results stay in your Library." } });
    });
  };
  const { errors } = await open(page, { member, generations: [connected], setup });
  await recreate(page, "gen_account");
  await expect(page.getByTestId("gen-prompt")).toHaveValue("a gull over the breakwater");
  const card = page.getByTestId("gen-recipe");
  /* The account's catalogue id is not a name: it is not dressed up as one. */
  await expect(card).toContainText("Model: Make runs on Studio engines only");
  /* The settings the account was asked for still carry over where this engine offers them. */
  await advanced(page);
  await expect(page.getByTestId("make-panel").getByRole("group", { name: "Aspect" }).getByRole("button", { name: /9:16/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("gen-length")).toHaveValue("6");
  await expect(page.getByTestId("gen-generate")).toHaveText("Make · 31 cr", { timeout: 30_000 });
  /* Dismissing the card leaves the engine choice where it was. */
  await page.getByTestId("gen-recipe-dismiss").click();
  await expect(page.getByTestId("make-engine-line")).toContainText("Seedance 2.5");
  expect(await noOverflow(page)).toBe(true);
  expect(asked, "the account is never asked").toEqual([]);
  expect(errors).toEqual([]);
});

test("the owner's Soul take is recreated on Studio engines: its identity is not carried, and the account's identities are never read", async ({ page }, info) => {
  test.skip(!["workbench-1440x900"].includes(info.project.name), "one desktop width");
  const soul = generation({
    id: "gen_soul", kind: "image", model: "soul_2", title: "Soul portrait", prompt: "a keeper on the pier at first light", provider: "higgsfield",
    params: { task: "connected-generation", consumerCreditUnit: "higgsfield_credits", outputType: "image", settings: { aspect_ratio: "3:4", soul_id: "soul_gone", enhance_prompt: true } },
  });
  const asked: string[] = [];
  const setup = async (page: Page) => {
    await page.route("**/api/higgsfield/consumer/**", (route) => {
      const listing = route.request().method() === "GET" && new URL(route.request().url()).searchParams.has("draftId");
      if (listing) return route.fulfill({ json: { jobs: [] } });
      asked.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
      return route.fulfill({ status: 410, json: { code: "retired", error: "The connected account is no longer used. Past results stay in your Library." } });
    });
  };
  const { errors, priced } = await open(page, { generations: [soul], setup });
  await recreate(page, "gen_soul");
  await expect(page.getByTestId("gen-prompt")).toHaveValue("a keeper on the pier at first light");
  const card = page.getByTestId("gen-recipe");
  await expect(card).toContainText("Model: Make runs on Studio engines only");
  await expect(page.getByTestId("gen-blocked").filter({ hasText: "Reading the account’s identities…" })).toHaveCount(0);
  expect(priced).toEqual([]);
  expect(asked, "the account's identities are never read").toEqual([]);
  expect(errors).toEqual([]);
});

test("an engine that is gone lands on the nearest size at or below the take's, and says why", async ({ page }, info) => {
  test.skip(!["workbench-1440x900"].includes(info.project.name), "one desktop width");
  const retired = generation({
    id: "gen_retired", kind: "video", model: "retired-engine-v1", title: "Old engine take", prompt: "a lighthouse at night",
    params: { rawPrompt: "a lighthouse at night", ratio: "16:9", resolution: "4k", duration: 5 },
  });
  const { errors, priced } = await open(page, { generations: [retired] });
  await recreate(page, "gen_retired");
  const card = page.getByTestId("gen-recipe");
  await expect(card).toContainText("Model: Not offered here now");
  /* 4k is not offered: the nearest below it, never the list's smallest. */
  await expect(card).toContainText(/Resolution: .+ has no 4k/);
  await advanced(page);
  await expect(page.getByRole("group", { name: "Resolution" }).getByRole("button", { name: /1080p/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("gen-generate")).toHaveText("Make · 31 cr", { timeout: 30_000 });
  expect(priced).toEqual([]);
  expect(errors).toEqual([]);
});

test("when the engines cannot be read, Again waits with the composer's one reason and prices nothing", async ({ page }, info) => {
  test.skip(!["workbench-1440x900"].includes(info.project.name), "one desktop width");
  const failed = "The available models could not be read.";
  const { errors, priced } = await open(page, {
    generations: [harbour(), plate()],
    setup: async (page) => { await page.route(/\/api\/workbench\/engines$/, (route) => route.fulfill({ status: 500, json: { error: failed } })); },
  });
  /* With the engines unread there is no price for Again: its button is disabled, unpriced, and says why. */
  const { card, button } = await again(page, "gen_harbour");
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute("data-spend", "unpriced");
  await expect(card.getByTestId("make-again-reason")).toHaveText(/\S/, { timeout: 30_000 });
  await expect(button).toHaveText("Again");
  expect(priced).toEqual([]);
  expect(errors).toEqual([]);
});
