import { test, expect, type Page, type PlaywrightWorkerArgs } from "@playwright/test";
import { createClient } from "@libsql/client";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { joinLocallyAsMember, localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, mockLibrary, mockMedia, mockProjects, upload } from "./helpers/workspaceFixtures";
import { smallTargets } from "./phoneFloors";

/**
 * Business = Marketing Studio (FINAL_SPEC §2), in the browser.
 *
 * Image ads runs Marketing Studio Image on Particl's API key for every
 * workspace and member: those tests drive the real page against the real
 * routes of a local ENGINE_MOCK server, in a MANAGED workspace (platform keys,
 * credits) — real uploads, the real POST /api/generate/quote on the button,
 * one real POST /api/generate at that figure — and assert that nothing reaches
 * the connected account. Only the preset catalogue read is answered here (in
 * mock mode the provider lists none).
 *
 * Ads and Setup still ride the owner's connected account, against the real
 * shell and route-mocked account replies: the two server rules as disabled
 * chips with their reason, the price on the button from a quote, submit with
 * that exact price, and Setup's pick carried into Ads. (Standalone sourcing:
 * hf-business-standalone-workbench.)
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const fixture = (): Project => ({ ...newProject("Coastal light study"), id: "ws-biz", productionProjectId: "prod-ws", shotMappings: {} });
const VIDEO_MODEL = { id: "marketing_studio_video", name: "Marketing Studio", outputType: "video", aspectRatios: ["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"], durationRange: { min: 4, max: 20 }, medias: [{ name: "medias", roles: ["image", "start_image", "end_image"] }], parameters: [{ name: "resolution", options: ["480p", "720p", "1080p"] }, { name: "mode" }, { name: "hook_id" }, { name: "setting_id" }, { name: "ad_reference_id" }, { name: "product_ids" }, { name: "avatar_ids" }, { name: "generate_audio" }] };
const IMAGE_MODEL = { id: "marketing_studio_image", name: "Marketing Studio Image", outputType: "image", aspectRatios: ["auto", "1:1", "3:2", "9:16"], medias: [{ name: "medias", roles: ["image"] }], parameters: [{ name: "resolution", options: ["1k", "2k", "4k"] }] };
const DTC_MODEL = { id: "ms_image", name: "DTC Ads", outputType: "image", aspectRatios: ["1:1", "9:16", "auto"], medias: [{ name: "medias", roles: ["image"], max: 14 }], parameters: [{ name: "style_id", type: "string" }, { name: "brand_kit_id", type: "string" }, { name: "resolution", options: ["1k", "2k", "4k"] }, { name: "quality", options: ["low", "medium", "high"] }, { name: "batch_size", type: "number" }, { name: "product_ids", type: "string_array" }] };

/* The server answers every job with the input it was admitted with; a status read before any quote in this page still carries it. */
const SAVED_INPUT = { type: "video", model: "marketing_studio_video", prompt: "Morning routine with the bottle on the sill.", parameters: { mode: "ugc", aspect_ratio: "9:16", duration: 15, resolution: "720p", generate_audio: true }, medias: [] };

/**
 * `routes` registers a test's own replies after these (the later route
 * answers first; `route.fallback()` hands a call on to these), before the
 * page loads, so even the first read on mount meets them. `requests` is every
 * call the page sent to the generation route, whichever route answered it.
 */
async function open(page: Page, cp: "ads" | "dtc" | "setup", options: { setupAvailable?: boolean; holdStatus?: Promise<void>; routes?: () => Promise<unknown> } = {}) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, { uploads: [upload({ id: "up_plate", filename: "harbour-plate.webp" })], generations: [] });
  const me = await page.request.get("/api/me").then((r) => r.json());
  await page.route("**/api/me", (route) => route.fulfill({ json: { ...me, owner: true } }));
  await page.route("**/api/higgsfield/consumer/connection", (route) => route.fulfill({ json: { connected: true, requiresReconnect: false } }));
  const requests: Record<string, unknown>[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/higgsfield/consumer/generation") requests.push(request.postDataJSON() as Record<string, unknown>);
  });
  let quoted = 0;
  await page.route("**/api/higgsfield/consumer/generation", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (body.action === "catalogue") return route.fulfill({ json: { catalogue: { models: body.type === "image" ? [IMAGE_MODEL, DTC_MODEL] : [VIDEO_MODEL], unlim: { available: false, remaining: null, expiresAt: null }, complete: true, fetchedAt: Date.now() } } });
    const input = body.input as Record<string, unknown> | undefined;
    const job = (status: string, credits: number) => ({ id: "9d2b3c4e-5f60-4a7b-8c9d-0e1f2a3b4c5d", draftId: "ws-biz", workflow: "generation", status, model: input?.model === "marketing_studio_image" ? IMAGE_MODEL : VIDEO_MODEL, input: input ?? requests.find((r) => r.action === "quote")?.input ?? SAVED_INPUT, workspaceId: "1f2e3d4c-5b6a-4798-8a9b-0c1d2e3f4a5b", workspaceName: "Northline wallet", quoteCredits: credits, creditUnit: "higgsfield_credits", quoteExpiresAt: Date.now() + 300_000, createdAt: Date.now(), providerJobId: status === "quoted" ? null : "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d", tool: null, result: null, originalAvailable: false, sources: [] });
    if (body.action === "quote") { quoted++; return route.fulfill({ json: { job: job("quoted", 40) } }); }
    if (body.action === "submit") {
      if (body.credits !== 40) return route.fulfill({ status: 409, json: { code: "approval_changed", error: "Review this job’s wallet and exact credit quote again." } });
      return route.fulfill({ json: { job: job("accepted", 40) } });
    }
    if (body.action === "status") { await options.holdStatus; return route.fulfill({ json: { job: job("completed", 40) } }); }
    return route.fulfill({ status: 400, json: { error: "unexpected" } });
  });
  await page.route("**/api/higgsfield/consumer/marketing-templates**", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { connection: { connected: true, requiresReconnect: false }, capabilities: {}, jobs: [] } });
    const body = route.request().postDataJSON() as { action: string };
    if (body.action === "catalogue") return route.fulfill({ json: { catalogue: { templates: [
      { id: "tpl_ugc_1", name: "Creator unboxing", category: "ugc", description: "A creator opens the product on camera.", previewUrl: null, outputKind: "video", inputs: ["product_image", "prompt"], credits: 24, priceSource: "cost_table" },
      { id: "tpl_poster_1", name: "Launch poster", category: "posters", description: "A bold launch poster.", previewUrl: null, outputKind: "image", inputs: ["prompt"], credits: 6, priceSource: "cost_table" },
    ], matched: 2, total: 2, loaded: 2, complete: true, fetchedAt: Date.now(), categories: ["posters", "ugc"], costsVersion: "v1" } } });
    return route.fulfill({ status: 400, json: { error: "unexpected" } });
  });
  await page.route("**/api/higgsfield/consumer/video", async (route) => {
    const body = route.request().postDataJSON() as { action: string; types?: string[] };
    if (body.action !== "setup") return route.fulfill({ status: 400, json: { error: "unexpected" } });
    const types = body.types ?? ["product", "avatar", "hook", "setting", "ad_reference", "brand_kit"];
    const items: Record<string, unknown[]> = {
      product: [{ id: "p1", name: "Sneaker Runner", meta: "product · fetched from URL", previewUrl: null }],
      avatar: [{ id: "a1", name: "Maya", meta: "avatar · preset", previewUrl: null }],
      hook: [{ id: "h1", name: "Stop scrolling", meta: "hook · prepended to the prompt", previewUrl: null }],
      setting: [{ id: "s1", name: "Sunlit kitchen", meta: "setting · scene context", previewUrl: null }],
      ad_reference: [{ id: "r1", name: "Founder unboxing.mp4", meta: "ad reference · 18 s", previewUrl: null }],
      brand_kit: [{ id: "bk1", name: "House kit", meta: "brand kit · completed", previewUrl: null }],
      image_style: [{ id: "st_bold", name: "Bold launch", meta: "image style", previewUrl: null }, { id: "st_clean", name: "Clean studio", meta: "image style", previewUrl: null }],
    };
    return route.fulfill({ json: { connected: true, reads: types.map((type) => ({ type, available: options.setupAvailable ?? true, items: options.setupAvailable === false ? [] : items[type].map((i) => ({ ...(i as object), type })) })) } });
  });
  await page.route("**/api/prompt/enhance", (route) => route.fulfill({ json: { model: "m", effort: "auto", estimateCredits: 1 } }));
  await options.routes?.();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/suites?suite=moleculr&page=marketing&sp=${cp}`);
  await expect(page.getByTestId("project-name")).toHaveText("Coastal light study");
  return { errors, requests, quoted: () => quoted };
}

test("Ads: the rules are disabled chips with a reason, the button wears the account's price, and submit carries exactly that price", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, requests } = await open(page, "ads");
  await expect(page.getByTestId("ads-view")).toBeVisible();
  await expect(page.getByTestId("page-title")).toHaveText("Marketing Studio");
  await expect(page.getByTestId("ads-blocked")).toHaveText("Write the prompt.");
  await expect(page.getByTestId("ads-generate")).toBeDisabled();

  /* Hooks and settings only for the UGC family: TV spot greys them with the reason; the picks are cleared. */
  const hook = page.getByTestId("ads-hook");
  await expect(hook.getByRole("button", { name: "Stop scrolling" })).toBeVisible();
  await hook.getByRole("button", { name: "Stop scrolling" }).click();
  await expect(hook.getByRole("button", { name: "Stop scrolling" })).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("ads-mode").getByRole("button", { name: "TV spot" }).click();
  await expect(hook.getByRole("button", { name: "Stop scrolling" })).toHaveAttribute("aria-disabled", "true");
  await expect(hook.getByRole("button", { name: "Stop scrolling" })).toHaveAttribute("title", "Hooks are not for tv_spot.");
  await expect(hook.getByRole("button", { name: "Stop scrolling" })).toHaveAttribute("aria-pressed", "false");
  expect(await hook.getByRole("button", { name: "Stop scrolling" }).evaluate((el) => getComputedStyle(el).opacity)).toBe("0.4");
  await page.getByTestId("ads-mode").getByRole("button", { name: "UGC", exact: true }).click();
  /* An ad reference excludes hooks and settings, and vice-versa. */
  await page.getByTestId("ads-adref").getByRole("button", { name: "Founder unboxing.mp4" }).click();
  await expect(hook.getByRole("button", { name: "Stop scrolling" })).toHaveAttribute("title", "Hooks are valid only for UGC-family modes and never with an ad reference.");
  await expect(page.getByTestId("ads-setting").getByRole("button", { name: "Sunlit kitchen" })).toHaveAttribute("aria-disabled", "true");
  await page.getByTestId("ads-adref").getByRole("button", { name: "None" }).click();
  await hook.getByRole("button", { name: "Stop scrolling" }).click();
  await expect(page.getByTestId("ads-adref").getByRole("button", { name: "Founder unboxing.mp4" })).toHaveAttribute("title", "Clear the hook and setting first.");

  /* 30 s is above this account's range: the clamped value is shown and sent. */
  await page.getByTestId("ads-duration").getByRole("button", { name: "30 s" }).click();
  await expect(page.getByTestId("ads-clamped")).toHaveText("The account caps this at 20 s; that is what will be sent.");
  await page.getByTestId("ads-product").getByRole("button", { name: "Sneaker Runner" }).click();
  await page.getByTestId("ads-prompt").fill("Morning routine with the bottle on the sill.");
  await expect(page.getByTestId("ads-generate")).toHaveText("Generate ad · 40 cr");
  const quote = requests.find((r) => r.action === "quote") as { input: { model: string; parameters: Record<string, unknown> } };
  expect(quote.input.model).toBe("marketing_studio_video");
  expect(quote.input.parameters).toEqual({ mode: "ugc", aspect_ratio: "9:16", duration: 20, resolution: "720p", generate_audio: true, product_ids: ["p1"], hook_id: "h1" });

  await page.getByTestId("ads-generate").click();
  await expect(page.getByTestId("ads-done")).toContainText("Rendered and filed to this project.", { timeout: 15_000 });
  expect(requests.find((r) => r.action === "submit")).toMatchObject({ action: "submit", credits: 40, workspaceId: "1f2e3d4c-5b6a-4798-8a9b-0c1d2e3f4a5b" });
  expect(errors).toEqual([]);
});

/* ── Image ads on Particl's API key: real routes, a managed workspace ── */
const MOCK_KEY_FINGERPRINT = createHash("sha256").update("particl-mock:higgsfield").digest("hex");
async function platform<T>(fn: (db: ReturnType<typeof createClient>) => Promise<T>): Promise<T> {
  const db = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try { return await fn(db); } finally { db.close(); }
}
async function tenant<T>(workspaceId: string, fn: (db: ReturnType<typeof createClient>) => Promise<T>): Promise<T> {
  const url = await platform(async (db) => String((await db.execute({ sql: "SELECT db_url FROM workspaces WHERE id = ?", args: [workspaceId] })).rows[0].db_url));
  expect(url).toMatch(/^file:/);
  const db = createClient({ url, timeout: 10_000 });
  try { return await fn(db); } finally { db.close(); }
}
type KeySeed = { workspaceId: string; consumer: string[]; quotes: Record<string, unknown>[]; sends: Record<string, unknown>[]; errors: string[] };
/** A person in a fresh managed workspace (owner, or a member through the real invitation) with credits and one saved project, opened on Image ads. */
async function openImageAds(page: Page, playwright: PlaywrightWorkerArgs["playwright"], as: "owner" | "member"): Promise<KeySeed> {
  let workspaceId: string;
  if (as === "owner") workspaceId = (await signInLocally(page.request)).workspace.id;
  else {
    const ownerApi = await playwright.request.newContext({ baseURL: process.env.PW_BASE_URL });
    workspaceId = (await joinLocallyAsMember(ownerApi, page.request)).workspace.id;
    await ownerApi.dispose();
  }
  const mode = await platform(async (db) => {
    await db.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), workspaceId, 5000, "Image ads key fixture", "manual", "test", Date.now()] });
    return Number((await db.execute({ sql: "SELECT uses_platform_keys FROM workspaces WHERE id=?", args: [workspaceId] })).rows[0].uses_platform_keys);
  });
  expect(mode, "a managed workspace: the platform's keys, paid in credits").toBe(1);
  const me = await (await page.request.get("/api/me")).json() as { id: string };
  const scope = `particl-active-${workspaceId}-${me.id}`;
  const project = newProject(`Ads ${randomUUID().slice(0, 6)}`);
  const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": scope }, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.addInitScript(({ scope, id }) => { try { localStorage.setItem(scope, id); } catch { /* storage off */ } }, { scope, id: project.id });
  const seeded: KeySeed = { workspaceId, consumer: [], quotes: [], sends: [], errors: [] };
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/higgsfield/consumer/")) seeded.consumer.push(`${request.method()} ${path}`);
    if (request.method() === "POST" && path === "/api/generate/quote") seeded.quotes.push(request.postDataJSON() as Record<string, unknown>);
    if (request.method() === "POST" && path === "/api/generate") seeded.sends.push(request.postDataJSON() as Record<string, unknown>);
  });
  page.on("pageerror", (error) => seeded.errors.push(error.message));
  await page.goto("/suites?suite=moleculr&page=marketing&sp=dtc");
  await expect(page.getByTestId("image-ads-view")).toBeVisible();
  return seeded;
}
/** What Image ads asked of the connected account: nothing (the shell's own collector lists an owner's earlier connected jobs on any page, to drain them). */
const imageAdsAsked = (consumer: string[]) => consumer.filter((call) => call !== "GET /api/higgsfield/consumer/generation");
/** A still from the device, uploaded into the project through the Product slot. */
async function uploadProduct(page: Page) {
  await page.getByTestId("image-ad-product-file").setInputFiles({ name: "serum.webp", mimeType: "image/webp", buffer: readFileSync("public/campaign/hero.webp") });
  await expect(page.getByTestId("image-ad-product-name")).toHaveText("serum.webp", { timeout: 60_000 });
}
const pricedImage = /^Generate image · about \d[\d,]* cr$/;
async function noSideScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), "no horizontal page scroll").toBeLessThanOrEqual(1);
}

test("Image ads runs Marketing Studio Image on the API key: the product first, the live estimate on the button, one send at that figure, and the still lands", async ({ page, playwright }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.setTimeout(180_000);
  const s = await openImageAds(page, playwright, "owner");
  await expect(page.getByTestId("page-title")).toHaveText("Image ads");
  /* Only the key's engine: no DTC engine, no account template library, no connect line. */
  await expect(page.getByTestId("image-ad-build").getByRole("button")).toHaveText(["Image 2.0"]);
  for (const gone of ["dtc-engine", "ad-formats", "dtc-connect", "owner-run-business"]) await expect(page.getByTestId(gone)).toHaveCount(0);
  await expect(page.getByTestId("image-ad-blocked")).toHaveText("Write the prompt.");
  await uploadProduct(page);
  await page.getByTestId("image-ad-prompt").fill("Bold hero shot on marble");
  await page.getByTestId("image-ad-aspect").getByRole("button", { name: "3:4", exact: true }).click();
  await page.getByTestId("image-ad-resolution").getByRole("button", { name: "1k", exact: true }).click();
  await page.getByTestId("image-ad-quality").getByRole("button", { name: "medium", exact: true }).click();
  await expect(page.getByTestId("image-ad-generate")).toHaveText(pricedImage, { timeout: 60_000 });
  await expect(page.getByTestId("image-ad-foot")).toHaveText("An estimate from the live price · filed to this project’s takes");
  const quote = s.quotes.at(-1)!;
  expect(quote).toMatchObject({ model: "higgsfield/marketing-studio-image", prompt: "Bold hero shot on marble", ratio: "3:4", resolution: "1k", refine: false, marketing: { quality: "medium", enhancePrompt: false } });
  expect(quote).not.toHaveProperty("shotId");
  expect(quote.references).toEqual([{ uploadId: expect.any(String), role: "reference_image" }]);
  if (["workbench-360x640", "workbench-390x844", "workbench-844x390"].includes(info.project.name))
    expect(await smallTargets(page, '[data-testid="image-ads-view"]'), "44px targets").toEqual([]);
  await noSideScroll(page);
  const shown = Number((await page.getByTestId("image-ad-generate").innerText()).match(/about ([\d,]+) cr/)![1].replace(/,/g, ""));
  await page.getByTestId("image-ad-generate").click();
  const done = page.getByTestId("image-ad-done");
  await expect(done).toContainText("Rendered and filed to this project.", { timeout: 90_000 });
  await expect(done.getByTestId("image-ad-done-take").locator("img")).toBeVisible();
  expect(s.sends).toHaveLength(1);
  expect(s.sends[0]).toMatchObject({ ...quote, maxCredits: shown, quoteFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
  await noSideScroll(page);
  expect(imageAdsAsked(s.consumer), "Image ads asks the connected account for nothing").toEqual([]);
  expect(s.errors).toEqual([]);
});

test("Image ads: the key's preset catalogue, searched, on its own shelves with covers; a preset builds the ad around the product at high quality", async ({ page, playwright }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.setTimeout(180_000);
  const PRESET = "0b9f3c2e-6a1d-4c8e-9f7a-2d5e8c1b4a60";
  const presets = [
    { id: PRESET, type: "ads", name: "Studio packshot", cover: "https://covers.particl.test/packshot.webp", group: "Product shots", aspectRatio: "1:1" },
    { id: "1c8e2d4f-7b3a-4e9d-8f6a-3e7d9c2b5a71", type: "ads", name: "Bold launch", cover: "https://covers.particl.test/launch.webp", group: "Graphic ads" },
    { id: "2d7f3e5a-8c4b-4f0e-9a7b-4f8e0d3c6b82", type: "marketplace_design", name: "Main listing image" },
  ];
  const searches: (string | null)[] = [];
  await page.route("**/api/higgsfield/marketing/presets**", (route) => {
    const search = new URL(route.request().url()).searchParams.get("search");
    searches.push(search);
    const items = search ? presets.filter((p) => p.name.toLowerCase().includes(search.toLowerCase())) : presets;
    return route.fulfill({ json: { configured: true, items, total: items.length, cursor: null } });
  });
  await page.route("https://covers.particl.test/**", (route) => route.fulfill({ body: readFileSync("public/campaign/character.webp"), contentType: "image/webp" }));
  const s = await openImageAds(page, playwright, "member");
  /* A member runs Image ads like anyone else: no owner card, the Business strip is theirs. */
  await expect(page.getByTestId("owner-run-business")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: /Image ads/ })).toBeVisible();
  await page.getByTestId("image-ad-preset-browse").click();
  const picker = page.getByTestId("image-ad-presets");
  await expect(picker.getByTestId("image-ad-shelf")).toHaveCount(3);
  await expect(picker.getByTestId("image-ad-shelf").locator(".gx-eyebrow")).toHaveText(["Product shots", "Graphic ads", "Marketplace design"]);
  await expect(picker.getByRole("button", { name: /Studio packshot/ }).locator("img")).toBeVisible();
  await expect(picker.getByRole("button", { name: /Studio packshot/ })).toContainText("1:1");
  await page.getByTestId("image-ad-preset-search").fill("pack");
  await expect(picker.getByTestId("image-ad-preset-option")).toHaveCount(1);
  expect(searches).toContain("pack");
  await picker.getByRole("button", { name: /Studio packshot/ }).click();
  await expect(page.getByTestId("image-ad-preset-picked")).toContainText("Studio packshot");
  /* The build runs presets at high quality: the other qualities say why they are off. */
  const quality = page.getByTestId("image-ad-quality");
  await expect(quality.getByRole("button", { name: "high", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(quality.getByRole("button", { name: "low", exact: true })).toHaveAttribute("aria-disabled", "true");
  await expect(quality.getByRole("button", { name: "low", exact: true })).toHaveAttribute("title", "A preset runs at high quality on Image 2.0.");
  await page.getByTestId("image-ad-prompt").fill("Clean studio packshot");
  await expect(page.getByTestId("image-ad-blocked")).toHaveText("A preset starts from the product still. Add the product.");
  /* The key listed this preset (as the catalogue read records it), so the route prices it. */
  await tenant(s.workspaceId, async (db) => {
    await db.execute(`CREATE TABLE IF NOT EXISTS higgsfield_marketing_presets (id TEXT NOT NULL, credential_fingerprint TEXT NOT NULL, name TEXT NOT NULL, seen_at INTEGER NOT NULL, PRIMARY KEY(id,credential_fingerprint))`);
    await db.execute({ sql: "INSERT OR REPLACE INTO higgsfield_marketing_presets(id,credential_fingerprint,name,seen_at) VALUES(?,?,?,?)", args: [PRESET, MOCK_KEY_FINGERPRINT, "Studio packshot", Date.now()] });
  });
  await uploadProduct(page);
  await expect(page.getByTestId("image-ad-generate")).toHaveText(pricedImage, { timeout: 60_000 });
  expect(s.quotes.at(-1)).toMatchObject({ model: "higgsfield/marketing-studio-image", marketing: { quality: "high", enhancePrompt: true, presetId: PRESET } });
  expect((s.quotes.at(-1)!.references as unknown[]).length).toBe(1);
  if (["workbench-360x640", "workbench-390x844", "workbench-844x390"].includes(info.project.name))
    expect(await smallTargets(page, '[data-testid="image-ads-view"]'), "44px targets").toEqual([]);
  await noSideScroll(page);
  expect(s.sends).toEqual([]);
  expect(s.consumer, "nothing reaches the connected account for a member").toEqual([]);
  expect(s.errors).toEqual([]);
});

test("Setup lists what Particl may use, and Use in Ads pre-selects", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  await open(page, "setup");
  await expect(page.getByTestId("setup-view")).toBeVisible();
  await expect(page.getByTestId("setup-hook")).toContainText("Stop scrolling");
  await expect(page.getByTestId("setup-brand_kit")).toContainText("House kit");
  await page.getByTestId("setup-hook").getByRole("button", { name: /Stop scrolling/ }).click();
  await expect(page.getByTestId("setup-detail")).toContainText("Stop scrolling");
  await page.getByTestId("setup-detail").getByRole("button", { name: "Use in Ads" }).click();
  await expect(page.getByTestId("ads-view")).toBeVisible();
  await expect(page.getByTestId("ads-hook").getByRole("button", { name: "Stop scrolling" })).toHaveAttribute("aria-pressed", "true");
});

test("when the account lists nothing Particl may use, the pickers step aside — no command line, no id boxes", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one viewport");
  await open(page, "ads", { setupAvailable: false });
  await expect(page.getByTestId("ads-product-choose")).toBeVisible();
  for (const id of ["ads-avatar", "ads-hook", "ads-adref"]) await expect(page.getByTestId(id)).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Hook id" })).toHaveCount(0);
  expect(await page.locator("body").innerText()).not.toContain("higgsfield marketing-studio");
});

test("Setup offers its items to Ads only: Image ads runs on the key and takes nothing from the account's setup", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors } = await open(page, "setup");
  await page.getByTestId("setup-avatar").getByRole("button", { name: /Maya/ }).click();
  await expect(page.getByTestId("setup-detail").getByRole("button", { name: "Use in Ads" })).toBeVisible();
  await expect(page.getByTestId("setup-detail").getByRole("button", { name: "Use in Image ads" })).toHaveCount(0);
  await page.getByTestId("setup-product").getByRole("button", { name: /Sneaker Runner/ }).click();
  await expect(page.getByTestId("setup-detail").getByRole("button", { name: "Use in Image ads" })).toHaveCount(0);
  await page.getByTestId("setup-detail").getByRole("button", { name: "Use in Ads" }).click();
  await expect(page.getByTestId("ads-view")).toBeVisible();
  await expect(page.getByTestId("ads-product").getByRole("button", { name: "Sneaker Runner" })).toHaveAttribute("aria-pressed", "true");
  if (["workbench-360x640", "workbench-390x844"].includes(info.project.name)) {
    const tiny = await page.getByTestId("ads-view").evaluate((root) => Array.from(root.querySelectorAll<HTMLElement>(".bz-note, .bz-role, code"))
      .filter((el) => el.getClientRects().length && Number.parseFloat(getComputedStyle(el).fontSize) < 12).map((el) => el.className));
    expect(tiny, "Business notes and roles under 12px").toEqual([]);
  }
  expect(errors).toEqual([]);
});

test("a failed price is not the end: Price again reads it anew, and a finished ad can be priced for another take", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  let refuse = true;
  const { requests } = await open(page, "ads");
  /* Registered last, so it answers first: the first quote hits the route's rate limit. */
  await page.route("**/api/higgsfield/consumer/generation", async (route) => {
    const body = route.request().postDataJSON() as { action?: string };
    if (body.action === "quote" && refuse) { refuse = false; return route.fulfill({ status: 429, json: { error: "Too many price checks. Try again in a minute." } }); }
    return route.fallback();
  });
  await page.getByTestId("ads-prompt").fill("Morning routine with the bottle on the sill.");
  await expect(page.getByTestId("ads-error")).toHaveText("Too many price checks. Try again in a minute.");
  await expect(page.getByTestId("ads-generate")).toBeDisabled();
  await page.getByTestId("ads-requote").click();
  await expect(page.getByTestId("ads-generate")).toHaveText("Generate ad · 40 cr");
  await page.getByTestId("ads-generate").click();
  await expect(page.getByTestId("ads-done")).toContainText("Rendered and filed to this project.", { timeout: 15_000 });
  const quotes = requests.filter((r) => r.action === "quote").length;
  await page.getByTestId("ads-requote").click();
  await expect(page.getByTestId("ads-generate")).toHaveText("Generate ad · 40 cr");
  expect(requests.filter((r) => r.action === "quote").length).toBe(quotes + 1);
});

test("an ad submitted before the page was left is picked up again and settled", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  const id = "9d2b3c4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";
  await page.addInitScript((jobId) => { if (!sessionStorage.getItem("seeded")) { sessionStorage.setItem("seeded", "1"); localStorage.setItem("particl:connected-job:ads:ws-biz", jobId); } }, id);
  const { requests, errors } = await open(page, "ads");
  await expect(page.getByTestId("ads-done")).toContainText("Rendered and filed to this project.", { timeout: 15_000 });
  expect(requests.find((r) => r.action === "status")).toEqual({ action: "status", draftId: "ws-biz", id });
  expect(await page.evaluate(() => localStorage.getItem("particl:connected-job:ads:ws-biz"))).toBeNull();
  expect(errors).toEqual([]);
});

test("while the last ad is read back nothing is priced or submitted, so a newer ad is never stranded under it", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  const id = "9d2b3c4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";
  await page.addInitScript((jobId) => { if (!sessionStorage.getItem("seeded")) { sessionStorage.setItem("seeded", "1"); localStorage.setItem("particl:connected-job:ads:ws-biz", jobId); } }, id);
  /* The read-back of the finished ad is slow (its original is being collected). */
  let release: () => void = () => undefined;
  const holdStatus = new Promise<void>((resolve) => { release = resolve; });
  const { requests, errors } = await open(page, "ads", { holdStatus });
  await page.getByTestId("ads-prompt").fill("Morning routine with the bottle on the sill.");
  await expect(page.getByTestId("ads-generate")).toHaveText("Checking the last take…");
  await expect(page.getByTestId("ads-generate")).toBeDisabled();
  await page.waitForTimeout(1500);
  expect(requests.filter((r) => r.action === "quote")).toHaveLength(0);
  expect(requests.filter((r) => r.action === "submit")).toHaveLength(0);
  release();
  await expect(page.getByTestId("ads-done")).toContainText("Rendered and filed to this project.", { timeout: 15_000 });
  expect(await page.evaluate(() => localStorage.getItem("particl:connected-job:ads:ws-biz"))).toBeNull();
  /* The next ad is priced from here, and only now. */
  await page.getByTestId("ads-requote").click();
  await expect(page.getByTestId("ads-generate")).toHaveText("Generate ad · 40 cr");
  expect(errors).toEqual([]);
});

test("an ad the server no longer knows is forgotten and the composer prices at once; a lost submit reply is read, never re-sent", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  const gone = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b", id = "9d2b3c4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";
  const remembered = () => page.evaluate(() => localStorage.getItem("particl:connected-job:ads:ws-biz"));
  await page.addInitScript((jobId) => { if (!sessionStorage.getItem("seeded")) { sessionStorage.setItem("seeded", "1"); localStorage.setItem("particl:connected-job:ads:ws-biz", jobId); } }, gone);
  const answered = { gone: 0, lost: 0 };
  let release: () => void = () => undefined;
  const holdStatus = new Promise<void>((resolve) => { release = resolve; });
  const { requests, errors } = await open(page, "ads", {
    holdStatus,
    routes: () => page.route("**/api/higgsfield/consumer/generation", async (route) => {
      const body = route.request().postDataJSON() as { action?: string; id?: string };
      if (body.action === "status" && body.id === gone) { answered.gone++; return route.fulfill({ status: 404, json: { code: "not_found", error: "This generation job is not available." } }); }
      /* The account took the job, but the reply never arrived. */
      if (body.action === "submit" && !answered.lost) { answered.lost++; return route.fulfill({ status: 503, json: { error: "The connected account could not complete this request. Check the saved job before trying again." } }); }
      return route.fallback();
    }),
  });

  /* The 404 forgets the remembered ad after one read: no take, no error, and the composer is free to price. */
  await expect.poll(remembered).toBeNull();
  expect(answered.gone).toBe(1);
  expect(requests.filter((r) => r.action === "status")).toEqual([{ action: "status", draftId: "ws-biz", id: gone }]);
  await expect(page.getByTestId("ads-done")).toHaveCount(0);
  await expect(page.getByTestId("ads-error")).toHaveCount(0);
  await page.getByTestId("ads-prompt").fill("Morning routine with the bottle on the sill.");
  await expect(page.getByTestId("ads-generate")).toHaveText("Generate ad · 40 cr");

  /* The submit's reply is lost (503): the ad stays remembered and is read by status (held here), never sent again. */
  await page.getByTestId("ads-generate").click();
  await expect(page.getByTestId("ads-generate")).toHaveText("Rendering…");
  await expect(page.getByTestId("ads-error")).toHaveCount(0);
  expect(await remembered()).toBe(id);
  await expect.poll(() => requests.filter((r) => r.action === "status" && r.id === id).length, { timeout: 10_000 }).toBeGreaterThan(0);
  expect(answered.lost).toBe(1);
  expect(requests.filter((r) => r.action === "submit")).toHaveLength(1);
  release();
  await expect(page.getByTestId("ads-done")).toContainText("Rendered and filed to this project.", { timeout: 15_000 });
  expect(requests.filter((r) => r.action === "submit")).toHaveLength(1);
  expect(requests.filter((r) => r.action === "status" && r.id === gone)).toHaveLength(1);
  expect(await remembered()).toBeNull();
  expect(errors).toEqual([]);
});
