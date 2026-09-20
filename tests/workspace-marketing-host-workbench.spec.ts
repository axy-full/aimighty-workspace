import { createHash } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { EMPTY_MOLECULR } from "../lib/workbench/moleculr";
import { newProject, type Project } from "../lib/workbench/studio";

/**
 * Marketing Studio inside the workspace shell: the /workspace Marketing page
 * mounts the same flow /workbench mounts, so a variant is configured, priced
 * and approved there — with the page's Atomik plan on the same engine.
 *
 * Nothing here dispatches: the fixture records and refuses every POST that is
 * not a quote or the draft's own save, and every test asserts that list is
 * empty. Desktop only; phones keep the existing phone surface.
 */

const DESKTOP = ["workbench-1440x900", "workbench-1920x1080"];
const PHONE = ["workbench-360x640", "workbench-390x844", "workbench-844x390"];
const modelId = "higgsfield/marketing-studio-image";

function campaignProject(): Project {
  return {
    ...newProject("Coastal light study"),
    id: "ws-mkt-host",
    productionProjectId: "ws-mkt-production",
    shotMappings: { "marketing-node": "marketing-shot" },
    assets: [
      {
        id: "product", uploadId: "product-upload", name: "Bottle", kind: "image", category: "Product",
        url: "/api/uploads/product-upload", mime: "image/png", description: "", prompt: "", status: "Draft",
        locked: false, version: 1, refs: [],
      },
    ],
    nodes: [
      { id: "product-node", type: "media", title: "Product", assetId: "product", x: 40, y: 80, width: 220, linked: [] },
      {
        id: "marketing-node", type: "generate", title: "Still Water · Quiet mornings", text: "A plain bottle on a clean studio background.",
        mode: "Image", x: 400, y: 80, width: 300, linked: ["product-node"],
      },
    ],
    moleculr: {
      ...EMPTY_MOLECULR,
      productName: "Still Water",
      productAssetIds: ["product"],
      hooks: ["Quiet mornings"],
      variants: [
        {
          id: "campaign-1", nodeId: "marketing-node", hook: "Quiet mornings", kind: "image",
          createdAt: "2026-09-19T10:00:00Z",
          generation: { modelId, ratio: "3:4", resolution: "2k", marketing: { quality: "high", enhancePrompt: false } },
        },
      ],
    },
  } as Project;
}

type State = {
  quotes: Record<string, unknown>[];
  saves: number;
  dispatches: string[];
  external: string[];
  errors: string[];
};

async function fixture(page: Page): Promise<State> {
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((response) => response.json());
  me.owner = true;
  let project = campaignProject();
  let revision = 1;
  const pixel = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=",
    "base64",
  );
  const state: State = { quotes: [], saves: 0, dispatches: [], external: [], errors: [] };
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
    if (path.startsWith("/api/uploads/") && method === "GET") return route.fulfill({ body: pixel, contentType: "image/png" });
    if (path === "/api/workbench/projects") {
      if (method === "PUT") {
        state.saves++;
        project = request.postDataJSON().project as Project;
        return json({ revision: ++revision, productionProjectId: project.productionProjectId, shotMappings: project.shotMappings });
      }
      if (method === "POST") {
        /* The draft is already mapped, so the dialog never asks; a request here would be a real write. */
        state.dispatches.push("POST /api/workbench/projects " + String(request.postDataJSON()?.action));
        return json({ productionProjectId: "ws-mkt-production", shotId: "marketing-shot" });
      }
      return json({
        project: !url.searchParams.get("id") || url.searchParams.get("id") === project.id ? project : null,
        projects: [{ id: project.id, name: project.name, revision }],
        revision,
        productions: [],
        shared: null,
      });
    }
    if (path === "/api/workbench/engines")
      return json({
        models: [
          {
            id: modelId, label: "Marketing Studio Image", kind: "image", family: "higgsfield-marketing", marketing: true,
            resolutions: ["2k", "1k", "4k"], ratios: ["auto", "16:9", "3:4"], durations: [], maxReferenceImages: 16, maxReferenceVideos: 0,
          },
        ],
      });
    if (path === "/api/higgsfield/marketing/presets") return json({ configured: true, items: [], total: 0, cursor: null });
    if (path === "/api/generate/quote" && method === "POST") {
      const body = request.postDataJSON();
      state.quotes.push(body);
      return json({
        estimatedCredits: 5,
        price: 5,
        unit: "cr",
        fingerprint: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
      });
    }
    if (path === "/api/jobs") return json({ generations: [], nextCursor: null, nextPageCursor: null });
    if (path === "/api/projects") return json({ projects: [] });
    if (path === "/api/pipelines") return json({ runs: [], publications: [], models: [], audioModels: { speech: [], sound: "", music: "" } });
    if (path === "/api/workbench/library") return json({ uploads: [], generations: [], nextCursor: null, nextPageCursor: null });
    if (path === "/api/workbench/atomik" || path === "/api/workbench/development") return json({ models: [], jobs: [], configured: true });
    if (path === "/api/settings") return json({ settings: {}, models: { image: "", video: "", text: {} } });
    if (method !== "GET") {
      state.dispatches.push(`${method} ${path}`);
      return json({ error: "No dispatch is permitted in this test." }, 409);
    }
    return json({});
  });
  return state;
}

const url = "/workspace?project=ws-mkt-host&suite=moleculr&page=marketing";

test("phones keep the existing phone surface on Marketing Studio", async ({ page }, info) => {
  test.skip(!PHONE.includes(info.project.name), "phone viewports");
  await fixture(page);
  await page.goto(url);
  await expect(page).toHaveURL(/\/workbench\?project=ws-mkt-host$/);
  await expect(page.locator(".pxw")).toHaveCount(0);
});

test("the workspace Marketing page hosts the real four sections, not a link out", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  const state = await fixture(page);
  await page.goto(url);
  await expect(page.getByTestId("page-title")).toHaveText("Marketing Studio");
  const tool = page.locator('[data-tool-body="marketing"]');
  await expect(tool).toBeVisible({ timeout: 30_000 });
  /* Marketing Studio itself: its own section nav and its seven sections. */
  await expect(tool.getByRole("navigation", { name: "Marketing Studio sections", exact: true })).toBeVisible();
  for (const id of ["product", "brand", "cast", "format", "variants", "design", "publish"])
    await expect(tool.locator(`#${id}`)).toHaveCount(1);
  /* The page's tool control opens the matching section rather than leaving the page. */
  await expect(tool.locator("#product .moleculr-section-body")).toBeVisible();
  await page.getByTestId("spec-work").getByRole("button", { name: "Variants & output", exact: true }).click();
  await expect(tool.locator("#variants .moleculr-section-body")).toBeVisible();
  /* No link out to the old workbench Marketing Studio remains on the page. */
  await expect(tool.locator('a[href*="/workbench?project=ws-mkt-host&suite=moleculr"]')).toHaveCount(0);

  /* The agent slot is this page's own Atomik plan, on the shell's engine. */
  const plan = page.getByTestId("marketing-plan-panel");
  await expect(plan).toContainText("Build the campaign set");
  await expect(plan.getByRole("button", { name: "Run with Atomik", exact: true })).toBeEnabled();

  /* No horizontal overflow at desktop widths, and no page error. */
  for (const width of [1200, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  }
  expect(state.dispatches).toEqual([]);
  expect(state.external).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("a variant is configured, priced and gated on the workspace page; nothing dispatches before approval", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  const state = await fixture(page);
  await page.goto(url);
  const tool = page.locator('[data-tool-body="marketing"]');
  await expect(tool).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("spec-work").getByRole("button", { name: "Variants & output", exact: true }).click();

  /* The saved variant's own Review generation opens the shared dialog. */
  await tool.getByRole("button", { name: "Review generation", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Generate a new take", exact: true });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  /* A live quote on the button, from the route, before anything is sent. */
  const generate = dialog.getByRole("button", { name: "Generate · 5 cr estimated", exact: true });
  await expect(generate).toBeEnabled({ timeout: 30_000 });
  expect(state.quotes.length).toBeGreaterThan(0);
  expect(state.quotes.at(-1)).toMatchObject({
    model: modelId,
    projectId: "ws-mkt-production",
    shotId: "marketing-shot",
    refine: false,
    references: [{ uploadId: "product-upload", role: "reference_image" }],
  });
  /* Approval is the only thing that could send it: nothing has. */
  expect(state.dispatches).toEqual([]);

  /* The page's plan prices the same variant, and stops at its gate. */
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click().catch(() => page.keyboard.press("Escape"));
  await expect(dialog).toHaveCount(0);
  await page.getByRole("navigation", { name: "Pages" }).getByRole("button", { name: /Atomik/ }).click();
  await expect(page.getByTestId("atomik-plan-title")).toHaveText("Build the campaign set");
  await expect(page.getByTestId("atomik-reason")).toHaveCount(0);
  await page.getByTestId("atomik-panel").getByRole("button", { name: /Run this page/ }).click();
  await expect(page.getByTestId("atomik-gate")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("atomik-gate-price")).toHaveText("5 cr");
  expect(state.dispatches).toEqual([]);
  expect(state.external).toEqual([]);
  expect(state.errors).toEqual([]);
});
