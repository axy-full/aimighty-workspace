import { test, expect, type Locator, type Page, type PlaywrightWorkerArgs } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { newProject, type Project } from "../lib/workbench/studio";
import { joinLocallyAsMember, signInLocally } from "./helpers/workbenchLocal";
import { closeSuitesMenu, openSuitesMenu } from "./helpers/suitesMenu";
import { forbidPaidWork } from "./helpers/workspaceFixtures";

/**
 * The Higgsfield sign-in is retired (lib/higgsfield-consumer/retired.ts), in
 * the browser against a local ENGINE_MOCK server. Everyone — the workspace
 * owner included — meets one calm card wherever the connected account used to
 * run and nothing replaces it yet: Business's Ads and Setup. It says what ran
 * there, that Particl no longer signs in to Higgsfield and that past results
 * stay in the Library, with the way to make the same kind of thing in Gen on
 * this workspace's credits. Viral and Business › Image ads run on Particl's API
 * key, and Business's own tools and Cast are on the platform's key: all are
 * everyone's. No suite carries an "Owner" badge, Gen offers no connected
 * catalogue or Analysis, and nothing new is asked of the account: the only
 * account route the owner's pages call is the shell's own list of saved jobs
 * (so jobs already running are still collected). Nothing is generated or billed.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const PORTRAIT = ["workbench-360x640", "workbench-390x844"];
const WIDE = ["workbench-1440x900", "workbench-1920x1080"];
const SHOT_AT: Record<string, string> = { "workbench-1440x900": "1440x900", "workbench-390x844": "390x844" };
const SHOTS = process.env.CONNECTED_ROLE_SHOTS;
const CONSUMER = /\/api\/higgsfield\/consumer\//;
const TITLE = "Particl no longer signs in to Higgsfield";
/** The shell's collector lists the owner's saved jobs (a ledger read, never the account): the one account route still called. */
const COLLECTOR_LIST = "GET /api/higgsfield/consumer/generation";
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "ignoreErrors" }); });

async function settle(page: Page) {
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => !(a.effect instanceof KeyframeEffect && a.effect.getComputedTiming().iterations === Infinity)).map((a) => a.finished.catch(() => undefined))));
}
async function shot(page: Page, name: string, project: string) {
  const size = SHOT_AT[project];
  if (!size || !SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await settle(page);
  await page.screenshot({ path: join(SHOTS, `role-${name}-${size}.png`) });
}
/** React has attached to the element: a click before that is lost on a cold server. */
async function hydrated(target: Locator) {
  await expect.poll(() => target.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps"))), { timeout: 30_000 }).toBe(true);
}
async function noSideScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), "no horizontal page scroll").toBeLessThanOrEqual(1);
  for (const card of await page.locator(".gx-owner-run").all()) expect(await card.evaluate((el) => el.scrollWidth - el.clientWidth), "owner card keeps its content inside").toBeLessThanOrEqual(1);
}
/** On a phone every button in `scope` is a whole 44px target. */
async function fingerSized(scope: Locator, project: string) {
  if (!PHONES.includes(project)) return;
  for (const button of await scope.getByRole("button").all()) {
    const box = await button.boundingBox();
    expect(box, await button.innerText()).not.toBeNull();
    expect(Math.round(box!.height), await button.innerText()).toBeGreaterThanOrEqual(44);
    expect(Math.round(box!.width), await button.innerText()).toBeGreaterThanOrEqual(44);
  }
}
function watch(page: Page) {
  const consumer: string[] = [];
  const errors: string[] = [];
  page.on("request", (request) => { if (CONSUMER.test(request.url())) consumer.push(`${request.method()} ${new URL(request.url()).pathname}`); });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (m) => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text().slice(0, 200)); });
  return { consumer, errors };
}
async function saveProject(page: Page, workspaceId: string, project: Project) {
  const me = await page.request.get("/api/me").then((r) => r.json()) as { id: string; owner: boolean };
  const saved = await page.request.put("/api/workbench/projects", { headers: { "X-Workbench-Scope": `particl-active-${workspaceId}-${me.id}` }, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  return me;
}

/** A project with one cast entry, saved in the page's workspace. */
function castProject(name: string) {
  const project = newProject(name);
  project.production = { cast: { entries: [{ id: "cast-fox", kind: "character", name: "Fox", description: "A red fox", prompt: "A red fox on ice at dusk", takes: [] }] } };
  return project;
}
/** The workspace's owner, with a project of their own. */
async function asOwner(page: Page) {
  const { workspace } = await signInLocally(page.request);
  const project = castProject("Harbour look");
  const me = await saveProject(page, workspace.id, project);
  await forbidPaidWork(page);
  expect(me.owner, "the page holds the owner's session").toBe(true);
  return { project, ...watch(page) };
}
/** A member of a fresh workspace whose owner has a name of its own. */
async function asMember(page: Page, playwright: PlaywrightWorkerArgs["playwright"]) {
  const ownerName = `Harbour Production Supervision ${randomBytes(12).toString("hex")}`;
  const ownerApi = await playwright.request.newContext({ baseURL: process.env.PW_BASE_URL });
  const { workspace } = await joinLocallyAsMember(ownerApi, page.request, { ownerName });
  await ownerApi.dispose();
  const project = castProject("Harbour look");
  const me = await saveProject(page, workspace.id, project);
  await forbidPaidWork(page);
  expect(me.owner, "the page holds a member's session").toBe(false);
  return { ownerName, project, ...watch(page) };
}
/** No suite carries the old "Owner" badge or its note. */
async function noBadges(page: Page) {
  /* A phone keeps the Suites behind its context badge (components/graphite/phone.css), one tap away. */
  await openSuitesMenu(page);
  await expect(page.getByRole("tablist", { name: "Suites" })).toBeVisible();
  for (const suite of ["business", "viral", "studio", "gen", "atomik", "crew"]) await expect(page.getByTestId(`owner-badge-${suite}`)).toHaveCount(0);
  for (const suite of ["business", "viral"]) expect(await page.locator(`[data-suite-tab="${suite}"]`).getAttribute("aria-describedby")).toBeNull();
  await closeSuitesMenu(page);
}

test("the owner meets one calm card where the Higgsfield account ran — Business's Ads and Setup — and makes the same kind of thing in Gen on this workspace's credits; Viral and Image ads run on the API key, Cast on the platform's key", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const project = info.project.name;
  const { project: film, consumer, errors } = await asOwner(page);

  /* Business › Ads: the card says what changed, on the first paint, and nothing else of that page. */
  await page.goto(`/suites?suite=moleculr&page=ads&sp=ads&project=${film.id}`);
  const business = page.getByTestId("owner-run-business");
  await expect(business).toBeVisible();
  await expect(page.getByTestId("owner-run-business-title")).toHaveText(TITLE);
  await expect(business).toContainText("Ads here ran on a signed-in Higgsfield account. Past results stay in your Library.");
  await expect(business).toContainText("On this workspace’s credits");
  await expect(business).not.toContainText(/run by|owner/i);
  await expect(page.getByTestId("ads-view")).toHaveCount(0);
  await expect(page.getByText(/Connect the account|Reconnect the account|Only the workspace owner/)).toHaveCount(0);
  await expect(page.getByTestId("primary-action")).toHaveCount(0);
  await noBadges(page);
  await noSideScroll(page);
  await fingerSized(business, project);
  await shot(page, "business-owner", project);

  /* Business's pages are listed; Setup is the same card, with what Particl made in the project below it. */
  await expect(page.getByRole("navigation", { name: "Pages" })).toBeVisible();
  await page.goto(`/suites?suite=moleculr&page=setup&sp=setup&project=${film.id}`);
  await expect(page.getByTestId("owner-run-business")).toBeVisible();
  await expect(page.getByTestId("particl-setup")).toBeVisible();
  await expect(page.getByTestId("setup-view")).toHaveCount(0);
  /* Image ads runs on Particl's API key: the composer, not the card. */
  await page.goto(`/suites?suite=moleculr&page=dtc&sp=dtc&project=${film.id}`);
  await expect(page.getByTestId("image-ads-view")).toBeVisible();
  await expect(page.getByTestId("owner-run-business")).toHaveCount(0);
  await expect(page.getByTestId("image-ad-blocked")).toHaveText("Write the prompt.");
  await noSideScroll(page);
  await shot(page, "image-ads-owner", project);

  /* Open Gen · Images: Gen on Images, Studio engines only — no Higgsfield catalogue, no Analysis, for the owner too. */
  await page.goto(`/suites?suite=moleculr&page=ads&sp=ads&project=${film.id}`);
  const toGen = page.getByTestId("owner-run-business-gen");
  await hydrated(toGen);
  await expect(toGen).toHaveText("Open Gen · Images");
  await toGen.click();
  await expect(page.getByTestId("gen-view")).toBeVisible();
  const output = page.getByRole("tablist", { name: "Output" });
  await expect(output.getByRole("tab", { name: "Images" })).toHaveAttribute("aria-selected", "true");
  await expect(output.getByRole("tab")).toHaveText(["Video", "Images", "Audio", "Edit"]);
  await expect(page.getByTestId("gen-tab-analysis")).toHaveCount(0);
  await page.getByTestId("gen-model").click();
  const sheet = page.getByRole("dialog", { name: "Choose a model" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("tab", { name: "Higgsfield catalogue" })).toHaveCount(0);
  await expect(sheet.getByTestId("gen-sheet-catalogue")).toHaveText("Studio engines");
  await expect(page.getByTestId("gen-model")).toContainText("Studio engine");
  await noSideScroll(page);
  await shot(page, "gen-owner-sheet", project);
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toHaveCount(0);
  /* Four tabs keep one row, each a whole target. */
  const tabs = await output.getByRole("tab").all();
  const tops = await Promise.all(tabs.map(async (tab) => (await tab.boundingBox())!.y));
  expect(new Set(tops.map((y) => Math.round(y))).size, "one row of tabs").toBe(1);
  if (PHONES.includes(project)) for (const tab of tabs) expect((await tab.boundingBox())!.width).toBeGreaterThanOrEqual(44);

  /* Viral runs on Particl's API key: the page is the composer, with its stage's plan to run too. */
  await page.goto(`/suites?suite=subatomik&page=motion&sp=motion&project=${film.id}`);
  await expect(page.getByTestId("viral-view")).toBeVisible();
  await expect(page.getByTestId("owner-run-viral")).toHaveCount(0);
  await expect(page.getByTestId("viral-reason")).toHaveText("Add one source video (4–30 s).");
  await expect(page.getByTestId("primary-action")).toBeVisible();
  if (WIDE.includes(project)) {
    /* The stage's Atomik plan is on the key (#470): the Inspector offers it, and nothing says the account runs it. */
    await expect(page.getByTestId("spec-plan")).toBeVisible();
    await expect(page.getByTestId("spec-plan-owner")).toHaveCount(0);
  }
  await noSideScroll(page);
  await shot(page, "viral-owner", project);

  /* Cast runs on the platform's key (28 September): no retired card and no connect prompt. The list, Build identity and
     each character's render are this workspace's, on its credits, and each entry's still can be made in Gen. */
  await page.goto(`/suites?suite=studio&page=cast&project=${film.id}`);
  await expect(page.getByTestId("cast-stage")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("owner-run-cast")).toHaveCount(0);
  for (const gone of ["cast-connect", "cast-price", "cast-blocked", "cast-elements", "page-soul"]) await expect(page.getByTestId(gone)).toHaveCount(0);
  const soul = page.getByTestId("soul-card");
  await expect(soul).toBeVisible();
  await expect(soul.getByRole("heading", { name: "Build identity" })).toBeVisible();
  const fox = page.getByTestId("cast-entry");
  await expect(fox).toHaveCount(1);
  await expect(fox.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Fox");
  await expect(fox.getByLabel("Fox prompt", { exact: true })).toHaveValue("A red fox on ice at dusk");
  await expect(fox.getByTestId("cast-render-why")).toHaveText("Train a Soul ID below to render it.", { timeout: 30_000 });
  await noSideScroll(page);
  await fingerSized(soul.locator(".gx-gen-enhance"), project);
  await shot(page, "cast-owner", project);
  const still = fox.getByTestId("cast-still-gen");
  await still.scrollIntoViewIfNeeded();
  await hydrated(still);
  await fingerSized(fox.locator(".gx-gen-enhance"), project);
  await still.click();
  await expect(page.getByTestId("gen-view")).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Output" }).getByRole("tab", { name: "Images" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("gen-prompt")).toHaveValue("A red fox on ice at dusk");
  await expect(page.getByTestId("gen-preset-note")).toHaveText("Reference still · Fox");
  await expect(page.getByTestId("gen-preset-note")).toBeInViewport();
  await shot(page, "gen-owner-still", project);

  /* The phone's Home: no suite ran on the account as a whole any more (Viral is on the key), so none says retired or who
     runs it; Business is Particl's own tools. */
  if (PORTRAIT.includes(project)) {
    await page.getByTestId("tabbar-home").click();
    await expect(page.getByTestId("suite-home")).toBeVisible();
    await expect(page.getByTestId("home-fact-business")).toHaveText("Brand · product · briefs · design");
    for (const suite of ["business", "viral", "studio"]) {
      await expect(page.getByTestId(`home-fact-${suite}`)).not.toContainText(/Run by|retired/);
      await expect(page.getByTestId(`home-suite-${suite}`)).not.toHaveAttribute("data-retired", "true");
    }
    await noSideScroll(page);
    await shot(page, "home-owner", project);
  }

  /* Nothing new was asked of the account on the way: the only account route called is the collector's list of saved jobs. */
  expect(consumer.filter((request) => request !== COLLECTOR_LIST), "no new work, and no read of the account").toEqual([]);
  expect(errors).toEqual([]);
});

test("a member meets the same card on Ads and Setup, naming no one, runs Viral and Image ads on the workspace's credits, and nothing of the account is read", async ({ page, playwright }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { ownerName, project: film, consumer, errors } = await asMember(page, playwright);
  for (const pageId of ["ads", "setup"] as const) {
    await page.goto(`/suites?suite=moleculr&page=${pageId}&sp=${pageId}&project=${film.id}`);
    const card = page.getByTestId("owner-run-business");
    await expect(card).toBeVisible();
    await expect(page.getByTestId("owner-run-business-title")).toHaveText(TITLE);
    await expect(card).not.toContainText(ownerName);
    await expect(card).not.toContainText(/run by/i);
    await expect(page.getByTestId("primary-action")).toHaveCount(0);
    await noBadges(page);
    await noSideScroll(page);
    await fingerSized(card, info.project.name);
  }
  await shot(page, "business-member", info.project.name);
  /* Image ads and Viral run on Particl's API key for a member as for anyone: the composers, not a card. */
  await page.goto(`/suites?suite=moleculr&page=dtc&sp=dtc&project=${film.id}`);
  await expect(page.getByTestId("image-ads-view")).toBeVisible();
  await expect(page.getByTestId("owner-run-business")).toHaveCount(0);
  await expect(page.getByTestId("image-ad-blocked")).toHaveText("Write the prompt.");
  await noSideScroll(page);
  await page.goto(`/suites?suite=subatomik&page=motion&sp=motion&project=${film.id}`);
  await expect(page.getByTestId("viral-view")).toBeVisible();
  await expect(page.getByTestId("owner-run-viral")).toHaveCount(0);
  await expect(page.getByTestId("viral-reason")).toHaveText("Add one source video (4–30 s).");
  await expect(page.getByTestId("primary-action")).toBeVisible();
  await noBadges(page);
  await noSideScroll(page);
  await shot(page, "viral-member", info.project.name);
  expect(consumer, "no account route at all for a member").toEqual([]);
  expect(errors).toEqual([]);
});

test("the Studio alternative takes a fresh credit quote before explicit Generate", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { project: film, consumer } = await asOwner(page);
  /* The server's own live quote, held until released: Generate waits for it. Its figure is the one the
     submit-time quote (POST /api/generate/quote) must match exactly before anything is sent. */
  const quotes: number[] = [];
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const submitted: Record<string, unknown>[] = [];
  await page.route("**/api/workbench/engines**", async (route) => {
    if (!new URL(route.request().url()).searchParams.has("model")) return route.fallback();
    const response = await route.fetch();
    const quote = await response.json() as { credits?: unknown };
    if (typeof quote.credits === "number") quotes.push(quote.credits);
    await hold;
    return route.fulfill({ response });
  });
  await page.route("**/api/generate", async (route) => {
    submitted.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ status: 409, json: { error: "Mock admission stopped this request." } });
  });
  try {
    await page.goto(`/suites?suite=moleculr&page=ads&sp=ads&project=${film.id}`);
    const card = page.getByTestId("owner-run-business");
    await expect(card).toBeVisible();
    await page.addStyleTag({ content: '.gx-owner-run, .gx-owner-run * { font-family: Verdana, sans-serif !important; }' });
    await noSideScroll(page);
    await fingerSized(card, info.project.name);
    await page.getByTestId("owner-run-business-gen").click();
    await page.getByTestId("gen-prompt").fill("A product still against a neutral studio background.");
    await expect.poll(() => quotes.length).toBeGreaterThan(0);
    await expect(page.getByTestId("gen-generate")).toBeDisabled();
    expect(submitted).toEqual([]);
    release();
    const generate = page.getByTestId("gen-generate");
    await expect(generate).toBeEnabled();
    /* The button asks for one of the server's own quotes — a real figure, never a guess — and exactly that is sent. */
    await expect(generate).toContainText(/· [\d,]+ cr/);
    const credits = Number(/· ([\d,]+) cr/.exec((await generate.textContent()) ?? "")![1].replace(/,/g, ""));
    expect(credits).toBeGreaterThan(0);
    expect(quotes).toContain(credits);
    expect(submitted).toEqual([]);
    await generate.click();
    await expect.poll(() => submitted.length).toBe(1);
    expect(submitted[0]).toMatchObject({ maxCredits: credits });
    expect(consumer.filter((request) => request !== COLLECTOR_LIST)).toEqual([]);
  } finally { release(); }
});

test("the previous workspace Atomik panel never offers an account approval, the owner's included: Motion Transfer's plan runs on the API-key engine and waits for the page's request", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { project: film } = await asOwner(page);
  const writes: string[] = [];
  await page.route("**/api/higgsfield/consumer/**", (route) => {
    if (route.request().method() !== "GET") writes.push(route.request().url());
    return route.fallback();
  });
  await page.goto(`/workspace?suite=subatomik&page=motion&project=${film.id}`);
  if (WIDE.includes(info.project.name)) await page.getByTestId("atomik-button").click();
  else await page.getByTestId("mobile-ask-atomik").click();
  /* Atomik no longer runs anything on the account, so the plan is no account's to refuse. */
  await expect(page.getByTestId("atomik-owner-run")).toHaveCount(0);
  await expect(page.getByTestId("atomik-reason").or(page.getByTestId("mobile-atomik-reason")).first()).toHaveText("Needs Motion Transfer data");
  await expect(page.getByRole("button", { name: /^Approve/ })).toHaveCount(0);
  for (const run of await page.getByRole("button", { name: /Run this page/ }).all()) await expect(run).toBeDisabled();
  expect(writes).toEqual([]);
  await noSideScroll(page);
});
