import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { createClient } from "@libsql/client";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { smallTargets, smallText } from "./phoneFloors";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";

/**
 * Recreate (idea 7): a take's whole recipe — the words as typed, the model,
 * its aspect, size and length, the references in order, the shot setup —
 * lands in Gen even when Gen is already open, says what it could not keep,
 * and is priced again on the button before anything runs. Undo puts the
 * composer back; Use settings only keeps the person's own words; Copy prompt
 * copies the words alone. Nothing here submits: paid routes fail the test.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
/* RECREATE_SHOTS=<dir> saves the finished card at the two sizes the review looks at. */
const SHOTS = ["workbench-390x844", "workbench-1440x900"];

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
const plate = () => generation({ id: "gen_plate", kind: "image", title: "Plate still", prompt: "a still of the pier" });
const edit = () => generation({ id: "gen_cut", kind: "video", title: "Trimmed cut", prompt: "trim the end", task: "edit", model: "dreamina-seedance-2-5-260628" });

async function open(page: Page, options: { member?: boolean; generations?: ReturnType<typeof generation>[] } = {}) {
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
  await mockLibrary(page, { uploads: [], generations: options.generations ?? [harbour(), plate(), edit()] });
  await page.route("**/api/prompt/enhance", (route) => route.fulfill({ json: { model: "m", effort: "auto", estimateCredits: 1 } }));
  /* The references are read again in this workspace: the still is there (a beat later), the upload is gone. */
  await page.route(/\/api\/jobs\/gen_plate(\?.*)?$/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 700));
    return route.fulfill({ json: { generation: plate() } });
  });
  await page.route(/\/api\/uploads\/up_gone\/metadata$/, (route) => route.fulfill({ status: 404, json: { error: "This asset is unavailable in the current workspace." } }));
  /* The composer's price reads (GET, never a charge) are answered here so the figure is known; the list itself is real. */
  const quotes: URLSearchParams[] = [];
  await page.route(/\/api\/workbench\/engines\?.*model=/, (route) => {
    quotes.push(new URL(route.request().url()).searchParams);
    return route.fulfill({ json: { credits: 31 } });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/suites?view=gen");
  await expect(page.getByTestId("gen-view")).toBeVisible();
  await expect(page.getByTestId("project-name")).toHaveText("Harbour recreate study");
  return { errors, quotes };
}

/** Opens a take from Gen's own results in the Inspector (a column when wide, an overlay on a phone). */
async function inspect(page: Page, id: string) {
  await page.getByTestId("gen-view").locator(`.gx-asset-thumb[data-ctx='asset:generation:${id}']`).click();
  const inspector = page.getByTestId("asset-inspector");
  await expect(inspector).toBeVisible();
  return inspector;
}

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

async function shot(page: Page, info: TestInfo, name: string) {
  const dir = process.env.RECREATE_SHOTS;
  if (!dir || !SHOTS.includes(info.project.name)) return;
  await page.getByTestId("gen-view").evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).filter((a) => a.effect && Number(a.effect.getTiming().iterations) !== Infinity).map((a) => a.finished)));
  await page.screenshot({ path: `${dir}/${name}-${info.project.name.replace("workbench-", "")}.png`, animations: "disabled" });
}

test("Recreate lands the whole recipe in a Gen that is already open, names what is missing, and prices it again", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, quotes } = await open(page);
  const prompt = page.getByTestId("gen-prompt");
  await prompt.fill("my own words");

  const inspector = await inspect(page, "gen_harbour");
  await expect(inspector.getByTestId("inspector-recreate")).toBeEnabled();
  await inspector.getByTestId("inspector-recreate").click();
  await expect(page.getByTestId("toast")).toHaveText("Recreating Harbour dusk — priced again before it runs.");

  /* The words as typed, the model, and each setting, applied in the open composer. */
  const card = page.getByTestId("gen-recipe");
  await expect(card).toBeVisible();
  await expect(card).toBeInViewport();
  await expect(page.getByTestId("gen-recipe-name")).toHaveText("Harbour dusk");
  await expect(prompt).toHaveValue(RAW);
  await expect(page.getByTestId("gen-model")).toContainText("Seedance 2.0");
  await expect(page.getByRole("group", { name: "Aspect" }).getByRole("button", { name: "21:9" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("group", { name: "Resolution" }).getByRole("button", { name: "1080p" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("gen-length")).toHaveValue("8");

  /* References are read again: a moment of reading, then the one still there, in order, and the one that is gone. */
  const refs = page.getByTestId("gen-recipe-refs");
  await expect(refs).toHaveAttribute("data-state", "reading");
  await expect(refs).toHaveText("2 refs…");
  await expect(refs).toHaveText("1 of 2 refs");
  await expect(refs).toHaveAttribute("data-state", "changed");
  await expect(page.getByTestId("gen-well")).toContainText("@Image1 · Plate still");
  await expect(page.getByTestId("gen-recipe-missing")).toHaveText("Not found: @Image2 (upload)");
  await expect(page.getByTestId("gen-recipe-chips").locator("li[data-state='kept']")).toHaveText(["Seedance 2.0", "21:9", "1080p", "8 s"]);
  await expect(page.getByTestId("gen-recipe-why")).toHaveCount(0);

  /* Priced again, exactly as recreated, before anything runs. */
  await expect(page.getByTestId("gen-generate")).toHaveText("Generate · 31 cr");
  const asked = quotes.at(-1)!;
  expect(Object.fromEntries(["model", "ratio", "resolution", "duration", "genId"].map((k) => [k, asked.get(k)]))).toEqual({
    model: "dreamina-seedance-2-0-260128", ratio: "21:9", resolution: "1080p", duration: "8", genId: "gen_plate",
  });
  expect(asked.has("uploadId")).toBe(false);

  /* The shot setup travels as words: named from the bank, written in once. */
  const setup = page.getByTestId("gen-recipe-setup");
  await expect(setup).toContainText("Close-up · Push in");
  await setup.getByTestId("gen-recipe-setup-add").click();
  await expect(prompt).toHaveValue(/^harbour at dusk, @Image1 walks the pier\. Close-up\.\n\nThe camera travels forward/);
  await expect(setup.getByTestId("gen-recipe-setup-in")).toHaveText("In the prompt");
  await expect(setup.getByTestId("gen-recipe-setup-add")).toHaveCount(0);

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

test("a take from a tool Gen does not have cannot be recreated, and says why", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  const { errors } = await open(page);
  const inspector = await inspect(page, "gen_cut");
  await expect(inspector.getByTestId("inspector-recreate")).toBeDisabled();
  await expect(inspector.getByTestId("inspector-settings-only")).toBeDisabled();
  await expect(inspector.getByTestId("inspector-recreate-why")).toHaveText("Made with a tool Gen does not have. Run it again from that tool.");
  await expect(inspector.getByTestId("inspector-copy-prompt")).toBeEnabled();
  /* The right-click menu says the same. */
  await page.getByTestId("gen-view").locator(".gx-asset-thumb[data-ctx='asset:generation:gen_cut']").click({ button: "right", force: true });
  const item = page.getByTestId("context-menu").getByRole("menuitem", { name: "Recreate" });
  await expect(item).toBeDisabled();
  await expect(item).toHaveAttribute("title", "Made with a tool Gen does not have. Run it again from that tool.");
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
  await expect(page.getByTestId("gen-recipe-why")).toHaveText("Model The connected account is the owner’s");
  /* The settings the account was asked for still carry over where this engine offers them. */
  await expect(page.getByRole("group", { name: "Aspect" }).getByRole("button", { name: "9:16" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("gen-length")).toHaveValue("6");
  await expect(page.getByTestId("gen-generate")).toHaveText("Generate · 31 cr");
  expect(await noOverflow(page)).toBe(true);
  expect(errors).toEqual([]);
});
