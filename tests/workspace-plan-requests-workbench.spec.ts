import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { MARKETING_IMAGE_MODEL_ID } from "../lib/models";
import { moleculrNode } from "../lib/workbench/moleculr";
import { newProject, type Asset, type CanvasNode, type Project } from "../lib/workbench/studio";

/**
 * The remaining page-supplied plan requests (workspace redesign follow-up):
 * Marketing Studio and Shorts now publish the bodies their existing paid flow
 * sends, so their Atomik plan reaches its gate with a live quote; Boards has
 * no such body and stays refused.
 *
 * Every test here proves the same two things: the plan becomes runnable only
 * from real page state, and NOTHING is dispatched before the approval. The
 * fixtures refuse every mutation other than the quote the gate takes.
 */

const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const PHONE = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=",
  "base64",
);
const presetId = "7fa32a45-2f1e-45ed-8cc7-03296ddcf07f";
const wallet = "22222222-2222-4222-8222-222222222222";
/** The one project original Shorts may restyle in these tests. */
const launchOriginal = {
  id: "launch-original", filename: "Launch cut.mp4", kind: "video", mime: "video/mp4", bytes: 4000,
  width: 640, height: 360, durationS: 31, sha256: "e".repeat(64), createdAt: Date.now(), url: "/api/uploads/launch-original",
};

/* ------------------------------------------------------------- fixtures */

const productImage = (id: string): Asset => ({
  id,
  url: `/api/uploads/${id}`,
  uploadId: id,
  kind: "image",
  mime: "image/png",
  name: "Bottle",
  category: "Product",
  description: "",
  prompt: "",
  status: "Draft",
  version: 1,
  locked: false,
  refs: [],
});

/**
 * A campaign project whose one variant Marketing Studio already configured:
 * its engine, ratio, resolution and image options were accepted once, and its
 * node is mapped to a production shot. That is the state the page publishes.
 */
function campaignProject(): Project {
  const variant: CanvasNode = {
    ...moleculrNode("variant-1", "A plain bottle on a clean studio background.", "Still Water · Quiet mornings", 0, "image"),
    linked: ["ref-node"],
  };
  const source: CanvasNode = { ...moleculrNode("ref-node", "", "Product reference", 1, "image"), assetId: "asset-1" };
  return {
    ...newProject("Coastal light study"),
    id: "ws-plan-marketing",
    productionProjectId: "ws-plan-production",
    shotMappings: { "variant-1": "shot-1" },
    assets: [productImage("asset-1")],
    nodes: [source, variant],
    moleculr: {
      productName: "Still Water",
      productUrl: "",
      productAssetIds: ["asset-1"],
      castAssetIds: [],
      format: "cinematic-demo",
      hooks: ["Quiet mornings"],
      notes: "",
      variants: [
        {
          id: "campaign-1",
          nodeId: "variant-1",
          hook: "Quiet mornings",
          kind: "image",
          createdAt: "2026-09-19T10:00:00Z",
          generation: {
            modelId: MARKETING_IMAGE_MODEL_ID,
            ratio: "1:1",
            resolution: "2k",
            marketing: { quality: "high", enhancePrompt: false },
          },
        },
      ],
    },
  } as Project;
}

type State = {
  quotes: Record<string, unknown>[];
  dispatches: string[];
  refused: string[];
  external: string[];
  errors: string[];
};

/**
 * Routes every request this shell makes. A POST that is not the gate's quote
 * is recorded as a dispatch and refused, so a test can assert that approval
 * is the only thing that could ever have sent one.
 */
async function fixture(page: Page, project: Project): Promise<State> {
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((response) => response.json());
  me.owner = true;
  const state: State = { quotes: [], dispatches: [], refused: [], external: [], errors: [] };
  page.on("pageerror", (error) => state.errors.push(error.message));
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (["localhost", "127.0.0.1"].includes(url.hostname)) return route.continue();
    state.external.push(url.href);
    return route.abort("blockedbyclient");
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const method = request.method();
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    if (path === "/api/me") return json(me);
    if (path === "/api/uploads/launch-original/metadata") return json({ upload: launchOriginal });
    if (path === "/api/uploads/launch-original") return route.fulfill({ body: pixel, contentType: "video/mp4" });
    if (path.startsWith("/api/uploads/") && method === "GET" && !path.endsWith("/metadata"))
      return route.fulfill({ body: pixel, contentType: "image/png" });
    if (path === "/api/workbench/projects" && method === "GET")
      return json({
        project: !url.searchParams.get("id") || url.searchParams.get("id") === project.id ? project : null,
        projects: [{ id: project.id, name: project.name, revision: 1 }],
        revision: 1,
        productions: [],
        shared: null,
      });
    if (path === "/api/higgsfield/consumer/connection") return json({ connected: true, requiresReconnect: false });
    if (path === "/api/higgsfield/consumer/shorts") {
      if (method === "GET")
        return json({
          connection: { connected: true, requiresReconnect: false },
          capabilities: { shorts: true, aspectRatios: ["9:16", "16:9"], resolution: "720p", minSourceSeconds: 4, maxSourceSeconds: 120, maxClips: 20, cancel: false },
          jobs: [],
        });
      const body = request.postDataJSON();
      if (body.action === "presets")
        return json({ presets: { presets: [{ id: presetId, source: "cms", name: "Bold Urban" }], complete: true, fetchedAt: Date.now() } });
      if (body.action === "quote") {
        state.quotes.push(body);
        return json({
          job: {
            id: `11111111-1111-4111-8111-${String(state.quotes.length).padStart(12, "0")}`,
            draftId: body.draftId,
            status: "quoted",
            input: body.input,
            source: { kind: "video", name: "Launch cut.mp4" },
            pricedSeconds: 31,
            workspaceId: wallet,
            workspaceName: "Studio wallet",
            quoteCredits: 40,
            creditUnit: "higgsfield_credits",
            quoteExpiresAt: Date.now() + 300_000,
            providerJobId: null,
            clips: [],
            settlement: null,
            createdAt: Date.now(),
          },
        });
      }
      state.dispatches.push(`${path} ${String(body.action)}`);
      return json({ error: "No dispatch is permitted in this test." }, 409);
    }
    if (path === "/api/generate/quote" && method === "POST") {
      state.quotes.push(request.postDataJSON());
      return json({ estimatedCredits: 18, price: 18, unit: "cr", fingerprint: `fp${"0".repeat(60)}01` });
    }
    if (path === "/api/generate" && method === "POST") {
      state.dispatches.push("POST /api/generate");
      return json({ error: "No dispatch is permitted in this test." }, 409);
    }
    if (path === "/api/workbench/library")
      return json({
        uploads: url.searchParams.get("source") === "generations" ? [] : [launchOriginal],
        generations: [],
        nextCursor: null,
        nextPageCursor: null,
      });
    if (path === "/api/uploads" && method === "GET") return json({ uploads: [launchOriginal], nextCursor: null, nextPageCursor: null });
    if (path === "/api/jobs") return json({ generations: [], nextCursor: null, nextPageCursor: null });
    if (path === "/api/projects") return json({ projects: [] });
    if (path === "/api/pipelines") return json({ runs: [], publications: [], models: [], audioModels: { speech: [], sound: "", music: "" } });
    if (path === "/api/settings") return json({ settings: {}, models: { image: "", video: "", text: {} } });
    if (method !== "GET") {
      state.dispatches.push(`${method} ${path}`);
      return json({ error: "No other mutation permitted." }, 409);
    }
    state.refused.push(path);
    return json({});
  });
  return state;
}

const url = (project: string, suite: string, page: string) => `/workspace?project=${project}&suite=${suite}&page=${page}`;

/** Open the Atomik panel for the page on screen. */
async function openAtomik(page: Page) {
  await page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: /Atomik/ }).click();
  await expect(page.getByTestId("atomik-panel")).toBeVisible();
}

/* ---------------------------------------------------------------- tests */

test("phones keep the existing phone surface on Shorts", async ({ page }, info) => {
  test.skip(!PHONE.includes(info.project.name), "phone viewports");
  const project = { ...newProject("Viral launch"), id: "ws-plan-shorts", productionProjectId: "ws-plan-production" } as Project;
  await fixture(page, project);
  await page.goto(url(project.id, "subatomik", "shorts"));
  await expect(page).toHaveURL(/\/workbench\?project=ws-plan-shorts$/);
  await expect(page.locator(".pxw")).toHaveCount(0);
});

test("Marketing Studio's plan prices the variants the page holds, and dispatches nothing before approval", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  const project = campaignProject();
  const state = await fixture(page, project);
  await page.goto(url(project.id, "moleculr", "marketing"));
  await expect(page.getByTestId("page-title")).toHaveText("Marketing Studio");
  await expect(page.locator('[data-tool-body="product"]')).toBeVisible({ timeout: 30_000 });

  await openAtomik(page);
  await expect(page.getByTestId("atomik-plan-title")).toHaveText("Build the campaign set");
  /* The page's own request, so no refusal: the variant was configured once. */
  await expect(page.getByTestId("atomik-reason")).toHaveCount(0);
  const run = page.getByTestId("atomik-panel").getByRole("button", { name: /Run this page/ });
  await expect(run).toBeEnabled();
  /* Publishing the request sent nothing. */
  expect(state.quotes).toEqual([]);

  await run.click();
  const gate = page.getByTestId("atomik-gate");
  await expect(gate).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("atomik-gate-price")).toHaveText("18 cr");
  await expect(gate.getByRole("button", { name: /^Approve 18 cr/ })).toBeEnabled();

  /* Exactly one quote, for exactly the body Marketing Studio's dialog sends. */
  expect(state.quotes).toHaveLength(1);
  expect(state.quotes[0]).toEqual({
    prompt: "A plain bottle on a clean studio background.",
    model: MARKETING_IMAGE_MODEL_ID,
    projectId: "ws-plan-production",
    shotId: "shot-1",
    ratio: "1:1",
    resolution: "2k",
    refine: false,
    references: [{ uploadId: "asset-1", role: "reference_image" }],
    marketing: { quality: "high", enhancePrompt: false },
  });
  expect(state.dispatches).toEqual([]);
  expect(state.external).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("a variant Marketing Studio never configured is named, not guessed at, and its plan refuses", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  const base = campaignProject();
  const variants = base.moleculr!.variants.map((variant) => ({ ...variant, generation: undefined }));
  const project = { ...base, moleculr: { ...base.moleculr!, variants } } as Project;
  const state = await fixture(page, project);
  await page.goto(url(project.id, "moleculr", "marketing"));
  await page.locator('.pxw-spec-card[data-card="Variants"]').click();
  await expect(page.getByTestId("marketing-plan-gaps")).toContainText(
    "Quiet mornings: no engine accepted yet — configure its generation in Marketing Studio once.",
  );
  await openAtomik(page);
  await expect(page.getByTestId("atomik-reason")).toHaveText("Needs Marketing Studio data");
  await expect(page.getByTestId("atomik-panel").getByRole("button", { name: /Run this page/ })).toBeDisabled();
  expect(state.quotes).toEqual([]);
  expect(state.dispatches).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("Shorts' own form is the request its plan prices; nothing is submitted before approval", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  const project = { ...newProject("Viral launch"), id: "ws-plan-shorts", productionProjectId: "ws-plan-production" } as Project;
  const state = await fixture(page, project);
  await page.goto(url(project.id, "subatomik", "shorts"));
  await expect(page.getByTestId("page-title")).toHaveText("Shorts");
  const panel = page.getByRole("region", { name: "Shorts on the connected account", exact: true });
  await expect(panel.getByRole("heading", { name: "Shorts", exact: true })).toBeVisible({ timeout: 30_000 });

  /* Before the form holds a source and a style the plan refuses, in its own words. */
  await openAtomik(page);
  await expect(page.getByTestId("atomik-plan-title")).toHaveText("Make a set of shorts");
  await expect(page.getByTestId("atomik-reason")).toContainText("choose a source video and a style on Shorts first");
  await page.keyboard.press("Escape");

  await panel.getByRole("button", { name: "Load styles", exact: true }).click();
  await page.locator('[data-library-id="upload:launch-original"]').getByRole("button", { name: "Use as reference", exact: true }).click();
  await expect(panel.getByRole("group", { name: "Source video", exact: true })).toContainText("Launch cut.mp4 · 31 s");
  await panel.getByRole("combobox", { name: "Style", exact: true }).selectOption(`cms:${presetId}`);
  await panel.getByRole("checkbox", { name: /copied to the connected account/ }).check();

  await openAtomik(page);
  await expect(page.getByTestId("atomik-reason")).toHaveCount(0);
  const run = page.getByTestId("atomik-panel").getByRole("button", { name: /Run this page/ });
  await expect(run).toBeEnabled();
  expect(state.quotes).toEqual([]);

  await run.click();
  await expect(page.getByTestId("atomik-gate")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("atomik-gate-price")).toHaveText("40 credits");
  /* One quote, on exactly the form's own input; no submission. */
  expect(state.quotes).toHaveLength(1);
  expect(state.quotes[0].input).toEqual({
    source: { uploadId: "launch-original" },
    preset: { id: presetId, source: "cms", name: "Bold Urban" },
    aspectRatio: "9:16",
  });
  expect(state.dispatches).toEqual([]);
  expect(state.external).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("Boards stays refused: no board body exists to price", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  const project = campaignProject();
  const state = await fixture(page, project);
  await page.goto(url(project.id, "particl", "boards"));
  await expect(page.getByTestId("page-title")).toHaveText("Boards");
  await openAtomik(page);
  await expect(page.getByTestId("atomik-plan-title")).toHaveText("Board every scene");
  await expect(page.getByTestId("atomik-reason")).toHaveText("Needs Boards data");
  await expect(page.getByTestId("atomik-panel").getByRole("button", { name: /Run this page/ })).toBeDisabled();
  expect(state.quotes).toEqual([]);
  expect(state.dispatches).toEqual([]);
  expect(state.errors).toEqual([]);
});
