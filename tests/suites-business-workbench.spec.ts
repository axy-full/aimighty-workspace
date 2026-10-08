import { test, expect, type Page, type PlaywrightWorkerArgs } from "@playwright/test";
import { createClient } from "@libsql/client";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { joinLocallyAsMember, localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { EMPTY_MOLECULR } from "../lib/workbench/moleculr";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, upload } from "./helpers/workspaceFixtures";
import { NO_PHONE_BOARD, onPhone } from "./helpers/businessOwn";
import { smallTargets } from "./phoneFloors";

/**
 * The old Business pages, on the Ads board (lib/shell/ads-social.ts: every `?suite=moleculr&page=marketing&sp=…` address is a
 * row to `?view=board&kind=ads&frame=…&card=…`, for every workspace).
 *
 * The image-ad card runs Marketing Studio Image on Particl's API key for every workspace and member: that test drives the
 * real board against the real routes of a local ENGINE_MOCK server, in a MANAGED workspace (platform keys, credits) — real
 * uploads, the real POST /api/generate/quote on the button, one real POST /api/generate at that figure — and asserts that
 * nothing reaches the connected account.
 *
 * The board draws no canvas on a phone: there its address opens the project's Record, and the old addresses are asserted to
 * do that, with no Ads card, no spending control and nothing sent. The two tests of the old Image ads page's variant names and
 * preset catalogue (Flare, the key's presets) have no home on the board's card yet: they stay as `test.fixme`, with the
 * reason, until the owner decides whether to port them or accept the loss.
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
  /* Nothing is made or sent by opening a page: any POST that spends (a render, an agent run) is recorded. */
  const paid: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && /^\/api\/(generate|workbench\/atomik)$/.test(path)) paid.push(path);
  });
  return { errors, asked, paid };
}

/** The old Business addresses and the Ads board address each is redirected to (lib/shell/ads-social.ts rows). */
const OLD_ADDRESSES: { old: string; frame: string | null; card: string | null }[] = [
  { old: "/suites?suite=moleculr&page=marketing&sp=ads", frame: "2", card: "image-ad" },
  { old: "/suites?suite=moleculr&page=ads&sp=ads", frame: null, card: null },
  { old: "/suites?suite=moleculr", frame: null, card: null },
  { old: "/suites?suite=moleculr&page=marketing&sp=dtc", frame: "2", card: "image-ad" },
  { old: "/suites?suite=moleculr&page=marketing&sp=setup", frame: "1", card: null },
  { old: "/suites?suite=moleculr&page=marketing&sp=hooks", frame: "2", card: "hooks" },
];
/** Words and controls of the old pages that no address reaches any more. */
const OLD_PAGE_IDS = ["image-ads-view", "ads-view", "ads-generate", "ads-connect", "owner-run-business", "particl-setup", "business-setup", "setup-connect", "primary-action"];

test("The old Business links land on the Ads board, Setup's address on its first frame; an earlier ad is a result on the board; the unbuilt sections say so with no price; nothing asks the account", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.skip(onPhone(info.project.name), NO_PHONE_BOARD);
  const { errors, asked, paid } = await open(page);
  for (const { old, frame, card } of OLD_ADDRESSES) {
    await page.goto(old);
    await expect(page.getByTestId("board")).toBeVisible({ timeout: 60_000 });
    /* The address is rewritten to the board's, and names the card from then on. */
    await expect.poll(() => new URL(page.url()).searchParams.get("view"), { message: old }).toBe("board");
    expect(new URL(page.url()).searchParams.get("kind"), old).toBe("ads");
    expect(new URL(page.url()).searchParams.get("frame"), old).toBe(frame);
    expect(new URL(page.url()).searchParams.get("card"), old).toBe(card);
    for (const gone of OLD_PAGE_IDS) await expect(page.getByTestId(gone), `${old}: ${gone}`).toHaveCount(0);
    await noSideScroll(page);
  }

  /* Setup is the first frame's cards, not a page: no retired card, no connect prompt, no Ads hand-off, no vendor name. */
  await page.goto("/suites?suite=moleculr&page=marketing&sp=setup");
  await expect(page.getByTestId("board")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("board")).not.toContainText(/Higgsfield|Open Ads|Use in Ads/);

  /* An ad made before reads as a result in the Ads group of the board. */
  await page.goto("/suites?suite=moleculr&page=marketing&sp=dtc");
  await expect(page.getByTestId("ads-image-ad")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("ads-result").filter({ hasText: "Bottle ad" })).toBeVisible({ timeout: 30_000 });

  /* Adapt, Deliver and UGC with consent are not built: each says so, shows no price and has no button that spends. */
  const unbuilt = page.getByTestId("ads-unavailable");
  await expect(unbuilt).toHaveCount(3);
  for (const section of await unbuilt.all()) {
    await expect(section).toContainText("Not in Particl yet");
    await expect(section).not.toContainText(/\d\s*cr\b|\$\s*\d|free/i);
    await expect(section.getByRole("button")).toHaveCount(0);
    await expect(section.locator("[data-spend]")).toHaveCount(0);
  }
  expect(paid, "opening the board sends nothing").toEqual([]);
  expect(asked, "nothing asks the account").toEqual([]);
  expect(errors).toEqual([]);
});

test("on a phone, the old Business addresses open the project's Record: no Ads card, no spending control, nothing sent", async ({ page }, info) => {
  test.skip(!onPhone(info.project.name), "desktop widths draw the board (the test above)");
  const { errors, asked, paid } = await open(page);
  for (const { old } of OLD_ADDRESSES) {
    await page.goto(old);
    await expect(page.getByTestId("phone-record"), old).toBeVisible({ timeout: 60_000 });
    for (const gone of [...OLD_PAGE_IDS, "board", "ads-image-ad", "ads-image-ad-make", "ads-unavailable"]) await expect(page.getByTestId(gone), `${old}: ${gone}`).toHaveCount(0);
    await expect(page.locator("[data-spend]"), `${old}: nothing here spends`).toHaveCount(0);
    await noSideScroll(page);
  }
  expect(paid, "opening an old address sends nothing").toEqual([]);
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
/** A person in a fresh managed workspace (owner, or a member through the real invitation) with credits and one saved project: the Ads board's brief holds a product, and no product image yet. */
async function seedManaged(page: Page, playwright: PlaywrightWorkerArgs["playwright"], as: "owner" | "member") {
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
  const project = { ...newProject(`Ads ${randomUUID().slice(0, 6)}`), boardKind: "ads", moleculr: { ...EMPTY_MOLECULR, productName: "Glass bottle", productBrand: "Clear Co", productDescription: "Borosilicate glass, 750 ml." } } as Project;
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
  return { seeded, project };
}
/** The Ads board at the image-ad card (the old Image ads address redirects here). */
async function openImageAdCard(page: Page, playwright: PlaywrightWorkerArgs["playwright"], as: "owner" | "member"): Promise<KeySeed> {
  const { seeded, project } = await seedManaged(page, playwright, as);
  await page.goto(`/suites?project=${project.id}&view=board&kind=ads&frame=2&card=image-ad`);
  await expect(page.getByTestId("ads-image-ad")).toBeVisible({ timeout: 60_000 });
  return seeded;
}
/** The old Image ads page, opened on its address. No address reaches it now (the board redirect); the two fixme tests below keep their steps against it. */
async function openOldImageAds(page: Page, playwright: PlaywrightWorkerArgs["playwright"], as: "owner" | "member"): Promise<KeySeed> {
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

test("The image-ad card runs Marketing Studio Image on the API key: the product first, the estimate on the button, one send at that figure, and the still lands", async ({ page, playwright }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.skip(onPhone(info.project.name), NO_PHONE_BOARD);
  test.setTimeout(180_000);
  const s = await openImageAdCard(page, playwright, "owner");
  const ad = page.getByTestId("ads-image-ad");
  /* Only the key's engine: no DTC engine, no account template library, no connect line, no old page. */
  await expect(ad.getByTestId("ads-image-ad-engine")).toContainText("Product image · 2.0 Alpha · 1:1 · 2K");
  for (const gone of ["dtc-engine", "ad-formats", "dtc-connect", "owner-run-business", "image-ads-view"]) await expect(page.getByTestId(gone)).toHaveCount(0);
  /* Before the product's image is in, nothing is priced and nothing can be sent. */
  await expect(ad).toContainText("Add the product's image first");
  await expect(ad.getByTestId("ads-image-ad-make")).toBeDisabled();
  await expect(ad.getByTestId("ads-image-ad-make")).not.toHaveAttribute("data-spend", "priced");
  expect(s.quotes, "nothing is priced before there is a product image").toEqual([]);
  /* The product's image comes in through the Product panel (a device file, kept as an original). */
  await page.getByTestId("board-rail").locator('[data-region="product"]').click();
  await page.getByTestId("ads-product-edit").click();
  await page.getByTestId("product-picker-file").setInputFiles({ name: "serum.webp", mimeType: "image/webp", buffer: readFileSync("public/campaign/hero.webp") });
  await expect(page.getByTestId("product-chosen")).toContainText("serum.webp", { timeout: 60_000 });
  await page.getByTestId("ads-panel-close").click();
  await page.getByTestId("board-rail").locator('[data-region="ads"]').click();
  await ad.getByTestId("ads-image-ad-prompt").fill("Bold hero shot on marble");
  await ad.getByRole("button", { name: "Change" }).click();
  await ad.getByRole("group", { name: "Aspect" }).getByRole("button", { name: "3:4", exact: true }).click();
  await ad.getByRole("group", { name: "Size" }).getByRole("button", { name: "1K", exact: true }).click();
  const make = ad.getByTestId("ads-image-ad-make");
  await expect(make).toHaveText(/^Make the image ad · \d[\d.,]* cr$/, { timeout: 60_000 });
  await expect(make).toHaveAttribute("data-spend", "priced");
  await expect(make).toHaveAttribute("data-spend-price", /^[\d.,]+ cr$/);
  await expect(ad.getByTestId("ads-image-ad-engine")).toContainText("Product image · 2.0 Alpha · 3:4 · 1K");
  const quote = s.quotes.at(-1)!;
  expect(quote).toMatchObject({ model: "higgsfield/marketing-studio-image", prompt: "Bold hero shot on marble", ratio: "3:4", resolution: "1k", refine: false, marketing: { quality: "high", enhancePrompt: false } });
  expect(quote).not.toHaveProperty("shotId");
  expect(quote.references).toEqual([{ uploadId: expect.any(String), role: "reference_image" }]);
  /* Nothing is sent until a person presses the button. */
  expect(s.sends, "nothing is sent before the press").toEqual([]);
  await noSideScroll(page);
  /* The figure on the button, as the button itself carries it: the ceiling the send must name. */
  const shown = Number((await make.getAttribute("data-spend-price"))!.replace(/ cr$/, "").replace(/,/g, ""));
  await expect(make).toContainText(`· ${(await make.getAttribute("data-spend-price"))!}`);
  await make.click();
  await expect(ad.getByText(/Done · it is in Ads below\./)).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("ads-result").first().locator("img")).toBeVisible({ timeout: 30_000 });
  expect(s.sends).toHaveLength(1);
  expect(s.sends[0]).toMatchObject({ ...quote, maxCredits: shown, quoteFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
  await noSideScroll(page);
  expect(imageAdsAsked(s.consumer), "The image-ad card asks the connected account for nothing").toEqual([]);
  expect(s.errors).toEqual([]);
});

/* owner decision pending: port to the board's image-ad card (a build name and quality), or accept the loss. */
test.fixme("Image ads on a 2.5 build: Flare at extra high names its variant, is priced approximately, is sent once at that figure, and the still lands", { annotation: { type: "owner decision pending", description: "port to the board's image-ad card, or accept the loss" } }, async ({ page, playwright }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.setTimeout(180_000);
  const s = await openOldImageAds(page, playwright, "owner");
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
  const shown = Number((await page.getByTestId("image-ad-generate").innerText()).match(/about ([\d,]+) cr/)![1].replace(/,/g, ""));
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

/* owner decision pending: port to the board's image-ad card (the key's preset catalogue), or accept the loss. */
test.fixme("Image ads: the key's preset catalogue, searched, on its own shelves with covers; a preset builds the ad around the product at high quality", { annotation: { type: "owner decision pending", description: "port to the board's image-ad card, or accept the loss" } }, async ({ page, playwright }, info) => {
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
  const s = await openOldImageAds(page, playwright, "member");
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

