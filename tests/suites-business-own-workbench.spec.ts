import { test, expect, type Page } from "@playwright/test";
import { joinLocallyAsMember } from "./helpers/workbenchLocal";
import { upload } from "./helpers/workspaceFixtures";
import { NO_PHONE_BOARD, SIZES, expectBusinessFloors, fixture, onPhone, openBusiness, png, still } from "./helpers/businessOwn";
import { EMPTY_MOLECULR } from "../lib/workbench/moleculr";
import { CREATIVE_TEMPLATES, EMPTY_BRAND_KIT, saveProduct } from "../lib/workbench/moleculr-creative";
import type { Asset } from "../lib/workbench/studio";

/**
 * Particl's own Business tools on the Ads board (the Edit panels of components/graphite/board/ads/AdsOverlay.tsx, which
 * mount the tools of components/graphite/business/): the brand kit read from a website and reviewed, product profiles from a
 * reviewed page, the eighteen creative briefs handed to Make (which prices them before anything runs), what Particl made in
 * the project on the Brand, Product and Reference cards, and a member's Brand panel.
 * Real local sign-in on an ENGINE_MOCK server; the project store, the Library, stored media and every web read are
 * route-mocked, and nothing paid is sent. The canvas is not drawn on a phone, so every test skips the phone sizes with that
 * reason. (Hooks, Reference and the poster Designer: suites-business-own-agents-workbench.spec.ts.)
 */

/** Page reads on the web are the extract routes' — mocked here, never fetched. */
async function mockReads(page: Page, reads: Record<string, unknown>[]) {
  await page.route("**/api/workbench/moleculr/extract-brand", async (route) => {
    reads.push({ route: "brand", ...(route.request().postDataJSON() as object) });
    return route.fulfill({ json: {
      source: { requestedUrl: "https://granite.example", finalUrl: "https://granite.example/", fetchedAt: "2026-09-28T10:00:00.000Z" },
      brand: { name: "Granite Salt Co.", description: "Sea salt harvested by hand on the north coast.", tagline: "Salt of the north", colors: ["#102030", "#F4F1EA"], fontFamilies: ["Inter"] },
      logoCandidates: [{ url: "https://granite.example/logo.png", source: "html-image", alt: "Granite logo" }, { url: "https://granite.example/mark.svg", source: "html-link" }],
      imageryCandidates: [], evidence: [{ field: "name", source: "open-graph", value: "Granite Salt Co.", sourceUrl: "https://granite.example/" }], warnings: [], requiresReview: true,
    } });
  });
  await page.route("**/api/workbench/moleculr/extract-product", async (route) => {
    reads.push({ route: "product", ...(route.request().postDataJSON() as object) });
    return route.fulfill({ json: {
      source: { requestedUrl: "https://granite.example/bottle", finalUrl: "https://granite.example/bottle", fetchedAt: "2026-09-28T10:00:00.000Z" },
      product: { name: "Salt Bottle 500 ml", description: "Hand-blown glass bottle, 500 ml.", brand: "Granite" },
      evidence: [{ field: "name", source: "json-ld", value: "Salt Bottle 500 ml", sourceUrl: "https://granite.example/bottle" }],
      imageCandidates: [{ url: "https://granite.example/bottle.png", source: "open-graph", alt: "The bottle" }], warnings: ["Prices and stock are not read."], requiresReview: true,
    } });
  });
  const bytes = await png();
  await page.route("**/api/workbench/moleculr/import-image", async (route) => {
    reads.push({ route: "import", ...(route.request().postDataJSON() as object) });
    return route.fulfill({ body: bytes, contentType: "image/png", headers: { "content-length": String(bytes.length) } });
  });
}

test("Brand: the website is read once, reviewed and applied; the logo is imported as an original; the kit saves with the project", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.skip(onPhone(info.project.name), NO_PHONE_BOARD);
  test.setTimeout(150_000);
  const reads: Record<string, unknown>[] = [];
  const seen = await openBusiness(page, "brand", fixture(), { routes: () => mockReads(page, reads) });
  await expect(page.getByTestId("ads-panel")).toHaveAccessibleName("Brand kit");
  await expect(page.getByTestId("brand-tool")).toBeVisible();

  await page.getByTestId("brand-url").fill("https://granite.example");
  await page.getByTestId("brand-read").click();
  const review = page.getByTestId("brand-review");
  await expect(review).toBeVisible();
  expect(reads).toEqual([{ route: "brand", projectId: "ws-granite", url: "https://granite.example/" }]);
  await expect(page.getByTestId("brand-review-name")).toHaveValue("Granite Salt Co.");
  await expect(page.getByTestId("brand-review-colors")).toHaveValue("#102030, #F4F1EA");
  /* Nothing is used until it is applied. */
  await expect(page.getByTestId("brand-name")).toHaveValue("");
  await page.getByTestId("brand-review-name").fill("Granite");
  await page.getByTestId("brand-apply").click();
  await expect(page.getByTestId("brand-name")).toHaveValue("Granite");
  await expect(page.getByTestId("brand-tagline")).toHaveValue("Salt of the north");
  await expect(page.getByTestId("brand-source")).toHaveText("Reviewed from granite.example");
  await expect(page.getByTestId("brand-colors")).toContainText("#102030");

  /* A candidate the import cannot take says so; the logo comes in as an original and is set on the kit. */
  const logos = page.getByTestId("brand-logos");
  await expect(logos.getByRole("button", { name: "Import the logo" }).nth(1)).toBeDisabled();
  await logos.getByRole("button", { name: "Import the logo" }).first().click();
  await expect(page.getByTestId("brand-logo-name")).toHaveText("brand-reference.png", { timeout: 30_000 });
  await expect(logos.getByRole("button", { name: "Imported" })).toBeVisible();
  expect(reads.at(-1)).toEqual({ route: "import", projectId: "ws-granite", url: "https://granite.example/logo.png" });

  await page.getByTestId("brand-voice").fill("Plain, calm and exact.");
  await page.getByTestId("brand-font").getByRole("button", { name: "Geometric" }).click();
  await page.getByTestId("brand-add-color").click();
  /* Sans only: the editorial face is not offered for a new kit. */
  await expect(page.getByTestId("brand-font").getByRole("button")).toHaveText(["System", "Geometric"]);
  await expect.poll(() => seen.store.project.moleculr?.brandKit?.voice, { timeout: 15_000 }).toBe("Plain, calm and exact.");
  await expect.poll(() => seen.store.project.moleculr?.brandKit?.colors.length, { timeout: 15_000 }).toBe(3);
  const kit = seen.store.project.moleculr!.brandKit!;
  expect(kit).toMatchObject({ name: "Granite", tagline: "Salt of the north", font: "geometric", website: "https://granite.example", source: { url: "https://granite.example/" }, fontFamilies: ["Inter"] });
  expect(kit.colors).toEqual(["#102030", "#F4F1EA", "#0A84FF"]);
  const logo = seen.store.project.assets.find((a) => a.id === kit.logoAssetId)!;
  expect(logo).toMatchObject({ kind: "image", category: "Brand", name: "brand-reference.png" });
  expect(logo.uploadId).toBe(logo.id);
  await expect(page.getByTestId("brand-save")).toHaveText("Saved");
  await expectBusinessFloors(page, "brand-tool");
  expect(seen.store.refused).toEqual([]);
  expect(seen.account).toEqual([]);
  expect(seen.paid).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test("Product: a page is read and reviewed, its image imported, a Library still picked; two profiles are saved and the picker switches between them", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.skip(onPhone(info.project.name), NO_PHONE_BOARD);
  test.setTimeout(150_000);
  const reads: Record<string, unknown>[] = [];
  const seen = await openBusiness(page, "product", fixture(), { routes: () => mockReads(page, reads) });
  await expect(page.getByTestId("ads-panel")).toHaveAccessibleName("Product facts");
  await expect(page.getByTestId("product-profiles")).toContainText("Saved products · 0 of 24");

  await page.getByTestId("product-name").fill("Salt bottle");
  await page.getByTestId("product-url").fill("https://granite.example/bottle");
  await page.getByTestId("product-read").click();
  const review = page.getByTestId("product-review");
  await expect(review).toBeVisible();
  await expect(review).toContainText("Prices and stock are not read.");
  expect(reads).toEqual([{ route: "product", projectId: "ws-granite", url: "https://granite.example/bottle" }]);
  await page.getByTestId("product-use-review").click();
  await expect(page.getByTestId("product-name")).toHaveValue("Salt Bottle 500 ml");
  await expect(page.getByTestId("product-brand")).toHaveValue("Granite");
  await expect(page.getByTestId("product-facts")).toHaveValue("Hand-blown glass bottle, 500 ml.");
  await expect(page.getByTestId("product-source")).toContainText("granite.example/bottle");

  await page.getByTestId("product-candidates").getByRole("button", { name: "Import" }).click();
  await expect(page.getByTestId("product-chosen").locator(".bo-chosen-item")).toHaveCount(1, { timeout: 30_000 });
  /* A still from this project's Library joins the draft with its upload identity. */
  await page.getByTestId("product-picker").getByRole("button", { name: "harbour-plate.webp" }).click();
  await expect(page.getByTestId("product-chosen").locator(".bo-chosen-item")).toHaveCount(2);
  await expect(page.getByTestId("product-images")).toContainText("Images · 2 of 5");
  await page.getByTestId("product-save").click();
  await expect(page.getByTestId("product-profiles").getByRole("button", { name: "Salt Bottle 500 ml" })).toHaveAttribute("aria-pressed", "true");

  await page.getByTestId("product-new").click();
  await expect(page.getByTestId("product-name")).toHaveValue("");
  await page.getByTestId("product-name").fill("Travel cap");
  await page.getByTestId("product-save").click();
  const chips = page.getByTestId("product-profiles").getByRole("group", { name: "Saved products" }).getByRole("button");
  await expect(chips).toHaveText(["Salt Bottle 500 ml", "Travel cap"]);
  await chips.first().click();
  await expect(page.getByTestId("product-name")).toHaveValue("Salt Bottle 500 ml");
  await expect(page.getByTestId("product-chosen").locator(".bo-chosen-item")).toHaveCount(2);

  await expect.poll(() => seen.store.project.moleculr?.products?.length, { timeout: 15_000 }).toBe(2);
  await expect.poll(() => seen.store.project.moleculr?.activeProductId, { timeout: 15_000 }).toBe(seen.store.project.moleculr!.products![0].id);
  const [bottle, cap] = seen.store.project.moleculr!.products!;
  expect(bottle).toMatchObject({ name: "Salt Bottle 500 ml", brand: "Granite", url: "https://granite.example/bottle", source: { url: "https://granite.example/bottle" } });
  expect(bottle.assetIds).toHaveLength(2);
  expect(bottle.assetIds).toContain("up_plate");
  expect(cap).toMatchObject({ name: "Travel cap", assetIds: [] });
  expect(seen.store.project.assets.find((a) => a.id === "up_plate")).toMatchObject({ uploadId: "up_plate", category: "Product", kind: "image" });
  await expectBusinessFloors(page, "product-tool");
  expect(seen.store.refused).toEqual([]);
  expect(seen.account).toEqual([]);
  expect(seen.paid).toEqual([]);
  expect(seen.errors).toEqual([]);
});

const PRICED = 4;
const IMAGE_ENGINES = [{ id: "gemini-3.1-flash-image", kind: "image", resolutions: ["1K", "2K"], ratios: ["1:1", "16:9", "9:16"], durations: [], use: "Stills and quick frames.", rate: { credits: PRICED, resolution: "1K", ratio: "1:1", duration: null } }];

test("Format: one of the eighteen briefs, made with Particl's product, brand kit and hook, goes to Make — which shows its price before anything runs", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.skip(onPhone(info.project.name), NO_PHONE_BOARD);
  test.setTimeout(150_000);
  const bottle = still("up_bottle");
  const brief = saveProduct({ ...EMPTY_MOLECULR, productName: "Salt bottle", productBrand: "Granite", productDescription: "Hand-blown glass, 500 ml.", productAssetIds: [bottle.id], hooks: ["Salt, not sugar.", "Made at sea."], brandKit: { ...EMPTY_BRAND_KIT, name: "Granite", tagline: "Salt of the north" } }, "p-bottle");
  const seen = await openBusiness(page, "format", fixture({ assets: [bottle], moleculr: brief }), { routes: async () => {
    await page.route(/\/api\/workbench\/engines(\?.*)?$/, (route) => route.fulfill({ json: { models: IMAGE_ENGINES, audio: null, credits: new URL(route.request().url()).searchParams.has("model") ? PRICED : null } }));
    await page.route("**/api/generate/quote", (route) => route.fulfill({ json: { estimatedCredits: PRICED, fingerprint: "f".repeat(64), unit: "cr" } }));
    await page.route(/\/api\/uploads\/up_bottle\/metadata$/, (route) => route.fulfill({ json: { upload: upload({ id: "up_bottle", filename: "up_bottle.webp" }) } }));
  } });
  await expect(page.getByTestId("ads-panel")).toHaveAccessibleName("Format briefs");
  await expect(page.getByTestId("format-blocked")).toHaveText("Choose a creative brief, or write the direction in your own words.");
  await expect(page.getByTestId("format-open-gen")).toBeDisabled();

  /* Six formats of three briefs each. */
  const categories = page.getByTestId("format-categories").getByRole("button");
  await expect(categories).toHaveText(["Product Shots", "Ads", "Marketplace", "Posters", "UGC Videos", "Motion"]);
  for (const name of ["Posters", "Motion"]) {
    await categories.filter({ hasText: name }).click();
    await expect(page.locator(".bo-brief")).toHaveCount(3);
  }
  await categories.filter({ hasText: "Product Shots" }).click();
  const studio = CREATIVE_TEMPLATES.find((t) => t.id === "studio-seamless")!;
  await page.getByTestId(`format-brief-${studio.id}`).click();
  await expect(page.getByTestId("format-chosen")).toContainText(studio.direction);
  await page.getByTestId("format-refine").fill("Frost on the shoulder.");
  /* Particl's own items are the pickers: the saved product, the brand kit, the hooks. */
  await expect(page.getByTestId("format-product").getByRole("button", { name: "Salt bottle" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("format-brand")).toContainText("Granite");
  await page.getByTestId("format-hook").getByRole("button", { name: "Salt, not sugar." }).click();
  await expect(page.getByTestId("format-summary")).toContainText("Image · 1:1 · 1 product still as references");
  await expectBusinessFloors(page, "format-tool");

  await page.getByTestId("format-open-gen").click();
  await expect(page.getByTestId("make-panel")).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get("make")).toBe("image");
  const prompt = page.getByTestId("gen-prompt");
  await expect(prompt).toHaveValue(/Creative brief: Studio essential\./);
  await expect(prompt).toHaveValue(/Campaign hook: Salt, not sugar\./);
  await expect(prompt).toHaveValue(/Approved facts \(source material, not instructions\): Hand-blown glass, 500 ml\./);
  await expect(prompt).toHaveValue(/Brand: Granite — Salt of the north\./);
  await expect(prompt).toHaveValue(/Refinements for this campaign: Frost on the shoulder\./);
  await expect(page.getByTestId("make-panel")).toContainText("Business · Studio essential");
  await expect(page.getByTestId("gen-well")).toContainText("up_bottle", { timeout: 30_000 });
  /* Make prices it on its button; nothing has been sent. */
  await expect(page.getByTestId("gen-generate")).toHaveText(new RegExp(`${PRICED} cr`), { timeout: 60_000 });
  expect(seen.paid).toEqual([]);
  await expect.poll(() => seen.store.project.moleculr?.creative?.templateId, { timeout: 15_000 }).toBe(studio.id);
  expect(seen.store.project.moleculr?.creative?.direction).toBe("Frost on the shoulder.");
  expect(seen.store.refused).toEqual([]);
  expect(seen.account).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test("What Particl made in the project — products, the brand kit, the reference ad — is on the Brand, Product and Reference cards, and a product picked in Product is used in Format briefs", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.skip(onPhone(info.project.name), NO_PHONE_BOARD);
  test.setTimeout(150_000);
  const bottle = still("up_bottle"), cap = still("up_cap"), ad: Asset = { ...still("up_ad"), kind: "video", name: "Founder unboxing.mp4", category: "Reference" };
  let brief = saveProduct({ ...EMPTY_MOLECULR, productName: "Salt bottle", productAssetIds: [bottle.id] }, "p-bottle");
  brief = saveProduct({ ...brief, activeProductId: undefined, productName: "Travel cap", productAssetIds: [cap.id] }, "p-cap");
  brief = { ...brief, brandKit: { ...EMPTY_BRAND_KIT, name: "Granite" }, referenceAd: { assetId: ad.id, notes: "", direction: "Open on the product in frost." } };
  const seen = await openBusiness(page, "setup", fixture({ assets: [bottle, cap, ad], moleculr: brief }));
  /* Setup's address opens frame 1: the brand kit, the product in use and the reference ad are its cards. No Setup page, no retired card, no connect prompt. */
  await expect(page.getByTestId("ads-brand")).toContainText("Granite · brand kit");
  await expect(page.getByTestId("ads-product")).toContainText("Travel cap");
  await expect(page.getByTestId("ads-reference")).toContainText("Founder unboxing.mp4");
  for (const gone of ["particl-setup", "owner-run-business", "setup-connect", "primary-action", "business-setup"]) await expect(page.getByTestId(gone)).toHaveCount(0);
  await expect(page.getByTestId("board")).not.toContainText(/Higgsfield|Open Ads|Use in Ads/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "no horizontal scroll").toBe(true);

  /* Both saved products are in Product's profiles; the one picked there is the one Format briefs are made with. */
  await page.getByTestId("ads-product-edit").click();
  await expect(page.getByTestId("product-profiles")).toContainText("Saved products · 2 of 24");
  await page.getByTestId("product-profiles").getByRole("button", { name: "Salt bottle" }).click();
  await expect.poll(() => seen.store.project.moleculr?.activeProductId, { timeout: 15_000 }).toBe("p-bottle");
  await page.getByTestId("ads-panel-close").click();
  await page.getByTestId("ads-formats-edit").click();
  await expect(page.getByTestId("format-tool")).toBeVisible();
  await expect(page.getByTestId("format-product").getByRole("button", { name: "Salt bottle" })).toHaveAttribute("aria-pressed", "true");
  /* No setup item was read from, or sent to, a connected account on the way. */
  expect(seen.paid).toEqual([]);
  expect(seen.account).toEqual([]);
  expect(seen.store.refused).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test("a member works in the Brand panel of the Ads board: the same panel as an owner, with no owner card", async ({ page, playwright }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.skip(onPhone(info.project.name), NO_PHONE_BOARD);
  test.setTimeout(150_000);
  const ownerApi = await playwright.request.newContext({ baseURL: process.env.PW_BASE_URL });
  await joinLocallyAsMember(ownerApi, page.request, { ownerName: "Harbour Supervision" });
  await ownerApi.dispose();
  const seen = await openBusiness(page, "brand", fixture(), { member: true });
  await expect(page.getByTestId("brand-tool")).toBeVisible();
  /* Ads is not a retired suite: no owner card, no Ads page, no owner badge on any suite. */
  for (const gone of ["owner-run-business", "ads-view", "owner-badge-business", "owner-badge-viral"]) await expect(page.getByTestId(gone)).toHaveCount(0);
  await page.getByTestId("brand-name").fill("Granite");
  await expect.poll(() => seen.store.project.moleculr?.brandKit?.name, { timeout: 15_000 }).toBe("Granite");
  await expectBusinessFloors(page, "brand-tool");
  expect(seen.paid).toEqual([]);
  expect(seen.account).toEqual([]);
  expect(seen.errors).toEqual([]);
});
