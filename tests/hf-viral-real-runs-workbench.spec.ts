import { mkdirSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { PHONE, forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, upload, type LibraryRoute } from "./helpers/workspaceFixtures";
import type { Generation } from "../lib/jobs";
import { smallTargets } from "./phoneFloors";

/**
 * Viral's Recent and History show real runs only (idea 17), read from the
 * project's Library alone: the transform takes on Particl's API key, in words
 * (Queued · Rendering · Held · Failed · not billed · Done), a failed take's
 * line saying what became of its charge (lib/errors.ts failureLine), and the runs made
 * earlier on the owner's connected account, which the Library keeps once
 * collected (read-only). A take in flight lands without a reload, older takes
 * page in by the Library's own cursor, Recent lists its own page's variant,
 * Send to Edit opens that very take in Takes, Recreate says what the key
 * cannot carry, and Cancel asks the route. Nothing asks the connected
 * account's Viral route. The Library and the cancel route are answered here;
 * nothing is priced or sent.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const SHOT_SIZES: Record<string, string> = { "workbench-1440x900": "1440x900", "workbench-390x844": "390x844" };
/* Review screenshots are written only when VIRAL_SHOTS names a folder; CI takes none. */
const SHOTS = process.env.VIRAL_SHOTS;
const fixture = (): Project => ({ ...newProject("Harbour dusk study"), id: "ws-runs", productionProjectId: "prod-ws", shotMappings: {} });
const MOTION = "higgsfield-genjutsu-motion-transfer", SWAP = "higgsfield-genjutsu-object-swap";
const MIN = 60_000;
const uploads = [upload({ id: "up_src", filename: "walk.mp4", mime: "video/mp4", kind: "video", durationS: 12 }), upload({ id: "up_ref", filename: "wren.png", mime: "image/png" }),
  ...Array.from({ length: 12 }, (_, i) => upload({ id: `up_r${i}`, filename: `still-${i}.png`, mime: "image/png" }))];
const keyParams = (resolution = "720p", extra: Record<string, unknown> = {}) => ({
  resolution, rawPrompt: "", sourceUploadId: "up_src", workbenchProjectId: "ws-runs",
  references: [{ uploadId: "up_src", kind: "video", role: "reference_video" }, { uploadId: "up_ref", kind: "image", role: "reference_image" }], ...extra,
});
/** A transform take on the key, as admission files it. */
const take = (id: string, status: string, minutesAgo: number, fields: Partial<Generation> = {}) => generation({
  id, kind: "video", model: MOTION, task: "genjutsu", provider: "higgsfield", title: id, prompt: "", params: keyParams(), status,
  storedUrl: status === "succeeded" ? `/api/media/${id}` : null, createdAt: Date.now() - minutesAgo * MIN, ...fields,
});
/** A run made earlier on the connected account, as the Library keeps it once collected. */
const earlier = (id: string, minutesAgo: number, refs = 1) => generation({
  id, kind: "video", model: "hf_mult_replace_object", provider: "higgsfield", title: "Swapped bottle", prompt: "swap the bottle", status: "succeeded", storedUrl: `/api/media/${id}`,
  createdAt: Date.now() - minutesAgo * MIN,
  params: { task: "genjutsu", resolution: "1080p", sourceUploadId: "up_src", references: Array.from({ length: refs }, (_, i) => ({ uploadId: refs === 1 ? "up_ref" : `up_r${i}`, role: "reference_image", kind: "image" })), consumerJobId: `job-${id}`, consumerCreditUnit: "higgsfield_credits" },
});

async function open(page: Page, sp: "motion" | "swap" | "history", generations: Generation[], options: { pageSize?: number; uploads?: LibraryRoute["uploads"] } = {}) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture() });
  const library: LibraryRoute = { uploads: options.uploads ?? uploads, generations, pageSize: options.pageSize };
  await mockLibrary(page, library);
  const asked: string[] = [];
  page.on("request", (request) => { const path = new URL(request.url()).pathname; if (path.startsWith("/api/higgsfield/consumer/")) asked.push(`${request.method()} ${path}`); });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  /* History is the Social board's History drawer now (the Viral page is deleted); the quick tools are Make's. */
  await page.goto(`/suites?suite=subatomik&page=${sp}&sp=${sp}`);
  if (sp === "history") await expect(page.getByTestId("history-view")).toBeVisible({ timeout: 60_000 });
  else await expect(page.getByTestId("project-name")).toHaveText("Harbour dusk study");
  return { errors, asked, library };
}
/** Viral asks nothing of the connected account; the shell's own collector may list an owner's earlier connected jobs, to drain them. */
const viralAsked = (asked: string[]) => asked.filter((call) => call !== "GET /api/higgsfield/consumer/generation");
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), "no horizontal page scroll").toBeLessThanOrEqual(1);
}
async function shoot(page: Page, project: string, name: string) {
  const size = SHOT_SIZES[project];
  if (!SHOTS || !size) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/viral-${name}-${size}.png` });
}

test("History lists the project's transform takes from the Library, each state in words, earlier account runs read-only, and Send to Edit opens that take in Takes", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, asked } = await open(page, "history", [
    generation({ id: "gen_still", title: "Dunes still", prompt: "dunes", createdAt: Date.now() }),
    take("t_done", "succeeded", 1, { creditsBilled: 22 }),
    take("t_render", "running", 2),
    take("t_queue", "queued", 3),
    take("t_held", "held", 4, { params: keyParams("720p", { held: { why: "credits", needs: 22 } }) }),
    /* Failed, and Particl's own ledger settled it at nothing: the only case that says "not billed". */
    take("t_failed", "failed", 5, { creditsBilled: 0, costUsd: 0, error: "The render failed.", failure: { provider: "higgsfield", stage: "run", code: "failed", kind: "provider_error", message: null, billing: null, payer: "platform", charge: { credits: 0, settled: true } } }),
    earlier("t_earlier", 60),
  ]);
  await expect(page.getByTestId("history-view")).toBeVisible();
  const running = page.getByTestId("history-take");
  await expect(running).toHaveCount(4);
  await expect(running.getByTestId("history-take-status")).toHaveText(["Rendering", "Queued", "Held · needs 22 cr", "Failed · not billed"]);
  /* Its line says what happened, what became of the charge, and what to do next. */
  await expect(running.nth(3).getByTestId("history-take-failure")).toContainText(/not billed/i);
  const done = page.getByTestId("history-result");
  await expect(done).toHaveCount(2);
  await expect(done.first()).toContainText("Motion Transfer · 720p");
  await expect(done.first()).toContainText("22 cr");
  /* A run made earlier on the connected account: kept in the Library, shown read-only with its own next steps. */
  await expect(done.nth(1)).toContainText("Object Swap · 1080p");
  await expect(done.nth(1)).toContainText("Earlier, on the connected account");
  await expect(done.nth(1)).toHaveAttribute("data-account", "true");
  /* No still is a transform; nothing is an estimate. */
  await expect(page.getByTestId("history-view")).not.toContainText("Dunes still");
  if (PHONE.includes(info.project.name)) expect(await smallTargets(page, '[data-testid="history-view"]'), "44px targets").toEqual([]);
  await noOverflow(page);
  await shoot(page, info.project.name, "history");

  await done.nth(1).getByRole("button", { name: "Send to Edit" }).click();
  /* Takes is the board's Shots region now: it opens there, with that take selected. */
  await expect.poll(() => { const q = new URL(page.url()).searchParams; return [q.get("view"), q.get("region")]; }).toEqual(["board", "shots"]);
  await expect.poll(() => new URL(page.url()).searchParams.get("asset")).toMatch(/^(generation|upload):/);
  expect(viralAsked(asked), "Viral asks the connected account for nothing").toEqual([]);
  expect(errors).toEqual([]);
});

test("a take in flight lands without a reload: the Library is read again, and the card turns into its result", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  await page.clock.install();
  const { errors, library } = await open(page, "history", [take("t_render", "running", 2)]);
  await expect(page.getByTestId("history-take").getByTestId("history-take-status")).toHaveText("Rendering");
  /* The engine finishes it; the Library's next settle read (six seconds on) brings it in. */
  library.generations = [take("t_render", "succeeded", 2, { creditsBilled: 22 })];
  await page.clock.fastForward("00:08");
  await expect(page.getByTestId("history-result")).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByTestId("history-take")).toHaveCount(0);
  await expect(page.getByTestId("history-result")).toContainText("22 cr");
  expect(errors).toEqual([]);
});

test("older takes page in by the Library's own cursor, and Recent beside a composer lists its own variant or says it has none", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  const takes = Array.from({ length: 5 }, (_, i) => take(`t_${i}`, "succeeded", i + 1, { model: i % 2 ? SWAP : MOTION }));
  const { errors } = await open(page, "history", takes, { pageSize: 2, uploads: [] });
  await expect(page.getByTestId("history-result")).toHaveCount(2);
  await page.getByTestId("history-more").click();
  await expect(page.getByTestId("history-result")).toHaveCount(4);
  await page.getByTestId("history-more").click();
  await expect(page.getByTestId("history-result")).toHaveCount(5);
  await expect(page.getByTestId("history-more")).toHaveCount(0);
  /* Recent under Object swap (Make's quick tool, opened from ⌘K over History): its own takes only, each a way into Takes. */
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("dialog", { name: "Search" }).getByRole("combobox").or(page.getByRole("dialog", { name: "Search" }).getByRole("textbox")).first().fill("object swap");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("make-panel")).toHaveAttribute("data-tab", "swap");
  const recent = page.getByTestId("viral-recent").getByTestId("viral-take");
  await expect(recent).toHaveCount(2);
  await expect(recent.getByTestId("viral-take-status")).toHaveText(["Done", "Done"]);
  await expect(recent.first().getByTestId("viral-take-open")).toBeEnabled();
  expect(errors).toEqual([]);
});

test("with no takes yet, History says so and starts one; Recent says which variant has none", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  const { errors, asked } = await open(page, "history", []);
  await expect(page.getByTestId("history-empty")).toContainText("No takes in this project yet.");
  await page.getByTestId("history-empty").getByRole("button", { name: "Object Swap" }).click();
  await expect(page.getByTestId("make-title")).toHaveText("Object swap");
  await expect(page.getByTestId("viral-recent-empty")).toHaveText("No Object Swap takes yet.");
  await noOverflow(page);
  expect(viralAsked(asked)).toEqual([]);
  expect(errors).toEqual([]);
});

test("Recreate from an earlier account run loads what the key carries and says what it cannot; Cancel on a queued take asks the route", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  const cancels: string[] = [];
  await page.route(/\/api\/generations\/[^/]+\/cancel$/, (route) => { cancels.push(route.request().url()); return route.fulfill({ status: 202, json: { status: "requested" } }); });
  const { errors, asked } = await open(page, "history", [take("t_queue", "queued", 1), earlier("t_many", 30, 12)]);
  /* The queued take is the person's own to cancel; the route answers, and the take then says what the provider did. */
  await page.getByTestId("history-take-cancel").click();
  await expect(page.getByTestId("history-note")).toHaveText("Cancel requested. The take says what the provider did once it answers.");
  expect(cancels).toHaveLength(1);
  expect(cancels[0]).toContain("/api/generations/t_queue/cancel");
  /* Twelve stills on the account; this route takes eight. */
  await page.getByTestId("history-result").getByRole("button", { name: "Open in Make" }).click();
  await expect(page.getByTestId("viral-view")).toHaveAttribute("data-page", "swap");
  await expect(page.getByTestId("toast")).toContainText("Loaded the first 8 of 12 references; this route takes up to 8.");
  await expect(page.getByTestId("viral-source")).toContainText("walk.mp4");
  await expect(page.getByTestId("viral-reference")).toHaveCount(8);
  await expect(page.getByTestId("viral-prompt")).toHaveValue("swap the bottle");
  await noOverflow(page);
  expect(viralAsked(asked)).toEqual([]);
  expect(errors).toEqual([]);
});

/* The account's Viral route is no longer read by these pages, but its history reads stay until its server code goes
   (lib/higgsfield-consumer/retired.ts), and pricing or starting a run there answers 410. */
test("the real route: the runs view pages runs by cursor and the saved-jobs list is unchanged; a quote or a submit is retired", async ({ page }, info) => {
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

  /* New work is retired on the real server, whatever the body holds; a status read still reaches the ledger. */
  const post = (data: Record<string, unknown>) => page.request.post("/api/higgsfield/consumer/genjutsu", { headers, data });
  for (const action of ["quote", "submit"]) {
    const refused = await post({ action, draftId: "ws-runs-real" });
    expect(refused.status(), action).toBe(410);
    expect(await refused.json()).toEqual({ code: "retired", error: "The connected account is no longer used. Past results stay in your Library." });
  }
  const status = await post({ action: "status", draftId: "ws-runs-real", id: "44444444-4444-4444-8444-000000000001" });
  expect(status.status()).not.toBe(410);
});
