import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { PHONE, forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, upload, type LibraryRoute } from "./helpers/workspaceFixtures";

/**
 * Viral's Recent and History show real runs only (idea 17), in the browser:
 * every state in words, runs sent before the page opened are read until they
 * land, a landed run re-reads the Library, older runs page in by cursor, and
 * Send to Edit opens the result in Takes. The connected account is mocked at
 * its route; nothing here is priced or sent.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const SHOT_SIZES: Record<string, string> = { "workbench-1440x900": "1440x900", "workbench-390x844": "390x844" };
const SHOTS = "/private/tmp/particl-suites/hf-connected/shots";
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

type Options = { page1?: Job[]; page2?: Job[]; failFirstRead?: boolean };
async function open(page: Page, sp: "motion" | "swap" | "history", options: Options = {}) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  const library: LibraryRoute = {
    uploads: [upload({ id: "up_src", filename: "walk.mp4", mime: "video/mp4", kind: "video", durationS: 12 }), upload({ id: "up_ref", filename: "mira.png", mime: "image/png" })],
    generations: [generation({ id: "gen_still", title: "Dunes still", prompt: "dunes" })],
  };
  await mockLibrary(page, library);
  const generationReads: number[] = [];
  page.on("request", (request) => { if (request.url().includes("/api/workbench/library") && request.url().includes("source=generations")) generationReads.push(Date.now()); });
  const me = await page.request.get("/api/me").then((r) => r.json());
  await page.route("**/api/me", (route) => route.fulfill({ json: { ...me, owner: true } }));

  const page1 = [...(options.page1 ?? [])], page2 = [...(options.page2 ?? [])];
  const cursor = page2.length && page1.length ? `${page1.at(-1)!.createdAt}.${page1.at(-1)!.id}` : null;
  const reads: (string | null)[] = [], polls: string[] = [];
  let failing = Boolean(options.failFirstRead), readsAtLanding = -1;
  const statusCalls = new Map<string, number>();
  await page.route("**/api/higgsfield/consumer/genjutsu**", async (route) => {
    const req = route.request();
    if (req.method() === "GET") {
      const query = new URL(req.url()).searchParams, at = query.get("cursor");
      reads.push(at);
      /* Viral reads the route's runs view; the saved-jobs list (quotes included) is for the surfaces that price from it. */
      if (query.get("view") !== "runs") return route.fulfill({ status: 400, json: { error: "Choose a valid page of runs." } });
      if (failing) return route.fulfill({ status: 503, json: { error: "The connected account could not be read." } });
      const base = { connection: { connected: true, requiresReconnect: false }, capabilities: { resolutions: ["480p", "720p", "1080p"], minSeconds: 4, maxSeconds: 30, maxImages: 30, maxMediaBytes: 52428800 } };
      if (at === null) return route.fulfill({ json: { ...base, jobs: page1, nextCursor: cursor } });
      if (at === cursor) return route.fulfill({ json: { ...base, jobs: page2, nextCursor: null } });
      return route.fulfill({ status: 400, json: { error: "Choose a valid page of runs." } });
    }
    const body = req.postDataJSON() as { action: string; id: string };
    if (body.action !== "status") return route.fulfill({ status: 409, json: { error: "Nothing is priced or sent in this spec." } });
    polls.push(body.id);
    const calls = (statusCalls.get(body.id) ?? 0) + 1;
    statusCalls.set(body.id, calls);
    const i = page1.findIndex((j) => j.id === body.id);
    if (i < 0) return route.fulfill({ status: 404, json: { error: "This transform job is not available." } });
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
  return { errors, reads, polls, cursor, generationReads, readsAtLanding: () => readsAtLanding, recover: () => { failing = false; } };
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

async function phoneTargets(page: Page, scope: string) {
  const small = await page.getByTestId(scope).locator("button:visible").evaluateAll((buttons) =>
    buttons.map((b) => ({ label: b.textContent?.trim() ?? "", h: b.getBoundingClientRect().height })).filter((b) => b.h > 0 && b.h < 44));
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
  /* Never the raw status codes. */
  for (const raw of ["accepted", "uncertain", "quoted", "dispatching"]) await expect(view).not.toContainText(raw);
  if (SHOT_SIZES[info.project.name]) await page.screenshot({ path: `${SHOTS}/history-in-flight-${SHOT_SIZES[info.project.name]}.png` });

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
  if (SHOT_SIZES[info.project.name]) await page.screenshot({ path: `${SHOTS}/history-landed-${SHOT_SIZES[info.project.name]}.png` });

  await result.first().getByRole("button", { name: "Send to Edit" }).click();
  await expect(page.getByTestId("page-title")).toHaveText("Takes");
  await expect(page.getByTestId("edit-takes").locator('[data-testid="edit-take"][aria-checked="true"]')).toContainText("Harbour motion");
  expect(f.errors).toEqual([]);
});

test("Recent beside the composer: a read that fails says so and retries; each page lists its own variant in words and lands runs in flight", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const f = await open(page, "motion", { page1: [run(1, "accepted", "motion-transfer"), run(2, "uncertain", "object-swap"), run(3, "failed", "object-swap")], failFirstRead: true });
  const recent = page.getByTestId("viral-recent");
  await expect(recent.getByTestId("viral-list-error")).toContainText("The connected account could not be read.");
  f.recover();
  await recent.getByRole("button", { name: "Try again" }).click();
  const rows = recent.getByTestId("viral-run");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("720p · 1 ref");
  await expect(rows.first().getByTestId("viral-run-status")).toHaveText("Rendering");
  await expect(rows.first()).toContainText("18 cr");
  await expect(recent.getByTestId("viral-list-error")).toHaveCount(0);
  /* Read until it lands, with nothing pressed. */
  await expect(rows.first().getByTestId("viral-run-status")).toHaveText("Done", { timeout: 30_000 });
  if (PHONE.includes(info.project.name)) await phoneTargets(page, "viral-recent");
  if (SHOT_SIZES[info.project.name]) await page.screenshot({ path: `${SHOTS}/recent-motion-${SHOT_SIZES[info.project.name]}.png` });

  await page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: /Object Swap/ }).click();
  await expect(page.getByTestId("viral-view")).toHaveAttribute("data-page", "swap");
  const swap = page.getByTestId("viral-recent").getByTestId("viral-run-status");
  await expect(swap).toHaveText(["Checking", "Failed · not billed"]);
  await noOverflow(page, "viral-recent");
  expect(f.errors).toEqual([]);
});

test("With no runs yet, History says so and starts one; Recent says which variant has none", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const f = await open(page, "history", { page1: [] });
  const empty = page.getByTestId("history-empty");
  await expect(empty).toContainText("No runs in this project yet.");
  await expect(page.getByTestId("history-more")).toHaveCount(0);
  if (PHONE.includes(info.project.name)) await phoneTargets(page, "history-view");
  if (SHOT_SIZES[info.project.name]) await page.screenshot({ path: `${SHOTS}/history-empty-${SHOT_SIZES[info.project.name]}.png` });
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
  for (const query of ["&view=runs&cursor=nope", "&cursor=1700000000000.abc", "&view=everything"])
    expect((await page.request.get(`${base}${query}`, { headers })).status(), query).toBe(400);
});
