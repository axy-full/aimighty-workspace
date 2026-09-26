import { mkdirSync } from "node:fs";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { PHONE, forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, upload, type LibraryRoute } from "./helpers/workspaceFixtures";
import type { Generation } from "../lib/jobs";

/**
 * Viral's Recent and History show real runs only (idea 17), in the browser:
 * every state in words, runs sent before the page opened are read until they
 * land (at the account's pace; a run that cannot move on its own is left for
 * Check again), a landed run re-reads the Library, older runs page in by
 * cursor, Recent lists its own page's variant, and Send to Edit opens that
 * very result in Takes — paging the Library back to it — in view. The
 * connected account is mocked at its route; nothing here is priced or sent.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const SHOT_SIZES: Record<string, string> = { "workbench-1440x900": "1440x900", "workbench-390x844": "390x844" };
/* Review screenshots are written only when VIRAL_SHOTS names a folder; CI takes none. */
const SHOTS = process.env.VIRAL_SHOTS;
const fixture = (): Project => ({ ...newProject("Harbour dusk study"), id: "ws-runs", productionProjectId: "prod-ws", shotMappings: {} });
const WALLET = "1f2e3d4c-5b6a-4798-8a9b-0c1d2e3f4a5b";
const GEN = "gen_hfc_" + "b".repeat(40);
const OLD_GEN = "gen_hfc_" + "c".repeat(40);
const uuid = (n: number) => `44444444-4444-4444-8444-${String(n).padStart(12, "0")}`;
type Job = Record<string, unknown> & { id: string; status: string; createdAt: number };

function run(n: number, status: string, variant: "motion-transfer" | "object-swap", extra: Record<string, unknown> = {}): Job {
  return {
    id: uuid(n), draftId: "ws-runs", status, input: { variant, resolution: "720p", prompt: "", source: { uploadId: "up_src" }, references: [{ uploadId: "up_ref" }] },
    workspaceId: WALLET, workspaceName: "Fixture wallet", quoteCredits: 18, creditUnit: "higgsfield_credits", quoteExpiresAt: 0,
    createdAt: Date.now() - n * 60_000, providerJobId: status === "dispatching" ? null : uuid(900 + n), ...extra,
  };
}
const landed = (gen: string) => ({ originalAvailable: true, originalAvailability: "available", result: { original: { generationId: gen, asset: { generationId: gen, url: `/api/media/${gen}`, kind: "video", mime: "video/mp4" } } } });

const withPrompt = (job: Job, prompt: string): Job => ({ ...job, input: { ...(job.input as object), prompt } });

type Options = { page1?: Job[]; page2?: Job[]; failFirstRead?: boolean; slowFirstReadMs?: number; generations?: Generation[]; pageSize?: number; gone?: string[] };
async function open(page: Page, sp: "motion" | "swap" | "history", options: Options = {}) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  const library: LibraryRoute = {
    uploads: [upload({ id: "up_src", filename: "walk.mp4", mime: "video/mp4", kind: "video", durationS: 12 }), upload({ id: "up_ref", filename: "mira.png", mime: "image/png" })],
    generations: options.generations ?? [generation({ id: "gen_still", title: "Dunes still", prompt: "dunes" })],
    pageSize: options.pageSize,
  };
  await mockLibrary(page, library);
  const generationReads: number[] = [], generationCursors: (string | null)[] = [];
  page.on("request", (request) => {
    if (!request.url().includes("/api/workbench/library") || !request.url().includes("source=generations")) return;
    generationReads.push(Date.now());
    generationCursors.push(new URL(request.url()).searchParams.get("cursor"));
  });
  const me = await page.request.get("/api/me").then((r) => r.json());
  await page.route("**/api/me", (route) => route.fulfill({ json: { ...me, owner: true } }));

  const page1 = [...(options.page1 ?? [])], page2 = [...(options.page2 ?? [])];
  const cursor = page2.length && page1.length ? `${page1.at(-1)!.createdAt}.${page1.at(-1)!.id}` : null;
  const reads: (string | null)[] = [], variants: (string | null)[] = [], polls: string[] = [];
  let failing = Boolean(options.failFirstRead), slow = options.slowFirstReadMs ?? 0, readsAtLanding = -1;
  const statusCalls = new Map<string, number>();
  await page.route("**/api/higgsfield/consumer/genjutsu**", async (route) => {
    const req = route.request();
    if (req.method() === "GET") {
      const query = new URL(req.url()).searchParams, at = query.get("cursor"), variant = query.get("variant");
      reads.push(at); variants.push(variant);
      if (slow) { const wait = slow; slow = 0; await new Promise((resolve) => setTimeout(resolve, wait)); }
      /* Viral reads the route's runs view; the saved-jobs list (quotes included) is for the surfaces that price from it. */
      if (query.get("view") !== "runs") return route.fulfill({ status: 400, json: { error: "Choose a valid page of runs." } });
      if (failing) return route.fulfill({ status: 503, json: { error: "The connected account could not be read." } });
      const base = { connection: { connected: true, requiresReconnect: false }, capabilities: { resolutions: ["480p", "720p", "1080p"], minSeconds: 4, maxSeconds: 30, maxImages: 30, maxMediaBytes: 52428800 } };
      /* The route narrows to one variant when asked (Recent beside a composer). */
      const kind = (jobs: Job[]) => jobs.filter((j) => !variant || (j.input as { variant: string }).variant === variant);
      if (at === null) return route.fulfill({ json: { ...base, jobs: kind(page1), nextCursor: variant ? null : cursor } });
      if (at === cursor) return route.fulfill({ json: { ...base, jobs: kind(page2), nextCursor: null } });
      return route.fulfill({ status: 400, json: { error: "Choose a valid page of runs." } });
    }
    const body = req.postDataJSON() as { action: string; id: string };
    if (body.action !== "status") return route.fulfill({ status: 409, json: { error: "Nothing is priced or sent in this spec." } });
    polls.push(body.id);
    const calls = (statusCalls.get(body.id) ?? 0) + 1;
    statusCalls.set(body.id, calls);
    const i = page1.findIndex((j) => j.id === body.id);
    if (i < 0 || options.gone?.includes(body.id)) return route.fulfill({ status: 404, json: { error: "This transform job is not available." } });
    /* The first run in flight lands on its second read; the account files the result to the project. */
    if (i === 0 && page1[0].status === "accepted" && calls >= 2) {
      page1[0] = { ...page1[0], status: "completed", ...landed(GEN) };
      library.generations.push(generation({ id: GEN, title: "Harbour motion", kind: "video", model: "genjutsu" }));
      readsAtLanding = generationReads.length;
    }
    return route.fulfill({ json: { job: page1[i], pollAfterSeconds: 15 } });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/suites?suite=subatomik&page=${sp}&sp=${sp}`);
  await expect(page.getByTestId("project-name")).toHaveText("Harbour dusk study");
  return { errors, reads, variants, polls, cursor, generationReads, generationCursors, readsAtLanding: () => readsAtLanding, recover: () => { failing = false; } };
}

/** Nothing scrolls sideways: not the page, not the surface, not a card inside it. */
async function noOverflow(page: Page, scope: string) {
  const problems = await page.getByTestId(scope).evaluate((root) => {
    const out: string[] = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) out.push(`document ${document.documentElement.scrollWidth} > ${innerWidth}`);
    if (root.scrollWidth > root.clientWidth + 1) out.push(`${root.dataset.testid} ${root.scrollWidth} > ${root.clientWidth}`);
    const box = root.getBoundingClientRect();
    for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-testid]"))) {
      const r = el.getBoundingClientRect();
      if (r.width && (r.left < box.left - 1 || r.right > box.right + 1)) out.push(`${el.dataset.testid} ${r.left}–${r.right} outside ${box.left}–${box.right}`);
    }
    return out;
  });
  expect(problems).toEqual([]);
}

async function snap(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** The screen with this part of it in the middle, clear of the dock. */
async function shot(page: Page, target: Locator, name: string) {
  await target.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await snap(page, name);
}

async function phoneTargets(page: Page, scope: string) {
  const small = await page.getByTestId(scope).locator("button:visible").evaluateAll((buttons) =>
    buttons.map((b) => ({ label: b.textContent?.trim() ?? "", h: b.getBoundingClientRect().height })).filter((b) => b.h > 0 && Math.round(b.h * 100) / 100 < 44));
  expect(small).toEqual([]);
}

test("History shows runs in words, reads the one still rendering until it lands, pages older runs in, and Send to Edit opens it in Takes", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const rendering = run(1, "accepted", "motion-transfer");
  const checking = run(2, "uncertain", "object-swap");
  const failed = run(3, "failed", "object-swap");
  const older = run(40, "completed", "motion-transfer", landed(OLD_GEN));
  const f = await open(page, "history", { page1: [rendering, checking, failed], page2: [older] });

  const view = page.getByTestId("history-view");
  await expect(view).toBeVisible();
  const cards = view.getByTestId("history-run");
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0).getByTestId("history-run-status")).toHaveText("Rendering");
  await expect(cards.nth(1).getByTestId("history-run-status")).toHaveText("Checking");
  await expect(cards.nth(2).getByTestId("history-run-status")).toHaveText("Failed · not billed");
  await expect(cards.nth(2).getByRole("button", { name: "Recreate" })).toBeVisible();
  /* What a state means is on the card, not in a tooltip; each card says what sets it apart. */
  await expect(cards.nth(1).getByTestId("history-run-note")).toHaveText("Confirming · never sent twice");
  await expect(cards.nth(0)).toContainText("1 ref");
  /* Never the raw status codes. */
  for (const raw of ["accepted", "uncertain", "quoted", "dispatching"]) await expect(view).not.toContainText(raw);
  if (SHOT_SIZES[info.project.name]) await snap(page, `history-in-flight-${SHOT_SIZES[info.project.name]}`);

  /* Nothing was submitted here: the run was already in flight, and the page reads it until it lands. */
  const result = view.getByTestId("history-result");
  await expect(result).toHaveCount(1, { timeout: 30_000 });
  await expect(result).toContainText("Motion Transfer · 720p");
  await expect(result).toContainText(/18 cr settled · \d+ min ago/);
  await expect(view.getByTestId("history-run")).toHaveCount(2);
  expect(f.polls).toContain(checking.id);
  /* The landed run re-reads the Library once, so Takes has it without a reload. */
  expect(f.readsAtLanding()).toBeGreaterThan(0);
  await expect.poll(() => f.generationReads.length).toBeGreaterThan(f.readsAtLanding());

  /* Older runs page in by the cursor the first page ended on. */
  const more = view.getByTestId("history-more");
  await expect(more).toHaveText("Load older runs");
  await more.click();
  await expect(result).toHaveCount(2);
  await expect(more).toHaveCount(0);
  expect(f.reads).toContain(f.cursor);

  await noOverflow(page, "history-view");
  if (PHONE.includes(info.project.name)) await phoneTargets(page, "history-view");
  if (SHOT_SIZES[info.project.name]) await snap(page, `history-landed-${SHOT_SIZES[info.project.name]}`);

  await result.first().getByRole("button", { name: "Send to Edit" }).click();
  await expect(page.getByTestId("page-title")).toHaveText("Takes");
  await expect(page.getByTestId("edit-takes").locator('[data-testid="edit-take"][aria-checked="true"]')).toContainText("Harbour motion");
  await expect(page.locator("[data-section='edit-panel']")).toContainText("Selected · Harbour motion");
  expect(f.errors).toEqual([]);
});

/** The top of an element sits inside the viewport. */
async function inView(page: Page, selector: string) {
  const box = await page.locator(selector).first().boundingBox();
  const height = page.viewportSize()!.height;
  expect(box, selector).not.toBeNull();
  expect(box!.y, `${selector} top`).toBeGreaterThanOrEqual(0);
  expect(box!.y, `${selector} top`).toBeLessThan(height - 40);
}

test("Send to Edit on an older run pages the Library back to that run's take and opens it — that take, in view", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  /* A busy project: seventy newer stills, then the older run's original — filed at its run's own time, on the Library's second page. */
  const older = run(90, "completed", "motion-transfer", landed(GEN));
  const stills = Array.from({ length: 70 }, (_, i) => generation({ id: `gen_newer_${String(i + 1).padStart(2, "0")}`, title: `Newer still ${i + 1}`, createdAt: Date.now() - (i + 1) * 1000 }));
  const original = generation({ id: GEN, title: "Harbour motion", kind: "video", model: "genjutsu", createdAt: older.createdAt });
  const f = await open(page, "history", { page1: [withPrompt(older, "Recast on the harbour wall")], generations: [...stills, original] });

  const card = page.getByTestId("history-result");
  await expect(card).toContainText("1 ref · Recast on the harbour wall");
  await card.getByRole("button", { name: "Send to Edit" }).click();
  await expect(page.getByTestId("page-title")).toHaveText("Takes");
  /* The take sent — not the newest still — is the one selected and edited. */
  await expect(page.getByTestId("edit-takes").locator('[data-testid="edit-take"][aria-checked="true"]')).toHaveText(/Harbour motion/);
  await expect(page.locator("[data-section='edit-panel']")).toContainText("Selected · Harbour motion");
  await expect(page.getByTestId("edit-image")).toHaveCount(0);
  expect(f.generationCursors).toContain("60");
  await expect(page.getByText("This asset is no longer in the project.")).toHaveCount(0);
  /* And the page opens at it, not at the top of seventy stills. */
  await expect.poll(async () => (await page.locator("[data-section='edit-panel']").boundingBox())?.y ?? -1).toBeGreaterThanOrEqual(0);
  await inView(page, "[data-section='edit-panel']");
  if (SHOT_SIZES[info.project.name]) await snap(page, `send-older-${SHOT_SIZES[info.project.name]}`);
  expect(f.errors).toEqual([]);
});

test("History says what it cannot show: an archived or unavailable original, a run that cannot move on its own, one the account no longer has", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const queued = run(1, "dispatching", "motion-transfer");
  const gone = run(2, "accepted", "object-swap");
  const archived = run(3, "completed", "motion-transfer", { originalAvailable: false, originalAvailability: "deleted", result: { original: { generationId: OLD_GEN } } });
  const unavailable = run(4, "completed", "object-swap", { originalAvailable: false, originalAvailability: "unavailable", result: { original: { generationId: OLD_GEN } } });
  const f = await open(page, "history", { page1: [queued, gone, archived, unavailable], gone: [gone.id] });
  const view = page.getByTestId("history-view");
  const results = view.getByTestId("history-result");
  await expect(results.nth(0).getByTestId("history-run-status")).toHaveText("Archived");
  await expect(results.nth(1).getByTestId("history-run-status")).toHaveText("Original unavailable");
  for (const i of [0, 1]) {
    await expect(results.nth(i).getByRole("button", { name: "Send to Edit" })).toBeDisabled();
    await expect(results.nth(i).getByRole("button", { name: "Compare" })).toBeDisabled();
    await expect(results.nth(i).getByRole("button", { name: "Recreate" })).toBeEnabled();
  }
  await expect(view).not.toContainText("RETAINED");

  /* A queued run the account never acknowledged is read a few times, then left for the person; one the account no longer has stops at once. */
  const runs = view.getByTestId("history-run");
  await expect(runs.nth(0).getByTestId("history-run-note")).toHaveText("Sending to the account");
  await expect(runs.nth(1).getByRole("button", { name: "Check again" })).toBeVisible({ timeout: 20_000 });
  await expect(runs.nth(1).getByTestId("history-run-note")).toHaveText("Could not be read");
  /* Why, in the words Gen and Business use for a read that would fail the same way every time. */
  await expect(runs.nth(1).getByTestId("history-run-problem")).toHaveText("This job can no longer be checked from here.");
  await expect(runs.nth(0).getByTestId("history-run-problem")).toHaveCount(0);
  await expect(runs.nth(0).getByTestId("history-run-note")).toHaveText("Not confirmed yet · never sent twice", { timeout: 40_000 });
  await expect(runs.nth(0).getByRole("button", { name: "Check again" })).toBeVisible();
  const count = (id: string) => f.polls.filter((p) => p === id).length;
  expect(count(queued.id)).toBe(3);
  expect(count(gone.id)).toBe(1);
  await page.waitForTimeout(9_000);
  expect(count(queued.id)).toBe(3);
  expect(count(gone.id)).toBe(1);
  if (PHONE.includes(info.project.name)) await phoneTargets(page, "history-view");
  await noOverflow(page, "history-view");
  if (SHOT_SIZES[info.project.name]) await snap(page, `history-stalled-${SHOT_SIZES[info.project.name]}`);
  /* Check again reads it again. */
  await runs.nth(0).getByRole("button", { name: "Check again" }).click();
  await expect(runs.nth(0).getByTestId("history-run-note")).toHaveText("Sending to the account");
  await expect.poll(() => count(queued.id), { timeout: 10_000 }).toBe(4);
  expect(f.errors).toEqual([]);
});

test("Recent beside the composer: a read that fails says so and retries; each page lists its own variant in words and lands runs in flight", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const f = await open(page, "motion", { page1: [withPrompt(run(1, "accepted", "motion-transfer"), "Recast on the harbour wall"), run(2, "uncertain", "object-swap"), run(3, "failed", "object-swap")], failFirstRead: true, slowFirstReadMs: 2500 });
  const recent = page.getByTestId("viral-recent");
  /* The composer says what is really in the way: the account being read, then that it could not be — never a connect hint it may not need. */
  const reason = page.getByTestId("viral-reason");
  await expect(reason).toHaveText("Reading the connected account…");
  await expect(recent.getByTestId("viral-list-error")).toContainText("The connected account could not be read.");
  await expect(reason).toHaveText("The connected account could not be read.");
  await expect(page.getByTestId("viral-view")).not.toContainText("Connect the account");
  if (SHOT_SIZES[info.project.name]) await shot(page, reason, `motion-unread-${SHOT_SIZES[info.project.name]}`);
  f.recover();
  await page.getByTestId("viral-reason-retry").click();
  const rows = recent.getByTestId("viral-run");
  await expect(rows).toHaveCount(1);
  await expect(reason).toHaveText("Add one source video (4–30 s).");
  /* Recent asks the route for this page's variant only. */
  expect(f.variants.at(-1)).toBe("motion-transfer");
  await expect(rows.first()).toContainText("Recast on the harbour wall");
  await expect(rows.first()).toContainText("720p · 1 ref");
  await expect(rows.first().getByTestId("viral-run-status")).toHaveText("Rendering");
  await expect(rows.first()).toContainText("18 cr");
  await expect(recent.getByTestId("viral-list-error")).toHaveCount(0);
  /* Read until it lands, with nothing pressed. */
  await expect(rows.first().getByTestId("viral-run-status")).toHaveText("Done", { timeout: 30_000 });
  if (PHONE.includes(info.project.name)) await phoneTargets(page, "viral-recent");
  if (SHOT_SIZES[info.project.name]) await shot(page, recent, `recent-motion-${SHOT_SIZES[info.project.name]}`);

  await page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: /Object Swap/ }).click();
  await expect(page.getByTestId("viral-view")).toHaveAttribute("data-page", "swap");
  const swap = page.getByTestId("viral-recent").getByTestId("viral-run-status");
  await expect(swap).toHaveText(["Checking", "Failed · not billed"]);
  await noOverflow(page, "viral-recent");

  /* A finished row is a way into Takes. */
  await page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: /Motion Transfer/ }).click();
  const toTakes = page.getByTestId("viral-recent").getByTestId("viral-run-open");
  await expect(toTakes).toHaveText("Open in Takes");
  if (PHONE.includes(info.project.name)) await phoneTargets(page, "viral-recent");
  await toTakes.click();
  await expect(page.getByTestId("page-title")).toHaveText("Takes");
  await expect(page.getByTestId("edit-takes").locator('[data-testid="edit-take"][aria-checked="true"]')).toContainText("Harbour motion");
  expect(f.errors).toEqual([]);
});

test("With no runs yet, History says so and starts one; Recent says which variant has none", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const f = await open(page, "history", { page1: [] });
  const empty = page.getByTestId("history-empty");
  await expect(empty).toContainText("No runs in this project yet.");
  await expect(page.getByTestId("history-more")).toHaveCount(0);
  if (PHONE.includes(info.project.name)) await phoneTargets(page, "history-view");
  if (SHOT_SIZES[info.project.name]) await snap(page, `history-empty-${SHOT_SIZES[info.project.name]}`);
  await empty.getByRole("button", { name: "Object Swap" }).click();
  await expect(page.getByTestId("viral-view")).toHaveAttribute("data-page", "swap");
  await expect(page.getByTestId("viral-recent-empty")).toHaveText("No Object Swap runs yet.");
  expect(f.polls).toEqual([]);
  expect(f.errors).toEqual([]);
});

test("the real route: the runs view pages runs by cursor; the saved-jobs list is unchanged", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one server check is enough");
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json()) as { id: string; owner?: boolean; workspace: { id: string } };
  const headers = { "X-Workbench-Scope": `particl-active-${me.workspace.id}-${me.id}` };
  const base = "/api/higgsfield/consumer/genjutsu?draftId=ws-runs-real";
  const runs = await page.request.get(`${base}&view=runs`, { headers });
  expect(runs.status(), await runs.text()).toBe(200);
  expect(await runs.json()).toMatchObject({ jobs: [], nextCursor: null, connection: { connected: false } });
  const saved = await page.request.get(base, { headers });
  expect(saved.status()).toBe(200);
  const body = await saved.json();
  expect(body.jobs).toEqual([]);
  expect(body).not.toHaveProperty("nextCursor");
  const swaps = await page.request.get(`${base}&view=runs&variant=object-swap`, { headers });
  expect(swaps.status(), await swaps.text()).toBe(200);
  expect(await swaps.json()).toMatchObject({ jobs: [], nextCursor: null });
  for (const query of ["&view=runs&cursor=nope", "&cursor=1700000000000.abc", "&view=everything", "&variant=object-swap", "&view=runs&variant=lip-sync"])
    expect((await page.request.get(`${base}${query}`, { headers })).status(), query).toBe(400);
});
