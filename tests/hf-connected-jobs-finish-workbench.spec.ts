import { test, expect, type Page, type Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, type LibraryRoute } from "./helpers/workspaceFixtures";

/**
 * Connected-account jobs finish after the page is left. Opening Gen, Ads or
 * Motion Transfer later lists the project's saved jobs once, follows every one
 * this composer made that is still in flight with the same status read the
 * composer uses (never a quote, never a submit), says its state in one word
 * with its age, names a problem plainly, and moves a finished take into
 * Takes. Every account reply here is a route mock; nothing is paid for.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const SHOTS: Record<string, string> = { "workbench-1440x900": "1440x900", "workbench-390x844": "390x844" };
const WALLET = "1f2e3d4c-5b6a-4798-8a9b-0c1d2e3f4a5b";
const MIN = 60_000;
const DRAFT = "ws-jobs";
const fixture = (): Project => ({ ...newProject("Harbour night shoot"), id: DRAFT, productionProjectId: "prod-ws", shotMappings: {} });
const uuid = (n: number) => `9d2b3c4e-5f60-4a7b-8c9d-${String(n).padStart(12, "0")}`;
const GEN = "gen_hfc_" + "c".repeat(40);

type Job = Record<string, unknown> & { id: string; status: string };
function connected(n: number, fields: { status: string; model: string; name: string; outputType?: string; prompt: string; ago: number; fileToProject?: boolean; credits?: number }): Job {
  return {
    id: uuid(n), draftId: DRAFT, status: fields.status,
    input: { type: fields.outputType ?? "video", model: fields.model, prompt: fields.prompt, parameters: {}, medias: [] },
    model: { id: fields.model, name: fields.name, outputType: fields.outputType ?? "video" }, tool: null, sources: [], fileToProject: fields.fileToProject ?? false,
    workspaceId: WALLET, workspaceName: "Fixture wallet", quoteCredits: fields.credits ?? 43, creditUnit: "higgsfield_credits", quoteExpiresAt: 0,
    providerJobId: fields.status === "quoted" ? null : uuid(900 + n), result: null, originalAvailable: false, createdAt: Date.now() - fields.ago,
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
async function shoot(page: Page, project: string, name: string, target: string, index = 0) {
  const size = SHOTS[project];
  const dir = process.env.HF_JOBS_SHOTS;
  if (!size || !dir) return;
  mkdirSync(dir, { recursive: true });
  await page.getByTestId(target).nth(index).evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.screenshot({ path: path.join(dir, `${name}-${size}.png`) });
}

test("Gen picks up takes left rendering, names each state, and files a finished one into Takes", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const phone = PHONES.includes(info.project.name);
  const library: LibraryRoute = { uploads: [], generations: [] };
  const errors = await base(page, library);
  const rendering = connected(1, { status: "accepted", model: "seedance_2_5", name: "Seedance 2.5", prompt: "Harbour at dusk, slow push in on the moored boats", ago: 12 * MIN, fileToProject: true });
  const confirming = connected(2, { status: "uncertain", model: "veo_3_1", name: "Veo 3.1", prompt: "Rain on the quay, a lantern swings", ago: 3 * 60 * MIN, fileToProject: true });
  const ad = connected(3, { status: "accepted", model: "marketing_studio_video", name: "Marketing Studio", prompt: "An ad from Business", ago: 5 * MIN });
  const priced = connected(4, { status: "quoted", model: "seedance_2_5", name: "Seedance 2.5", prompt: "Only priced, never sent", ago: 2 * MIN, fileToProject: true });
  let phase: "first" | "done" = "first";
  const asked: string[] = [];
  const { posts } = await mockGeneration(page, [rendering, confirming, ad, priced], (id) => {
    asked.push(id);
    if (id === rendering.id) return phase === "first" ? { json: { job: rendering, pollAfterSeconds: 8 } } : { json: { job: completed(rendering), pollAfterSeconds: 15 } };
    if (id === confirming.id) return phase === "first"
      ? { status: 401, json: { code: "reconnect_required", error: "Reconnect the connected account." } }
      : { json: { job: { ...confirming, status: "failed", failureCode: "provider_failed" } } };
    return { status: 404, json: { error: "not this composer's job" } };
  });
  await page.clock.install();
  await page.goto("/suites?view=gen");
  await expect(page.getByTestId("gen-view")).toBeVisible();
  await expect(page.getByTestId("project-name")).toHaveText("Harbour night shoot");

  /* Only this composer's takes still in flight: not the Business ad, not a job that was only priced. */
  const cards = page.getByTestId("gen-resumed");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText("Harbour at dusk, slow push in on the moored boats");
  await expect(cards.nth(0).locator(".gx-asset-meta")).toHaveText("Rendering · 12 min");
  await expect(cards.nth(1).locator(".gx-asset-meta")).toHaveText("Confirming · 3 h");
  await expect(page.getByText("Nothing generated in this project yet.")).toHaveCount(0);
  /* A problem is said plainly, with what to do; the card stays and keeps asking. */
  await expect(cards.nth(1).getByRole("status")).toHaveText("Reconnect the account in Workspace › Engines to finish this take.");
  await expect(cards.nth(0).getByRole("status")).toHaveCount(0);
  await noOverflow(page);
  await shoot(page, info.project.name, "gen-picked-up", "gen-resumed", 1);

  /* The account finishes both: the rendered take lands in Takes, the failed one says it was not billed. */
  phase = "done";
  library.generations = [generation({ id: GEN, kind: "video", title: "Harbour at dusk", prompt: "Harbour at dusk, slow push in on the moored boats", projectId: "prod-ws" })];
  await page.clock.fastForward("01:05");
  await expect(page.getByTestId("toast")).toHaveText("Harbour at dusk, slow push in on the moored boats rendered. Filed in Takes.");
  await expect(cards).toHaveCount(1);
  await expect(cards.first().locator(".gx-asset-meta")).toHaveText("Failed · not billed");
  await expect(page.getByTestId("gen-view").locator(".gx-gen-grid .gx-asset:not([data-testid])")).toHaveCount(1);
  await shoot(page, info.project.name, "gen-landed", "gen-resumed");
  if (phone) await thumbSized(page, "Dismiss Rain on the quay, a lantern swings", "gen-view");
  await cards.first().getByRole("button", { name: "Dismiss Rain on the quay, a lantern swings" }).click();
  await expect(cards).toHaveCount(0);
  await noOverflow(page);

  /* Status reads only, and only for the two picked up: nothing was priced or sent again. */
  expect(posts.map((p) => p.action).filter((a) => a !== "catalogue").every((a) => a === "status")).toBe(true);
  expect(new Set(asked)).toEqual(new Set([rendering.id, confirming.id]));
  expect(errors).toEqual([]);
});

test("Ads follows an ad from an earlier visit until it lands, then points to Takes; the ad its button resumes is not listed twice", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const phone = PHONES.includes(info.project.name);
  const errors = await base(page, { uploads: [], generations: [] });
  const ad = connected(11, { status: "accepted", model: "marketing_studio_video", name: "Marketing Studio", prompt: "Unboxing the trail runner on a kitchen counter", ago: 25 * MIN, credits: 40 });
  const genTake = connected(12, { status: "accepted", model: "seedance_2_5", name: "Seedance 2.5", prompt: "A Gen take", ago: 4 * MIN, fileToProject: true });
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
  await expect(rows.locator(".vr-job-name")).toHaveText("Unboxing the trail runner on a kitchen counter");
  await expect.poll(() => posts.some((p) => p.action === "status" && p.id === remembered.id)).toBe(true);
  await expect(page.getByText("The ad this device submitted last")).toHaveCount(0);
  await expect(rows.locator(".gx-resumed-state")).toHaveText("Rendering · 25 min");
  await noOverflow(page);
  await shoot(page, info.project.name, "ads-earlier", "ads-earlier");

  done = true;
  await page.clock.fastForward("00:10");
  await expect(rows.locator(".gx-resumed-state")).toHaveText("Complete");
  await expect(page.getByTestId("toast")).toHaveText("An ad from earlier rendered and is in your takes.");
  if (phone) {
    await thumbSized(page, "Open Takes", "ads-earlier");
    await thumbSized(page, "Dismiss Unboxing the trail runner on a kitchen counter", "ads-earlier");
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
  await rows.getByRole("button", { name: "Open Takes" }).click();
  await expect(page.getByTestId("page-title")).toHaveText("Takes");
  expect(posts.filter((p) => p.action === "status").every((p) => p.id === ad.id || p.id === remembered.id)).toBe(true);
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
