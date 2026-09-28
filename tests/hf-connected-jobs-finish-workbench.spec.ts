import { test, expect, type Page, type Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, type LibraryRoute } from "./helpers/workspaceFixtures";

/**
 * Connected-account jobs finish after the page is left — and after the
 * Higgsfield sign-in was retired (lib/higgsfield-consumer/retired.ts), which
 * is how jobs already running drain. The shell's collector lists the open
 * project's saved jobs and reads each sent one with the same status read the
 * composer used (never a quote, never a submit) until it settles, and
 * announces it once. Opening Gen later shows the jobs Gen made from what the
 * collector has — their state in one word with its age, a problem named
 * plainly, a finished take moved into Takes — and asks nothing itself. (The
 * Ads and Motion Transfer pages that showed theirs are the retired card now;
 * their results land in Takes the same way.) Every account reply here is a
 * route mock; nothing is paid for.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const SHOTS: Record<string, string> = Object.fromEntries(SIZES.map((name) => [name, name.replace("workbench-", "")]));
const WALLET = "1f2e3d4c-5b6a-4798-8a9b-0c1d2e3f4a5b";
const MIN = 60_000;
const DRAFT = "ws-jobs";
/* The collector's pace (lib/shell/connected-collector.ts): 20 s, then 1.5x longer while a job is unchanged, up to a minute,
   ±20% — so a read is never more than 72 s after the one before; a few reads for a job the account has not accepted. */
const NEXT_READ = "01:13";
/* After failed reads it waits a minute, doubling up to five (±20%): six minutes reach the next read. */
const NEXT_READ_AFTER_FAILURES = "06:01";
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

/**
 * The collector reads the jobs one after another and times each one's next read from its own answer, so a clock
 * jump that lands while a read is still out skips that job at the jump and leaves it a read behind the rest. This
 * counts the status reads the page has sent and not yet taken in (answered, body read); the returned wait holds a
 * jump until none is out.
 */
async function countStatusReads(page: Page) {
  await page.addInitScript(() => {
    let out = 0;
    Object.defineProperty(window, "__statusReadsOut", { get: () => out });
    const send = window.fetch.bind(window);
    /* Queued ahead of the reader's own continuation, which sets the job's next read in that same turn. */
    const settle = () => queueMicrotask(() => { out -= 1; });
    window.fetch = async (input, init) => {
      if (init?.method !== "POST" || !String(input).includes("/api/higgsfield/consumer/generation") || !String(init.body).includes('"action":"status"')) return send(input, init);
      out += 1;
      let response: Response;
      try { response = await send(input, init); } catch (error) { settle(); throw error; }
      const json = response.json.bind(response);
      response.json = () => json().finally(settle);
      return response;
    };
  });
  return () => expect.poll(() => page.evaluate(() => (window as typeof window & { __statusReadsOut: number }).__statusReadsOut)).toBe(0);
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
  const readsTakenIn = await countStatusReads(page);
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
  await expect(card("Rain on the quay").getByRole("status")).toHaveText("Could not check this take. Checking again shortly.");
  /* A take from an earlier account connection cannot be checked: said once, never asked again, dismissable. */
  await expect(card("Fog rolling").locator(".gx-asset-meta")).toHaveText("Can't be checked");
  await expect(card("Fog rolling").getByRole("status")).toHaveText("Started on an earlier account connection, so it can't be checked from here.");
  /* No invented progress: the same solid ring as the composer's own run. */
  expect(await card("A slow dolly").locator(".gx-ring").evaluate((el) => getComputedStyle(el).backgroundImage)).toBe("none");

  /* A job the account has not confirmed is read a few times, then left as it is: said so, with Dismiss. */
  await expect.poll(() => reads(unconfirmed)).toBe(1);
  for (let read = 2; read <= UNSETTLED_READS; read++) {
    await readsTakenIn();
    await page.clock.fastForward(NEXT_READ);
    await expect.poll(() => [reads(unconfirmed), reads(setAside)]).toEqual([read, read]);
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
  await readsTakenIn();
  await page.clock.fastForward("02:00");
  await readsTakenIn();
  await page.clock.fastForward(NEXT_READ);
  expect(reads(earlier)).toBe(1);
  expect(reads(unconfirmed)).toBe(UNSETTLED_READS);
  expect(reads(setAside)).toBe(UNSETTLED_READS);
  expect(reads(priced)).toBe(0);

  /* The account finishes the rendering take: announced once, gone from the cards, in the results. */
  await readsTakenIn();
  rendered = true;
  library.generations = [generation({ id: GEN, kind: "video", title: "Harbour at dusk", prompt: "A slow dolly push across the wet harbour", projectId: "prod-ws" })];
  await page.clock.fastForward(NEXT_READ);
  await expect(page.getByTestId("toast")).toHaveText("Seedance 2.5 rendered on the connected account. It is in Takes.");
  await expect(cards).toHaveCount(4);
  /* The landed take is a result card (components/graphite/TakeTile.tsx), no longer a picked-up one. */
  await expect(page.getByTestId("gen-view").locator(".gx-gen-grid").getByTestId("take-tile")).toHaveCount(1);
  await readsTakenIn();
  /* Then the unconfirmed one settles as failed: said so, not billed, dismissable. */
  confirmed = true;
  await page.clock.fastForward(NEXT_READ_AFTER_FAILURES);
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

test("the jump to the takes still rendering reaches them past a long, windowed results grid", async ({ page }, info) => {
  test.skip(!PHONES.includes(info.project.name), "the jump is on narrow screens; wider, the results sit beside the composer");
  /* virtual-core holds back its scroll corrections while an iOS page scrolls, and takes a Mac with touch points for an
     iPad; CI's Linux browsers correct at once. This puts a local run on CI's path. */
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "Linux x86_64", configurable: true }));
  const library: LibraryRoute = { uploads: [], pageSize: 200, generations: Array.from({ length: 150 }, (_, i) => generation({ id: `gen_hfc_long_${i}`, title: `Still ${i + 1}` })) };
  const errors = await base(page, library);
  const rendering = connected(1, { status: "accepted", model: "seedance_2_5", name: "Seedance 2.5", prompt: "A slow dolly push across the wet harbour at blue hour", ago: 12 * MIN, composer: "gen" });
  await mockGeneration(page, [rendering], () => ({ json: { job: rendering, pollAfterSeconds: 60 } }));
  await page.goto("/suites?view=gen");
  await expect(page.getByTestId("project-name")).toHaveText("Harbour night shoot");
  /* A long project: the results are windowed, and the take still out sits at their head, under the composer. */
  await expect(page.locator(".gx-gen-grid")).toHaveAttribute("data-virtual", "on");
  const card = page.getByTestId("gen-resumed");
  await expect(card).toHaveCount(1);
  await expect(card).not.toBeInViewport();
  await page.getByTestId("gen-resumed-jump").click();
  await expect(card).toBeInViewport();
  await noOverflow(page);
  expect(errors).toEqual([]);
});
