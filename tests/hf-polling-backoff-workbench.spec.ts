import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";

/**
 * Polling with back-off (lib/poll): a running ad is read at the page's pace —
 * 2 s, then 1.5× longer, never before the account's own pollAfterSeconds is
 * up (its poll lease) — not at all while the tab is hidden, and a failed read
 * says so on the job in fixed words and backs off. Motion Transfer reads its
 * jobs in turn, sharing the hint and never asking a job inside its own lease.
 * The shell's collector asks nothing while the tab is hidden either. Business
 * reads say the account did not answer instead of the routes' catch-all: the
 * catalogue is tried again a few times (5, 15, 45 s, held while the tab is
 * hidden) and then waits for Read again; a failed Setup read waits for Try
 * again, which keeps keyboard focus. The clock is paused so every wait is
 * counted exactly; every account reply is a route mock, nothing is paid for.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const SHOTS: Record<string, string> = Object.fromEntries(SIZES.map((name) => [name, name.replace("workbench-", "")]));
const DRAFT = "ws-poll";
const WALLET = "1f2e3d4c-5b6a-4798-8a9b-0c1d2e3f4a5b";
const JOB_ID = "9d2b3c4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";
const fixture = (): Project => ({ ...newProject("Harbour launch spot"), id: DRAFT, productionProjectId: "prod-ws", shotMappings: {} });
/** What the routes really send when a request fails without a named reason (app/api/higgsfield/consumer/*). */
const ROUTE_FALLBACK = "The connected account could not complete this request. Check the saved job before trying again.";
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
type StatusReply = { status?: number; json?: unknown; abort?: boolean };
async function open(page: Page, sp: "ads" | "setup", setup: Setup, status: (n: number) => StatusReply, catalogue: Setup = answering(), listed: unknown[] = []) {
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
    if (route.request().method() === "GET") return route.fulfill({ json: { connection: { connected: true }, capabilities: {}, jobs: listed } });
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (body.action === "catalogue") {
      /* One read asks for video, then image; a failed video ends that read. */
      if (body.type === "video") { catalogue.reads++; await catalogue.gate; }
      if (catalogue.failing) return route.fulfill({ status: 503, json: { error: ROUTE_FALLBACK } });
      return route.fulfill({ json: { catalogue: { models: body.type === "video" ? [VIDEO_MODEL] : [], unlim: { available: false, remaining: null, expiresAt: null }, complete: true, fetchedAt: Date.now() } } });
    }
    if (body.action === "quote") { input = body.input; return route.fulfill({ json: { job: job("quoted") } }); }
    if (body.action === "submit") return route.fulfill({ json: { job: job("accepted") } });
    if (body.action === "status") {
      statusReads.push(statusReads.length + 1);
      const reply = status(statusReads.length);
      /* A dropped connection: the browser's own error, never shown as it is. */
      if (reply.abort) return route.abort("internetdisconnected");
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
    if (setup.failing) return route.fulfill({ status: 503, json: { error: ROUTE_FALLBACK } });
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
/** Where keyboard focus is: the Try again button itself, or the section a finished read left it in. */
const focused = (page: Page) => page.evaluate(() => {
  const el = document.activeElement as HTMLElement | null;
  return { tag: el?.tagName ?? "", text: el?.textContent?.trim() ?? "", disabled: el?.getAttribute("aria-disabled") ?? null, home: el?.hasAttribute("data-focus-home") ?? false };
});
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
  const element = page.getByTestId(target).last();
  /* Centred in the band the sticky page head and the phone dock leave free, so the shot shows it whole. */
  await element.evaluate((el) => {
    let top = 0, bottom = window.innerHeight;
    /* The stage scrolls inside its own box under the page head on some layouts. */
    for (let box = el.parentElement; box; box = box.parentElement) {
      const { overflowY } = getComputedStyle(box);
      if ((overflowY === "auto" || overflowY === "scroll") && box.scrollHeight > box.clientHeight) { const r = box.getBoundingClientRect(); top = Math.max(top, r.top); bottom = Math.min(bottom, r.bottom); break; }
    }
    for (const other of document.querySelectorAll<HTMLElement>("body *")) {
      const position = getComputedStyle(other).position;
      if (position !== "sticky" && position !== "fixed") continue;
      const box = other.getBoundingClientRect();
      if (!box.height || box.width < window.innerWidth * 0.5) continue;
      if (box.top <= 1 && box.bottom < window.innerHeight * 0.8) top = Math.max(top, box.bottom);
      else if (box.bottom >= window.innerHeight - 48 && box.top > window.innerHeight * 0.3) bottom = Math.min(bottom, box.top);
    }
    el.scrollIntoView({ block: "center" });
    /* Then nudge its scroller so the element's centre sits in the middle of the free band. */
    const box = el.getBoundingClientRect(), shift = box.top + box.height / 2 - (top + bottom) / 2;
    for (let scroller = el.parentElement; scroller; scroller = scroller.parentElement) {
      if (scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY)) { scroller.scrollTop += shift; return; }
    }
    window.scrollBy(0, shift);
  });
  await page.screenshot({ path: path.join(dir, `${name}-${size}.png`) });
}

test("Setup: a failed read says so in plain words with Try again, is never asked again on its own, and Try again keeps focus", async ({ page }, info) => {
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

  /* The failure: said once in the product's words (not the route's job-oriented fallback), with Try again —
     and not read again on its own however long the page sits, shown or hidden (a Setup read waits for the person). */
  const problem = page.getByTestId("setup-error");
  await expect(problem).toContainText("The connected account did not answer.");
  await expect(problem).not.toContainText("saved job");
  await expect(problem.getByRole("button", { name: "Try again" })).toBeEnabled();
  await page.clock.runFor(10 * 60_000);
  await setHidden(page, true);
  await page.clock.runFor(10 * 60_000);
  await setHidden(page, false);
  await page.waitForTimeout(500);
  expect(setup.reads).toBe(1);
  if (phone) await thumbSized(page, "setup-error", "Try again");
  await noOverflow(page);
  await shoot(page, info.project.name, "setup-read-failed", "setup-error");

  /* Try again from the keyboard: it reads now and keeps focus while the read is out; the items land, the error
     goes, and focus stays in the list it reloaded rather than falling to the top of the page. */
  setup.failing = false;
  setup.gate = new Promise<void>((resolve) => { release = resolve; });
  await problem.getByRole("button", { name: "Try again" }).focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => setup.reads).toBe(2);
  await expect(problem.getByRole("button", { name: "Reading…" })).toHaveAttribute("aria-disabled", "true");
  expect(await focused(page)).toMatchObject({ tag: "BUTTON", text: "Reading…", disabled: "true" });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  expect(setup.reads).toBe(2);
  release();
  setup.gate = null;
  await expect(problem).toBeHidden();
  await expect(page.getByTestId("setup-product").getByRole("button", { name: /Trail bottle/ })).toBeVisible();
  expect(await focused(page)).toMatchObject({ tag: "DIV", home: true });
  await expect(page.getByRole("button", { name: "Read again" })).toBeEnabled();
  await noOverflow(page);
  await shoot(page, info.project.name, "setup-read-recovered", "setup-product");
  expect(errors).toEqual([]);
});

test("Ads: a running ad is read at the page's pace, never while the tab is hidden, never inside the account's window, a failed read is said in fixed words and backs off, and the finished ad stops the reads", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const setup = answering();
  const replies: Record<number, StatusReply> = {
    1: { json: "accepted" },
    2: { abort: true },
    3: { status: 503, json: { error: ROUTE_FALLBACK } },
    4: { json: "accepted-15" },
    5: { json: "completed" },
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

  /* That read never reached the server: the job says so in plain words (not the browser's own error text), and
     the next wait doubles (about 9 s) instead of asking again at once. */
  const problem = page.getByTestId("ads-problem");
  await expect(problem).toHaveText("The connection dropped. Checking again shortly.");
  await expect(page.getByTestId("ads-generate")).toHaveText("Rendering…");
  await shoot(page, info.project.name, "ads-read-dropped", "ads-problem");
  await page.clock.runFor(7000);
  await page.waitForTimeout(300);
  expect(reads()).toBe(2);
  await page.clock.runFor(4000);
  await expect.poll(reads).toBe(3);

  /* The route's own fallback (a 503): one fixed line, not the route's advice about a saved job; the wait doubles again (about 27 s). */
  await expect(problem).toHaveText("Could not check this take. Checking again shortly.");
  await shoot(page, info.project.name, "ads-read-failed", "ads-problem");
  await settle(page);
  await page.clock.runFor(21_000);
  await page.waitForTimeout(300);
  expect(reads()).toBe(3);
  await page.clock.runFor(12_000);
  await expect.poll(reads).toBe(4);
  await expect(problem).toBeHidden();
  await settle(page);

  /* The account asked for 15 s and holds the job until then: the next read never comes before it (at most +20% after). */
  await page.clock.runFor(15_400);
  await page.waitForTimeout(300);
  expect(reads()).toBe(4);
  await page.clock.runFor(3300);
  await expect.poll(reads).toBe(5);
  await settle(page);
  await expect(page.getByTestId("ads-done")).toContainText("Rendered and filed to this project.");

  /* Completed is terminal: no read after it. */
  await page.clock.runFor(5 * 60_000);
  await page.waitForTimeout(500);
  expect(reads()).toBe(5);
  await noOverflow(page);
  expect(errors).toEqual([]);
});

test("Ads: a catalogue that did not load says so plainly, is tried again a few times but never while the tab is hidden, then waits for Read again; a job the account no longer knows hands the composer back", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const phone = PHONES.includes(info.project.name);
  let release: () => void = () => undefined;
  const catalogue: Setup = { failing: true, gate: new Promise<void>((resolve) => { release = resolve; }), reads: 0 };
  const { errors, statusReads } = await open(page, "ads", answering(), () => ({ status: 404, json: { error: "Not found." } }), catalogue);
  await expect(page.getByTestId("ads-view")).toBeVisible();
  await expect.poll(() => catalogue.reads).toBe(1);
  /* The prompt is written while the clock still runs; from here the composer waits only on the catalogue. */
  await page.getByTestId("ads-prompt").fill("Morning routine with the bottle on the sill.");
  await expect(page.getByTestId("ads-blocked")).toHaveText("Reading the connected catalogue…");
  await pauseClock(page);
  release();
  catalogue.gate = null;

  /* Failed: the composer says why it waits in the product's words, not the route's advice about a saved job. */
  await expect(page.getByTestId("ads-blocked")).toHaveText("The connected account did not answer.");
  await expect(page.getByTestId("ads-generate")).toBeDisabled();
  await shoot(page, info.project.name, "ads-catalogue-failed", "ads-blocked");
  await settle(page);
  /* The first retry falls due (about 5 s) while the tab is hidden: held however long, made at once when it is back. */
  await setHidden(page, true);
  await page.clock.runFor(60_000);
  await page.waitForTimeout(500);
  expect(catalogue.reads).toBe(1);
  await setHidden(page, false);
  await expect.poll(() => catalogue.reads).toBe(2);
  await settle(page);
  /* Then 15 s and 45 s after each failure, and then not again: Read again asks. */
  for (const [wait, count] of [[16_000, 3], [46_000, 4]] as const) {
    await page.clock.runFor(wait);
    await expect.poll(() => catalogue.reads).toBe(count);
    await settle(page);
  }
  await page.clock.runFor(10 * 60_000);
  await page.waitForTimeout(500);
  expect(catalogue.reads).toBe(4);
  const again = page.getByTestId("catalogue-again");
  await expect(again).toBeVisible();
  if (phone) await thumbSized(page, "ads-view", "Read again");
  await noOverflow(page);

  /* Read again: the catalogue lands and the composer prices. */
  catalogue.failing = false;
  await again.click();
  await page.clock.runFor(100);
  await expect.poll(() => catalogue.reads).toBe(5);
  await expect(page.getByTestId("ads-blocked")).toBeHidden();
  await expect(again).toHaveCount(0);
  await page.clock.runFor(1000);
  await expect(page.getByTestId("ads-generate")).toHaveText("Generate ad · 40 cr");

  /* The account no longer knows the job: one read, then the composer is handed back with the reason and Price again,
     and nothing else (the shell's collector included) asks after it again. */
  await page.getByTestId("ads-generate").click();
  await expect(page.getByTestId("ads-generate")).toHaveText("Rendering…");
  await page.clock.runFor(2500);
  await expect.poll(() => statusReads.length).toBe(1);
  await expect(page.getByTestId("ads-error")).toHaveText("This job can no longer be checked from here.");
  await expect(page.getByTestId("ads-requote")).toBeVisible();
  await shoot(page, info.project.name, "ads-job-gone", "ads-requote");
  await page.clock.runFor(5 * 60_000);
  await page.waitForTimeout(500);
  expect(statusReads.length).toBe(1);
  await noOverflow(page);
  expect(errors).toEqual([]);
});

test("the shell's collector asks nothing while the tab is hidden, and makes the read that fell due when it is back", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  /* An ad from an earlier visit, still rendering: the collector follows it (at least 20 s between reads). */
  const earlier = {
    id: "9d2b3c4e-5f60-4a7b-8c9d-0e1f2a3b4c99", draftId: DRAFT, status: "accepted", model: VIDEO_MODEL, tool: null, sources: [],
    input: { type: "video", model: "marketing_studio_video", prompt: "An ad left rendering on another visit", parameters: {}, medias: [] },
    workspaceId: WALLET, workspaceName: "Fixture wallet", quoteCredits: 40, creditUnit: "higgsfield_credits", quoteExpiresAt: 0,
    createdAt: Date.now() - 6 * 60_000, providerJobId: "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c99", result: null, originalAvailable: false,
  };
  const { errors, statusReads } = await open(page, "ads", answering(), () => ({ json: { job: earlier, pollAfterSeconds: 15 } }), answering(), [earlier]);
  await expect(page.getByTestId("ads-view")).toBeVisible();
  await expect(page.getByTestId("ads-earlier-row")).toHaveCount(1);
  await expect.poll(() => statusReads.length).toBe(1);
  await expect(page.getByTestId("ads-earlier-row").locator(".gx-resumed-state")).toHaveText("Rendering · 6 min");
  await pauseClock(page);
  await settle(page);

  /* Hidden: nothing is asked, however long. Back: the read that fell due is made at once, and the pace goes on. */
  await setHidden(page, true);
  await page.clock.runFor(5 * 60_000);
  await page.waitForTimeout(500);
  expect(statusReads.length).toBe(1);
  await setHidden(page, false);
  await expect.poll(() => statusReads.length).toBe(2);
  await settle(page);
  await page.clock.runFor(15_000);
  await page.waitForTimeout(300);
  expect(statusReads.length).toBe(2);
  await page.clock.runFor(6000);
  await expect.poll(() => statusReads.length).toBe(3);
  expect(errors).toEqual([]);
});

test("Motion Transfer: two running jobs are read in turn, the account's pace shared out, never inside a job's own window, and not while the tab is hidden", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const VIRAL_DRAFT = "ws-viral-poll";
  const A = "33333333-3333-4333-8333-00000000000a", B = "33333333-3333-4333-8333-00000000000b";
  /* A asks for 30 s between reads, B for 15 s: shared out, the page would come back to A after about 26 s —
     inside A's window — unless it keeps each job's own. */
  const HINT: Record<string, number> = { [A]: 30, [B]: 15 };
  const running = (id: string, minutesAgo: number) => ({
    id, draftId: VIRAL_DRAFT, status: "accepted", input: { variant: "motion-transfer", resolution: "720p" }, workspaceId: WALLET, workspaceName: "Fixture wallet",
    quoteCredits: 22, creditUnit: "higgsfield_credits", quoteExpiresAt: Date.now() + 300_000, createdAt: Date.now() - minutesAgo * 60_000, providerJobId: `prov-${id.slice(-1)}`,
  });
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: { ...newProject("Coastal light study"), id: VIRAL_DRAFT, productionProjectId: "prod-ws", shotMappings: {} } });
  await mockLibrary(page, { uploads: [], generations: [] });
  const me = await page.request.get("/api/me").then((r) => r.json());
  await page.route("**/api/me", (route) => route.fulfill({ json: { ...me, owner: true } }));
  let release: () => void = () => undefined;
  const listed = new Promise<void>((resolve) => { release = resolve; });
  const asked: string[] = [];
  let listReads = 0;
  await page.route("**/api/higgsfield/consumer/genjutsu**", async (route) => {
    const req = route.request();
    if (req.method() === "GET") {
      listReads++;
      await listed;
      return route.fulfill({ json: { connection: { connected: true, requiresReconnect: false }, capabilities: { resolutions: ["480p", "720p", "1080p"], minSeconds: 4, maxSeconds: 30, maxImages: 30, maxMediaBytes: 52428800 }, jobs: [running(A, 3), running(B, 2)] } });
    }
    const body = req.postDataJSON() as { action: string; id?: string };
    if (body.action !== "status" || !body.id) return route.fulfill({ status: 400, json: { error: "unexpected in this spec" } });
    asked.push(body.id);
    return route.fulfill({ json: { job: running(body.id, body.id === A ? 3 : 2), pollAfterSeconds: HINT[body.id] } });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install();
  await page.goto(`/suites?suite=subatomik&page=motion&sp=motion`);
  await expect(page.getByTestId("project-name")).toHaveText("Coastal light study");
  await expect(page.getByTestId("viral-view")).toBeVisible();
  await expect.poll(() => listReads).toBeGreaterThan(0);
  await pauseClock(page);
  release();
  await expect(page.getByTestId("viral-job")).toHaveCount(2);
  await settle(page);

  /* The first read: about 2 s, the first listed job first. */
  await page.clock.runFor(1500);
  await page.waitForTimeout(300);
  expect(asked).toEqual([]);
  await page.clock.runFor(1000);
  await expect.poll(() => asked.length).toBe(1);
  expect(asked).toEqual([A]);
  await settle(page);

  /* A's 30 s shared across two jobs: B is next, after 15 s (never before). */
  await page.clock.runFor(15_400);
  await page.waitForTimeout(300);
  expect(asked).toEqual([A]);
  await page.clock.runFor(3300);
  await expect.poll(() => asked.length).toBe(2);
  expect(asked).toEqual([A, B]);
  await settle(page);

  /* B's 15 s shared would bring A back after about 8 s — 26.7 s after A's read, inside its 30 s. It waits for A's own. */
  await page.clock.runFor(11_700);
  await page.waitForTimeout(300);
  expect(asked).toEqual([A, B]);
  await page.clock.runFor(2600);
  await expect.poll(() => asked.length).toBe(3);
  expect(asked).toEqual([A, B, A]);
  await settle(page);

  /* Hidden: neither job is asked about, however long; back: the read that fell due (B's turn) is made at once. */
  await setHidden(page, true);
  await page.clock.runFor(2 * 60_000);
  await page.waitForTimeout(500);
  expect(asked).toEqual([A, B, A]);
  await setHidden(page, false);
  await expect.poll(() => asked.length).toBe(4);
  expect(asked).toEqual([A, B, A, B]);
  await expect(page.getByTestId("viral-job").first()).toContainText("Rendering");
  await noOverflow(page);
  await shoot(page, info.project.name, "viral-two-running", "viral-job");
  expect(errors).toEqual([]);
});

test("Production re-edit: a failed read says so while it is checked again, and a re-edit that can no longer be read says where it goes and what it costs", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: { ...newProject("Harbour cut"), id: "ws-edit-poll", productionProjectId: "prod-edit", shotMappings: {}, fps: 24 } });
  await mockLibrary(page, { uploads: [], generations: [generation({ id: "gen_still", title: "Mara at the window", prompt: "Mara at the window", projectId: "prod-edit" })] });
  /* The price and the dispatch are mocks: nothing is sent to an engine. */
  await page.route(/\/api\/generate(\/quote)?$/, (route) => route.fulfill({ json: route.request().url().endsWith("/quote") ? { estimatedCredits: 4, fingerprint: "f".repeat(64), price: 0.04, unit: "cr" } : { id: "gen_reedit" } }));
  const reads: number[] = [];
  await page.route(/\/api\/jobs\/gen_reedit(\?.*)?$/, (route) => {
    reads.push(reads.length + 1);
    return reads.length === 1 ? route.fulfill({ status: 503, json: { error: "The render request could not finish." } }) : route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.route("**/api/higgsfield/consumer/audio-tools?**", (route) => route.fulfill({ json: { connection: { connected: false, requiresReconnect: false }, capabilities: { voice: false, dubbing: false, analysis: false, reframe: false, languages: [] }, jobs: [] } }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install();
  await page.goto("/suites?suite=studio&page=takes");
  await expect(page.getByTestId("project-name")).toHaveText("Harbour cut");
  await page.getByTestId("edit-takes").getByTestId("edit-take").filter({ hasText: "Mara at the window" }).click();
  await page.getByTestId("edit-instruction").fill("Make it night, rain on the glass");
  await page.getByTestId("edit-price").click();
  await expect(page.getByTestId("edit-render")).toHaveText("Re-edit · 4 credits");
  await page.getByTestId("edit-render").click();
  await expect(page.getByTestId("edit-price")).toHaveText("Rendering…");
  await pauseClock(page);

  /* The first read (about 2 s) fails: said in fixed words while it keeps checking; the button still says Rendering. */
  await page.clock.runFor(2500);
  await expect.poll(() => reads.length).toBe(1);
  const checking = page.getByTestId("edit-checking");
  await expect(checking).toHaveText("Could not check this re-edit. Checking again shortly.");
  await expect(page.getByTestId("edit-price")).toHaveText("Rendering…");
  await expect(page.getByTestId("edit-price")).toBeDisabled();
  await shoot(page, info.project.name, "reedit-read-failed", "edit-checking");
  await settle(page);

  /* The next read (about 6 s later) finds nothing on record: it stops, says where a finished one goes and that a failed one
     costs nothing, and offers the price again. No read after that. */
  await page.clock.runFor(7500);
  await expect.poll(() => reads.length).toBe(2);
  await expect(page.getByTestId("edit-image").getByRole("alert")).toHaveText("This re-edit can no longer be checked from here. If it renders, it lands in the library; a failed render is not billed.");
  await expect(checking).toBeHidden();
  await expect(page.getByTestId("edit-price")).toHaveText("Price the re-edit");
  await expect(page.getByTestId("edit-price")).toBeEnabled();
  await shoot(page, info.project.name, "reedit-gone", "edit-price");
  await page.clock.runFor(5 * 60_000);
  await page.waitForTimeout(500);
  expect(reads.length).toBe(2);
  await noOverflow(page);
  expect(errors).toEqual([]);
});
