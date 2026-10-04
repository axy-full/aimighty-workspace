import { test, expect, type Page, type PlaywrightWorkerArgs } from "@playwright/test";
import { createClient } from "@libsql/client";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { joinLocallyAsMember, localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
/* Grants in today's credits, saying so (unit_usd): the runner and the mock server share the default. */
import { creditUsd } from "../lib/creditTerms";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, upload } from "./helpers/workspaceFixtures";
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
 * Business › Ads is removed (design/particl-graphite/README.md › What this
 * design removes): the suite opens on Image ads, an old `sp=ads` link lands
 * there with the address rewritten, and Setup is Particl's own list. An ad
 * made before is still a take in the Library. Nothing asks the account.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const fixture = (): Project => ({ ...newProject("Coastal light study"), id: "ws-biz", productionProjectId: "prod-ws", shotMappings: {} });
/** An image ad the account rendered earlier, filed to the project like any take. */
const AD = "gen_hfc_" + "b".repeat(40);

async function open(page: Page) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, {
    uploads: [upload({ id: "up_plate", filename: "harbour-plate.webp" })],
    generations: [generation({ id: AD, title: "Bottle ad", kind: "image", model: "marketing_studio_image", provider: "higgsfield", params: { task: "connected-generation", consumerCreditUnit: "higgsfield_credits" } })],
  });
  /* Every account request the page makes, bar the shell collector's list of saved jobs (a ledger read). */
  const asked: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/higgsfield/consumer/")) return;
    if (request.method() === "GET" && url.pathname === "/api/higgsfield/consumer/generation") return;
    asked.push(`${request.method()} ${url.pathname}`);
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { errors, asked };
}

test("Business opens on Image ads, an old Ads link lands there, Setup is Particl's own list; an earlier ad is still in the Library; nothing asks the account", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, asked } = await open(page);
  /* An old link to the Ads page: Image ads, and the address names it from then on. */
  for (const old of ["/suites?suite=moleculr&page=marketing&sp=ads", "/suites?suite=moleculr&page=ads&sp=ads"]) {
    await page.goto(old);
    await expect(page.getByTestId("project-name")).toHaveText("Coastal light study");
    await expect(page.getByTestId("image-ads-view")).toBeVisible();
    await expect(page.getByTestId("page-title")).toHaveText("Image ads");
    await expect.poll(() => new URL(page.url()).searchParams.get("sp")).toBe("dtc");
    for (const gone of ["ads-view", "ads-generate", "ads-connect", "owner-run-business"]) await expect(page.getByTestId(gone)).toHaveCount(0);
    await noSideScroll(page);
  }
  /* With no page named, Business opens on Image ads too. */
  await page.goto("/suites?suite=moleculr");
  await expect(page.getByTestId("image-ads-view")).toBeVisible();

  /* Setup: what Particl made in this project — no retired card, no connect prompt, no Ads hand-off, no vendor name. */
  await page.goto("/suites?suite=moleculr&page=marketing&sp=setup");
  await expect(page.getByTestId("page-title")).toHaveText("Setup items");
  await expect(page.getByTestId("page-hint")).toHaveText("Saved products, brand kit and reference ad");
  await expect(page.getByTestId("particl-setup")).toBeVisible();
  for (const gone of ["owner-run-business", "setup-connect", "primary-action", "image-ads-view"]) await expect(page.getByTestId(gone)).toHaveCount(0);
  await expect(page.getByTestId("business-setup")).not.toContainText(/Higgsfield|Open Ads|Use in Ads/);
  await noSideScroll(page);

  /* An ad made before reads as a take in the Library. */
  const library = page.getByTestId("library");
  const opened = !(await library.isVisible());
  if (opened) await page.getByTestId("toggle-library").click();
  await expect(library.locator(`.gx-asset-thumb[data-ctx='asset:generation:${AD}']`)).toBeVisible();
  if (opened) await page.getByTestId("close-library").click();
  expect(asked, "nothing asks the account").toEqual([]);
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
    await db.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at,unit_usd) VALUES(?,?,?,?,?,?,?,?)", args: [randomUUID(), workspaceId, 5000, "Image ads key fixture", "manual", "test", Date.now(), creditUsd()] });
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
const pricedImage = /^Generate image · about \d[\d,]*(?:\.\d)? cr$/;
async function noSideScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), "no horizontal page scroll").toBeLessThanOrEqual(1);
}

test("Image ads runs Marketing Studio Image on the API key: the product first, the live estimate on the button, one send at that figure, and the still lands", async ({ page, playwright }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.setTimeout(180_000);
  const s = await openImageAds(page, playwright, "owner");
  await expect(page.getByTestId("page-title")).toHaveText("Image ads");
  /* Only the key's engine: no DTC engine, no account template library, no connect line. */
  await expect(page.getByTestId("image-ad-build").getByRole("button")).toHaveText(["2.0 Alpha", "2.5 Flare", "2.5 Sunburst"]);
  await expect(page.getByTestId("image-ad-build").getByRole("button", { name: "2.0 Alpha" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("image-ad-build")).toContainText("priced live before generating");
  for (const gone of ["dtc-engine", "ad-formats", "dtc-connect", "owner-run-business"]) await expect(page.getByTestId(gone)).toHaveCount(0);
  await expect(page.getByTestId("image-ad-blocked")).toHaveText("Write the prompt.");
  await uploadProduct(page);
  await page.getByTestId("image-ad-prompt").fill("Bold hero shot on marble");
  await page.getByTestId("image-ad-aspect").getByRole("button", { name: "3:4", exact: true }).click();
  await page.getByTestId("image-ad-resolution").getByRole("button", { name: "1k", exact: true }).click();
  await expect(page.getByTestId("image-ad-quality").getByRole("button")).toHaveText(["Low", "Medium", "High"]);
  await page.getByTestId("image-ad-quality").getByRole("button", { name: "Medium", exact: true }).click();
  await expect(page.getByTestId("image-ad-generate")).toHaveText(pricedImage, { timeout: 60_000 });
  await expect(page.getByTestId("image-ad-foot")).toHaveText("An estimate from the live price · filed to this project’s takes");
  const quote = s.quotes.at(-1)!;
  expect(quote).toMatchObject({ model: "higgsfield/marketing-studio-image", prompt: "Bold hero shot on marble", ratio: "3:4", resolution: "1k", refine: false, marketing: { quality: "medium", enhancePrompt: false } });
  expect(quote).not.toHaveProperty("shotId");
  expect(quote.references).toEqual([{ uploadId: expect.any(String), role: "reference_image" }]);
  if (["workbench-360x640", "workbench-390x844", "workbench-844x390"].includes(info.project.name))
    expect(await smallTargets(page, '[data-testid="image-ads-view"]'), "44px targets").toEqual([]);
  await noSideScroll(page);
  const shown = Number((await page.getByTestId("image-ad-generate").innerText()).match(/about (\d[\d,]*(?:\.\d)?) cr/)![1].replace(/,/g, ""));
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

test("Image ads on a 2.5 build: Flare at extra high names its variant, is priced approximately, is sent once at that figure, and the still lands", async ({ page, playwright }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.setTimeout(180_000);
  const s = await openImageAds(page, playwright, "owner");
  /* The project is read before anything is chosen: the Product slot takes a file only once it is. */
  await expect(page.getByTestId("image-ad-blocked")).toHaveText("Write the prompt.");
  const build = page.getByTestId("image-ad-build");
  await build.getByRole("button", { name: "2.5 Flare" }).click();
  await expect(build.getByRole("button", { name: "2.5 Flare" })).toHaveAttribute("aria-pressed", "true");
  /* Moleculr's words for the build's price, and the 2.5 qualities. */
  await expect(build).toContainText("priced approximately; the delivered image settles it");
  const quality = page.getByTestId("image-ad-quality");
  await expect(quality.getByRole("button")).toHaveText(["Low", "Medium", "High", "Extra high", "Max"]);
  await quality.getByRole("button", { name: "Extra high", exact: true }).click();
  await uploadProduct(page);
  await page.getByTestId("image-ad-prompt").fill("Bold hero shot on marble");
  await expect(page.getByTestId("image-ad-generate")).toHaveText(pricedImage, { timeout: 60_000 });
  await expect(page.getByTestId("image-ad-foot")).toHaveText("An approximate price · the delivered image settles it · filed to this project’s takes");
  const quote = s.quotes.at(-1)!;
  expect(quote).toMatchObject({ model: "higgsfield/marketing-studio-image", prompt: "Bold hero shot on marble", marketing: { variant: "flare", quality: "xhigh", enhancePrompt: false } });
  if (["workbench-360x640", "workbench-390x844", "workbench-844x390"].includes(info.project.name))
    expect(await smallTargets(page, '[data-testid="image-ads-view"]'), "44px targets").toEqual([]);
  await noSideScroll(page);
  const shown = Number((await page.getByTestId("image-ad-generate").innerText()).match(/about (\d[\d,]*(?:\.\d)?) cr/)![1].replace(/,/g, ""));
  await page.getByTestId("image-ad-generate").click();
  const done = page.getByTestId("image-ad-done");
  await expect(done).toContainText("Rendered and filed to this project.", { timeout: 90_000 });
  await expect(done.getByTestId("image-ad-done-take").locator("img")).toBeVisible();
  expect(s.sends).toHaveLength(1);
  expect(s.sends[0]).toMatchObject({ ...quote, maxCredits: shown, quoteFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
  /* Back on 2.0 Alpha, extra high is not offered: the quality falls to high, and the price is live again. */
  await build.getByRole("button", { name: "2.0 Alpha" }).click();
  await expect(quality.getByRole("button")).toHaveText(["Low", "Medium", "High"]);
  await expect(quality.getByRole("button", { name: "High", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(build).toContainText("priced live before generating");
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
  await expect(quality.getByRole("button", { name: "High", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(quality.getByRole("button", { name: "Low", exact: true })).toHaveAttribute("aria-disabled", "true");
  await expect(quality.getByRole("button", { name: "Low", exact: true })).toHaveAttribute("title", "On 2.0 Alpha, presets use high quality.");
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

