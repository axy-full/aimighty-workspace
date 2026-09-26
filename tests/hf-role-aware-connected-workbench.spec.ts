import { test, expect, type Locator, type Page, type PlaywrightWorkerArgs } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { newProject, type Project } from "../lib/workbench/studio";
import { joinLocallyAsMember, signInLocally } from "./helpers/workbenchLocal";

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
const SHOTS = "/private/tmp/particl-suites/hf-connected/shots";
const CONSUMER = /\/api\/higgsfield\/consumer\//;

async function settle(page: Page) {
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => !(a.effect instanceof KeyframeEffect && a.effect.getComputedTiming().iterations === Infinity)).map((a) => a.finished.catch(() => undefined))));
}
async function shot(page: Page, name: string, project: string) {
  const size = SHOT_AT[project];
  if (!size) return;
  mkdirSync(SHOTS, { recursive: true });
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/role-${name}-${size}.png` });
}
/** React has attached to the element: a click before that is lost on a cold server. */
async function hydrated(target: Locator) {
  await expect.poll(() => target.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps"))), { timeout: 30_000 }).toBe(true);
}
async function noSideScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), "no horizontal page scroll").toBeLessThanOrEqual(1);
}
/** On a phone every button in `scope` is a whole 44px target. */
async function fingerSized(scope: Locator, project: string) {
  if (!PHONES.includes(project)) return;
  for (const button of await scope.getByRole("button").all()) {
    const box = await button.boundingBox();
    expect(box, await button.innerText()).not.toBeNull();
    expect(box!.height, await button.innerText()).toBeGreaterThanOrEqual(44);
    expect(box!.width, await button.innerText()).toBeGreaterThanOrEqual(44);
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
  const ownerName = `Harbour Owner ${randomBytes(3).toString("hex")}`;
  const ownerApi = await playwright.request.newContext({ baseURL: process.env.PW_BASE_URL });
  const { workspace } = await joinLocallyAsMember(ownerApi, page.request, { ownerName });
  await ownerApi.dispose();
  const project = newProject("Harbour look");
  project.production = { cast: { entries: [{ id: "cast-fox", kind: "character", name: "Fox", description: "A red fox", prompt: "A red fox on ice at dusk", takes: [] }] } };
  const me = await saveProject(page, workspace.id, project);
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
  await expect(page.getByTestId("owner-run-business-title")).toHaveText(`Business is run by ${ownerName}`);
  await expect(business).toContainText("Higgsfield account");
  await expect(business).toContainText("on this workspace’s credits");
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
  await page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: /Setup/ }).click();
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
  await expect(page.getByTestId("owner-run-viral-title")).toHaveText(`Viral is run by ${ownerName}`);
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
  await expect(page.getByTestId("owner-run-cast-title")).toHaveText(`Soul Cinema and Soul ID are run by ${ownerName}`);
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
  for (const tool of ["dubbing", "voice_change"]) {
    await expect(page.getByTestId(`workflow-${tool}-reason`)).toHaveText(`Run by ${ownerName} on the Higgsfield account`);
    await expect(page.getByTestId(`workflow-${tool}-tool`)).toHaveCount(0);
  }
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
