import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, upload } from "./helpers/workspaceFixtures";

/**
 * Business, standalone (owner's rule, 23 September): nothing of the connected
 * account's own library is listed or sent. A product or a setting is a still
 * from this project's Library, avatars, hooks and settings are the engine's
 * presets, and nothing asks for an id from a command line. Setup's Use in Ads
 * / Use in Image ads is added to the ad being built, once; the composer keeps
 * its draft across the trip; a finished job sits beside the composer and
 * re-reads the project's Library. Connected-account replies are route mocks;
 * nothing is billed.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const SHOTS = process.env.BZ_SHOTS;
const fixture = (): Project => ({ ...newProject("Coastal light study"), id: "ws-biz", productionProjectId: "prod-ws", shotMappings: {} });
const VIDEO_MODEL = { id: "marketing_studio_video", name: "Marketing Studio", outputType: "video", aspectRatios: ["auto", "16:9", "1:1", "9:16"], durationRange: { min: 4, max: 20 }, medias: [{ name: "medias", roles: ["image", "start_image", "end_image"] }], parameters: [{ name: "resolution", options: ["480p", "720p", "1080p"] }, { name: "mode" }, { name: "hook_id" }, { name: "setting_id" }, { name: "avatar_ids" }, { name: "generate_audio" }] };
const IMAGE_MODEL = { id: "marketing_studio_image", name: "Marketing Studio Image", outputType: "image", aspectRatios: ["auto", "1:1", "9:16"], medias: [{ name: "medias", roles: ["image"] }], parameters: [{ name: "resolution", options: ["1k", "2k", "4k"] }] };
const DTC_MODEL = { id: "ms_image", name: "DTC Ads", outputType: "image", aspectRatios: ["1:1", "9:16", "auto"], medias: [{ name: "medias", roles: ["image"], max: 14 }], parameters: [{ name: "style_id" }, { name: "brand_kit_id" }, { name: "resolution", options: ["1k", "2k", "4k"] }, { name: "quality", options: ["low", "medium", "high"] }, { name: "batch_size" }, { name: "product_ids" }] };
/** What the setup route answers for a standalone workspace: the engine's presets, nothing of the account's own. */
type Item = { id: string; name: string; meta: string; previewUrl?: string };
const STANDALONE: Record<string, Item[]> = {
  avatar: [{ id: "av_ava", name: "Ava", meta: "avatar · preset", previewUrl: "/campaign/hero.webp" }],
  product: [], brand_kit: [], ad_reference: [],
  hook: [{ id: "h1", name: "Stop scrolling", meta: "hook · preset" }],
  setting: [{ id: "s1", name: "Sunlit kitchen", meta: "setting · preset" }],
  image_style: [{ id: "st_bold", name: "Bold launch", meta: "image style" }],
};
const NOTHING: Record<string, Item[]> = { avatar: [], product: [], brand_kit: [], ad_reference: [], hook: [], setting: [], image_style: [] };

const TAKE = `gen_hfc_${"a".repeat(40)}`;
async function open(page: Page, sp: "ads" | "dtc" | "setup", options: { reads?: typeof STANDALONE; init?: string; setupStatus?: number } = {}) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, {
    uploads: [upload({ id: "up_plate", filename: "harbour-plate.webp" }), upload({ id: "up_room", filename: "studio-room.webp" }), upload({ id: "up_clip", filename: "walkthrough.mp4", mime: "video/mp4", kind: "video" })],
    generations: [generation({ id: "g_bottle", title: "Bottle hero" })],
  });
  /* Registered after the Library mock, so it sees every read first (routes run newest first) and falls through to it. */
  let libraryReads = 0;
  await page.route("**/api/workbench/library**", (route) => { if (route.request().method() === "GET") libraryReads++; return route.fallback(); });
  const me = await page.request.get("/api/me").then((r) => r.json());
  await page.route("**/api/me", (route) => route.fulfill({ json: { ...me, owner: true } }));
  await page.route("**/api/higgsfield/consumer/connection", (route) => route.fulfill({ json: { connected: true, requiresReconnect: false } }));
  const requests: Record<string, unknown>[] = [];
  await page.route("**/api/higgsfield/consumer/generation", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    requests.push(body);
    if (body.action === "catalogue") return route.fulfill({ json: { catalogue: { models: body.type === "image" ? [IMAGE_MODEL, DTC_MODEL] : [VIDEO_MODEL], unlim: { available: false, remaining: null, expiresAt: null }, complete: true, fetchedAt: Date.now() } } });
    const input = (body.input ?? requests.find((r) => r.action === "quote")?.input) as Record<string, unknown> | undefined;
    const job = (status: string) => ({ id: "9d2b3c4e-5f60-4a7b-8c9d-0e1f2a3b4c5d", draftId: "ws-biz", workflow: "generation", status, model: input?.model === "marketing_studio_video" ? VIDEO_MODEL : IMAGE_MODEL, input, workspaceId: "1f2e3d4c-5b6a-4798-8a9b-0c1d2e3f4a5b", workspaceName: "Connected wallet", quoteCredits: 40, creditUnit: "higgsfield_credits", quoteExpiresAt: Date.now() + 300_000, createdAt: Date.now(), providerJobId: status === "quoted" ? null : "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d", tool: null, result: null, originalAvailable: false, sources: [] });
    if (body.action === "quote") return route.fulfill({ json: { job: job("quoted") } });
    if (body.action === "submit") return body.credits === 40 ? route.fulfill({ json: { job: job("accepted") } }) : route.fulfill({ status: 409, json: { error: "Review the quote again." } });
    /* A finished image job carries its filed original (Particl's copy, at /api/media); the video one is filed without a preview here. */
    if (body.action === "status") {
      const done = job("completed"), image = done.model.outputType === "image";
      const original = { generationId: TAKE, providerJobId: done.providerJobId, creditUnit: "higgsfield_credits", credits: 40, sha256: "b".repeat(64), bytes: 2048,
        asset: { generationId: TAKE, mime: "image/webp", url: `/api/media/${TAKE}`, kind: "image" } };
      return route.fulfill({ json: { job: image ? { ...done, originalAvailable: true, originalAvailability: "available", result: { original } } : done } });
    }
    return route.fulfill({ status: 400, json: { error: "unexpected" } });
  });
  await page.route("**/api/higgsfield/consumer/marketing-templates**", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { connection: { connected: true, requiresReconnect: false }, capabilities: {}, jobs: [] } });
    return route.fulfill({ json: { catalogue: { templates: [], matched: 0, total: 0, loaded: 0, complete: true, fetchedAt: Date.now(), categories: [], costsVersion: "v1" } } });
  });
  const reads = options.reads ?? STANDALONE;
  const setupReads: string[][] = [];
  await page.route("**/api/higgsfield/consumer/video", async (route) => {
    const body = route.request().postDataJSON() as { action: string; types?: string[] };
    if (body.action !== "setup") return route.fulfill({ status: 400, json: { error: "unexpected" } });
    const types = body.types ?? Object.keys(reads);
    setupReads.push(types);
    if (options.setupStatus) return route.fulfill({ status: options.setupStatus, json: { error: "The connected account could not be read. Try again in a moment." } });
    return route.fulfill({ json: { connected: true, reads: types.map((type) => ({ type, available: true, items: reads[type].map((i) => ({ previewUrl: null, ...i, type })) })) } });
  });
  await page.route("**/api/prompt/enhance", (route) => route.fulfill({ json: { model: "m", effort: "auto", estimateCredits: 1 } }));
  if (options.init) await page.addInitScript(options.init);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  /* React's own errors count too (a done job once toasted in a loop); a missing optional read's 404 does not. */
  page.on("console", (m) => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text().slice(0, 200)); });
  await page.goto(`/suites?suite=moleculr&page=marketing&sp=${sp}`);
  await expect(page.getByTestId("project-name")).toHaveText("Coastal light study");
  return { errors, requests, libraryReads: () => libraryReads, setupReads };
}

const lastQuote = (requests: Record<string, unknown>[]) => [...requests].reverse().find((r) => r.action === "quote") as { input: { model: string; parameters: Record<string, unknown>; medias: unknown[] } } | undefined;
async function noCommandLine(page: Page) {
  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/higgsfield marketing-studio|--json|--url|--video-input/);
  await expect(page.getByRole("textbox", { name: / id$/ })).toHaveCount(0);
}
async function noSideScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
}
async function shot(page: Page, name: string, project: string) {
  if (!SHOTS || !["workbench-1440x900", "workbench-390x844"].includes(project) && !name.startsWith("setup-detail")) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}-${project.replace("workbench-", "")}.png`, fullPage: false });
}

test("Ads: product and setting are stills from this project, the avatar an engine preset, and the finished ad sits beside the composer and re-reads the Library", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, requests, libraryReads } = await open(page, "ads");
  await expect(page.getByTestId("ads-view")).toBeVisible();
  await expect(page.getByTestId("ads-hook").getByRole("button", { name: "Stop scrolling" })).toBeVisible();
  /* Standalone: no command line, no id boxes, and a type with nothing of Particl's is not shown at all. */
  await noCommandLine(page);
  await expect(page.getByTestId("ads-adref")).toHaveCount(0);
  await expect(page.getByTestId("business-sources")).toHaveCount(0);

  /* The avatar chip wears its preview. */
  const ava = page.getByTestId("ads-avatar").getByRole("button", { name: "Ava" });
  await expect(ava.locator("img")).toHaveAttribute("src", "/campaign/hero.webp");
  await ava.click();
  await expect(ava).toHaveAttribute("aria-pressed", "true");
  if (PHONES.includes(info.project.name)) expect((await ava.boundingBox())!.height).toBeGreaterThanOrEqual(44);

  /* Product: pick a still from this project's Library (pictures only). */
  const choose = page.getByTestId("ads-product-choose");
  if (PHONES.includes(info.project.name)) expect((await choose.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await choose.click();
  const stills = page.getByTestId("ads-product-stills");
  await expect(stills.getByRole("button", { name: "harbour-plate.webp" })).toBeVisible();
  await expect(stills.getByRole("button", { name: "walkthrough.mp4" })).toHaveCount(0);
  await expect(stills.getByRole("button", { name: "Upload" })).toBeVisible();
  await shot(page, "ads-product-picker", info.project.name);
  await stills.getByRole("button", { name: "harbour-plate.webp" }).click();
  await expect(page.getByTestId("ads-product-name")).toHaveText("harbour-plate.webp");
  await expect(stills).toHaveCount(0);

  /* Setting: a still too; the engine's preset settings sit beside it. */
  await expect(page.getByTestId("ads-setting").getByRole("button", { name: "Sunlit kitchen" })).toBeVisible();
  await page.getByTestId("ads-setting-choose").click();
  await page.getByTestId("ads-setting-stills").getByRole("button", { name: "studio-room.webp" }).click();
  await expect(page.getByTestId("ads-setting-name")).toHaveText("studio-room.webp");

  await page.getByTestId("ads-prompt").fill("Morning routine with the bottle on the sill.");
  await expect(page.getByTestId("ads-generate")).toHaveText("Generate ad · 40 cr");
  const quote = lastQuote(requests)!;
  expect(quote.input.model).toBe("marketing_studio_video");
  expect(quote.input.parameters).toEqual({ mode: "ugc", aspect_ratio: "9:16", duration: 15, resolution: "720p", generate_audio: true, avatar_ids: ["av_ava"] });
  expect(quote.input.medias).toEqual([{ role: "image", source: { uploadId: "up_plate" } }, { role: "image", source: { uploadId: "up_room" } }]);
  await noSideScroll(page);
  await page.getByTestId("ads-product").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await shot(page, "ads-standalone", info.project.name);

  const before = libraryReads();
  await page.getByTestId("ads-generate").click();
  await expect(page.getByTestId("ads-done")).toContainText("Rendered and filed to this project.", { timeout: 15_000 });
  await expect(page.getByTestId("ads-done").getByRole("button", { name: "Open Takes" })).toBeVisible();
  /* One message, not two: the toast is gone. */
  await expect(page.getByText("Rendered and filed to this project.")).toHaveCount(1);
  /* Takes and the Library read one store: it is re-read once the job finishes. */
  await expect.poll(libraryReads).toBeGreaterThan(before);
  /* The same input is priced again at once: Generate is the rerun. */
  await expect(page.getByTestId("ads-generate")).toHaveText("Generate ad · 40 cr");
  await expect(page.getByTestId("ads-generate")).toBeEnabled();
  await expect(page.getByTestId("ads-done")).toBeVisible();
  await page.getByTestId("ads-done").evaluate((el) => el.scrollIntoView({ block: "center" }));
  await shot(page, "ads-done", info.project.name);
  expect(errors).toEqual([]);
});

test("Setup lists only what Particl may use, and Use in Image ads lands once — the pick is spent, never pre-selected later", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  const { errors, requests } = await open(page, "setup");
  await expect(page.getByTestId("setup-view")).toBeVisible();
  await expect(page.getByTestId("setup-avatar")).toContainText("Ava");
  await expect(page.getByTestId("setup-avatar")).toContainText("Engine presets");
  await expect(page.getByTestId("setup-image_style")).toContainText("Bold launch");
  for (const type of ["product", "brand_kit", "ad_reference"]) await expect(page.getByTestId(`setup-${type}`)).toHaveCount(0);
  await noCommandLine(page);
  await noSideScroll(page);
  await shot(page, "setup", info.project.name);

  await page.getByTestId("setup-image_style").getByRole("button", { name: /Bold launch/ }).click();
  await expect(page.getByTestId("setup-detail")).toContainText("Bold launch");
  await expect(page.getByTestId("setup-detail").getByRole("button", { name: "Use in Ads" })).toHaveCount(0);
  await page.getByTestId("setup-detail").getByRole("button", { name: "Use in Image ads" }).click();
  await expect(page.getByTestId("image-ads-view")).toBeVisible();
  await expect(page.getByTestId("dtc-engine-ms_image")).toHaveAttribute("aria-selected", "true");
  /* The engine switch is a phone target too. */
  if (info.project.name === "workbench-390x844")
    for (const id of ["dtc-engine-marketing_studio_image", "dtc-engine-ms_image"]) expect((await page.getByTestId(id).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByTestId("dtc-style").getByRole("button", { name: "Bold launch" })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("particl-business-preset"))).toBeNull();

  /* The image ad's product is a still from this project, first among the references. */
  await page.getByTestId("dtc-product-choose").click();
  await page.getByTestId("dtc-product-stills").getByRole("button", { name: "Bottle hero" }).click();
  await expect(page.getByTestId("dtc-product-name")).toHaveText("Bottle hero");
  await page.getByTestId("dtc-prompt").fill("Bold hero shot on marble");
  await expect(page.getByTestId("dtc-generate")).toContainText("40 cr");
  const quote = lastQuote(requests)!;
  expect(quote.input.model).toBe("ms_image");
  expect(quote.input.parameters).toMatchObject({ style_id: "st_bold" });
  expect(quote.input.parameters).not.toHaveProperty("product_ids");
  expect(quote.input.medias).toEqual([{ role: "image", source: { genId: "g_bottle" } }]);
  await noSideScroll(page);
  await shot(page, "image-ads", info.project.name);
  /* The finished still sits beside the composer, from Particl's own copy. */
  await page.getByTestId("dtc-generate").click();
  await expect(page.getByTestId("dtc-done-take").locator("img")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("dtc-done")).toContainText("Rendered and filed to this project.");
  await expect(page.getByTestId("dtc-generate")).toContainText("40 cr");
  await page.getByTestId("dtc-done").evaluate((el) => el.scrollIntoView({ block: "center" }));
  await noSideScroll(page);
  await shot(page, "image-ads-done", info.project.name);
  expect(errors).toEqual([]);
});

test("a pick older than two minutes is spent on arrival, not applied", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one viewport");
  const stale = `sessionStorage.setItem("particl-business-preset", JSON.stringify({ page: "ads", type: "hook", id: "h1", name: "Stop scrolling", at: Date.now() - 600000 }));`;
  await open(page, "ads", { init: `if (!sessionStorage.getItem("bz-seeded")) { sessionStorage.setItem("bz-seeded", "1"); ${stale} }` });
  await expect(page.getByTestId("ads-hook").getByRole("button", { name: "Stop scrolling" })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("ads-hook").getByRole("button", { name: "None" })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("particl-business-preset"))).toBeNull();
});

test("when there is nothing to set up, Setup says so with a way on, and the Ads pickers step aside", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  const { errors } = await open(page, "setup", { reads: NOTHING });
  await expect(page.getByTestId("setup-empty")).toContainText("Nothing to set up yet");
  await expect(page.getByTestId("setup-count")).toHaveText("0 items");
  await noCommandLine(page);
  await shot(page, "setup-empty", info.project.name);
  await page.getByTestId("setup-empty").getByRole("button", { name: "Open Ads" }).click();
  await expect(page.getByTestId("ads-view")).toBeVisible();
  /* The product slot is always there: this project's Library is the source. */
  await expect(page.getByTestId("ads-product-choose")).toBeVisible();
  for (const id of ["ads-avatar", "ads-hook", "ads-adref"]) await expect(page.getByTestId(id)).toHaveCount(0);
  await noCommandLine(page);
  expect(errors).toEqual([]);
});

test("a product still uploads from the device straight into the slot", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one viewport");
  const filed: string[] = [];
  await open(page, "ads");
  await page.route("**/api/workbench/library", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    filed.push((route.request().postDataJSON() as { uploadId: string }).uploadId);
    return route.fulfill({ json: { ok: true } });
  });
  await page.getByTestId("ads-product-choose").click();
  await page.getByTestId("ads-product-file").setInputFiles("public/campaign/hero.webp");
  await expect(page.getByTestId("ads-product-name")).toHaveText("hero.webp", { timeout: 30_000 });
  expect(filed).toHaveLength(1);
});

test("the server refuses a quote naming a connected-account item Particl did not make, before anything is priced", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one viewport");
  const account = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json()) as { id: string };
  const headers = { "X-Workbench-Scope": `particl-active-${account.workspace.id}-${me.id}` };
  const quote = (parameters: Record<string, unknown>) => page.request.post("/api/higgsfield/consumer/generation", { headers, data: {
    action: "quote", draftId: "ws-biz", idempotencyKey: crypto.randomUUID(),
    input: { type: "video", model: "marketing_studio_video", prompt: "A bottle on the sill.", parameters: { mode: "ugc", ...parameters }, medias: [] },
  } });
  /* Owned types and backend assets refuse from Particl's record alone (a preset type would first read the account, which this server does not hold). */
  for (const parameters of [{ product_ids: ["acct_product_1"] }, { brand_kit_id: "acct_kit_1" }, { ad_reference_id: "acct_ref_1" }, { assets: ["acct_asset_1"] }]) {
    const response = await quote(parameters);
    expect(response.status(), JSON.stringify(parameters)).toBe(409);
    expect(await response.json()).toMatchObject({ code: "setup_not_particl" });
  }
  const video = await page.request.post("/api/higgsfield/consumer/video", { headers, data: {
    action: "quote", draftId: "ws-biz", idempotencyKey: crypto.randomUUID(),
    input: { prompt: "A bottle.", duration: 15, resolution: "720p", aspectRatio: "9:16", generateAudio: true, mode: "ugc", productIds: ["acct_product_1"] },
  } });
  expect(video.status()).toBe(409);
  expect(await video.json()).toMatchObject({ code: "setup_not_particl" });
});

test("a setup read that fails is asked once, the error stays with Try again, and nothing loops", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  const { setupReads } = await open(page, "ads", { setupStatus: 502 });
  const error = page.getByTestId("ads-setup-error");
  await expect(error).toContainText("could not be read");
  await page.waitForTimeout(2500);
  expect(setupReads).toHaveLength(1);
  await expect(error).toBeVisible();
  /* No pickers wait forever: the skeletons are gone once the read has failed. */
  await expect(page.locator('[data-testid="ads-view"] [aria-busy="true"]')).toHaveCount(0);
  await error.getByRole("button", { name: "Try again" }).click();
  await expect.poll(() => setupReads.length).toBe(2);
  await page.waitForTimeout(1500);
  expect(setupReads).toHaveLength(2);
  /* Setup: the same — one read on arrival, the error with its own Try again, no endless skeleton. */
  await page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: /Setup/ }).click();
  const setupError = page.getByTestId("setup-error");
  await expect(setupError).toBeVisible();
  await page.waitForTimeout(2000);
  expect(setupReads.length).toBeLessThanOrEqual(3);
  await expect(page.getByTestId("setup-loading")).toHaveCount(0);
  const reads = setupReads.length;
  await setupError.getByRole("button", { name: "Try again" }).click();
  await expect.poll(() => setupReads.length).toBe(reads + 1);
  await noSideScroll(page);
  await shot(page, "setup-error", info.project.name);
});

test("phone: a picked Setup row brings its action into reach, clear of the tab bar", async ({ page }, info) => {
  test.skip(!PHONES.includes(info.project.name), "phones");
  const { errors } = await open(page, "setup");
  await page.getByTestId("setup-setting").getByRole("button", { name: /Sunlit kitchen/ }).tap().catch(() => page.getByTestId("setup-setting").getByRole("button", { name: /Sunlit kitchen/ }).click());
  const use = page.getByTestId("setup-detail").getByRole("button", { name: "Use in Ads" });
  await expect(use).toBeVisible();
  /* Once the scroll settles, the point at the button's centre is the button — not the tab bar, not off screen. */
  await expect.poll(async () => use.evaluate((button) => {
    const box = button.getBoundingClientRect();
    const x = box.left + box.width / 2, y = box.top + box.height / 2;
    if (y < 0 || y > innerHeight) return "off screen";
    const hit = document.elementFromPoint(x, y);
    return hit && (hit === button || button.contains(hit)) ? "reachable" : hit?.className?.toString() ?? "nothing";
  }), { timeout: 5000 }).toBe("reachable");
  expect((await use.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.waitForTimeout(400);
  await shot(page, "setup-detail", info.project.name);
  await use.click();
  await expect(page.getByTestId("ads-setting").getByRole("button", { name: "Sunlit kitchen" })).toHaveAttribute("aria-pressed", "true");
  expect(errors).toEqual([]);
});

test("a trip to Setup and back keeps the ad being built; the pick is added to it", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  const { errors, requests } = await open(page, "ads");
  await page.getByTestId("ads-prompt").fill("Morning routine with the bottle on the sill.");
  await page.getByTestId("ads-product-choose").click();
  await page.getByTestId("ads-product-stills").getByRole("button", { name: "harbour-plate.webp" }).click();
  await page.getByTestId("ads-avatar").getByRole("button", { name: "Ava" }).click();
  await page.getByTestId("ads-mode").getByRole("button", { name: "TV spot" }).click();
  await page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: /Setup/ }).click();
  await page.getByTestId("setup-hook").getByRole("button", { name: /Stop scrolling/ }).click();
  await page.getByTestId("setup-detail").getByRole("button", { name: "Use in Ads" }).click();
  await expect(page.getByTestId("ads-view")).toBeVisible();
  await expect(page.getByTestId("ads-prompt")).toHaveValue("Morning routine with the bottle on the sill.");
  await expect(page.getByTestId("ads-product-name")).toHaveText("harbour-plate.webp");
  await expect(page.getByTestId("ads-avatar").getByRole("button", { name: "Ava" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("ads-hook").getByRole("button", { name: "Stop scrolling" })).toHaveAttribute("aria-pressed", "true");
  /* A hook needs the UGC family, so the mode moved there rather than dropping the pick. */
  await expect(page.getByTestId("ads-mode").getByRole("button", { name: "UGC", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("ads-generate")).toHaveText("Generate ad · 40 cr");
  expect(lastQuote(requests)!.input.parameters).toMatchObject({ mode: "ugc", avatar_ids: ["av_ava"], hook_id: "h1" });
  /* The draft outlives a reload of the tab, too; the spent pick does not come back. */
  await page.reload();
  await expect(page.getByTestId("ads-prompt")).toHaveValue("Morning routine with the bottle on the sill.");
  await expect(page.getByTestId("ads-product-name")).toHaveText("harbour-plate.webp");
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("particl-business-preset"))).toBeNull();
  await shot(page, "ads-roundtrip", info.project.name);
  expect(errors).toEqual([]);
});
