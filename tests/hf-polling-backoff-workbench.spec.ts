import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject } from "../lib/workbench/studio";
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
 *
 * The Business pages that showed the connected account's jobs, and the
 * shell's collector that finished them, went with the Higgsfield sign-in
 * (lib/higgsfield-consumer/retired.ts). Viral runs on Particl's API key and
 * lists its takes from the project's Library, collected by the key's own job
 * reads (tests/hf-viral-real-runs-workbench.spec.ts). What is here is a
 * Production re-edit's own reads.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const SHOTS: Record<string, string> = Object.fromEntries(SIZES.map((name) => [name, name.replace("workbench-", "")]));
const MIN = 60_000;

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
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
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
