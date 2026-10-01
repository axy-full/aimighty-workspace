import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";

/**
 * Polling with back-off and jitter, on the connected-job model: a composer
 * reads the job it is rendering itself (lib/poll: never within 6 s of the last
 * read — the route allows a person 30 status reads a minute — then longer to
 * 10 s), and the shell's collector reads every job no view is reading —
 * one left rendering on an earlier visit, or one a composer let go of — at
 * its own slower rate (20 s, then 1.5× longer to a minute). Both: a read that
 * finds the job where it was waits longer; one that finds it moved on (its
 * status changed) starts the pace over, and so does the person (coming back
 * to the tab, or opening the page again); every wait is jittered ±20%; a
 * failed read backs off and says so; the account's pollAfterSeconds is never
 * cut short; a hidden tab asks nothing; one read at a time; and nothing is
 * ever sent but status reads — no price or submit is repeated.
 *
 * Deterministic: the page's clock is paused and moved only by runFor, the
 * jitter's draw (Math.random) is pinned for each step, and every read is
 * counted twice — on the page's own record the moment the clock stops (so a
 * read that did not happen is known at once, with no waiting) and at the
 * route mocks, which see it go out. Every account reply is a route mock.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const SHOTS: Record<string, string> = Object.fromEntries(SIZES.map((name) => [name, name.replace("workbench-", "")]));
const MIN = 60_000;
const DRAFT = "ws-poll";
const WALLET = "1f2e3d4c-5b6a-4798-8a9b-0c1d2e3f4a5b";
const JOB_ID = "9d2b3c4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";
const EARLIER = "9d2b3c4e-5f60-4a7b-8c9d-0e1f2a3b4c99";
const SECOND = "9d2b3c4e-5f60-4a7b-8c9d-0e1f2a3b4c98";
const GEN = "gen_hfc_" + "e".repeat(40);
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

type Job = Record<string, unknown> & { id: string; status: string };
/** An ad on the connected account, as the generation route lists and reads it. */
function adJob(id: string, status: string, over: Record<string, unknown> = {}): Job {
  return {
    id, draftId: DRAFT, status, model: VIDEO_MODEL, tool: null, sources: [], result: null, originalAvailable: false,
    input: { type: "video", model: "marketing_studio_video", prompt: "An ad left rendering on another visit", parameters: {}, medias: [] },
    workspaceId: WALLET, workspaceName: "Fixture wallet", quoteCredits: 40, creditUnit: "higgsfield_credits", quoteExpiresAt: 0,
    createdAt: Date.now() - 6 * MIN, providerJobId: status === "quoted" ? null : "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d", ...over,
  };
}
/** The same ad, rendered, its original kept (what the collector announces as landed in Takes). */
const landed = (job: Job): Job => ({
  ...job, status: "completed", originalAvailable: true, originalAvailability: "available",
  result: { original: { generationId: GEN, providerJobId: job.providerJobId, creditUnit: "higgsfield_credits", credits: job.quoteCredits, sha256: "d".repeat(64), bytes: 2048, asset: { generationId: GEN, url: `/api/media/${GEN}`, kind: "video", mime: "video/mp4" } } },
});

/* ── The page's own record of what it sent ─────────────────────────────── */

/** One request to the connected-account or job routes: which action (and type), which job, when on the page's clock, and when its reply was handled. */
type Sent = { url: string; method: string; action: string | null; type: string | null; id: string | null; at: number; handledAt: number | null };

/**
 * Before any page script runs: the page keeps a record of every request it
 * makes to the connected-account and job routes, and marks each handled once
 * every microtask its reply set off has run (so its next wait is set). While
 * `__draw` is a number, Math.random returns it: the jitter is pinned.
 */
async function probe(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __sent: unknown[]; __draw: number | null };
    const sent: { url: string; method: string; action: string | null; type: string | null; id: string | null; at: number; handledAt: number | null }[] = [];
    w.__sent = sent;
    w.__draw = null;
    const random = Math.random.bind(Math);
    Math.random = () => (typeof w.__draw === "number" ? w.__draw : random());
    /* A task posted after the reply: when it runs, every microtask the reply set off has run. The paused clock does not hold it. */
    const channel = new MessageChannel();
    const queued: (() => void)[] = [];
    channel.port1.onmessage = () => queued.shift()?.();
    const later = (run: () => void) => { queued.push(run); channel.port2.postMessage(0); };
    const fetch0 = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!/\/api\/(higgsfield\/consumer\/|jobs\/)/.test(url)) return fetch0(input, init);
      let body: Record<string, unknown> | null = null;
      try { body = typeof init?.body === "string" ? JSON.parse(init.body) : null; } catch { body = null; }
      const text = (key: string) => (typeof body?.[key] === "string" ? (body[key] as string) : null);
      const entry = { url, method: (init?.method ?? "GET").toUpperCase(), action: text("action"), type: text("type"), id: text("id"), at: Date.now(), handledAt: null as number | null };
      sent.push(entry);
      const handled = () => later(() => { entry.handledAt = Date.now(); });
      return fetch0(input, init).then((response) => {
        const json = response.json.bind(response);
        response.json = () => { const read = json(); read.then(handled, handled); return read; };
        return response;
      }, (error: unknown) => { handled(); throw error; });
    };
  });
}
/**
 * The dev server's live reload is held for every test here. On a dev server
 * still compiling routes on their first use, the dev client applies what
 * compiled by refreshing the page and then, for some updates, reloading it.
 * A reload wipes the page's record above, restarts the pace the page was
 * keeping and drops the paused clock, so the fresh page's first read looks like
 * an extra one. The client's socket (/_next/hmr) still connects, and every
 * message reaches the page except the ones that apply a change: builds and
 * syncs, refreshes, reloads and Turbopack updates. The rest pass, React's debug
 * data for the page among them (the page does not hydrate without it). A
 * production build has no such socket.
 */
const DEV_UPDATES = new Set(["building", "built", "sync", "serverComponentChanges", "serverOnlyChanges", "clientChanges", "middlewareChanges", "staticParamsChanged", "devPagesManifestUpdate", "addedPage", "removedPage", "reloadPage", "turbopack-message"]);
test.beforeEach(async ({ page }) => {
  await page.routeWebSocket(/\/_next\/hmr(\?|$)/, (socket) => {
    const server = socket.connectToServer();
    server.onMessage((message) => {
      if (typeof message === "string") {
        try {
          if (DEV_UPDATES.has((JSON.parse(message) as { type?: string }).type ?? "")) return;
        } catch {
          /* Not JSON: passed on as it came. */
        }
      }
      socket.send(message);
    });
  });
});
const record = (page: Page) => page.evaluate(() => (window as unknown as { __sent: Sent[] }).__sent);
/** Status reads the page sent (the connected account's `status` action, or GET /api/jobs/:id), oldest first. */
async function statusReads(page: Page, id?: string): Promise<Sent[]> {
  return (await record(page)).filter((s) => (s.action === "status" && (!id || s.id === id)) || (s.method === "GET" && /\/api\/jobs\//.test(s.url)));
}
/** Pin the jitter's draw (0 is the bottom of the ±20% band, 0.5 no jitter, 0.999999 the top); null lets it run free. */
async function draw(page: Page, value: number | null) {
  await page.evaluate((v) => { (window as unknown as { __draw: number | null }).__draw = v; }, value);
}
/** Requests whose replies the page reads (every POST; the job and listing reads). */
const answered = (s: Sent) => s.method === "POST" || /\/api\/jobs\//.test(s.url) || /\/(generation|genjutsu)\?draftId=/.test(s.url);
/**
 * The page has handled every reply it has had — each next wait is set — and
 * React has committed what they changed. A condition polled for, never a
 * fixed wait; only then may the clock move on.
 */
async function settled(page: Page) {
  await expect.poll(async () => (await record(page)).filter(answered).every((s) => s.handledAt !== null)).toBe(true);
  await page.evaluate(async () => {
    for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => { const c = new MessageChannel(); c.port1.onmessage = () => resolve(); c.port2.postMessage(0); });
  });
}
/**
 * The next status read comes exactly `wait` ms on: the page's record shows
 * none a millisecond before and one at `wait`, and the route (`seen`) sees it
 * go out. Its reply is handled before the clock moves on, unless the route
 * holds it.
 */
async function nextRead(page: Page, wait: number, seen: () => number, options: { id?: string; held?: boolean } = {}) {
  const before = (await statusReads(page, options.id)).length;
  await page.clock.runFor(wait - 1);
  expect((await statusReads(page, options.id)).length, `no read ${wait - 1} ms on`).toBe(before);
  await page.clock.runFor(1);
  expect((await statusReads(page, options.id)).length, `a read ${wait} ms on`).toBe(before + 1);
  await expect.poll(seen).toBe(before + 1);
  if (!options.held) await settled(page);
}
/** One read at a time: each read of a job went out after the reply to the one before it was handled. */
function oneAtATime(reads: Sent[]) {
  for (const id of new Set(reads.map((r) => r.id ?? r.url))) {
    const mine = reads.filter((r) => (r.id ?? r.url) === id);
    for (let i = 1; i < mine.length; i++) expect(mine[i].at).toBeGreaterThanOrEqual(mine[i - 1].handledAt ?? Number.POSITIVE_INFINITY);
  }
}

/* ── The page ──────────────────────────────────────────────────────────── */

/** A read the spec controls: fail or answer, held at `gate` until the spec lets it through; `reads` counts the attempts. */
type Gate = { failing: boolean; gate: Promise<void> | null; reads: number };
const answering = (): Gate => ({ failing: false, gate: null, reads: 0 });
type Reply = { status?: number; json?: unknown; abort?: boolean; hold?: Promise<void> };
type Business = {
  /** What the generation route lists for the project (GET ?draftId=), asked each time. */
  listed?: () => Job[];
  /** The reply to status read `n` (from 1) of job `id`. */
  status?: (id: string, n: number) => Reply;
  /** The job a submit leaves (`input` is what was quoted). */
  submitted?: (input: unknown) => Job;
  setup?: Gate;
  catalogue?: Gate;
};
async function openBusiness(page: Page, sp: "ads" | "setup", options: Business = {}) {
  const { listed = () => [], status = (): Reply => ({ json: { job: adJob(JOB_ID, "accepted") } }), submitted = (input) => adJob(JOB_ID, "accepted", { input, createdAt: Date.now() }), setup = answering(), catalogue = answering() } = options;
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
  /** Every POST body as the route saw it arrive. */
  const posts: Record<string, unknown>[] = [];
  let input: unknown = null, lists = 0;
  await page.route(/\/api\/higgsfield\/consumer\/generation(\?.*)?$/, async (route) => {
    if (route.request().method() === "GET") { lists++; return route.fulfill({ json: { connection: { connected: true }, capabilities: {}, jobs: listed() } }); }
    const body = route.request().postDataJSON() as Record<string, unknown>;
    posts.push(body);
    if (body.action === "catalogue") {
      /* One read asks for video, then image; a failed video ends that read. */
      if (body.type === "video") { catalogue.reads++; await catalogue.gate; }
      if (catalogue.failing) return route.fulfill({ status: 503, json: { error: ROUTE_FALLBACK } });
      return route.fulfill({ json: { catalogue: { models: body.type === "video" ? [VIDEO_MODEL] : [], unlim: { available: false, remaining: null, expiresAt: null }, complete: true, fetchedAt: Date.now() } } });
    }
    if (body.action === "quote") { input = body.input; return route.fulfill({ json: { job: adJob(JOB_ID, "quoted", { input, quoteExpiresAt: Date.now() + 300_000, createdAt: Date.now() }) } }); }
    if (body.action === "submit") return route.fulfill({ json: { job: submitted(input) } });
    if (body.action === "status") {
      const id = String(body.id);
      const reply = status(id, posts.filter((p) => p.action === "status" && p.id === id).length);
      await reply.hold;
      /* A dropped connection: the browser's own error, never shown as it is. */
      if (reply.abort) return route.abort("internetdisconnected");
      return route.fulfill({ status: reply.status ?? 200, json: reply.json });
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
  await probe(page);
  await page.clock.install();
  await page.goto(`/suites?suite=moleculr&page=marketing&sp=${sp}`);
  await expect(page.getByTestId("project-name")).toHaveText("Harbour launch spot");
  /** Status reads of `id` (or of any job) the route has seen. */
  const seen = (id?: string) => posts.filter((p) => p.action === "status" && (!id || p.id === id)).length;
  return { errors, posts, seen, lists: () => lists };
}

/**
 * Stop the page's clock where it is: from here only runFor moves time, so every wait is counted exactly.
 * The installed clock runs on until it is paused, so the pause is set 50 ms past the page's time as read.
 * On a slow runner that moment can pass before the pause arrives, and Playwright refuses a pause in the
 * past ("Cannot fast-forward to the past"): then the page's time is read again and the margin grows by
 * 50 ms (100, 150, …), five tries at most. Any other error is thrown as it is.
 */
async function pauseClock(page: Page) {
  for (let attempt = 1; ; attempt++) {
    const now = await page.evaluate(() => Date.now());
    try {
      await page.clock.pauseAt(now + 50 * attempt);
      return;
    } catch (error) {
      if (attempt === 5 || !(error instanceof Error && error.message.includes("Cannot fast-forward to the past"))) throw error;
    }
  }
}
async function setHidden(page: Page, hidden: boolean) {
  await page.evaluate((value) => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (value ? "hidden" : "visible") });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}
/** The shell's strip of the suite's pages (every size). */
const pageTab = (page: Page, name: RegExp) => page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name });
/** Where keyboard focus is: the Try again button itself, or the section a finished read left it in. */
const focused = (page: Page) => page.evaluate(() => {
  const el = document.activeElement as HTMLElement | null;
  return { tag: el?.tagName ?? "", text: el?.textContent?.trim() ?? "", disabled: el?.getAttribute("aria-disabled") ?? null, home: el?.hasAttribute("data-focus-home") ?? false };
});
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
}
async function thumbSized(page: Page, testId: string, name: string) {
  const height = await page.getByTestId(testId).getByRole("button", { name }).first().evaluate((el) => el.getBoundingClientRect().height);
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
    const box = el.getBoundingClientRect(), shift = box.top + box.height / 2 - (top + bottom) / 2;
    for (let scroller = el.parentElement; scroller; scroller = scroller.parentElement) {
      if (scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY)) { scroller.scrollTop += shift; return; }
    }
    window.scrollBy(0, shift);
  });
  await page.screenshot({ path: path.join(dir, `${name}-${size}.png`) });
}

/* ── The shell's collector ─────────────────────────────────────────────── */

test("the shell's collector: an ad left rendering is read 1.5x further apart while nothing moves, each wait jittered, started over by a changed status and by the person coming back or opening the page again, never while the tab is hidden, one read at a time, and never sent anything but status reads", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const phone = PHONES.includes(info.project.name);
  /* Left rendering on an earlier visit; the account had not confirmed it yet. */
  let account = adJob(EARLIER, "uncertain", { providerReceipt: { response: "submitted" } });
  const release: Record<number, () => void> = {};
  const holds: Record<number, Promise<void>> = Object.fromEntries([1, 15].map((n) => [n, new Promise<void>((resolve) => { release[n] = resolve; })]));
  const replies: Record<number, "uncertain" | "completed"> = { 1: "uncertain", 2: "uncertain", 16: "completed" };
  const { errors, posts, seen, lists } = await openBusiness(page, "ads", {
    listed: () => [account],
    status: (_id, n) => {
      const next = replies[n] ?? "accepted";
      account = next === "completed" ? landed(account) : { ...account, status: next };
      return { json: { job: account, pollAfterSeconds: 15 }, hold: holds[n] };
    },
  });
  const reads = () => seen(EARLIER);
  const row = page.getByTestId("ads-earlier-row");
  const state = row.locator(".gx-resumed-state");
  await expect(row).toHaveCount(1);
  await expect(state).toHaveText(/^Confirming · \d+ min$/);
  /* Its first read went out as the page opened; its reply waits until the clock is stopped and the draw pinned. */
  await expect.poll(reads).toBe(1);
  await pauseClock(page);
  await draw(page, 0.5);
  release[1]();
  await settled(page);

  /* While nothing moves, each read waits 1.5x longer: 20 s, then 30 s. */
  await nextRead(page, 20_000, reads);
  await nextRead(page, 30_000, reads);
  /* That read found it accepted: it moved on, so the pace starts over at 20 s, then 30, 45, and a minute at most. */
  await expect(state).toHaveText(/^Rendering · \d+ min$/);
  await noOverflow(page);
  await shoot(page, info.project.name, "collector-rendering", "ads-earlier");
  for (const wait of [20_000, 30_000, 45_000, 60_000]) await nextRead(page, wait, reads);

  /* Jitter: the same minute, drawn at the bottom of its ±20% band, is 48 s; at the top, 72 s — never in step. */
  await draw(page, 0);
  await nextRead(page, 60_000, reads);
  await draw(page, 0.999999);
  await nextRead(page, 48_000, reads);
  await draw(page, 0.5);
  await nextRead(page, 72_000, reads);

  /* Hidden: nothing is asked, however long. */
  await setHidden(page, true);
  await page.clock.runFor(10 * MIN);
  expect(await statusReads(page, EARLIER)).toHaveLength(10);
  /* Back: the one read that fell due is made at once — not ten minutes' worth — and the page lists the project again. */
  const listed = lists();
  await setHidden(page, false);
  expect(await statusReads(page, EARLIER)).toHaveLength(11);
  await expect.poll(reads).toBe(11);
  await expect.poll(lists).toBe(listed + 1);
  await settled(page);
  /* The person came back: the pace starts over, 20 s, then 30 s — not the minute it had reached. */
  await nextRead(page, 20_000, reads);
  await nextRead(page, 30_000, reads);

  /* Opening the page again (Setup, then back to Ads) starts it over too: 20 s after the last read, not 45. */
  await pageTab(page, /Setup$/).click();
  await expect(page.getByTestId("setup-view")).toBeVisible();
  await pageTab(page, /Ads$/).click();
  await expect(row).toHaveCount(1);
  await settled(page);
  await nextRead(page, 20_000, reads);

  /* One read at a time: a reply the account takes ten minutes over has no second read queued behind it. */
  await nextRead(page, 30_000, reads, { held: true });
  await page.clock.runFor(10 * MIN);
  expect(await statusReads(page, EARLIER)).toHaveLength(15);
  release[15]();
  await settled(page);
  /* Answered at last: the next wait (45 s) counts from that reply. It finds the ad rendered: announced once, then no read. */
  await nextRead(page, 45_000, reads);
  await expect(page.getByTestId("toast")).toHaveText("Marketing Studio rendered on the connected account. It is in Takes.");
  await expect(state).toHaveText("Complete");
  if (phone) await thumbSized(page, "ads-earlier", "Open Takes");
  await noOverflow(page);
  await shoot(page, info.project.name, "collector-landed", "ads-earlier");
  await page.clock.runFor(10 * MIN);
  expect(await statusReads(page, EARLIER)).toHaveLength(16);
  expect(reads()).toBe(16);

  /* Only status reads of that one job went out — nothing priced or sent — each after the reply to the one before. */
  expect(posts.filter((p) => p.action !== "catalogue").every((p) => p.action === "status" && p.id === EARLIER && p.draftId === DRAFT)).toBe(true);
  oneAtATime(await statusReads(page));
  expect(errors).toEqual([]);
});

test("the shell's collector: two ads asked in the same round are next asked apart, each wait drawn on its own", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const first = adJob(EARLIER, "accepted"), second = adJob(SECOND, "accepted", { input: { type: "video", model: "marketing_studio_video", prompt: "Another ad left rendering", parameters: {}, medias: [] }, createdAt: Date.now() - 5 * MIN });
  const release: Record<string, () => void> = {};
  const holds: Record<string, Promise<void>> = Object.fromEntries([EARLIER, SECOND].map((id) => [id, new Promise<void>((resolve) => { release[id] = resolve; })]));
  const { errors, posts, seen } = await openBusiness(page, "ads", {
    listed: () => [first, second],
    status: (id, n) => ({ json: { job: id === EARLIER ? first : second, pollAfterSeconds: 15 }, hold: n === 1 ? holds[id] : undefined }),
  });
  await expect(page.getByTestId("ads-earlier-row")).toHaveCount(2);
  /* The collector reads them in turn: the first ad's read is out; the second waits behind it. */
  await expect.poll(() => seen(EARLIER)).toBe(1);
  await pauseClock(page);
  expect(seen(SECOND)).toBe(0);
  /* The first's reply draws low (16 s); the second's read then goes out in the same round, and its reply draws high (24 s). */
  await draw(page, 0);
  release[EARLIER]();
  await expect.poll(() => seen(SECOND)).toBe(1);
  await draw(page, 0.999999);
  release[SECOND]();
  await settled(page);
  await draw(page, 0.5);
  /* Asked together once, then 8 s apart. */
  await nextRead(page, 16_000, () => seen(EARLIER), { id: EARLIER });
  expect(await statusReads(page, SECOND)).toHaveLength(1);
  await nextRead(page, 8000, () => seen(SECOND), { id: SECOND });
  expect(await statusReads(page, EARLIER)).toHaveLength(2);
  expect(posts.filter((p) => p.action !== "catalogue").every((p) => p.action === "status")).toBe(true);
  oneAtATime(await statusReads(page));
  expect(errors).toEqual([]);
});

/* ── A composer's own job, and the hand-over ───────────────────────────── */

test("Ads: the ad being rendered is read by its composer never within 6 s of the last read, longer while it is unchanged, started over by a changed status, backs off and says so when a read fails, never reads inside the account's window or while the tab is hidden, and leaving the page hands it to the collector one pace after its last read; the price is sent once", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  let submitted: Job | null = null;
  /* What the account says to status read n: unconfirmed five times, then accepted; a dropped connection and a 503;
     a 15 s window; then, read by the collector, accepted and finally rendered. */
  const replies: Record<number, Reply> = {
    1: { json: "uncertain" }, 2: { json: "uncertain" }, 3: { json: "uncertain" }, 4: { json: "uncertain" }, 5: { json: "uncertain" },
    6: { json: "accepted" }, 7: { abort: true }, 8: { status: 503, json: { error: ROUTE_FALLBACK } },
    9: { json: "accepted-15" }, 10: { json: "accepted" }, 11: { json: "accepted-15" }, 12: { json: "accepted-15" }, 13: { json: "completed" },
  };
  const { errors, posts, seen } = await openBusiness(page, "ads", {
    listed: () => (submitted ? [submitted] : []),
    submitted: (input) => (submitted = adJob(JOB_ID, "uncertain", { input, createdAt: Date.now() })),
    status: (_id, n) => {
      const reply = replies[n] ?? { json: "completed" };
      if (typeof reply.json !== "string") return reply;
      /* "accepted-15": still rendering, and the account asks for 15 s before the next read. */
      const [state, after] = reply.json.split("-");
      submitted = state === "completed" ? landed(submitted!) : { ...submitted!, status: state };
      return { json: { job: submitted, ...(after ? { pollAfterSeconds: Number(after) } : {}) } };
    },
  });
  const reads = () => seen(JOB_ID);
  const generate = page.getByTestId("ads-generate");
  await expect(page.getByTestId("ads-view")).toBeVisible();
  await expect(page.getByTestId("ads-hook").getByRole("button", { name: "Stop scrolling" })).toBeVisible();
  await page.getByTestId("ads-prompt").fill("Morning routine with the bottle on the sill.");
  await expect(generate).toHaveText("Generate ad · 40 cr");
  await pauseClock(page);
  await draw(page, 0.5);
  await generate.click();
  await expect(generate).toHaveText("Rendering…");
  await settled(page);

  /* The route allows a person 30 status reads a minute, so a connected job is never read within 6 s of the last
     read: the floor and half a second, jittered upward only (7.15 s at this draw). While the account has not
     confirmed it the pace grows past the floor: 7.15 s three times, then 6.75 s and 10 s. */
  for (const wait of [7150, 7150, 7150, 6750, 10_000]) await nextRead(page, wait, reads);
  /* Still unconfirmed: 10 s again. Then confirmed: it moved on, so the pace starts over at the floor (7.15 s, not 10 s). */
  await nextRead(page, 10_000, reads);
  await nextRead(page, 7150, reads);
  /* That read never reached the server: said in plain words, not the browser's error, and the wait doubles (12 s). */
  const problem = page.getByTestId("ads-problem");
  await expect(problem).toHaveText("The connection dropped. Checking again shortly.");
  await expect(generate).toHaveText("Rendering…");
  await shoot(page, info.project.name, "ads-read-dropped", "ads-problem");
  await nextRead(page, 12_000, reads);
  /* The route's catch-all (a 503): one fixed line, not its advice about a saved job; the wait doubles again (24 s). */
  await expect(problem).toHaveText("Could not check this take. Checking again shortly.");
  await noOverflow(page);
  await shoot(page, info.project.name, "ads-read-failed", "ads-problem");
  await draw(page, 0);
  await nextRead(page, 24_000, reads);
  await expect(problem).toBeHidden();
  /* The account asked for 15 s and holds the job until then: even at the bottom of the jitter the next read is 15.5 s on. */
  await draw(page, 0.5);
  await nextRead(page, 15_500, reads);

  /* Hidden: nothing, however long. Back: the read that fell due, at once. */
  await setHidden(page, true);
  await page.clock.runFor(5 * MIN);
  expect(await statusReads(page, JOB_ID)).toHaveLength(10);
  await setHidden(page, false);
  expect(await statusReads(page, JOB_ID)).toHaveLength(11);
  await expect.poll(reads).toBe(11);
  await settled(page);

  /* Leaving the page lets the composer go: it reads nothing more, and the shell's collector's first read comes one pace
     after the composer's last (20 s at its own rate, past the account's 15 s window) — then 30 s, as for any job it follows. */
  await pageTab(page, /Setup$/).click();
  await expect(page.getByTestId("setup-view")).toBeVisible();
  await settled(page);
  await nextRead(page, 20_000, reads);
  await nextRead(page, 30_000, reads);
  await expect(page.getByTestId("toast")).toHaveText("Marketing Studio rendered on the connected account. It is in Takes.");
  await page.clock.runFor(10 * MIN);
  expect(await statusReads(page, JOB_ID)).toHaveLength(13);
  expect(reads()).toBe(13);
  /* Never two reads of it closer than the floor. */
  const times = (await statusReads(page, JOB_ID)).map((r) => r.at);
  for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(6500);

  /* Priced before, sent once, then only status reads — never two of them at a time. */
  const actions = posts.map((p) => p.action).filter((a) => a !== "catalogue");
  expect(actions.filter((a) => a === "submit")).toHaveLength(1);
  expect(actions.slice(actions.indexOf("submit") + 1).every((a) => a === "status")).toBe(true);
  oneAtATime(await statusReads(page));
  await noOverflow(page);
  expect(errors).toEqual([]);
});

test("Ads: an ad read back after a reload is next read when the account's window is up, not at the floor's 7 s", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  /* The ad this device submitted before the reload: the composer remembers it and reads it back on open. */
  await page.addInitScript(([key, id]) => { try { localStorage.setItem(key, id); } catch { /* private mode */ } }, [`particl:connected-job:ads:${DRAFT}`, JOB_ID]);
  let release: () => void = () => undefined;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const job = adJob(JOB_ID, "accepted", { createdAt: Date.now() - 2 * MIN });
  const { errors, posts, seen } = await openBusiness(page, "ads", {
    status: (_id, n) => (n === 1 ? { json: { job, pollAfterSeconds: 15 }, hold } : n === 2 ? { json: { job } } : { json: { job: landed(job) } }),
  });
  const reads = () => seen(JOB_ID);
  await expect(page.getByTestId("ads-view")).toBeVisible();
  await expect.poll(reads).toBe(1);
  await pauseClock(page);
  /* The read-back's reply asks for 15 s: the account holds the job until then. */
  await draw(page, 0);
  release();
  await settled(page);
  /* The composer's first read of its own waits that out: 15.5 s at the bottom of the jitter — not its usual 6.5–7.8 s. */
  await draw(page, 0.5);
  await nextRead(page, 15_500, reads);
  /* Then its own pace (the floor: 7.15 s), and the rendered ad ends the reads. */
  await nextRead(page, 7150, reads);
  await expect(page.getByTestId("ads-done")).toBeVisible();
  await page.clock.runFor(10 * MIN);
  expect(await statusReads(page, JOB_ID)).toHaveLength(3);
  expect(posts.every((p) => p.action === "catalogue" || p.action === "status")).toBe(true);
  oneAtATime(await statusReads(page));
  expect(errors).toEqual([]);
});

test("Ads: a catalogue that did not load says so plainly, is tried again a few times but never while the tab is hidden, then waits for Read again; a job the account no longer knows hands the composer back and is never asked after again", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const phone = PHONES.includes(info.project.name);
  let release: () => void = () => undefined;
  const catalogue: Gate = { failing: true, gate: new Promise<void>((resolve) => { release = resolve; }), reads: 0 };
  const { errors, seen } = await openBusiness(page, "ads", { catalogue, status: () => ({ status: 404, json: { error: "Not found." } }) });
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
  await settled(page);
  /* A read of the catalogue asks for video, then image; a failed video read ends it. */
  const tries = async () => (await record(page)).filter((s) => s.action === "catalogue" && s.type === "video").length;
  /* The first retry falls due (5 s) while the tab is hidden: held however long, made at once when it is back. */
  const before = await tries();
  await setHidden(page, true);
  await page.clock.runFor(MIN);
  expect(await tries()).toBe(before);
  await setHidden(page, false);
  await expect.poll(() => catalogue.reads).toBe(2);
  await settled(page);
  /* Then 15 s and 45 s after each failure, to the millisecond, and then not again: Read again asks. */
  for (const [wait, count] of [[15_000, 3], [45_000, 4]] as const) {
    const sent = await tries();
    await page.clock.runFor(wait - 1);
    expect(await tries()).toBe(sent);
    await page.clock.runFor(1);
    expect(await tries()).toBe(sent + 1);
    await expect.poll(() => catalogue.reads).toBe(count);
    await settled(page);
  }
  const stalled = await tries();
  await page.clock.runFor(10 * MIN);
  expect(await tries()).toBe(stalled);
  expect(catalogue.reads).toBe(4);
  const again = page.getByTestId("catalogue-again");
  await expect(again).toBeVisible();
  if (phone) await thumbSized(page, "ads-view", "Read again");
  await noOverflow(page);

  /* Read again: asked on the next tick of the page's clock; the catalogue lands and the composer prices. */
  catalogue.failing = false;
  await again.click();
  await settled(page);
  expect(await tries()).toBe(stalled);
  await page.clock.runFor(1);
  expect(await tries()).toBe(stalled + 1);
  await expect.poll(() => catalogue.reads).toBe(5);
  await expect(page.getByTestId("ads-blocked")).toBeHidden();
  await expect(again).toHaveCount(0);
  await settled(page);
  await page.clock.runFor(1000);
  await expect(page.getByTestId("ads-generate")).toHaveText("Generate ad · 40 cr");

  /* The account no longer knows the job: one read, then the composer is handed back with the reason and Price again,
     and nothing else (the shell's collector included) asks after it again. */
  await draw(page, 0.5);
  await page.getByTestId("ads-generate").click();
  await expect(page.getByTestId("ads-generate")).toHaveText("Rendering…");
  await settled(page);
  /* Its first read, at the connected floor (7.15 s at this draw), finds nothing on record. */
  await nextRead(page, 7150, () => seen(JOB_ID));
  await expect(page.getByTestId("ads-error")).toHaveText("This job can no longer be checked from here.");
  await expect(page.getByTestId("ads-requote")).toBeVisible();
  await shoot(page, info.project.name, "ads-job-gone", "ads-requote");
  await page.clock.runFor(10 * MIN);
  expect(await statusReads(page, JOB_ID)).toHaveLength(1);
  expect(seen(JOB_ID)).toBe(1);
  await noOverflow(page);
  expect(errors).toEqual([]);
});

/* ── Setup, Motion Transfer, a re-edit ─────────────────────────────────── */

test("Setup: a failed read says so in plain words with Try again, is never asked again on its own, and Try again keeps focus", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const phone = PHONES.includes(info.project.name);
  let release: () => void = () => undefined;
  const setup: Gate = { failing: true, gate: new Promise<void>((resolve) => { release = resolve; }), reads: 0 };
  const { errors } = await openBusiness(page, "setup", { setup });
  await expect(page.getByTestId("setup-view")).toBeVisible();
  await expect.poll(() => setup.reads).toBe(1);
  await pauseClock(page);
  release();
  setup.gate = null;
  const asked = async () => (await record(page)).filter((s) => s.action === "setup").length;

  /* The failure: said once in the product's words (not the route's job-oriented fallback), with Try again —
     and not read again on its own however long the page sits, shown or hidden (a Setup read waits for the person). */
  const problem = page.getByTestId("setup-error");
  await expect(problem).toContainText("The connected account did not answer.");
  await expect(problem).not.toContainText("saved job");
  await expect(problem.getByRole("button", { name: "Try again" })).toBeEnabled();
  await settled(page);
  await page.clock.runFor(10 * MIN);
  await setHidden(page, true);
  await page.clock.runFor(10 * MIN);
  await setHidden(page, false);
  expect(await asked()).toBe(1);
  expect(setup.reads).toBe(1);
  if (phone) await thumbSized(page, "setup-error", "Try again");
  await noOverflow(page);
  await shoot(page, info.project.name, "setup-read-failed", "setup-error");

  /* Try again from the keyboard: it reads now and keeps focus while the read is out (a second Enter sends nothing);
     the items land, the error goes, and focus stays in the list it reloaded rather than falling to the top of the page. */
  setup.failing = false;
  setup.gate = new Promise<void>((resolve) => { release = resolve; });
  await problem.getByRole("button", { name: "Try again" }).focus();
  await page.keyboard.press("Enter");
  expect(await asked()).toBe(2);
  await expect.poll(() => setup.reads).toBe(2);
  await expect(problem.getByRole("button", { name: "Reading…" })).toHaveAttribute("aria-disabled", "true");
  expect(await focused(page)).toMatchObject({ tag: "BUTTON", text: "Reading…", disabled: "true" });
  await page.keyboard.press("Enter");
  expect(await asked()).toBe(2);
  release();
  setup.gate = null;
  await expect(problem).toBeHidden();
  await expect(page.getByTestId("setup-product").getByRole("button", { name: /Trail bottle/ })).toBeVisible();
  expect(await focused(page)).toMatchObject({ tag: "DIV", home: true });
  await expect(page.getByRole("button", { name: "Read again" })).toBeEnabled();
  expect(setup.reads).toBe(2);
  await noOverflow(page);
  await shoot(page, info.project.name, "setup-read-recovered", "setup-product");
  expect(errors).toEqual([]);
});

test("Motion Transfer: runs in flight are read one at a time, in turn, each at the account's own pace and never inside its window, and nothing while the tab is hidden", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const VIRAL_DRAFT = "ws-viral-poll";
  const A = "33333333-3333-4333-8333-00000000000a", B = "33333333-3333-4333-8333-00000000000b";
  /* A asks for 30 s between reads, B for 15 s. B is the newer run, listed first. */
  const HINT: Record<string, number> = { [A]: 30, [B]: 15 };
  const running = (id: string, minutesAgo: number) => ({
    id, draftId: VIRAL_DRAFT, status: "accepted", input: { variant: "motion-transfer", resolution: "720p", prompt: "", source: { uploadId: "up_src" }, references: [{ uploadId: "up_ref" }] },
    workspaceId: WALLET, workspaceName: "Fixture wallet", quoteCredits: 22, creditUnit: "higgsfield_credits", quoteExpiresAt: 0,
    createdAt: Date.now() - minutesAgo * MIN, providerJobId: `22222222-2222-4222-8222-00000000000${id.slice(-1)}`,
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
  const posts: Record<string, unknown>[] = [];
  let listReads = 0;
  await page.route("**/api/higgsfield/consumer/genjutsu**", async (route) => {
    const req = route.request();
    if (req.method() === "GET") {
      listReads++;
      await listed;
      return route.fulfill({ json: { connection: { connected: true, requiresReconnect: false }, capabilities: { resolutions: ["480p", "720p", "1080p"], minSeconds: 4, maxSeconds: 30, maxImages: 30, maxMediaBytes: 52428800 }, jobs: [running(A, 3), running(B, 2)], nextCursor: null } });
    }
    const body = req.postDataJSON() as { action: string; id?: string };
    posts.push(body);
    if (body.action !== "status" || !body.id) return route.fulfill({ status: 400, json: { error: "unexpected in this spec" } });
    asked.push(body.id);
    return route.fulfill({ json: { job: running(body.id, body.id === A ? 3 : 2), pollAfterSeconds: HINT[body.id] } });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await probe(page);
  await page.clock.install();
  await page.goto(`/suites?suite=subatomik&page=motion&sp=motion`);
  await expect(page.getByTestId("project-name")).toHaveText("Coastal light study");
  await expect(page.getByTestId("viral-view")).toBeVisible();
  await expect.poll(() => listReads).toBeGreaterThan(0);
  await pauseClock(page);
  await draw(page, 0.5);
  release();
  const rows = page.getByTestId("viral-recent").getByTestId("viral-run");
  await expect(rows).toHaveCount(2);
  await settled(page);
  const seen = () => asked.length;

  /* A tick (4 s) after the list: the first listed run; the other one tick after that — never two reads together. */
  await nextRead(page, 4000, seen);
  expect(asked).toEqual([B]);
  await nextRead(page, 4000, seen);
  expect(asked).toEqual([B, A]);
  /* B asked for 15 s: it is read again after that and a half second, jittered upward only (17.05 s after its read,
     13.05 s after A's) — and at the bottom of the jitter, 15.5 s: never inside its window. */
  await draw(page, 0);
  await nextRead(page, 13_050, seen);
  expect(asked).toEqual([B, A, B]);
  await draw(page, 0.5);
  await nextRead(page, 15_500, seen);
  /* A asked for 30 s: not read inside it, while B was read twice. */
  expect(asked).toEqual([B, A, B, B]);

  /* Hidden: neither run is asked about, however long; back: the read that fell due (A's turn) is made at once. */
  await setHidden(page, true);
  await page.clock.runFor(2 * MIN);
  expect(await statusReads(page)).toHaveLength(4);
  await setHidden(page, false);
  expect(await statusReads(page)).toHaveLength(5);
  await expect.poll(seen).toBe(5);
  expect(asked).toEqual([B, A, B, B, A]);
  await settled(page);
  await expect(rows.first().getByTestId("viral-run-status")).toHaveText("Rendering");
  expect(posts.every((p) => p.action === "status")).toBe(true);
  oneAtATime(await statusReads(page));
  await noOverflow(page);
  await shoot(page, info.project.name, "viral-two-running", "viral-recent");
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
  let dispatched = 0;
  await page.route(/\/api\/generate(\/quote)?$/, (route) => {
    if (route.request().url().endsWith("/quote")) return route.fulfill({ json: { estimatedCredits: 4, fingerprint: "f".repeat(64), price: 0.04, unit: "cr" } });
    dispatched++;
    return route.fulfill({ json: { id: "gen_reedit" } });
  });
  const reads: number[] = [];
  await page.route(/\/api\/jobs\/gen_reedit(\?.*)?$/, (route) => {
    reads.push(reads.length + 1);
    return reads.length === 1 ? route.fulfill({ status: 503, json: { error: "The render request could not finish." } }) : route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.route("**/api/higgsfield/consumer/audio-tools?**", (route) => route.fulfill({ json: { connection: { connected: false, requiresReconnect: false }, capabilities: { voice: false, dubbing: false, analysis: false, reframe: false, languages: [] }, jobs: [] } }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await probe(page);
  await page.clock.install();
  await page.goto("/suites?suite=studio&page=takes");
  await expect(page.getByTestId("project-name")).toHaveText("Harbour cut");
  await page.getByTestId("edit-takes").getByTestId("edit-take").filter({ hasText: "Mara at the window" }).click();
  await page.getByTestId("edit-instruction").fill("Make it night, rain on the glass");
  await expect(page.getByTestId("edit-render")).toHaveText("Re-edit · 4 credits");
  await pauseClock(page);
  await draw(page, 0.5);
  await page.getByTestId("edit-render").click();
  await expect(page.getByTestId("edit-render")).toHaveText("Rendering…");
  await settled(page);
  const seen = () => reads.length;

  /* The first read (2 s) fails: said in fixed words while it keeps checking; the button still says Rendering. */
  await nextRead(page, 2000, seen);
  const checking = page.getByTestId("edit-checking");
  await expect(checking).toHaveText("Could not check this re-edit. Checking again shortly.");
  await expect(page.getByTestId("edit-render")).toHaveText("Rendering…");
  await expect(page.getByTestId("edit-render")).toBeDisabled();
  await shoot(page, info.project.name, "reedit-read-failed", "edit-checking");

  /* The next read (the 3 s pace, doubled: 6 s) finds nothing on record: it stops, says where a finished one goes — never
     that a failed one cost nothing — and offers the price again. No read after that, and the re-edit was sent once. */
  await nextRead(page, 6000, seen);
  await expect(page.getByTestId("edit-image").getByRole("alert")).toHaveText("This re-edit can no longer be checked from here. If it renders, it lands in the library.");
  await expect(checking).toBeHidden();
  await expect(page.getByTestId("edit-render")).toHaveText("Re-edit · 4 credits");
  await expect(page.getByTestId("edit-render")).toBeEnabled();
  await shoot(page, info.project.name, "reedit-gone", "edit-render");
  await page.clock.runFor(10 * MIN);
  expect(await statusReads(page)).toHaveLength(2);
  expect(reads).toHaveLength(2);
  expect(dispatched).toBe(1);
  await noOverflow(page);
  expect(errors).toEqual([]);
});
