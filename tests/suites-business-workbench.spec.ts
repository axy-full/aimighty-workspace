import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, mockLibrary, mockMedia, mockProjects, upload } from "./helpers/workspaceFixtures";

/**
 * Business = Marketing Studio (FINAL_SPEC §2), in the browser against the
 * real shell and route-mocked connected-account replies: the three pages,
 * the two server rules as disabled chips with their reason, the price on the
 * button from a quote, submit with that exact price, and Setup's pick
 * carried into Ads. (Standalone sourcing: hf-business-standalone-workbench.)
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const fixture = (): Project => ({ ...newProject("Coastal light study"), id: "ws-biz", productionProjectId: "prod-ws", shotMappings: {} });
const VIDEO_MODEL = { id: "marketing_studio_video", name: "Marketing Studio", outputType: "video", aspectRatios: ["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"], durationRange: { min: 4, max: 20 }, medias: [{ name: "medias", roles: ["image", "start_image", "end_image"] }], parameters: [{ name: "resolution", options: ["480p", "720p", "1080p"] }, { name: "mode" }, { name: "hook_id" }, { name: "setting_id" }, { name: "ad_reference_id" }, { name: "product_ids" }, { name: "avatar_ids" }, { name: "generate_audio" }] };
const IMAGE_MODEL = { id: "marketing_studio_image", name: "Marketing Studio Image", outputType: "image", aspectRatios: ["auto", "1:1", "3:2", "9:16"], medias: [{ name: "medias", roles: ["image"] }], parameters: [{ name: "resolution", options: ["1k", "2k", "4k"] }] };
const DTC_MODEL = { id: "ms_image", name: "DTC Ads", outputType: "image", aspectRatios: ["1:1", "9:16", "auto"], medias: [{ name: "medias", roles: ["image"], max: 14 }], parameters: [{ name: "style_id", type: "string" }, { name: "brand_kit_id", type: "string" }, { name: "resolution", options: ["1k", "2k", "4k"] }, { name: "quality", options: ["low", "medium", "high"] }, { name: "batch_size", type: "number" }, { name: "product_ids", type: "string_array" }] };

async function open(page: Page, cp: "ads" | "dtc" | "setup", options: { setupAvailable?: boolean } = {}) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, { uploads: [upload({ id: "up_plate", filename: "harbour-plate.webp" })], generations: [] });
  const me = await page.request.get("/api/me").then((r) => r.json());
  await page.route("**/api/me", (route) => route.fulfill({ json: { ...me, owner: true } }));
  await page.route("**/api/higgsfield/consumer/connection", (route) => route.fulfill({ json: { connected: true, requiresReconnect: false } }));
  const requests: Record<string, unknown>[] = [];
  let quoted = 0;
  await page.route("**/api/higgsfield/consumer/generation", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    requests.push(body);
    if (body.action === "catalogue") return route.fulfill({ json: { catalogue: { models: body.type === "image" ? [IMAGE_MODEL, DTC_MODEL] : [VIDEO_MODEL], unlim: { available: false, remaining: null, expiresAt: null }, complete: true, fetchedAt: Date.now() } } });
    const input = body.input as Record<string, unknown> | undefined;
    const job = (status: string, credits: number) => ({ id: "9d2b3c4e-5f60-4a7b-8c9d-0e1f2a3b4c5d", draftId: "ws-biz", workflow: "generation", status, model: input?.model === "marketing_studio_image" ? IMAGE_MODEL : VIDEO_MODEL, input: input ?? requests.find((r) => r.action === "quote")?.input, workspaceId: "1f2e3d4c-5b6a-4798-8a9b-0c1d2e3f4a5b", workspaceName: "Northline wallet", quoteCredits: credits, creditUnit: "higgsfield_credits", quoteExpiresAt: Date.now() + 300_000, createdAt: Date.now(), providerJobId: status === "quoted" ? null : "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d", tool: null, result: null, originalAvailable: false, sources: [] });
    if (body.action === "quote") { quoted++; return route.fulfill({ json: { job: job("quoted", 40) } }); }
    if (body.action === "submit") {
      if (body.credits !== 40) return route.fulfill({ status: 409, json: { code: "approval_changed", error: "Review this job’s wallet and exact credit quote again." } });
      return route.fulfill({ json: { job: job("accepted", 40) } });
    }
    if (body.action === "status") return route.fulfill({ json: { job: job("completed", 40) } });
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

test("Image ads runs on Marketing Studio Image by default; aspect auto needs a still", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { requests } = await open(page, "dtc");
  await expect(page.getByTestId("image-ads-view")).toBeVisible();
  await expect(page.getByTestId("dtc-engine")).toBeVisible();
  /* Ad formats: the account's template catalogue, through the existing template client. */
  await expect(page.getByTestId("ad-formats")).toContainText("Ad formats");
  await expect(page.getByTestId("ad-formats-client").getByRole("list", { name: "Templates" }).getByRole("listitem")).toHaveCount(2);
  await expect(page.getByTestId("ad-formats-client")).toContainText("Creator unboxing");
  await expect(page.getByTestId("dtc-blocked")).toHaveText("Write the prompt or add a reference.");
  await page.getByTestId("dtc-prompt").fill("Bold hero shot on marble");
  await page.getByTestId("dtc-aspect").getByRole("button", { name: "auto" }).click();
  await expect(page.getByTestId("dtc-blocked")).toHaveText("Aspect auto needs a reference still.");
  await page.getByTestId("dtc-aspect").getByRole("button", { name: "9:16" }).click();
  await page.getByTestId("dtc-resolution").getByRole("button", { name: "2k" }).click();
  await expect(page.getByTestId("dtc-generate")).toHaveText("Generate image · 40 cr");
  const quote = requests.find((r) => r.action === "quote") as { input: { model: string; parameters: Record<string, unknown> } };
  expect(quote.input).toMatchObject({ model: "marketing_studio_image", parameters: { aspect_ratio: "9:16", resolution: "2k" } });
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

test("DTC Ads: the ms_image engine needs a style (the ad format); brand kit, products, quality and batch go into the quote", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  const { requests } = await open(page, "dtc");
  await page.getByTestId("dtc-engine-ms_image").click();
  await expect(page.getByTestId("dtc-copy")).toContainText("a style (the ad format) is required");
  await page.getByTestId("dtc-prompt").fill("Bold hero shot on marble");
  await expect(page.getByTestId("dtc-blocked")).toHaveText("Pick a style — the ad format. DTC Ads has no default.");
  await page.getByTestId("dtc-style").getByRole("button", { name: "Bold launch" }).click();
  await expect(page.getByTestId("dtc-blocked")).toHaveCount(0);
  await page.getByTestId("dtc-brand-kit").getByRole("button", { name: "House kit" }).click();
  await page.getByTestId("dtc-products").getByRole("button", { name: "Sneaker Runner" }).click();
  await page.getByTestId("dtc-quality").getByRole("button", { name: "high" }).click();
  await page.getByTestId("dtc-batch").getByRole("button", { name: "More" }).click();
  await expect(page.getByTestId("dtc-batch-count")).toHaveText("2");
  await expect.poll(() => {
    const quote = [...requests].reverse().find((r) => r.action === "quote") as { input?: { model: string; parameters: Record<string, unknown> } } | undefined;
    return quote?.input?.model === "ms_image" ? quote.input.parameters : null;
  }).toEqual({ aspect_ratio: "1:1", resolution: "1k", style_id: "st_bold", quality: "high", batch_size: 2, brand_kit_id: "bk1", product_ids: ["p1"] });
  await expect(page.getByTestId("dtc-generate")).toContainText("40");
});
