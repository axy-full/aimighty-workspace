import { test, expect, type Page, type Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, type LibraryRoute } from "./helpers/workspaceFixtures";

/**
 * Connected-account jobs finish after the page is left. The shell's collector
 * lists the open project's saved jobs and reads each sent one with the same
 * status read the composer uses (never a quote, never a submit) until it
 * settles, and announces it once. Opening Gen or Ads later shows the jobs that
 * composer made from what the collector has — their state in one word with its
 * age, a problem named plainly, a finished take moved into Takes — and asks
 * nothing itself. Motion Transfer follows its own jobs. Every account reply
 * here is a route mock; nothing is paid for.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const SHOTS: Record<string, string> = Object.fromEntries(SIZES.map((name) => [name, name.replace("workbench-", "")]));
const WALLET = "1f2e3d4c-5b6a-4798-8a9b-0c1d2e3f4a5b";
const MIN = 60_000;
const DRAFT = "ws-jobs";
/* The collector's pace (lib/shell/connected-collector.ts): 20 s between reads, a few reads for a job the account has not accepted. */
const NEXT_READ = "00:21";
const UNSETTLED_READS = 6;
const fixture = (): Project => ({ ...newProject("Harbour night shoot"), id: DRAFT, productionProjectId: "prod-ws", shotMappings: {} });
const uuid = (n: number) => `9d2b3c4e-5f60-4a7b-8c9d-${String(n).padStart(12, "0")}`;
const GEN = "gen_hfc_" + "c".repeat(40);

type Job = Record<string, unknown> & { id: string; status: string };
type Fields = { status: string; model: string; name: string; outputType?: string; prompt: string; ago: number; composer?: "gen"; credits?: number; receipt?: boolean; setAside?: boolean };
function connected(n: number, fields: Fields): Job {
  return {
    id: uuid(n), draftId: DRAFT, status: fields.status,
    input: { type: fields.outputType ?? "video", model: fields.model, prompt: fields.prompt, parameters: {}, medias: [] },
    model: { id: fields.model, name: fields.name, outputType: fields.outputType ?? "video" }, tool: null, sources: [], composer: fields.composer ?? null,
    workspaceId: WALLET, workspaceName: "Fixture wallet", quoteCredits: fields.credits ?? 43, creditUnit: "higgsfield_credits", quoteExpiresAt: 0,
    providerJobId: fields.status === "accepted" || fields.status === "completed" ? uuid(900 + n) : null, result: null, originalAvailable: false, createdAt: Date.now() - fields.ago,
    ...(fields.receipt ? { providerReceipt: { response: { status: "submitted" } } } : {}), ...(fields.setAside ? { setAside: true } : {}),
  };
}
const completed = (job: Job): Job => ({
  ...job, status: "completed", originalAvailable: true, originalAvailability: "available",
  result: { original: { generationId: GEN, providerJobId: job.providerJobId, creditUnit: "higgsfield_credits", credits: job.quoteCredits, sha256: "d".repeat(64), bytes: 2048, asset: { generationId: GEN, url: `/api/media/${GEN}`, kind: "video", mime: "video/mp4" } } },
});

async function base(page: Page, library: LibraryRoute) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  await mockLibrary(page, library);
  const me = await page.request.get("/api/me").then((r) => r.json());
  await page.route("**/api/me", (route) => route.fulfill({ json: { ...me, owner: true } }));
  await page.route("**/api/higgsfield/consumer/connection", (route) => route.fulfill({ json: { connected: true, requiresReconnect: false } }));
  await page.route("**/api/higgsfield/consumer/video", (route) => route.fulfill({ json: { connected: true, reads: [] } }));
  await page.route("**/api/prompt/enhance", (route) => route.fulfill({ json: { model: "m", effort: "auto", estimateCredits: 1 } }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

/** The generation route: GET lists the project's saved jobs; POST answers status reads from `reply`. */
type Reply = { status?: number; json: unknown };
async function mockGeneration(page: Page, jobs: Job[], reply: (id: string) => Reply | Promise<Reply>) {
  const posts: Record<string, unknown>[] = [];
  let listed = 0;
  await page.route(/\/api\/higgsfield\/consumer\/generation(\?.*)?$/, async (route: Route) => {
    const request = route.request();
    if (request.method() === "GET") {
      listed++;
      expect(new URL(request.url()).searchParams.get("draftId")).toBe(DRAFT);
      return route.fulfill({ json: { connection: { connected: true }, capabilities: {}, jobs } });
    }
    const body = request.postDataJSON() as Record<string, unknown>;
    posts.push(body);
    if (body.action === "catalogue") return route.fulfill({ json: { catalogue: { models: [], unlim: { available: false, remaining: null, expiresAt: null }, complete: true, fetchedAt: Date.now() } } });
    if (body.action === "status") { const { status, json } = await reply(String(body.id)); return route.fulfill({ status: status ?? 200, json }); }
    return route.fulfill({ status: 400, json: { error: "unexpected in this spec" } });
  });
  return { posts, listed: () => listed };
}

async function noOverflow(page: Page) {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(wide).toBeLessThanOrEqual(0);
}
async function thumbSized(page: Page, name: string, testId: string) {
  /* Rounded: a landscape phone lays out on fractional pixels (43.99997 is a 44 px target). */
  const height = await page.getByTestId(testId).getByRole("button", { name }).first().evaluate((el) => el.getBoundingClientRect().height);
  expect(Math.round(height)).toBeGreaterThanOrEqual(44);
}
async function shootTop(page: Page, project: string, name: string) {
  const size = SHOTS[project];
  const dir = process.env.HF_JOBS_SHOTS;
  if (!size || !dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}-${size}.png`) });
}
async function shoot(page: Page, project: string, name: string, target: string, index = 0) {
  const size = SHOTS[project];
  const dir = process.env.HF_JOBS_SHOTS;
  if (!size || !dir) return;
  mkdirSync(dir, { recursive: true });
  /* Its end just above the phone dock, so the state and actions are in the frame; then the element alone. */
  const element = page.getByTestId(target).nth(index);
  await element.evaluate((el) => { (el as HTMLElement).style.scrollMarginBottom = "120px"; el.scrollIntoView({ block: "end" }); });
  await page.screenshot({ path: path.join(dir, `${name}-${size}.png`) });
  await element.screenshot({ path: path.join(dir, `${name}-${size}-element.png`) });
}

test("Gen shows the takes left rendering as the collector reads them, bounds the asking, and a finished one lands in Takes without writing the draft", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const phone = PHONES.includes(info.project.name);
  const narrow = phone;
  const library: LibraryRoute = { uploads: [], generations: [] };
  const errors = await base(page, library);
  const rendering = connected(1, { status: "accepted", model: "seedance_2_5", name: "Seedance 2.5", prompt: "A slow dolly push across the wet harbour at blue hour, lanterns swaying over the moored boats", ago: 12 * MIN, composer: "gen" });
  const confirming = connected(2, { status: "uncertain", model: "veo_3_1", name: "Veo 3.1", prompt: "Rain on the quay, a lantern swings", ago: 3 * 60 * MIN, composer: "gen", receipt: true });
  const unconfirmed = connected(3, { status: "uncertain", model: "veo_3_1", name: "Veo 3.1", prompt: "Gulls over the breakwater", ago: 27 * 60 * MIN, composer: "gen" });
  const setAside = connected(4, { status: "dispatching", model: "seedance_2_5", name: "Seedance 2.5", prompt: "Nets drying on the quay", ago: 3 * 24 * 60 * MIN, composer: "gen", setAside: true });
  const earlier = connected(5, { status: "accepted", model: "seedance_2_5", name: "Seedance 2.5", prompt: "Fog rolling in past the lighthouse", ago: 3 * 24 * 60 * MIN, composer: "gen" });
  const ad = connected(6, { status: "accepted", model: "marketing_studio_video", name: "Marketing Studio", prompt: "An ad from Business", ago: 5 * MIN });
  const priced = connected(7, { status: "quoted", model: "seedance_2_5", name: "Seedance 2.5", prompt: "Only priced, never sent", ago: 2 * MIN, composer: "gen" });
  let rendered = false, confirmed = false;
  const asked: string[] = [];
  const { posts } = await mockGeneration(page, [rendering, confirming, unconfirmed, setAside, earlier, ad, priced], (id) => {
    asked.push(id);
    if (id === rendering.id) return rendered ? { json: { job: completed(rendering), pollAfterSeconds: 15 } } : { json: { job: rendering, pollAfterSeconds: 8 } };
    if (id === confirming.id) return confirmed
      ? { json: { job: { ...confirming, status: "failed", failureCode: "provider_failed" } } }
      : { status: 429, json: { error: "Too many requests. Try again shortly." } };
    /* A read cannot move these: the service answers with the saved job as it is. */
    if (id === unconfirmed.id) return { json: { job: unconfirmed } };
    if (id === setAside.id) return { json: { job: setAside } };
    if (id === earlier.id) return { status: 409, json: { code: "connection_changed", error: "The account connection changed." } };
    if (id === ad.id) return { json: { job: ad, pollAfterSeconds: 8 } };
    return { status: 404, json: { error: "not on record" } };
  });
  const reads = (job: Job) => asked.filter((id) => id === job.id).length;
  const saves: string[] = [];
  page.on("request", (request) => { if (request.method() === "PUT" && request.url().includes("/api/workbench/projects")) saves.push(request.url()); });
  await page.clock.install();
  await page.goto("/suites?view=gen");
  await expect(page.getByTestId("gen-view")).toBeVisible();
  await expect(page.getByTestId("project-name")).toHaveText("Harbour night shoot");

  /* This composer's open takes only: not the Business ad, not a job that was only priced. */
  const cards = page.getByTestId("gen-resumed");
  const card = (prompt: string) => cards.filter({ hasText: prompt });
  await expect(cards).toHaveCount(5);
  /* Cut on a word, never mid-word; the full prompt is on hover. */
  await expect(card("A slow dolly").locator(".gx-asset-name")).toHaveText("A slow dolly push across the wet harbour at blue hour…");
  await expect(card("A slow dolly").locator(".gx-asset-meta")).toHaveText("Rendering · 12 min");
  await expect(card("A slow dolly").getByRole("status")).toHaveCount(0);
  await expect(page.getByText("Nothing generated in this project yet.")).toHaveCount(0);
  /* A passing problem is said plainly; the card stays and is asked again. */
  await expect(card("Rain on the quay").locator(".gx-asset-meta")).toHaveText("Confirming · 3 h");
  await expect(card("Rain on the quay").getByRole("status")).toHaveText("Too many requests. Try again shortly.");
  /* A take from an earlier account connection cannot be checked: said once, never asked again, dismissable. */
  await expect(card("Fog rolling").locator(".gx-asset-meta")).toHaveText("Can't be checked");
  await expect(card("Fog rolling").getByRole("status")).toHaveText("Started on an earlier account connection, so it can't be checked from here.");
  /* No invented progress: the same solid ring as the composer's own run. */
  expect(await card("A slow dolly").locator(".gx-ring").evaluate((el) => getComputedStyle(el).backgroundImage)).toBe("none");

  /* A job the account has not confirmed is read a few times, then left as it is: said so, with Dismiss. */
  await expect.poll(() => reads(unconfirmed)).toBe(1);
  for (let read = 2; read <= UNSETTLED_READS; read++) {
    await page.clock.fastForward(NEXT_READ);
    await expect.poll(() => reads(unconfirmed)).toBe(read);
  }
  await expect(card("Gulls").locator(".gx-asset-meta")).toHaveText("Not confirmed · never sent twice");
  await expect(card("Gulls").getByRole("status")).toHaveText("Free its slot in Workspace › Engines.");
  await expect(card("Nets drying").locator(".gx-asset-meta")).toHaveText("Set aside · never sent again");
  await expect(card("Nets drying").getByRole("status")).toHaveCount(0);
  for (const prompt of ["Gulls", "Nets drying", "Fog rolling"]) await expect(card(prompt).getByRole("button", { name: /^Dismiss/ })).toBeVisible();
  for (const prompt of ["A slow dolly", "Rain on the quay"]) await expect(card(prompt).getByRole("button", { name: /^Dismiss/ })).toHaveCount(0);
  /* On a narrow screen the results sit under the composer: its top says takes are still out and jumps to them. */
  const jump = page.getByTestId("gen-resumed-jump");
  await shootTop(page, info.project.name, "gen-top");
  if (narrow) {
    await expect(jump).toHaveText("2 takes still rendering");
    const top = await jump.boundingBox();
    expect(top!.y + top!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    await thumbSized(page, "2 takes still rendering", "gen-view");
    expect(await cards.first().evaluate((el) => el.getBoundingClientRect().top)).toBeGreaterThan(page.viewportSize()!.height);
    await jump.click();
    await expect.poll(() => cards.first().evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.top < window.innerHeight - 40; })).toBe(true);
  } else await expect(jump).toBeHidden();
  await noOverflow(page);
  await shoot(page, info.project.name, "gen-picked-up", "gen-resumed", 1);

  /* Well past the asking: the stopped jobs are never read again, and a job only priced never was. */
  await page.clock.fastForward("02:00");
  await page.clock.fastForward(NEXT_READ);
  expect(reads(earlier)).toBe(1);
  expect(reads(unconfirmed)).toBe(UNSETTLED_READS);
  expect(reads(setAside)).toBe(UNSETTLED_READS);
  expect(reads(priced)).toBe(0);

  /* The account finishes the rendering take: announced once, gone from the cards, in the results. */
  rendered = true;
  library.generations = [generation({ id: GEN, kind: "video", title: "Harbour at dusk", prompt: "A slow dolly push across the wet harbour", projectId: "prod-ws" })];
  await page.clock.fastForward(NEXT_READ);
  await expect(page.getByTestId("toast")).toHaveText("Seedance 2.5 rendered on the connected account. It is in Takes.");
  await expect(cards).toHaveCount(4);
  await expect(page.getByTestId("gen-view").locator(".gx-gen-grid .gx-asset:not([data-testid])")).toHaveCount(1);
  /* Then the unconfirmed one settles as failed: said so, not billed, dismissable. */
  confirmed = true;
  await page.clock.fastForward("01:01");
  await expect(card("Rain on the quay").locator(".gx-asset-meta")).toHaveText("Failed · not billed");
  await expect(card("Rain on the quay").getByRole("status")).toHaveCount(0);
  if (narrow) await expect(jump).toHaveText("4 earlier takes to check");
  await shoot(page, info.project.name, "gen-landed", "gen-resumed");
  if (phone) await thumbSized(page, "Dismiss Rain on the quay, a lantern swings", "gen-view");
  await card("Rain on the quay").getByRole("button", { name: "Dismiss Rain on the quay, a lantern swings" }).click();
  await card("Gulls").getByRole("button", { name: /^Dismiss/ }).click();
  await expect(cards).toHaveCount(2);
  await noOverflow(page);

  /* Dismiss hides for this viewer only and holds across a reload; the rest come back. */
  await page.reload();
  await expect(page.getByTestId("gen-view")).toBeVisible();
  await expect(card("Nets drying")).toBeVisible();
  await expect(card("Gulls")).toHaveCount(0);
  await expect(card("Rain on the quay")).toHaveCount(0);

  /* Status reads only: nothing priced or sent again, and no draft written. */
  expect(posts.map((p) => p.action).filter((a) => a !== "catalogue").every((a) => a === "status")).toBe(true);
  expect(saves).toEqual([]);
  expect(errors).toEqual([]);
});

test("Ads shows an ad from an earlier visit until it lands, then points to Takes; the ad its button reads back is its button's alone", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const phone = PHONES.includes(info.project.name);
  const errors = await base(page, { uploads: [], generations: [] });
  const ad = connected(11, { status: "accepted", model: "marketing_studio_video", name: "Marketing Studio", prompt: "Unboxing the trail runner on a kitchen counter, morning light through the window, close on the laces", ago: 25 * MIN, credits: 40 });
  const genTake = connected(12, { status: "accepted", model: "seedance_2_5", name: "Seedance 2.5", prompt: "A Gen take", ago: 4 * MIN, composer: "gen" });
  /* The last ad submitted on this device: the composer remembers it and reads it back on its own button
     (held open here, so the composer stays "Checking the last take…" the whole time). */
  const remembered = connected(13, { status: "accepted", model: "marketing_studio_video", name: "Marketing Studio", prompt: "The ad this device submitted last", ago: 2 * MIN });
  await page.addInitScript(([key, id]) => { try { localStorage.setItem(key, id); } catch { /* private mode */ } }, [`particl:connected-job:ads:${DRAFT}`, remembered.id]);
  let done = false;
  const { posts } = await mockGeneration(page, [ad, genTake, remembered], (id) =>
    id === ad.id ? { json: { job: done ? completed(ad) : ad, pollAfterSeconds: 8 } }
      : id === remembered.id ? new Promise<Reply>(() => {})
        : { status: 404, json: { error: "not this composer's job" } });
  await page.clock.install();
  await page.goto(`/suites?suite=moleculr&page=marketing&sp=ads`);
  await expect(page.getByTestId("ads-view")).toBeVisible();
  const rows = page.getByTestId("ads-earlier-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.locator(".vr-job-name")).toHaveText("Unboxing the trail runner on a kitchen counter, morning light through the…");
  await expect.poll(() => posts.some((p) => p.action === "status" && p.id === remembered.id)).toBe(true);
  await expect(page.getByText("The ad this device submitted last")).toHaveCount(0);
  await expect(rows.locator(".gx-resumed-state")).toHaveText("Rendering · 25 min");
  await noOverflow(page);
  await shoot(page, info.project.name, "ads-earlier", "ads-earlier");

  done = true;
  await page.clock.fastForward(NEXT_READ);
  await expect(rows.locator(".gx-resumed-state")).toHaveText("Complete");
  /* The collector's one announcement. */
  await expect(page.getByTestId("toast")).toHaveText("Marketing Studio rendered on the connected account. It is in Takes.");
  if (phone) {
    await thumbSized(page, "Open Takes", "ads-earlier");
    await thumbSized(page, "Dismiss Unboxing the trail runner on a kitchen counter, morning light through the…", "ads-earlier");
  }
  /* The actions travel together at the end of the row, never split across lines. */
  const open = await rows.getByRole("button", { name: "Open Takes" }).boundingBox();
  const dismiss = await rows.getByRole("button", { name: /^Dismiss/ }).boundingBox();
  const row = await rows.boundingBox();
  expect(Math.abs(open!.y - dismiss!.y)).toBeLessThanOrEqual(1);
  expect(open!.x).toBeLessThan(dismiss!.x);
  expect(row!.x + row!.width - (dismiss!.x + dismiss!.width)).toBeLessThanOrEqual(16);
  await noOverflow(page);
  await shoot(page, info.project.name, "ads-complete", "ads-earlier");
  /* The collector reads every open job of the project (the Gen take too); this page shows only its own. */
  expect(posts.filter((p) => p.action === "status").every((p) => p.id === ad.id || p.id === remembered.id || p.id === genTake.id)).toBe(true);
  /* One reader per job: while the button reads the remembered ad back (its reply is held open), only the button asked, once. */
  expect(posts.filter((p) => p.action === "status" && p.id === remembered.id)).toHaveLength(1);
  await rows.getByRole("button", { name: "Open Takes" }).click();
  await expect(page.getByTestId("page-title")).toHaveText("Takes");
  /* Leaving the page lets the button's job go: from here only the collector may read it. */
  expect(posts.filter((p) => p.action === "status" && p.id === remembered.id).length).toBeLessThanOrEqual(2);
  expect(posts.some((p) => p.action === "quote" || p.action === "submit")).toBe(false);
  expect(errors).toEqual([]);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("Motion Transfer rows move from Rendering to settled instead of sitting at accepted", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const errors = await base(page, { uploads: [], generations: [] });
  const job = {
    id: "33333333-3333-4333-8333-000000000021", draftId: DRAFT, status: "accepted",
    input: { variant: "motion-transfer", resolution: "720p", prompt: "", source: { uploadId: "up_src" }, references: [{ uploadId: "up_ref" }] },
    workspaceId: WALLET, workspaceName: "Fixture wallet", quoteCredits: 34, creditUnit: "higgsfield_credits", quoteExpiresAt: 0,
    providerJobId: "22222222-2222-4222-8222-000000000021", createdAt: Date.now() - 7 * MIN,
  };
  let state: "accepted" | "completed" = "accepted";
  const posts: Record<string, unknown>[] = [];
  await page.route("**/api/higgsfield/consumer/genjutsu**", async (route) => {
    const request = route.request();
    const current = state === "accepted" ? job : { ...job, status: "completed", originalAvailable: true, originalAvailability: "available", result: { original: { generationId: GEN, asset: { generationId: GEN, url: `/api/media/${GEN}`, kind: "video", mime: "video/mp4" } } } };
    if (request.method() === "GET") return route.fulfill({ json: { connection: { connected: true, requiresReconnect: false }, capabilities: { resolutions: ["480p", "720p", "1080p"], minSeconds: 4, maxSeconds: 30, maxImages: 30, maxMediaBytes: 52428800 }, jobs: [current] } });
    const body = request.postDataJSON() as Record<string, unknown>;
    posts.push(body);
    if (body.action === "status") return route.fulfill({ json: { job: current, pollAfterSeconds: 8 } });
    return route.fulfill({ status: 400, json: { error: "unexpected in this spec" } });
  });
  await page.clock.install();
  await page.goto(`/suites?suite=subatomik&page=motion&sp=motion`);
  await expect(page.getByTestId("viral-view")).toBeVisible();
  const row = page.getByTestId("viral-job");
  await expect(row).toHaveCount(1);
  await expect(row.locator(".gx-resumed-state")).toHaveText("Rendering · 7 min");
  await expect.poll(() => posts.filter((p) => p.action === "status").length).toBeGreaterThan(0);
  await noOverflow(page);
  await shoot(page, info.project.name, "viral-rendering", "viral-job");
  state = "completed";
  await page.clock.fastForward("00:10");
  await expect(row.locator(".gx-resumed-state")).toHaveText("34 cr settled");
  await expect(row).toHaveAttribute("data-tone", "green");
  expect(posts.every((p) => p.action === "status" && p.id === job.id)).toBe(true);
  expect(errors).toEqual([]);
});
