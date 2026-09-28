import { test, expect, type Locator, type Page, type PlaywrightWorkerArgs } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { newProject, type Project } from "../lib/workbench/studio";
import { reachFromTools } from "../lib/higgsfield-consumer/reach";
import { joinLocallyAsMember, signInLocally } from "./helpers/workbenchLocal";
import { forbidPaidWork } from "./helpers/workspaceFixtures";

/**
 * Idea 19 — role-aware connected-account surfaces, in the browser against a
 * local ENGINE_MOCK server. A member (a real invitation, accepted) meets one
 * calm card wherever the owner's Higgsfield account runs — Business, Viral,
 * Cast — naming this workspace's owner, with the way to make the same kind of
 * thing in Gen on this workspace's credits; the suites the owner runs carry
 * the key; Gen offers them no connected tab; and nothing of the account is
 * read for them. The owner's connection is read once and shared across
 * Business's pages, and a failed read is an error to retry, never a member's
 * card. Nothing is generated or billed.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const PORTRAIT = ["workbench-360x640", "workbench-390x844"];
const WIDE = ["workbench-1440x900", "workbench-1920x1080"];
const SHOT_AT: Record<string, string> = { "workbench-1440x900": "1440x900", "workbench-390x844": "390x844" };
const SHOTS = process.env.CONNECTED_ROLE_SHOTS;
const CONSUMER = /\/api\/higgsfield\/consumer\//;
const TOOLS_PAGE = "/suites?suite=atomik&page=skills&sp=skills";
/** The connected account's answer to Tools' reach check, from a recorded tools/list: 13 of 14 rows (analysis is switched off). */
function reachChecked() {
  const names = (JSON.parse(readFileSync("tests/fixtures/connected-tools-98.json", "utf8")) as { tools: { name: string }[] }).tools.map((tool) => tool.name);
  const reach = reachFromTools(names, { off: ["analysis"] });
  return { status: "checked", checkedAt: Date.now(), reach, available: reach.filter((row) => row.available).length, total: reach.length };
}
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

/** A member of a fresh workspace whose owner has a name of its own, and a project with one cast entry. */
async function asMember(page: Page, playwright: PlaywrightWorkerArgs["playwright"]) {
  const ownerName = `Harbour Production Supervision ${randomBytes(12).toString("hex")}`;
  const ownerApi = await playwright.request.newContext({ baseURL: process.env.PW_BASE_URL });
  const { workspace } = await joinLocallyAsMember(ownerApi, page.request, { ownerName });
  await ownerApi.dispose();
  const project = newProject("Harbour look");
  project.production = { cast: { entries: [{ id: "cast-fox", kind: "character", name: "Fox", description: "A red fox", prompt: "A red fox on ice at dusk", takes: [] }] } };
  const me = await saveProject(page, workspace.id, project);
  await forbidPaidWork(page);
  expect(me.owner, "the page holds a member's session").toBe(false);
  return { ownerName, project, ...watch(page) };
}

test("a member meets one calm card where the owner's account runs, and makes the same kind of thing in Gen on this workspace's credits", async ({ page, playwright }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const project = info.project.name;
  const { ownerName, project: film, consumer, errors } = await asMember(page, playwright);

  /* Business: the card names this workspace's owner — on the first paint, from the session — and nothing else of the suite. */
  await page.goto(`/suites?suite=moleculr&page=ads&sp=ads&project=${film.id}`);
  const business = page.getByTestId("owner-run-business");
  await expect(business).toBeVisible();
  await expect(page.getByTestId("owner-run-business-title")).toHaveText(`Higgsfield-account tools are run by ${ownerName}`);
  await expect(business).toContainText("connected account");
  await expect(business).toContainText("On this workspace’s credits");
  await expect(page.getByTestId("ads-view")).toHaveCount(0);
  await expect(page.getByText(/Connect the account|Only the workspace owner/)).toHaveCount(0);
  /* The stage is the owner's to run: no Run stage for a member. */
  await expect(page.getByTestId("primary-action")).toHaveCount(0);
  /* The suites the owner runs carry the key, and say who runs them; the rest do not. */
  await expect(page.getByTestId("owner-badge-business")).toBeVisible();
  await expect(page.getByTestId("owner-badge-viral")).toBeVisible();
  for (const other of ["studio", "gen", "atomik", "crew"]) await expect(page.getByTestId(`owner-badge-${other}`)).toHaveCount(0);
  await expect(page.locator('[data-suite-tab="business"]')).toHaveAccessibleDescription(`Run by ${ownerName} on the Higgsfield account`);
  await expect(page.locator('[data-suite-tab="viral"]')).toHaveAccessibleDescription(`Run by ${ownerName} on the Higgsfield account`);
  expect(await page.locator('[data-suite-tab="atomik"]').getAttribute("aria-describedby")).toBeNull();
  await noSideScroll(page);
  await fingerSized(business, project);
  await shot(page, "business-member", project);

  /* Business's other pages are the same card. */
  await expect(page.getByRole("navigation", { name: "Pages" })).toHaveCount(0);
  await page.goto(`/suites?suite=moleculr&page=setup&sp=setup&project=${film.id}`);
  await expect(page.getByTestId("owner-run-business")).toBeVisible();
  await expect(page.getByTestId("setup-view")).toHaveCount(0);

  /* Open Gen · Images: Gen on Images, Studio engines only — no Higgsfield catalogue, no Analysis. */
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
  await shot(page, "gen-member-sheet", project);
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toHaveCount(0);
  /* A member's four tabs keep one row, each a whole target. */
  const tabs = await output.getByRole("tab").all();
  const tops = await Promise.all(tabs.map(async (tab) => (await tab.boundingBox())!.y));
  expect(new Set(tops.map((y) => Math.round(y))).size, "one row of tabs").toBe(1);
  if (PHONES.includes(project)) for (const tab of tabs) expect((await tab.boundingBox())!.width).toBeGreaterThanOrEqual(44);

  /* Viral: the same card; its way is Gen on Video. */
  await page.goto(`/suites?suite=subatomik&page=motion&sp=motion&project=${film.id}`);
  const viral = page.getByTestId("owner-run-viral");
  await expect(viral).toBeVisible();
  await expect(page.getByTestId("owner-run-viral-title")).toHaveText(`Higgsfield-account tools are run by ${ownerName}`);
  await expect(page.getByTestId("viral-view")).toHaveCount(0);
  await expect(page.getByTestId("primary-action")).toHaveCount(0);
  if (WIDE.includes(project)) {
    /* The stage's Atomik plan runs on the connected account: the Inspector says who runs it instead of offering the button. */
    await expect(page.getByTestId("spec-plan-owner")).toHaveText(`Run by ${ownerName} on the Higgsfield account.`);
    await expect(page.getByTestId("spec-plan").getByRole("button")).toHaveCount(0);
  }
  await noSideScroll(page);
  await fingerSized(viral, project);
  await shot(page, "viral-member", project);
  const toVideo = page.getByTestId("owner-run-viral-gen");
  await hydrated(toVideo);
  await toVideo.click();
  await expect(page.getByRole("tablist", { name: "Output" }).getByRole("tab", { name: "Video" })).toHaveAttribute("aria-selected", "true");

  /* Cast: the list stays the member's to shape; the card replaces the connect prompt, and each entry's still is made in Gen. */
  await page.goto(`/suites?suite=studio&page=cast&project=${film.id}`);
  const cast = page.getByTestId("owner-run-cast");
  await expect(cast).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("owner-run-cast-title")).toHaveText(`Higgsfield-account tools are run by ${ownerName}`);
  for (const gone of ["cast-connect", "cast-price", "cast-blocked", "cast-elements", "page-soul"]) await expect(page.getByTestId(gone)).toHaveCount(0);
  const fox = page.getByTestId("cast-entry");
  await expect(fox).toHaveCount(1);
  await expect(fox.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Fox");
  await expect(fox.getByLabel("Fox prompt", { exact: true })).toHaveValue("A red fox on ice at dusk");
  await noSideScroll(page);
  await fingerSized(cast, project);
  await shot(page, "cast-member", project);
  const still = fox.getByTestId("cast-still-gen");
  await still.scrollIntoViewIfNeeded();
  await hydrated(still);
  await fingerSized(fox.locator(".gx-gen-enhance"), project);
  await still.click();
  await expect(page.getByTestId("gen-view")).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Output" }).getByRole("tab", { name: "Images" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("gen-prompt")).toHaveValue("A red fox on ice at dusk");
  await expect(page.getByTestId("gen-preset-note")).toHaveText("Reference still · Fox");
  /* Gen opens at its top, not where the Cast page was scrolled to: the prompt it was sent with is in view. */
  await expect(page.getByTestId("gen-preset-note")).toBeInViewport();
  await shot(page, "gen-member-still", project);

  /* The phone's Home says who runs the owner's suites. */
  if (PORTRAIT.includes(project)) {
    await page.getByTestId("tabbar-home").click();
    await expect(page.getByTestId("suite-home")).toBeVisible();
    for (const suite of ["business", "viral"]) {
      await expect(page.getByTestId(`home-fact-${suite}`)).toHaveText(`Run by ${ownerName}`);
      await expect(page.getByTestId(`home-suite-${suite}`)).toHaveAttribute("data-owner-run", "true");
    }
    await expect(page.getByTestId("home-fact-studio")).not.toContainText("Run by");
    await noSideScroll(page);
    await shot(page, "home-member", project);
  }

  /* Nothing of the connected account was read or sent for the member, anywhere on the way. */
  expect(consumer, "no connected-account request for a member").toEqual([]);
  expect(errors).toEqual([]);
});

test("a member's connected workflows say who runs them, and read nothing", async ({ page, playwright }, info) => {
  test.skip(!["workbench-1440x900", "workbench-390x844"].includes(info.project.name), "one wide, one phone");
  const { ownerName, project: film, consumer, errors } = await asMember(page, playwright);
  await page.goto(`/suites?suite=studio&page=edit&project=${film.id}`);
  await expect(page.getByTestId("owner-run-workflows-title")).toHaveText(`Higgsfield-account tools are run by ${ownerName}`);
  for (const tool of ["dubbing", "voice_change"]) await expect(page.getByTestId(`workflow-${tool}-tool`)).toHaveCount(0);
  await expect(page.getByText("The workspace owner uses the connected account.")).toHaveCount(0);
  await noSideScroll(page);
  await shot(page, "edit-member", info.project.name);
  expect(consumer).toEqual([]);
  expect(errors).toEqual([]);
});

test("the owner sees no badge and reads the connection once for Business's pages; a lapsed grant says reconnect, with Engines one tap away", async ({ page }, info) => {
  test.skip(!["workbench-1440x900", "workbench-390x844"].includes(info.project.name), "one wide, one phone");
  const { workspace } = await signInLocally(page.request);
  const film = newProject("Owner look");
  const me = await saveProject(page, workspace.id, film);
  expect(me.owner).toBe(true);
  const { errors } = watch(page);
  let reads = 0;
  await page.route("**/api/higgsfield/consumer/connection", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    reads++;
    return route.fulfill({ json: { connected: true, requiresReconnect: true } });
  });
  await page.goto(`/suites?suite=moleculr&page=ads&sp=ads&project=${film.id}`);
  const connect = page.getByTestId("ads-connect");
  await expect(connect).toHaveText(/Reconnect the account in Workspace › Engines\./);
  await expect(page.getByTestId("ads-blocked")).toHaveText("Reconnect the account in Workspace › Engines.");
  await expect(page.getByTestId("owner-run-business")).toHaveCount(0);
  for (const suite of ["business", "viral"]) await expect(page.getByTestId(`owner-badge-${suite}`)).toHaveCount(0);
  expect(await page.locator('[data-suite-tab="business"]').getAttribute("aria-describedby")).toBeNull();
  await expect(page.locator('[data-suite-tab="business"]')).not.toHaveAccessibleDescription(/Run by/);
  await expect(page.getByTestId("primary-action")).toBeVisible();

  /* Business's pages share the one answer: moving between them reads nothing again. */
  const strip = page.getByRole("navigation", { name: "Pages" });
  await hydrated(strip.getByRole("button", { name: /Image ads/ }));
  await strip.getByRole("button", { name: /Image ads/ }).click();
  await expect(page.getByTestId("dtc-connect")).toHaveText(/Reconnect the account/);
  await strip.getByRole("button", { name: /Setup/ }).click();
  await expect(page.getByTestId("setup-connect")).toHaveText(/Reconnect the account/);
  await strip.getByRole("button", { name: /Ads/ }).first().click();
  await expect(page.getByTestId("ads-connect")).toBeVisible();
  expect(reads, "one read of the connection for every Business page").toBe(1);

  /* The owner is offered the Higgsfield catalogue in Gen. */
  await page.locator('[data-suite-tab="gen"]').click();
  await page.getByTestId("gen-model").click();
  await expect(page.getByRole("dialog", { name: "Choose a model" }).getByRole("tab")).toHaveText(["Studio engines", "Higgsfield catalogue"]);
  await page.getByRole("dialog", { name: "Choose a model" }).getByRole("button", { name: "Close" }).click();
  await expect(page.getByTestId("gen-tab-analysis")).toBeVisible();

  /* Engines is where the owner reconnects. */
  await page.locator('[data-suite-tab="business"]').click();
  await page.getByTestId("ads-connect").getByRole("button", { name: "Open Engines" }).click();
  await expect(page.getByTestId("ws-engines")).toBeVisible();
  await shot(page, "owner-engines", info.project.name);
  expect(errors).toEqual([]);
});

test("while the owner's connection is read Business says so, a failed read is an error with Try again — never a member's card — and Try again reads once more", async ({ page }, info) => {
  test.skip(!["workbench-1440x900", "workbench-390x844"].includes(info.project.name), "one wide, one phone");
  const { workspace } = await signInLocally(page.request);
  const film = newProject("Owner errors");
  await saveProject(page, workspace.id, film);
  const { errors } = watch(page);
  let reads = 0;
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/higgsfield/consumer/connection", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    reads++;
    if (reads === 1) { await held; return route.fulfill({ status: 503, json: { error: "The connected account is temporarily unavailable." } }); }
    return route.fulfill({ json: { connected: false, requiresReconnect: false } });
  });
  await page.goto(`/suites?suite=moleculr&page=ads&sp=ads&project=${film.id}`);

  /* Loading: the reason is the read itself, not a connect prompt the owner may not need. */
  await expect(page.getByTestId("ads-blocked")).toHaveText("Reading the connected account…");
  await expect(page.getByTestId("ads-connect")).toHaveCount(0);
  await expect(page.getByTestId("ads-generate")).toBeDisabled();
  await shot(page, "owner-reading", info.project.name);
  release();

  /* Error: said plainly, with Try again; the owner is still the owner. */
  const failed = page.getByTestId("ads-connect");
  await expect(failed).toHaveText(/The connected account is temporarily unavailable\.\s*Try again/);
  await expect(failed).toHaveAttribute("role", "alert");
  await expect(page.getByTestId("ads-blocked")).toHaveText("The connected account could not be read.");
  await expect(page.getByTestId("owner-run-business")).toHaveCount(0);
  await noSideScroll(page);
  await fingerSized(failed, info.project.name);
  await shot(page, "owner-error", info.project.name);

  /* Try again reads once more, and the answer replaces the error. */
  const retry = failed.getByRole("button", { name: "Try again" });
  await hydrated(retry);
  await retry.click();
  await expect(page.getByTestId("ads-connect")).toHaveText(/^Connect the account in Workspace › Engines\.\s*Open Engines$/);
  await expect(page.getByTestId("ads-connect")).not.toHaveAttribute("role", "alert");
  expect(reads).toBe(2);
  expect(errors).toEqual([]);
});


test("the member's Studio alternative takes a fresh credit quote before explicit Generate", async ({ page, playwright }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { project: film, consumer } = await asMember(page, playwright);
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
    expect(consumer).toEqual([]);
  } finally { release(); }
});

test("the previous workspace Atomik panel never offers a member an owner-account approval", async ({ page, playwright }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { ownerName, project: film } = await asMember(page, playwright);
  const writes: string[] = [];
  await page.route("**/api/higgsfield/consumer/**", (route) => {
    if (route.request().method() !== "GET") writes.push(route.request().url());
    return route.fulfill({ status: 403, json: { error: "Owner only." } });
  });
  await page.goto(`/workspace?suite=subatomik&page=motion&project=${film.id}`);
  if (WIDE.includes(info.project.name)) await page.getByTestId("atomik-button").click();
  else await page.getByTestId("mobile-ask-atomik").click();
  await expect(page.getByTestId("atomik-owner-run")).toHaveText(`Run by ${ownerName} on the Higgsfield account.`);
  await expect(page.getByRole("button", { name: /^Approve/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Run this page/ })).toHaveCount(0);
  expect(writes).toEqual([]);
  await noSideScroll(page);
});

test("Tools: a reach check that set out before the owner disconnects never comes back — the page checks again, and no surface is told the account is connected", async ({ page }, info) => {
  test.skip(!["workbench-1440x900", "workbench-390x844"].includes(info.project.name), "one wide, one phone");
  await signInLocally(page.request);
  await forbidPaidWork(page);
  const { errors } = watch(page);
  /* The owner's account is connected until Engines disconnects it. */
  let linked = true;
  await page.route("**/api/higgsfield/consumer/connection", (route) => {
    const method = route.request().method();
    if (method === "DELETE") { linked = false; return route.fulfill({ json: { ok: true } }); }
    if (method !== "GET") return route.fallback();
    return route.fulfill({ json: { connected: linked, requiresReconnect: false } });
  });
  /* The first check is held until after the disconnect, then answers with the account's old tools; later checks find no account. */
  let checks = 0;
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/higgsfield/consumer/capabilities", async (route) => {
    checks++;
    if (checks === 1) { await held; return route.fulfill({ json: reachChecked() }); }
    return route.fulfill({ status: 409, json: { status: "unavailable", code: "not_connected", error: "Connect the owner’s account in Workspace › Engines." } });
  });
  try {
    await page.goto(TOOLS_PAGE);
    await expect(page.getByTestId("reach-summary")).toHaveText("Checking the connected account…");
    await expect.poll(() => checks).toBe(1);

    /* Engines, in the same page: the owner disconnects while the check is still out. */
    const avatar = page.getByTestId("workspace-avatar");
    const toWorkspace = (await avatar.isVisible()) ? avatar : page.getByTestId("tabbar-more");
    await hydrated(toWorkspace);
    await toWorkspace.click();
    await page.getByRole("tablist", { name: "Workspace sections" }).getByRole("tab", { name: "Engines" }).click();
    const account = page.getByTestId("engine-connected-account");
    const disconnect = account.getByTestId("connected-account-disconnect");
    await expect(disconnect).toBeVisible();
    await disconnect.click();
    await expect(page.getByTestId("connected-account-note")).toHaveText("Account disconnected.");
    await expect(account.locator(".cw-engine").first()).toHaveText("Not connected");

    /* The old check lands now, with the account's old tools. */
    const landed = page.waitForEvent("requestfinished", (request) => request.url().includes("/api/higgsfield/consumer/capabilities"));
    release();
    await landed;
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));

    /* Business is not told the account is connected: it says connect, from the answer Engines shared. */
    await page.locator('[data-suite-tab="business"]').click();
    await expect(page.getByTestId("ads-connect")).toHaveText(/Connect the account in Workspace › Engines\./);

    /* Back on Tools within the minute: the late answer is not reused; the page checks again and says connect first. */
    await page.locator('[data-suite-tab="atomik"]').click();
    await page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: /Tools$/ }).click();
    await expect(page.getByTestId("reach-summary")).toHaveText("Connect the account in Workspace › Engines");
    expect(checks).toBe(2);
    for (const pill of await page.getByTestId("reach-connected").getByTestId("reach-status").all()) await expect(pill).toHaveText("Connect first");
    await expect(page.getByTestId("reach-engines")).toBeVisible();
    await expect(page.getByText(/of 14 available/)).toHaveCount(0);
    await noSideScroll(page);
    expect(errors).toEqual([]);
  } finally { release(); }
});

test("Tools: each workspace gets its own reach answer — back in a workspace where they are a member, none of the other's shows and nothing is asked", async ({ page, playwright }, info) => {
  test.skip(!["workbench-1440x900", "workbench-390x844"].includes(info.project.name), "one wide, one phone");
  const ownerApi = await playwright.request.newContext({ baseURL: process.env.PW_BASE_URL });
  const { workspace: joined } = await joinLocallyAsMember(ownerApi, page.request);
  await ownerApi.dispose();
  const me = await page.request.get("/api/me").then((r) => r.json()) as { owner: boolean; workspaces: { id: string }[] };
  expect(me.owner, "the page holds a member's session in the workspace they joined").toBe(false);
  const own = me.workspaces.find((w) => w.id !== joined.id);
  expect(own, "the member owns a workspace of their own").toBeTruthy();
  await forbidPaidWork(page);
  const { errors } = watch(page);
  let checks = 0;
  await page.route("**/api/higgsfield/consumer/capabilities", (route) => { checks++; return route.fulfill({ json: reachChecked() }); });
  /* Switching workspace is the app's own route; the app then loads the shell again. */
  const switchTo = async (id: string) => {
    const switched = await page.request.post("/api/workspaces/switch", { data: { id } });
    expect(switched.ok(), await switched.text()).toBe(true);
    await page.goto(TOOLS_PAGE);
  };
  const memberSees = async () => {
    await expect(page.getByTestId("reach-summary")).toHaveText("Only the workspace owner uses the connected account");
    for (const pill of await page.getByTestId("reach-connected").getByTestId("reach-status").all()) await expect(pill).toHaveText("Owner only");
    await expect(page.getByTestId("reach-check")).toHaveCount(0);
  };

  /* In the workspace they joined, a member: the page says who uses the account, and asks nothing. */
  await page.goto(TOOLS_PAGE);
  await memberSees();
  expect(checks).toBe(0);
  /* In their own workspace they are the owner: the account is checked for that workspace. */
  await switchTo(own!.id);
  await expect(page.getByTestId("reach-summary")).toContainText("13 of 14 available · checked");
  expect(checks).toBe(1);
  /* Back in the joined workspace: none of that answer, and still nothing asked. */
  await switchTo(joined.id);
  await memberSees();
  await expect(page.getByText(/of 14 available/)).toHaveCount(0);
  expect(checks).toBe(1);
  /* Returning to their own workspace reads it again, for that workspace. */
  await switchTo(own!.id);
  await expect(page.getByTestId("reach-summary")).toContainText("13 of 14 available · checked");
  expect(checks).toBe(2);
  await noSideScroll(page);
  expect(errors).toEqual([]);
});
