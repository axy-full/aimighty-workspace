import { test, expect, type Page, type Locator } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { seedBoard } from "./helpers/s03-board";
import { forbidPaidWork } from "./helpers/workspaceFixtures";
import { expectLargerScreen } from "./helpers/largerScreen";
import { astraRenderPendingKey } from "../components/astra-blender/astra-render-recovery";
import { CHECK_LINE, SAMPLE_LINE } from "../lib/demo/sample";
import { isCompact } from "./helpers/shellMode";
import { createAstraScene } from "../lib/astra-blender/scene";
import { astraSceneDigest } from "../lib/astra-blender/proposal";
import type { AstraRenderJob, AstraRenderRequest, AstraRenderRuntime } from "../lib/astra-blender/render-contract";

/*
 * Owner Q19: production renders in 3D, and Release 1 deleted the Studio page that started them. Until renders get a new home the
 * old render panel (components/astra-blender/AstraRenderPanel.tsx) is the Studio board's "3D scene" drawer. Ported from the old
 * page's spec (tests/astra-render-workbench.spec.ts, deleted with the old screens): the quote is shown before anything is spent,
 * the one paid press carries the quoted ceiling, the job's progress and its outputs show, an unconnected runtime says the
 * server's own words and cannot submit, and a phone says "Open this on a larger screen". Nothing paid reaches the server: the
 * render route is answered here, and every other paid route throws (forbidPaidWork).
 */
const ENDPOINT = "/api/workbench/astra-blender/render";
const READY: AstraRenderRuntime = { configured: true, reason: null, blenderVersion: "5.0", timeoutMs: 180000, vcpus: 2, memoryMb: 4096 };
/* A neutral folder name; R1_ASTRA_SHOTS points it elsewhere. */
const SHOTS = process.env.R1_ASTRA_SHOTS;
/* On a fresh dev server the drawer's lazily loaded panel compiles on first open, and its hot reload can reload the page under
   the test (seen locally once, cold). One retry runs it on the warm server, as tests/demo-s03-drawers-workbench.spec.ts does. */
test.describe.configure({ retries: 1 });

async function openDrawer(page: Page, projectId: string): Promise<Locator> {
  await page.goto(`/suites?project=${projectId}&view=board`);
  await expect(page.getByTestId("board-rail")).toBeVisible();
  await page.getByTestId("board-drawer-render").click();
  const drawer = page.getByTestId("board-render");
  await expect(drawer).toBeVisible();
  const panel = drawer.getByRole("region", { name: "Native 3D renders", exact: true });
  await expect(panel).toBeVisible({ timeout: 30_000 });
  return panel;
}

/** Reload the board (the routes stay) and open the drawer again: what a person does after a lost answer or a closed tab. */
async function reopen(page: Page): Promise<Locator> {
  await page.reload();
  await expect(page.getByTestId("board-rail")).toBeVisible();
  await page.getByTestId("board-drawer-render").click();
  const panel = page.getByTestId("board-render").getByRole("region", { name: "Native 3D renders", exact: true });
  await expect(panel).toBeVisible({ timeout: 30_000 });
  return panel;
}

/**
 * The render route, answered here. `loseResponse`: the first send's answer never arrives, either before the server
 * kept the job ("missing") or after it did ("accepted"), as in production's spec.
 */
async function mockRender(page: Page, options: { loseResponse?: "missing" | "accepted" } = {}) {
  const quotes: AstraRenderRequest[] = [], submissions: string[] = [], other: string[] = [], cancellations: string[] = [];
  let jobs: AstraRenderJob[] = [];
  const bytes = { preview: await readFile("public/fixtures/still.png"), blend: Buffer.from("BLENDER-v500-fixture"), glb: Buffer.from("glTF-fixture") };
  await page.route(`**${ENDPOINT}**`, async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() === "GET") return route.fulfill({ json: { runtime: READY, jobs: url.searchParams.has("requestId") ? jobs.filter((job) => job.requestId === url.searchParams.get("requestId")) : jobs } });
    if (request.method() === "PATCH") {
      const input = request.postDataJSON() as { projectId: string; jobId: string; action: string };
      cancellations.push(input.jobId);
      expect(input).toEqual({ projectId: jobs[0].projectId, jobId: jobs[0].id, action: "cancel" });
      jobs[0] = { ...jobs[0], status: "cancelled", billedCredits: 0, updatedAt: Date.now() };
      return route.fulfill({ json: { job: jobs[0] } });
    }
    if (request.method() !== "POST") { other.push(request.method()); return route.fulfill({ status: 409, json: { error: "Unexpected render request in this fixture." } }); }
    const input = request.postDataJSON() as AstraRenderRequest;
    if (input.quoteOnly) {
      quotes.push(input);
      return route.fulfill({ json: { runtime: READY, quote: { estimateCredits: 12, quoteDigest: "a".repeat(64), sourceDigest: input.sourceDigest, expiresAt: Date.now() + 60000, billingNote: "The approved ceiling covers this native job. Actual usage is settled after completion." } } });
    }
    submissions.push(request.postData()!);
    if (options.loseResponse === "missing" && submissions.length === 1) return route.abort("failed");
    jobs = [{ id: "render-fixture-1", requestId: input.requestId, projectId: input.projectId, source: input.source, sourceDigest: input.sourceDigest, status: "running", estimateCredits: 12, billedCredits: null, createdAt: Date.now(), updatedAt: Date.now(), error: null, artifacts: [], assetsRegistered: false }];
    if (options.loseResponse === "accepted" && submissions.length === 1) return route.abort("failed");
    return route.fulfill({ status: 202, json: { job: jobs[0] } });
  });
  await page.route("**/api/uploads/astra-render-*", (route) => {
    const kind = new URL(route.request().url()).pathname.split("-").at(-1) as keyof typeof bytes;
    return route.fulfill({ contentType: kind === "preview" ? "image/png" : "application/octet-stream", body: bytes[kind] });
  });
  return {
    quotes, submissions, other, cancellations,
    complete() {
      const artifacts = (["preview", "blend", "glb"] as const).map((kind) => ({ kind, assetId: `asset-${kind}`, uploadId: `astra-render-${kind}`, url: `/api/uploads/astra-render-${kind}`, filename: kind === "preview" ? "preview.png" : `scene.${kind}`, mime: kind === "preview" ? "image/png" : "application/octet-stream", bytes: bytes[kind].length }));
      jobs[0] = { ...jobs[0], status: "succeeded", billedCredits: 8, assetsRegistered: true, artifacts, updatedAt: Date.now() };
    },
  };
}

test("the Studio board's 3D scene drawer shows the quote before any spend, sends one priced render, and shows its progress and outputs", async ({ page }, info) => {
  test.skip(isCompact(info), "a phone has no screen for the render panel: the larger-screen test below covers it");
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await forbidPaidWork(page);
  const state = await mockRender(page);
  const { project, paid } = await seedBoard(page);
  const panel = await openDrawer(page, project.id);
  await expect(panel.getByText("3D runtime 5.0 · Ready", { exact: true })).toBeVisible();
  await expect(panel.getByLabel("Native render source")).toHaveValue("scene");

  /* The quote first: nothing is sent until the confirm's own press. */
  await panel.getByRole("button", { name: "Review render quote", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Run native 3D render", exact: true });
  const start = dialog.getByRole("button", { name: "Start render · up to 12 cr", exact: true });
  await expect(start).toBeEnabled();
  await expect(start).toHaveAttribute("data-spend", "priced");
  await expect(start).toHaveAttribute("data-spend-price", "up to 12 cr");
  await expect(dialog.getByText("Credit ceiling", { exact: true })).toBeVisible();
  await expect(dialog.getByText("12 cr", { exact: true })).toBeVisible();
  expect(state.quotes).toHaveLength(1);
  expect(state.quotes[0]).toMatchObject({ projectId: project.id, source: "scene", quoteOnly: true, sourceDigest: await astraSceneDigest(createAstraScene("product")) });
  expect(state.submissions).toEqual([]);
  if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: `${SHOTS}/astra-render-quote-1440x900.png` }); }

  /* One press is one render, however fast it is pressed, with the reviewed quote's identity and ceiling. */
  await start.evaluate((button) => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect(dialog).toHaveCount(0);
  await expect(panel.getByRole("progressbar", { name: "Native render in progress" })).toBeVisible();
  await expect(panel.getByRole("article", { name: "Native render render-fixture-1", exact: true })).toContainText("12 cr reserved");
  expect(state.submissions).toHaveLength(1);
  expect(JSON.parse(state.submissions[0])).toEqual({ projectId: project.id, requestId: state.quotes[0].requestId, source: "scene", sourceDigest: state.quotes[0].sourceDigest, quoteOnly: false, quoteDigest: "a".repeat(64), maxCredits: 12 });

  /* The job finishes: what it charged, its preview and its files. */
  state.complete();
  await panel.getByRole("button", { name: "Refresh native render history" }).click();
  const job = panel.getByRole("article", { name: "Native render render-fixture-1", exact: true });
  await expect(job).toContainText("Completed");
  await expect(job).toContainText("8 cr charged");
  await expect(job.getByRole("img", { name: "Native 3D rendered preview" })).toBeVisible();
  for (const label of ["PNG", ".blend", "GLB"]) await expect(job.getByRole("link", { name: `Download rendered ${label}`, exact: true })).toBeVisible();
  await expect(job.getByText("Outputs saved in your project library.", { exact: true })).toBeVisible();
  await expect(page.getByTestId("board-render").getByRole("button", { name: "Download Blender package", exact: true })).toBeEnabled();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/astra-render-done-1440x900.png` });
  else await page.screenshot({ path: info.outputPath("astra-render-done.png") });

  expect(state.submissions).toHaveLength(1);
  expect(state.other).toEqual([]);
  expect(paid).toEqual([]);
  expect(errors).toEqual([]);
});

/* Production's recovery cases (tests/astra-render-workbench.spec.ts, deleted with the old page), on the board's drawer. */
async function startRender(page: Page, panel: Locator) {
  await panel.getByRole("button", { name: "Review render quote", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Run native 3D render", exact: true });
  await dialog.getByRole("button", { name: "Start render · up to 12 cr", exact: true }).click();
  return dialog;
}

test("an interrupted render send keeps the exact approved request; after a reload, Recover sends those same bytes once more", async ({ page }, info) => {
  test.skip(isCompact(info), "a phone has no screen for the render panel");
  await forbidPaidWork(page);
  const state = await mockRender(page, { loseResponse: "missing" });
  const { project, headers } = await seedBoard(page);
  const panel = await openDrawer(page, project.id);
  const dialog = await startRender(page, panel);
  await expect(dialog.getByRole("alert")).toBeVisible();
  expect(state.submissions).toHaveLength(1);
  const original = state.submissions[0];
  const key = astraRenderPendingKey(headers["X-Workbench-Scope"], project.id);
  expect(JSON.parse((await page.evaluate((k) => localStorage.getItem(k), key))!).body).toBe(original);

  const again = await reopen(page);
  const recover = again.getByRole("button", { name: "Recover saved render request · up to 12 cr", exact: true });
  await expect(recover).toBeEnabled();
  await expect(recover).toHaveAttribute("data-spend-price", "up to 12 cr");
  await recover.click();
  await expect(again.getByRole("article", { name: "Native render render-fixture-1", exact: true })).toBeVisible();
  expect(state.submissions).toEqual([original, original]);
  expect(state.quotes).toHaveLength(1);
  expect(await page.evaluate((k) => localStorage.getItem(k), key)).toBeNull();
  expect(state.other).toEqual([]);
});

test("a lost answer for a job the server kept is found by lookup, with no second send", async ({ page }, info) => {
  test.skip(isCompact(info), "a phone has no screen for the render panel");
  await forbidPaidWork(page);
  const state = await mockRender(page, { loseResponse: "accepted" });
  const { project, headers } = await seedBoard(page);
  const panel = await openDrawer(page, project.id);
  const dialog = await startRender(page, panel);
  await expect(dialog).toHaveCount(0);
  await expect(panel.getByRole("article", { name: "Native render render-fixture-1", exact: true })).toBeVisible();
  expect(state.submissions).toHaveLength(1);
  expect(state.quotes).toHaveLength(1);
  expect(await page.evaluate((k) => localStorage.getItem(k), astraRenderPendingKey(headers["X-Workbench-Scope"], project.id))).toBeNull();
  expect(state.other).toEqual([]);
});

test("a cancelled render stays cancelled, at nothing charged, after a reload", async ({ page }, info) => {
  test.skip(isCompact(info), "a phone has no screen for the render panel");
  await forbidPaidWork(page);
  const state = await mockRender(page);
  const { project } = await seedBoard(page);
  const panel = await openDrawer(page, project.id);
  await startRender(page, panel);
  await panel.getByRole("button", { name: "Cancel render", exact: true }).click();
  const job = panel.getByRole("article", { name: "Native render render-fixture-1", exact: true });
  await expect(job).toContainText("Cancelled");
  await expect(panel.getByRole("progressbar")).toHaveCount(0);
  const again = await reopen(page);
  await expect(again.getByRole("article", { name: "Native render render-fixture-1", exact: true })).toContainText("0 cr charged");
  await expect(again.getByRole("article", { name: "Native render render-fixture-1", exact: true })).toContainText("Cancelled");
  expect(state.cancellations).toEqual(["render-fixture-1"]);
  expect(state.submissions).toHaveLength(1);
  expect(state.other).toEqual([]);
});

test("in the sample workspace (and when that check fails) every paid press in the drawer is disabled and says the board's line", async ({ page }, info) => {
  test.skip(isCompact(info), "a phone has no screen for the render panel");
  await forbidPaidWork(page);
  const state = await mockRender(page);
  const mode = { failed: false };
  await page.route("**/api/demo/sample", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return mode.failed ? route.fulfill({ status: 500, json: { error: "unavailable" } }) : route.fulfill({ json: { board: null, sampleWorkspace: true } });
  });
  const { project, headers } = await seedBoard(page);
  /* A saved request waiting for recovery, so the Recover press is on screen too. */
  const scope = headers["X-Workbench-Scope"], requestId = "render-request-sample-1";
  const body = JSON.stringify({ projectId: project.id, requestId, source: "scene", sourceDigest: "c".repeat(64), quoteOnly: false, quoteDigest: "a".repeat(64), maxCredits: 12 });
  await page.addInitScript(({ key, record }) => { try { localStorage.setItem(key, record); } catch { /* storage off */ } },
    { key: astraRenderPendingKey(scope, project.id), record: JSON.stringify({ version: 1, scope, projectId: project.id, requestId, body, createdAt: Date.now() }) });
  for (const [failed, line] of [[false, SAMPLE_LINE], [true, CHECK_LINE]] as const) {
    mode.failed = failed;
    const panel = await openDrawer(page, project.id);
    await expect(panel.getByTestId("astra-render-blocked")).toHaveText(line);
    const review = panel.getByRole("button", { name: "Review render quote", exact: true });
    await expect(review).toBeDisabled();
    await expect(review).toHaveAttribute("title", line);
    const recover = panel.getByRole("button", { name: "Recover saved render request · up to 12 cr", exact: true });
    await expect(recover).toBeDisabled();
    await expect(recover).toHaveAttribute("title", line);
  }
  expect(state.quotes).toEqual([]);
  expect(state.submissions).toEqual([]);
});

test("with no 3D runtime connected (the off-Vercel guard), the drawer says the server's words and cannot ask for a quote", async ({ page }, info) => {
  test.skip(isCompact(info), "a phone has no screen for the render panel: the larger-screen test below covers it");
  await forbidPaidWork(page);
  const sent: string[] = [];
  page.on("request", (request) => { if (request.method() !== "GET" && new URL(request.url()).pathname === ENDPOINT) sent.push(request.postData() ?? ""); });
  const { project, headers } = await seedBoard(page);
  /* The real route, as this host answers it: no runtime snapshot or credentials here, so not configured, with its reason. */
  const status = await page.request.get(`${ENDPOINT}?projectId=${project.id}`, { headers });
  expect(status.ok(), await status.text()).toBe(true);
  const { runtime } = await status.json() as { runtime: AstraRenderRuntime };
  test.skip(runtime.configured, "this host has a 3D runtime connected");
  expect(runtime.reason).toMatch(/^Native 3D rendering is not connected\./);

  const panel = await openDrawer(page, project.id);
  await expect(panel.getByText("Runtime setup required", { exact: true })).toBeVisible();
  const notice = panel.getByRole("status").filter({ hasText: "Native rendering is unavailable" });
  await expect(notice).toBeVisible();
  await expect(notice.getByText(runtime.reason!, { exact: true })).toBeVisible();
  await expect(notice.getByText("You can keep editing and download the portable 3D package.", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Review render quote", exact: true })).toBeDisabled();
  await expect(page.getByTestId("board-render").getByRole("button", { name: "Download Blender package", exact: true })).toBeEnabled();
  expect(sent).toEqual([]);
});

test("a phone opens the 3D scene drawer's address as the plain 'Open this on a larger screen' page", async ({ page }, info) => {
  test.skip(!isCompact(info), "the desktop opens the drawer itself: the tests above");
  await forbidPaidWork(page);
  await expectLargerScreen(page, "/suites?view=board&drawer=render", "3D scene");
});
