import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { createClient } from "@libsql/client";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { smallTargets, smallText } from "./phoneFloors";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";
import { composePrompt } from "../lib/studio";

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
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
/* Portrait phones: the sticky Generate band and the tab bar sit over the page's lower third. */
const PORTRAIT = ["workbench-360x640", "workbench-390x844"];
/* RECREATE_SHOTS=<dir> saves the finished card at the sizes the review looks at. */
const SHOTS = ["workbench-360x640", "workbench-390x844", "workbench-1440x900"];

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
    quotes.push(new URL(route.request().url()).searchParams);
    return route.fulfill({ json: { credits: 31 } });
  });
  /* Generate's own re-quote is where a press would first spend: it is recorded and refused, so nothing runs. */
  const priced: Record<string, unknown>[] = [];
  await page.route("**/api/generate/quote", (route) => {
    priced.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ status: 409, json: { error: "Stopped by the test before anything ran." } });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(options.url ?? "/suites?view=gen");
  if (!options.url) await expect(page.getByTestId("gen-view")).toBeVisible();
  await expect(page.getByTestId("project-name")).toHaveText("Harbour recreate study");
  return { errors, quotes, priced, release: () => release() };
}

/** Opens a take from Gen's own results in the Inspector (a column when wide, an overlay on a phone). */
async function inspect(page: Page, id: string) {
  await page.getByTestId("gen-view").locator(`.gx-asset-thumb[data-ctx='asset:generation:${id}']`).click();
  const inspector = page.getByTestId("asset-inspector");
  await expect(inspector).toBeVisible();
  return inspector;
}

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

/**
 * Every row of the card is really visible: at the left, middle and right of each row, the topmost
 * element is the card's own (not the sticky Generate band, the tab bar or anything else), and the
 * row lies inside the viewport. toBeInViewport would pass for a row painted over by the band.
 */
async function hiddenRows(page: Page) {
  return page.getByTestId("gen-recipe").evaluate((card) => {
    const out: string[] = [];
    for (const row of Array.from(card.children) as HTMLElement[]) {
      const rect = row.getBoundingClientRect();
      if (!rect.height) continue;
      const y = rect.top + rect.height / 2;
      if (rect.top < 0 || rect.bottom > innerHeight) { out.push(`${row.className}: ${Math.round(rect.top)}–${Math.round(rect.bottom)} outside 0–${innerHeight}`); continue; }
      for (const x of [rect.left + 6, rect.left + rect.width / 2, rect.right - 6]) {
        const hit = document.elementFromPoint(x, y);
        if (!hit || !card.contains(hit)) { out.push(`${row.className} at ${Math.round(x)},${Math.round(y)} is under ${hit ? `${hit.tagName}.${hit.className}` : "nothing"}`); break; }
      }
    }
    return out;
  });
}

/** The card lands clear of the band: every row. */
async function landsClear(page: Page) {
  expect(await hiddenRows(page), "card rows hidden").toEqual([]);
}

async function shot(page: Page, info: TestInfo, name: string) {
  const dir = process.env.RECREATE_SHOTS;
  if (!dir || !SHOTS.includes(info.project.name)) return;
  await page.getByTestId("gen-view").evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).filter((a) => a.effect && Number(a.effect.getTiming().iterations) !== Infinity).map((a) => a.finished)));
  await page.screenshot({ path: `${dir}/${name}-${info.project.name.replace("workbench-", "")}.png`, animations: "disabled" });
}

test("Recreate lands the whole recipe in a Gen that is already open, waits for its references, names what is missing, and prices it again", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, quotes, priced, release } = await open(page, { holdPlate: true });
  const prompt = page.getByTestId("gen-prompt");
  await prompt.fill("my own words");

  const inspector = await inspect(page, "gen_harbour");
  await expect(inspector.getByTestId("inspector-recreate")).toBeEnabled();
  await inspector.getByTestId("inspector-recreate").click();
  await expect(page.getByTestId("toast")).toHaveText("Harbour dusk’s recipe is in Gen.");

  /* The words as typed, the model, and each setting, applied in the open composer. */
  const card = page.getByTestId("gen-recipe");
  await expect(card).toBeVisible();
  await expect(page.getByTestId("gen-recipe-name")).toHaveText("Harbour dusk");
  await expect(prompt).toHaveValue(RAW);
  await expect(page.getByTestId("gen-model")).toContainText("Seedance 2.0");
  await expect(page.getByRole("group", { name: "Aspect" }).getByRole("button", { name: "21:9" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("group", { name: "Resolution" }).getByRole("button", { name: "1080p" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("gen-length")).toHaveValue("8");

  /* The still has not answered yet: the recipe is half-read, and a price for that is not the take's. */
  const refs = page.getByTestId("gen-recipe-refs");
  const go = page.getByTestId("gen-generate");
  await expect(refs).toHaveAttribute("data-state", "reading");
  await expect(refs).toHaveText("2 refs…");
  await expect(page.getByTestId("gen-blocked")).toHaveText("Reading the take’s references…");
  /* Long enough for the composer's own debounced price of the reference-less state to have come back. */
  await expect.poll(() => quotes.length).toBeGreaterThan(0);
  await page.waitForTimeout(600);
  await expect(go).toBeDisabled();
  await expect(go).toHaveText("Generate");
  await expect(refs).toHaveAttribute("data-state", "reading");
  expect(priced).toEqual([]);

  /* Then the one still there, in order, and the one that is gone. */
  release();
  await expect(refs).toHaveText("1 of 2 refs");
  await expect(refs).toHaveAttribute("data-state", "changed");
  await expect(page.getByTestId("gen-well")).toContainText("@Image1 · Plate still");
  await expect(page.getByTestId("gen-recipe-missing")).toHaveText("Not found @Image2 (upload)");
  await expect(page.getByTestId("gen-recipe-chips").locator("li[data-state='kept']")).toHaveText(["Seedance 2.0", "21:9", "1080p", "8 s", "Close-up · Push in"]);
  await expect(page.getByTestId("gen-recipe-why").locator("li")).toHaveCount(1);
  /* The words cite @Image1 only, which is the still: nothing to renumber, nothing to wait for. */
  await expect(prompt).toHaveValue(RAW);

  /* Priced again, exactly as recreated, before anything runs. */
  await expect(go).toHaveText("Generate · 31 cr");
  await expect(go).toBeEnabled();
  const asked = quotes.at(-1)!;
  expect(Object.fromEntries(["model", "ratio", "resolution", "duration", "genId"].map((k) => [k, asked.get(k)]))).toEqual({
    model: "dreamina-seedance-2-0-260128", ratio: "21:9", resolution: "1080p", duration: "8", genId: "gen_plate",
  });
  expect(asked.has("uploadId")).toBe(false);

  /* The card is in view where the composer is: on a portrait phone, above the sticky Generate band. */
  await landsClear(page);

  /* The shot setup lands on the film vocabulary's chips; the words stay the words as typed. */
  await expect(page.getByTestId("gen-recipe-setup")).toHaveText("Close-up · Push in");
  await expect(page.getByTestId("gen-film-shot")).toHaveAttribute("aria-label", "Shot: Close-up");
  await expect(page.getByTestId("gen-film-camera")).toHaveAttribute("aria-label", "Camera: Push in");
  await expect(page.getByTestId("gen-film-lens")).toHaveAttribute("aria-label", "Lens: Auto");
  await expect(prompt).toHaveValue(RAW);

  await shot(page, info, "recreate");
  expect(await noOverflow(page)).toBe(true);
  if (PHONES.includes(info.project.name)) {
    expect(await smallTargets(page, ".gx-recipe"), "card targets under 44×44").toEqual([]);
    expect(await smallText(page, ".gx-legacy"), "text under 12px").toEqual([]);
  }

  /* Undo puts the composer back exactly as it was. */
  await page.getByTestId("gen-recipe-undo").click();
  await expect(card).toHaveCount(0);
  await expect(prompt).toHaveValue("my own words");
  await expect(page.getByTestId("gen-model")).toContainText("Seedance 2.5");
  await expect(page.getByTestId("gen-well")).not.toContainText("Plate still");
  await expect(page.getByTestId("gen-film-shot")).toHaveAttribute("aria-label", "Shot: Auto");
  await expect(page.getByTestId("gen-film-camera")).toHaveAttribute("aria-label", "Camera: Auto");
  expect(priced).toEqual([]);
  expect(errors).toEqual([]);
});

test("× hides the card, and a recipe still being read keeps Generate waiting all the same", async ({ page }, info) => {
  test.skip(!["workbench-360x640", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  const { errors, release, priced } = await open(page, { holdPlate: true });
  const inspector = await inspect(page, "gen_harbour");
  await inspector.getByTestId("inspector-recreate").click();
  await expect(page.getByTestId("gen-recipe-refs")).toHaveText("2 refs…");
  await page.getByTestId("gen-recipe-dismiss").click();
  await expect(page.getByTestId("gen-recipe")).toHaveCount(0);
  await expect(page.getByTestId("gen-blocked")).toHaveText("Reading the take’s references…");
  await expect(page.getByTestId("gen-generate")).toBeDisabled();
  release();
  await expect(page.getByTestId("gen-well")).toContainText("@Image1 · Plate still");
  await expect(page.getByTestId("gen-generate")).toHaveText("Generate · 31 cr");
  await expect(page.getByTestId("gen-recipe")).toHaveCount(0);
  expect(priced).toEqual([]);
  expect(errors).toEqual([]);
});

test("a gone first reference: the words are renumbered to the well, the gap keeps its own citation, and Generate waits for it", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors } = await open(page, { generations: [pier(), plate()] });
  const inspector = await inspect(page, "gen_pier");
  await inspector.getByTestId("inspector-recreate").click();
  const prompt = page.getByTestId("gen-prompt");
  await expect(page.getByTestId("gen-recipe-refs")).toHaveText("1 of 2 refs");
  /* The still was @Image2 in the take and is @Image1 in the well now; the words follow it. The gone
     upload's citation moves after it, so no citation lands on a different picture. */
  await expect(page.getByTestId("gen-well")).toContainText("@Image1 · Plate still");
  await expect(prompt).toHaveValue("@Image1 walks the pier past @Image2");
  await expect(page.getByTestId("gen-recipe-missing")).toHaveText("Not found @Image2 (upload) · still in the prompt");
  await expect(page.getByTestId("gen-recipe-why").locator("li[data-note='renumbered']")).toHaveText("Renumbered Plate still @Image2 → @Image1");
  /* The words still cite the gone reference: nothing is priced as if it were there. */
  await expect(page.getByTestId("gen-blocked")).toHaveText("The prompt cites @Image2, which is gone. Add a reference or edit the words.");
  await expect(page.getByTestId("gen-generate")).toBeDisabled();
  await landsClear(page);
  await shot(page, info, "gone-first");
  /* Dropping the citation is the person's call; then the take is priced. */
  await prompt.fill("@Image1 walks the pier");
  await expect(page.getByTestId("gen-recipe-missing")).toHaveText("Not found @Image2 (upload)");
  await expect(page.getByTestId("gen-generate")).toHaveText("Generate · 31 cr");
  await expect(page.getByTestId("gen-generate")).toBeEnabled();
  expect(await noOverflow(page)).toBe(true);
  expect(errors).toEqual([]);
});

test("an enhancement of the words a Recreate replaced is cleared, and Generate sends the take's words", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  const { errors, priced } = await open(page);
  /* The enhancer answers from the test: a quote, then the rewrite of whatever words it was sent. */
  await page.route("**/api/prompt/enhance", (route) => {
    const body = route.request().postDataJSON() as { prompt: string; quoteOnly?: boolean };
    return route.fulfill({ json: body.quoteOnly ? { model: "m", effort: "auto", estimateCredits: 1 } : { prompt: `ENHANCED ${body.prompt}`, provider: "claude" } });
  });
  const prompt = page.getByTestId("gen-prompt");
  await prompt.fill("my own words");
  await page.getByRole("switch", { name: "Auto" }).click();
  await expect(page.getByTestId("enhance")).toHaveText("Enhance · 1 cr");
  await page.getByTestId("enhance").click();
  await expect(page.getByTestId("enhanced-card")).toContainText("ENHANCED my own words");

  const inspector = await inspect(page, "gen_harbour");
  await inspector.getByTestId("inspector-recreate").click();
  await expect(prompt).toHaveValue(RAW);
  await expect(page.getByTestId("enhanced-card")).toHaveCount(0);
  await expect(page.getByTestId("gen-recipe-refs")).toHaveText("1 of 2 refs");
  const go = page.getByTestId("gen-generate");
  await expect(go).toHaveText("Generate · 31 cr");
  await go.click();
  /* The price check is where a press first spends: it carries the take's words, not the old enhancement,
     with its shot setup written in once and sent as data. */
  await expect.poll(() => priced.length).toBe(1);
  expect(priced[0]).toMatchObject({ prompt: composePrompt(RAW, { shot: "cu", move: "push" }), shotSpec: { shot: "cu", move: "push" } });
  expect(errors).toEqual([]);
});

test("Use settings only keeps the person's words; Copy prompt copies the take's words alone", async ({ page, context, baseURL }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseURL });
  const { errors } = await open(page);
  const prompt = page.getByTestId("gen-prompt");
  await prompt.fill("a lighthouse keeper at first light");

  let inspector = await inspect(page, "gen_harbour");
  await inspector.getByTestId("inspector-settings-only").click();
  await expect(page.getByTestId("toast")).toHaveText("Harbour dusk’s model and settings are in Gen.");
  const card = page.getByTestId("gen-recipe");
  await expect(card).toHaveAttribute("data-settings-only", "true");
  await expect(card).toContainText("Settings from");
  await expect(prompt).toHaveValue("a lighthouse keeper at first light");
  await expect(page.getByTestId("gen-model")).toContainText("Seedance 2.0");
  await expect(page.getByRole("group", { name: "Aspect" }).getByRole("button", { name: "21:9" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("gen-length")).toHaveValue("8");
  await expect(page.getByTestId("gen-recipe-refs")).toHaveCount(0);
  await expect(page.getByTestId("gen-well")).not.toContainText("Plate still");
  /* A setting changed afterwards reads as changed, with the reason. */
  await page.getByRole("group", { name: "Aspect" }).getByRole("button", { name: "16:9" }).click();
  await expect(page.getByTestId("gen-recipe-chips").locator("li[data-chip='ratio']")).toHaveText("21:9 → 16:9");
  await expect(page.getByTestId("gen-recipe-why")).toHaveText("Aspect Changed here");
  /* So does a model the person picked while the take's is still offered. */
  await page.getByTestId("gen-model").click();
  const sheet = page.getByRole("dialog", { name: "Choose a model" });
  await sheet.getByRole("option", { name: /^Kling 3\.0/ }).first().click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId("gen-recipe-chips").locator("li[data-chip='model']")).toHaveText(/^Seedance 2\.0 → Kling 3\.0/);
  await expect(page.getByTestId("gen-recipe-why").locator("li[data-note='model']")).toHaveText("Model Changed here");
  await expect(page.getByTestId("gen-generate")).toHaveText("Generate · 31 cr");
  await card.scrollIntoViewIfNeeded();
  await shot(page, info, "settings-only");

  inspector = await inspect(page, "gen_harbour");
  await inspector.getByTestId("inspector-copy-prompt").click();
  await expect(page.getByTestId("toast")).toHaveText("Prompt copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(RAW);
  expect(await noOverflow(page)).toBe(true);
  expect(errors).toEqual([]);
});

test("a take from a tool Gen does not have — an edit, a dub — cannot be recreated, and says why", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  const { errors } = await open(page);
  const why = "Made with a tool Gen does not have. Run it again from that tool.";
  let inspector = await inspect(page, "gen_cut");
  await expect(inspector.getByTestId("inspector-recreate")).toBeDisabled();
  await expect(inspector.getByTestId("inspector-settings-only")).toBeDisabled();
  await expect(inspector.getByTestId("inspector-recreate-why")).toHaveText(why);
  await expect(inspector.getByTestId("inspector-copy-prompt")).toBeEnabled();
  /* The right-click menu says the same. */
  await page.getByTestId("gen-view").locator(".gx-asset-thumb[data-ctx='asset:generation:gen_cut']").click({ button: "right", force: true });
  const item = page.getByTestId("context-menu").getByRole("menuitem", { name: "Recreate" });
  await expect(item).toBeDisabled();
  await expect(item).toHaveAttribute("title", why);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("context-menu")).toHaveCount(0);
  /* A dub is filed as an ordinary audio take; its params say what made it. */
  const close = page.getByTestId("close-inspector");
  if (info.project.name !== "workbench-1440x900" && await close.isVisible()) await close.click();
  inspector = await inspect(page, "gen_dub");
  await expect(inspector.getByTestId("inspector-recreate")).toBeDisabled();
  await expect(inspector.getByTestId("inspector-recreate-why")).toHaveText(why);
  expect(errors).toEqual([]);
});

test("a member recreates a connected-account take on this workspace's engines, and the card says so", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  const connected = generation({
    id: "gen_account", kind: "video", model: "seedance_2_5", title: "Account take", prompt: "a gull over the breakwater", provider: "higgsfield",
    params: { task: "connected-generation", consumerCreditUnit: "higgsfield_credits", outputType: "video", duration: 5.04, settings: { aspect_ratio: "9:16", resolution: "720p", duration: 6 } },
  });
  const { errors } = await open(page, { member: true, generations: [connected] });
  const inspector = await inspect(page, "gen_account");
  await inspector.getByTestId("inspector-recreate").click();
  await expect(page.getByTestId("gen-prompt")).toHaveValue("a gull over the breakwater");
  await expect(page.getByTestId("gen-model")).toContainText("Studio engine");
  const model = page.getByTestId("gen-recipe-chips").locator("li[data-chip='model']");
  await expect(model).toHaveAttribute("data-state", "changed");
  /* The account's catalogue id is not a name: it is not dressed up as one. */
  await expect(model).toHaveText("Account model → Seedance 2.5");
  await expect(page.getByTestId("gen-recipe-why")).toHaveText("Model The connected account is the owner’s");
  /* The settings the account was asked for still carry over where this engine offers them. */
  await expect(page.getByRole("group", { name: "Aspect" }).getByRole("button", { name: "9:16" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("gen-length")).toHaveValue("6");
  await expect(page.getByTestId("gen-generate")).toHaveText("Generate · 31 cr");
  /* Dismissing the card leaves the member's own engine choice where it was. */
  await page.getByTestId("gen-recipe-dismiss").click();
  await expect(page.getByTestId("gen-model")).toContainText("Seedance 2.5");
  expect(await noOverflow(page)).toBe(true);
  expect(errors).toEqual([]);
});

test("the owner's Soul take waits for the account's identities, and one no longer there is dropped, never sent", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  const soul = generation({
    id: "gen_soul", kind: "image", model: "soul_2", title: "Soul portrait", prompt: "a keeper on the pier at first light", provider: "higgsfield",
    params: { task: "connected-generation", consumerCreditUnit: "higgsfield_credits", outputType: "image", settings: { aspect_ratio: "3:4", soul_id: "soul_gone", enhance_prompt: true } },
  });
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const connectedQuotes: { input: { parameters: Record<string, unknown> } }[] = [];
  const setup = async (page: Page) => {
    const me = await page.request.get("/api/me").then((r) => r.json());
    await page.route("**/api/me", (route) => route.fulfill({ json: { ...me, owner: true } }));
    await page.route("**/api/higgsfield/consumer/connection", (route) => route.fulfill({ json: { connected: true, requiresReconnect: false } }));
    await page.route("**/api/higgsfield/consumer/generation", async (route) => {
      const body = route.request().postDataJSON() as { action: string; input: { parameters: Record<string, unknown> } };
      if (body.action === "catalogue") return route.fulfill({ json: { catalogue: { models: [
        { id: "soul_2", name: "Soul 2", outputType: "image", aspectRatios: ["1:1", "3:4"], medias: [{ name: "image", roles: ["image_references"], max: 1 }], parameters: [{ name: "soul_id", type: "string" }] },
      ], unlim: { available: false, remaining: null, expiresAt: null }, complete: true, fetchedAt: Date.now() } } });
      if (body.action === "characters") {
        await held;
        return route.fulfill({ json: { connected: true, available: true, characters: [{ soulId: "soul_here", name: "Keeper", type: "soul_2", status: "ready", previewUrl: null }] } });
      }
      /* A connected price read is refused here: the block under test sits in front of it. */
      if (body.action === "quote") { connectedQuotes.push(body); return route.fulfill({ status: 409, json: { error: "No connected price in this test." } }); }
      return route.fulfill({ status: 400, json: { error: "unexpected" } });
    });
  };
  const { errors, priced } = await open(page, { generations: [soul], setup });
  const inspector = await inspect(page, "gen_soul");
  await inspector.getByTestId("inspector-recreate").click();
  await expect(page.getByTestId("gen-model")).toContainText("Soul 2");
  await expect(page.getByTestId("gen-recipe-chips").locator("li[data-chip='identity']")).toHaveAttribute("data-state", "reading");
  await expect(page.getByTestId("gen-blocked")).toHaveText("Reading the account’s identities…");
  await expect(page.getByTestId("gen-generate")).toBeDisabled();
  /* A take enhanced on the account is enhanced there again: Auto follows the take (and Undo puts it back). */
  await expect(page.getByRole("switch", { name: "Auto" })).toHaveAttribute("aria-checked", "true");
  release();
  await expect(page.getByTestId("gen-recipe-chips").locator("li[data-chip='identity']")).toHaveText("Identity → none");
  await expect(page.getByTestId("gen-recipe-why").locator("li[data-note='identity']")).toHaveText("Identity No longer on the account");
  await expect(page.getByTestId("gen-identity-pick")).toHaveValue("");
  await expect(page.getByTestId("gen-blocked")).not.toHaveText("Reading the account’s identities…");
  /* Once the list is read, no price is asked with the identity that is gone. */
  await expect.poll(() => connectedQuotes.at(-1)?.input.parameters).toBeDefined();
  expect(connectedQuotes.at(-1)!.input.parameters).not.toHaveProperty("soul_id");
  /* The owner who moves to Studio engines is told that, not that the account is someone else's. */
  await page.getByTestId("gen-model").click();
  const sheet = page.getByRole("dialog", { name: "Choose a model" });
  await sheet.getByRole("tab", { name: "Studio engines" }).click();
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId("gen-recipe-chips").locator("li[data-chip='model']")).toHaveText(/^Account model → /);
  await expect(page.getByTestId("gen-recipe-why").locator("li[data-note='model']")).toHaveText("Model Studio engines chosen");
  await page.getByTestId("gen-recipe-undo").click();
  await expect(page.getByRole("switch", { name: "Auto" })).toHaveAttribute("aria-checked", "false");
  expect(priced).toEqual([]);
  expect(errors).toEqual([]);
});

test("an engine that is gone lands on the nearest size at or below the take's, and says why", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  const retired = generation({
    id: "gen_retired", kind: "video", model: "retired-engine-v1", title: "Old engine take", prompt: "a lighthouse at night",
    params: { rawPrompt: "a lighthouse at night", ratio: "16:9", resolution: "4k", duration: 5 },
  });
  const { errors, priced } = await open(page, { generations: [retired] });
  const inspector = await inspect(page, "gen_retired");
  await inspector.getByTestId("inspector-recreate").click();
  const chips = page.getByTestId("gen-recipe-chips");
  await expect(chips.locator("li[data-chip='model']")).toHaveAttribute("data-state", "changed");
  await expect(page.getByTestId("gen-recipe-why").locator("li[data-note='model']")).toHaveText("Model Not offered here now");
  /* 4k is not offered: the nearest below it, never the list's smallest. */
  await expect(chips.locator("li[data-chip='resolution']")).toHaveText("4k → 1080p");
  await expect(page.getByRole("group", { name: "Resolution" }).getByRole("button", { name: "1080p" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("gen-recipe-why").locator("li[data-note='resolution']")).toHaveText(/^Resolution .+ has no 4k$/);
  await expect(page.getByTestId("gen-generate")).toHaveText("Generate · 31 cr");
  expect(priced).toEqual([]);
  expect(errors).toEqual([]);
});

test("when the engines cannot be read, the card gives the composer's one reason and no per-setting noise", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  const failed = "The available models could not be read.";
  const { errors } = await open(page, {
    generations: [harbour(), plate()],
    setup: async (page) => { await page.route(/\/api\/workbench\/engines$/, (route) => route.fulfill({ status: 500, json: { error: failed } })); },
  });
  const inspector = await inspect(page, "gen_harbour");
  await inspector.getByTestId("inspector-recreate").click();
  await expect(page.getByTestId("gen-recipe-refs")).toHaveText("1 of 2 refs");
  /* The model, the references and the shot setup (which lands on the chips whatever the engines say); no per-setting chips. */
  const chips = page.getByTestId("gen-recipe-chips").locator("li");
  await expect(chips).toHaveCount(3);
  await expect(chips.first()).toHaveText("Seedance 2.0 → none");
  await expect(chips.last()).toHaveText("Close-up · Push in");
  await expect(page.getByTestId("gen-recipe-why").locator("li[data-note='model']")).toHaveText(`Model ${failed}`);
  await expect(page.getByTestId("gen-recipe-why").locator("li")).toHaveCount(2);
  await expect(page.getByTestId("gen-generate")).toBeDisabled();
  expect(errors).toEqual([]);
});

test("from a page's Library, the card lands where it can be read, clear of the sticky Generate", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors } = await open(page, { url: "/suites?suite=particl&page=boards&sp=boards" });
  const wide = info.project.name === "workbench-1440x900" || info.project.name === "workbench-1920x1080";
  if (!wide) await page.getByTestId("toggle-library").click();
  const library = page.getByTestId("library");
  await library.getByRole("tab", { name: /Assets/ }).click();
  await library.locator(".gx-asset-thumb[data-ctx='asset:generation:gen_harbour']").click({ button: "right" });
  await page.getByTestId("context-menu").getByRole("menuitem", { name: "Recreate" }).click();
  await expect(page.getByTestId("gen-view")).toBeVisible();
  await expect(page.getByTestId("gen-recipe-refs")).toHaveText("1 of 2 refs");
  await expect(page.getByTestId("gen-recipe-setup")).toContainText("Close-up · Push in");
  if (PORTRAIT.includes(info.project.name)) await landsClear(page);
  else await expect(page.getByTestId("gen-recipe")).toBeInViewport();
  await shot(page, info, "from-library");
  expect(await noOverflow(page)).toBe(true);
  expect(errors).toEqual([]);
});
