import { test, expect, type Page, type PlaywrightWorkerArgs } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { newProject, type Project } from "../lib/workbench/studio";
import { joinLocallyAsMember, signInLocally } from "./helpers/workbenchLocal";
import { forbidPaidWork } from "./helpers/workspaceFixtures";
import { isCompact } from "./helpers/shellMode";

/**
 * The Higgsfield sign-in is retired (lib/higgsfield-consumer/retired.ts), in
 * the browser against a local ENGINE_MOCK server. Business › Ads, which ran on
 * the connected account, is removed: an old link to it lands on Image ads, and
 * Setup is the list of what Particl made in the project — no retired card, no
 * vendor name. Viral and Business › Image ads run on Particl's API
 * key, and Business's own tools and Cast are on the platform's key: all are
 * everyone's. No suite carries an "Owner" badge, Gen offers no connected
 * catalogue or Analysis, and nothing new is asked of the account: the only
 * account route the owner's pages call is the shell's own list of saved jobs
 * (so jobs already running are still collected). Nothing is generated or billed.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const PORTRAIT = ["workbench-360x640", "workbench-390x844"];
const SHOT_AT: Record<string, string> = { "workbench-1440x900": "1440x900", "workbench-390x844": "390x844" };
const SHOTS = process.env.CONNECTED_ROLE_SHOTS;
const CONSUMER = /\/api\/higgsfield\/consumer\//;
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
}async function noSideScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), "no horizontal page scroll").toBeLessThanOrEqual(1);
  for (const card of await page.locator(".gx-owner-run").all()) expect(await card.evaluate((el) => el.scrollWidth - el.clientWidth), "owner card keeps its content inside").toBeLessThanOrEqual(1);
}function watch(page: Page) {
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
/** Business › Setup: the Ads board's brand and product cards (a phone: its Record), and nothing of the connected account. */
async function setupIsParticls(page: Page, projectId: string, info: { project: { name: string } }) {
  await page.goto(`/suites?suite=moleculr&page=setup&sp=setup&project=${projectId}`);
  if (PHONES.includes(info.project.name)) { await expect(page.getByTestId("phone-app")).toBeVisible({ timeout: 60_000 }); return; }
  await expect(page.locator(".gx")).toHaveAttribute("data-screen", "board-ads", { timeout: 60_000 });
  await expect(page.getByTestId("board")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("board")).not.toContainText(/Higgsfield|Open Ads|Use in Ads|run by/i);
}

/** The retired account leaves no word and no badge on a page: no "Owner" badge, no card that says who runs a page, no vendor name. */
async function noAccountWords(page: Page, within = page.locator("body")) {
  for (const suite of ["business", "viral", "studio", "gen", "atomik", "crew"]) await expect(page.getByTestId(`owner-badge-${suite}`)).toHaveCount(0);
  await expect(page.getByTestId("owner-run-business")).toHaveCount(0);
  await expect(page.getByTestId("owner-run-viral")).toHaveCount(0);
  expect(await within.innerText()).not.toMatch(/Higgsfield|Connect the account|Reconnect the account|Only the workspace owner|Run by|Owner only/i);
}

/** An old link to Business › Ads or Setup: the Ads board on a desktop (cards for everyone), the project's Record on a phone, and nothing of the removed page or the retired card. */
async function oldBusinessLinks(page: Page, projectId: string, info: { project: { name: string } }) {
  const phone = PHONES.includes(info.project.name);
  for (const where of ["ads&sp=ads", "setup&sp=setup", "dtc&sp=dtc"]) {
    await page.goto(`/suites?suite=moleculr&page=${where}&project=${projectId}`);
    if (phone) await expect(page.getByTestId("phone-app")).toBeVisible({ timeout: 60_000 });
    else {
      await expect(page.locator(".gx")).toHaveAttribute("data-screen", "board-ads", { timeout: 60_000 });
      await expect(page.getByTestId("board")).toBeVisible({ timeout: 60_000 });
      for (const gone of ["ads-view", "owner-run-business", "setup-view", "setup-connect"]) await expect(page.getByTestId(gone)).toHaveCount(0);
    }
    await noAccountWords(page);
    await noSideScroll(page);
  }
}

/** Motion transfer runs on Particl's API key for everyone: Make's quick tool (the old Viral page's link lands on it), its composer and its button; nothing says an account runs it. A phone draws no quick tool yet (a fixme twin is in demo-s10-phone-make-workbench). */
async function motionOnTheKey(page: Page, projectId: string, info: { project: { name: string } }) {
  if (isCompact(info)) return;
  await page.goto(`/suites?suite=subatomik&page=motion&sp=motion&project=${projectId}`);
  await expect(page.getByTestId("viral-view")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("owner-run-viral")).toHaveCount(0);
  await expect(page.getByTestId("viral-reason")).toHaveText("Add one source video (4–8 s).", { timeout: 60_000 });
  await expect(page.getByTestId("viral-generate")).toBeVisible();
  await expect(page.getByTestId("spec-plan-owner")).toHaveCount(0);
  await noAccountWords(page);
  await noSideScroll(page);
}

test("an old Business link opens the Ads board for the owner, Setup is Particl's own, Make offers Studio engines only; Motion transfer runs on the API key; nothing asks the account", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.setTimeout(240_000);
  const project = info.project.name;
  const { project: film, consumer, errors } = await asOwner(page);

  await oldBusinessLinks(page, film.id, info);
  await shot(page, "business-owner", project);
  await setupIsParticls(page, film.id, info);
  await motionOnTheKey(page, film.id, info);
  await shot(page, "viral-owner", project);

  /* Make: Studio engines only — no connected catalogue, no Analysis type, for the owner too. A phone draws its own simple Make (demo-s10-phone-make-workbench). */
  if (!isCompact(info)) {
    await page.goto(`/suites?make=video&project=${film.id}`);
    await expect(page.getByTestId("gen-view")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("radiogroup", { name: "Type" }).getByRole("radio")).toHaveText(["Video", "Image", "Audio"]);
    await expect(page.getByTestId("gen-tab-analysis")).toHaveCount(0);
    await page.getByTestId("gen-model").click();
    await expect(page.getByTestId("make-engines")).toBeVisible();
    await expect(page.getByTestId("make-engines")).not.toContainText(/Higgsfield|catalogue|connected/i);
    await noSideScroll(page);
    await shot(page, "gen-owner-sheet", project);
  }

  /* The phone's Home: no suite runs on the account, so nothing says retired or who runs it. */
  if (PORTRAIT.includes(project)) {
    await page.goto("/suites");
    await expect(page.getByTestId("phone-home")).toBeVisible({ timeout: 60_000 });
    await noAccountWords(page);
    await expect(page.getByTestId("phone-home")).not.toContainText(/retired/i);
    await noSideScroll(page);
    await shot(page, "home-owner", project);
  }

  /* Nothing was asked of the account on the way, not even the saved-job list (the collector is off with the sign-in). */
  expect(consumer, "no account route at all").toEqual([]);
  expect(errors).toEqual([]);
});

test("an old Business link opens the Ads board for a member too, Setup names no one, Motion transfer runs on the workspace's credits, and nothing of the account is read", async ({ page, playwright }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.setTimeout(240_000);
  const { ownerName, project: film, consumer, errors } = await asMember(page, playwright);
  await oldBusinessLinks(page, film.id, info);
  await setupIsParticls(page, film.id, info);
  if (!PHONES.includes(info.project.name)) await expect(page.getByTestId("board")).not.toContainText(ownerName);
  else expect(await page.evaluate(() => document.body.innerText)).not.toContain(ownerName);
  await shot(page, "business-member", info.project.name);
  await motionOnTheKey(page, film.id, info);
  await shot(page, "viral-member", info.project.name);
  expect(consumer, "no account route at all for a member").toEqual([]);
  expect(errors).toEqual([]);
});

test("Atomik never offers an account approval, the owner's included: its panel names no account and nothing is written to one", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { project: film } = await asOwner(page);
  const writes: string[] = [];
  await page.route("**/api/higgsfield/consumer/**", (route) => {
    if (route.request().method() !== "GET") writes.push(route.request().url());
    return route.fallback();
  });
  /* Release 1: the per-page plan (Motion Transfer's "Run this page") is gone with the page; Atomik opens from the header or the phone's tab. */
  await page.goto(`/suites?project=${film.id}&atomik=1`);
  await expect(page.getByTestId("atomik-input").or(page.getByTestId("phone-atomik-input")).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("atomik-owner-run")).toHaveCount(0);
  /* The how-to hint "Approve everything under N cr" is Atomik's own free question, not a plan approval. */
  await expect(page.getByRole("button", { name: /^Approve(?! everything under)/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /connected account|sign in|connect/i })).toHaveCount(0);
  await noAccountWords(page);
  expect(writes).toEqual([]);
  await noSideScroll(page);
});
