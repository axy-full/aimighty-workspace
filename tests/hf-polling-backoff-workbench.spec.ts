import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";

/**
 * Polling with back-off (lib/poll): a running ad is read at the page's pace —
 * 2 s, then 1.5× longer, never sooner than the account's own pollAfterSeconds —
 * not at all while the tab is hidden, and a failed read says so on the job and
 * backs off instead of asking at the same pace. Business Setup's read no
 * longer loops after an error: it is tried again after about 2 s, 6 s and
 * 18 s, then waits for Try again. The clock is paused so every wait is
 * counted exactly; every account reply is a route mock, nothing is paid for.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const SHOTS: Record<string, string> = Object.fromEntries(SIZES.map((name) => [name, name.replace("workbench-", "")]));
const DRAFT = "ws-poll";
const WALLET = "1f2e3d4c-5b6a-4798-8a9b-0c1d2e3f4a5b";
const JOB_ID = "9d2b3c4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";
const fixture = (): Project => ({ ...newProject("Harbour launch spot"), id: DRAFT, productionProjectId: "prod-ws", shotMappings: {} });
const VIDEO_MODEL = { id: "marketing_studio_video", name: "Marketing Studio", outputType: "video", aspectRatios: ["auto", "16:9", "1:1", "9:16"], durationRange: { min: 4, max: 20 }, medias: [{ name: "medias", roles: ["image", "start_image", "end_image"] }], parameters: [{ name: "resolution", options: ["480p", "720p", "1080p"] }, { name: "mode" }, { name: "hook_id" }, { name: "setting_id" }, { name: "ad_reference_id" }, { name: "product_ids" }, { name: "avatar_ids" }, { name: "generate_audio" }] };
const SETUP_ITEMS: Record<string, { id: string; name: string; meta: string }[]> = {
  product: [{ id: "p1", name: "Trail bottle", meta: "product" }],
  avatar: [{ id: "a1", name: "Studio presenter", meta: "avatar · preset" }],
  hook: [{ id: "h1", name: "Stop scrolling", meta: "hook · prepended to the prompt" }],
  setting: [{ id: "s1", name: "Sunlit kitchen", meta: "setting · scene context" }],
  ad_reference: [], brand_kit: [], image_style: [],
};

/** A read the spec controls: fail or answer, held at `gate` until the spec lets it through; `reads` counts the attempts. */
type Setup = { failing: boolean; gate: Promise<void> | null; reads: number };
const answering = (): Setup => ({ failing: false, gate: null, reads: 0 });
async function open(page: Page, sp: "ads" | "setup", setup: Setup, status: (n: number) => { status?: number; json: unknown }, catalogue: Setup = answering()) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, { uploads: [], generations: [] });
  const me = await page.request.get("/api/me").then((r) => r.json());
  await page.route("**/api/me", (route) => route.fulfill({ json: { ...me, owner: true } }));
  await page.route("**/api/higgsfield/consumer/connection", (route) => route.fulfill({ json: { connected: true, requiresReconnect: false } }));
  await page.route("**/api/prompt/enhance", (route) => route.fulfill({ json: { model: "m", effort: "auto", estimateCredits: 1 } }));
  await page.route("**/api/higgsfield/consumer/marketing-templates**", (route) => route.fulfill({ json: { connection: { connected: true }, capabilities: {}, jobs: [] } }));
  const statusReads: number[] = [];
  let input: unknown = null;
  const job = (state: string) => ({
    id: JOB_ID, draftId: DRAFT, status: state, model: VIDEO_MODEL, input, workspaceId: WALLET, workspaceName: "Fixture wallet", quoteCredits: 40, creditUnit: "higgsfield_credits",
    quoteExpiresAt: Date.now() + 300_000, createdAt: Date.now(), providerJobId: state === "quoted" ? null : "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d", tool: null, result: null, originalAvailable: false, sources: [],
  });
  await page.route(/\/api\/higgsfield\/consumer\/generation(\?.*)?$/, async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { connection: { connected: true }, capabilities: {}, jobs: [] } });
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (body.action === "catalogue") {
      /* One read asks for video, then image; a failed video ends that read. */
      if (body.type === "video") { catalogue.reads++; await catalogue.gate; }
      if (catalogue.failing) return route.fulfill({ status: 503, json: { error: "The connected catalogue could not be read." } });
      return route.fulfill({ json: { catalogue: { models: body.type === "video" ? [VIDEO_MODEL] : [], unlim: { available: false, remaining: null, expiresAt: null }, complete: true, fetchedAt: Date.now() } } });
    }
    if (body.action === "quote") { input = body.input; return route.fulfill({ json: { job: job("quoted") } }); }
    if (body.action === "submit") return route.fulfill({ json: { job: job("accepted") } });
    if (body.action === "status") {
      statusReads.push(statusReads.length + 1);
      const reply = status(statusReads.length);
      /* "accepted", "completed", or "accepted-15" (still rendering, and the account asks for 15 s before the next read). */
      const json = typeof reply.json === "string" ? { job: job(reply.json.replace(/-\d+$/, "")), ...(/-(\d+)$/.test(reply.json) ? { pollAfterSeconds: Number(reply.json.split("-")[1]) } : {}) } : reply.json;
      return route.fulfill({ status: reply.status ?? 200, json });
    }
    return route.fulfill({ status: 400, json: { error: "unexpected in this spec" } });
  });
  await page.route("**/api/higgsfield/consumer/video", async (route) => {
    const body = route.request().postDataJSON() as { action: string; types?: string[] };
    if (body.action !== "setup") return route.fulfill({ status: 400, json: { error: "unexpected in this spec" } });
    setup.reads++;
    await setup.gate;
    if (setup.failing) return route.fulfill({ status: 503, json: { error: "The connected account did not answer." } });
    const types = body.types ?? Object.keys(SETUP_ITEMS);
    return route.fulfill({ json: { connected: true, reads: types.map((type) => ({ type, available: true, items: (SETUP_ITEMS[type] ?? []).map((item) => ({ ...item, type, previewUrl: null })) })) } });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install();
  await page.goto(`/suites?suite=moleculr&page=marketing&sp=${sp}`);
  await expect(page.getByTestId("project-name")).toHaveText("Harbour launch spot");
  return { errors, statusReads };
}

/** Stop the page's clock where it is: from here only runFor moves time, so every wait is counted exactly. */
async function pauseClock(page: Page) {
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(now + 50);
}
/** Let a reply that just arrived be handled (its next wait set) before time moves on. */
const settle = (page: Page) => page.waitForTimeout(250);
async function setHidden(page: Page, hidden: boolean) {
  await page.evaluate((value) => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (value ? "hidden" : "visible") });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
}
async function thumbSized(page: Page, testId: string, name: string) {
  const height = await page.getByTestId(testId).getByRole("button", { name }).evaluate((el) => el.getBoundingClientRect().height);
  expect(Math.round(height)).toBeGreaterThanOrEqual(44);
}
async function shoot(page: Page, project: string, name: string, target: string) {
  const size = SHOTS[project];
  const dir = process.env.HF_POLL_SHOTS;
  if (!size || !dir) return;
  mkdirSync(dir, { recursive: true });
  const element = page.getByTestId(target);
  await element.evaluate((el) => { (el as HTMLElement).style.scrollMarginBottom = "140px"; el.scrollIntoView({ block: "end" }); });
  await page.screenshot({ path: path.join(dir, `${name}-${size}.png`) });
}

test("Setup: a failed read backs off instead of looping, says so with Try again, and Try again reads it", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const phone = PHONES.includes(info.project.name);
  let release: () => void = () => undefined;
  const setup: Setup = { failing: true, gate: new Promise<void>((resolve) => { release = resolve; }), reads: 0 };
  const { errors } = await open(page, "setup", setup, () => ({ json: "accepted" }));
  await expect(page.getByTestId("setup-view")).toBeVisible();
  await expect.poll(() => setup.reads).toBe(1);
  await pauseClock(page);
  release();
  setup.gate = null;

  /* The first failure: said once, with Try again — and not read again at once, however long the page sits. */
  const problem = page.getByTestId("setup-error");
  await expect(problem).toContainText("The connected account did not answer.");
  await expect(problem.getByRole("button", { name: "Try again" })).toBeEnabled();
  await expect(page.getByTestId("setup-product")).toContainText("Not read.");
  await page.waitForTimeout(1000);
  expect(setup.reads).toBe(1);
  await shoot(page, info.project.name, "setup-read-failed", "setup-error");

  /* Tried again on its own after about 2 s, 6 s and 18 s (±20%), keeping the error on screen; then only Try again. */
  await page.clock.runFor(1500);
  await page.waitForTimeout(300);
  expect(setup.reads).toBe(1);
  await page.clock.runFor(1000);
  await expect.poll(() => setup.reads).toBe(2);
  await expect(problem.getByRole("button", { name: "Try again" })).toBeEnabled();
  await settle(page);
  await page.clock.runFor(4700);
  await page.waitForTimeout(300);
  expect(setup.reads).toBe(2);
  await page.clock.runFor(2600);
  await expect.poll(() => setup.reads).toBe(3);
  await expect(problem.getByRole("button", { name: "Try again" })).toBeEnabled();
  await settle(page);
  await page.clock.runFor(14_000);
  await page.waitForTimeout(300);
  expect(setup.reads).toBe(3);
  await page.clock.runFor(8000);
  await expect.poll(() => setup.reads).toBe(4);
  await expect(problem.getByRole("button", { name: "Try again" })).toBeEnabled();
  await settle(page);
  await page.clock.runFor(10 * 60_000);
  await page.waitForTimeout(500);
  expect(setup.reads).toBe(4);
  if (phone) await thumbSized(page, "setup-error", "Try again");
  await noOverflow(page);

  /* Try again reads it now; the items land and the error goes. */
  setup.failing = false;
  await problem.getByRole("button", { name: "Try again" }).click();
  await expect.poll(() => setup.reads).toBe(5);
  await expect(problem).toBeHidden();
  await expect(page.getByTestId("setup-product").getByRole("button", { name: /Trail bottle/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Read again" })).toBeEnabled();
  await noOverflow(page);
  await shoot(page, info.project.name, "setup-read-recovered", "setup-product");
  expect(errors).toEqual([]);
});

test("Ads: a running ad is read at the page's pace, never while the tab is hidden, a failed read says so and backs off, and the finished ad stops the reads", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const setup = answering();
  const replies: Record<number, { status?: number; json: unknown }> = {
    1: { json: "accepted" },
    2: { status: 503, json: { error: "The connected account did not answer." } },
    3: { json: "accepted-15" },
    4: { json: "completed" },
  };
  const { errors, statusReads } = await open(page, "ads", setup, (n) => replies[n] ?? { json: "completed" });
  await expect(page.getByTestId("ads-view")).toBeVisible();
  await expect(page.getByTestId("ads-hook").getByRole("button", { name: "Stop scrolling" })).toBeVisible();
  await page.getByTestId("ads-prompt").fill("Morning routine with the bottle on the sill.");
  await expect(page.getByTestId("ads-generate")).toHaveText("Generate ad · 40 cr");
  await pauseClock(page);

  await page.getByTestId("ads-generate").click();
  await expect(page.getByTestId("ads-generate")).toHaveText("Rendering…");
  const reads = () => statusReads.length;

  /* The first read waits about 2 s — not the old fixed tick, and not at once. */
  await page.clock.runFor(1500);
  await page.waitForTimeout(300);
  expect(reads()).toBe(0);
  await page.clock.runFor(1000);
  await expect.poll(reads).toBe(1);
  await settle(page);

  /* Hidden: nothing is asked, however long. Back: the read that fell due is made at once. */
  await setHidden(page, true);
  await page.clock.runFor(60_000);
  await page.waitForTimeout(500);
  expect(reads()).toBe(1);
  await setHidden(page, false);
  await expect.poll(reads).toBe(2);

  /* That read failed: the job says so, and the next wait doubles (about 9 s) instead of asking again at once. */
  await expect(page.getByTestId("ads-problem")).toHaveText("The connected account did not answer. Checking again shortly.");
  await expect(page.getByTestId("ads-generate")).toHaveText("Rendering…");
  await shoot(page, info.project.name, "ads-read-failed", "ads-generate");
  await page.clock.runFor(7000);
  await page.waitForTimeout(300);
  expect(reads()).toBe(2);
  await page.clock.runFor(4000);
  await expect.poll(reads).toBe(3);
  await expect(page.getByTestId("ads-problem")).toBeHidden();

  /* The account asked for 15 s: the next read waits for it (±20%). */
  await page.clock.runFor(11_500);
  await page.waitForTimeout(300);
  expect(reads()).toBe(3);
  await page.clock.runFor(7000);
  await expect.poll(reads).toBe(4);
  await settle(page);
  await expect(page.getByTestId("ads-done")).toContainText("Rendered.");

  /* Completed is terminal: no read after it. */
  await page.clock.runFor(5 * 60_000);
  await page.waitForTimeout(500);
  expect(reads()).toBe(4);
  await noOverflow(page);
  expect(errors).toEqual([]);
});

test("Ads: a catalogue that did not load is tried again, then waits for Try again; a job the account no longer knows hands the composer back", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const phone = PHONES.includes(info.project.name);
  let release: () => void = () => undefined;
  const catalogue: Setup = { failing: true, gate: new Promise<void>((resolve) => { release = resolve; }), reads: 0 };
  const { errors, statusReads } = await open(page, "ads", answering(), () => ({ status: 404, json: { error: "Not found." } }), catalogue);
  await expect(page.getByTestId("ads-view")).toBeVisible();
  await expect.poll(() => catalogue.reads).toBe(1);
  await pauseClock(page);
  release();
  catalogue.gate = null;

  /* Failed: said with Try again, the composer says why it waits, and it is asked again after about 2 s, 6 s and 18 s — then not again. */
  const problem = page.getByTestId("ads-catalogue-error");
  await expect(problem).toContainText("The connected catalogue could not be read.");
  await expect(page.getByTestId("ads-blocked")).toHaveText("The connected catalogue did not load.");
  await expect(page.getByTestId("ads-generate")).toBeDisabled();
  await settle(page);
  for (const [wait, count] of [[2500, 2], [7500, 3], [22_000, 4]] as const) {
    await page.clock.runFor(wait);
    await expect.poll(() => catalogue.reads).toBe(count);
    await expect(problem.getByRole("button", { name: "Try again" })).toBeEnabled();
    await settle(page);
  }
  await page.clock.runFor(10 * 60_000);
  await page.waitForTimeout(500);
  expect(catalogue.reads).toBe(4);
  if (phone) await thumbSized(page, "ads-catalogue-error", "Try again");
  await noOverflow(page);

  /* Try again: the catalogue lands and the composer prices. */
  catalogue.failing = false;
  await problem.getByRole("button", { name: "Try again" }).click();
  await expect(problem).toBeHidden();
  await expect(page.getByTestId("ads-blocked")).toHaveText("Write the prompt.");
  await page.getByTestId("ads-prompt").fill("Morning routine with the bottle on the sill.");
  await page.clock.runFor(1000);
  await expect(page.getByTestId("ads-generate")).toHaveText("Generate ad · 40 cr");

  /* The account no longer knows the job: one read, then the composer is handed back with the reason and Price again. */
  await page.getByTestId("ads-generate").click();
  await expect(page.getByTestId("ads-generate")).toHaveText("Rendering…");
  await page.clock.runFor(2500);
  await expect.poll(() => statusReads.length).toBe(1);
  await expect(page.getByTestId("ads-error")).toHaveText("This job can no longer be checked from here.");
  await expect(page.getByTestId("ads-requote")).toBeVisible();
  await page.clock.runFor(5 * 60_000);
  await page.waitForTimeout(500);
  expect(statusReads.length).toBe(1);
  await noOverflow(page);
  expect(errors).toEqual([]);
});
