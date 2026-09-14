import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { readFile } from "node:fs/promises";
import { seedProject, STAGES, type Plan, type Project } from "../lib/workbench/studio";


async function goStage(page: Page, label: string) {
  if (page.viewportSize()!.width < 760) {
    await page.getByRole("navigation", { name: "Mobile studio navigation" }).getByRole("button", { name: "Workflow", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Production workflow" });
    await expect(sheet).toBeVisible();
    await sheet.locator(".mobile-workflow-list button").filter({ hasText: label }).click();
    await expect(sheet).not.toBeVisible();
  } else {
    await page.locator(".workflow-stages").getByRole("tab").nth(STAGES.findIndex(stage => stage.label === label)).click();
  }
}

async function fixture(page: Page) {
  const me=await page.request.get('/api/me').then(response=>response.json());
  let project: Project = seedProject();
  project.productionProjectId = "prod-browser";
  project.shotMappings = { "generate-browser": "shot-browser" };
  project.assets = project.assets.map(asset => ({ ...asset, uploadId: `upload-${asset.id}` }));
  project.nodes.push({ id: "generate-browser", title: "Browser test shot", type: "generate", text: "An ivory silhouette in the desert", x: 100, y: 100, width: 344, linked: ["cast", "world"], mode: "Image" });
  let revision = 1;
  let generated = false;
  let atomikPlan: Plan | undefined;
  let atomikRequestId = "";
  let budgetFailure = true;
  const generationRequests: { key: string | undefined; body: Record<string, unknown> }[] = [];
  const image = await readFile("public/campaign/hero.webp");
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const body = request.method() === "POST" || request.method() === "PUT" ? (() => { try { return request.postDataJSON(); } catch { return {}; } })() : {};
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (path === "/api/me") return json(me);
    if (path === "/api/workbench/projects") {
      if (request.method() === "PUT") {
        project = { ...body.project, productionProjectId: "prod-browser", shotMappings: { "generate-browser": "shot-browser" } };
        return json({ revision: ++revision, productionProjectId: project.productionProjectId, shotMappings: project.shotMappings });
      }
      if (request.method() === "POST") return json(body.action === "map-shot" ? { shotId: "shot-browser", productionProjectId: "prod-browser" } : { version: 1, project });
      return json({ project, revision, projects: [{ id: project.id, name: project.name }], productions: [] });
    }
    if (path === "/api/workbench/engines") return json({ models: [{ id: "mock-image", label: "Mock image engine", kind: "image", resolutions: ["1k"], ratios: ["16:9", "9:16", "1:1"], durations: [], maxReferenceImages: 8, maxReferenceVideos: 0 }], credits: 3 });
    if (path === "/api/generate") {
      generationRequests.push({ key: request.headers()["idempotency-key"], body });
      if (budgetFailure) { budgetFailure = false; return json({ error: "The workspace generation budget is exhausted." }, 409); }
      generated = true;
      return json({ id: "generated-browser" }, 202);
    }
    if (path === "/api/jobs") return json({ generations: generated ? [{ id: "generated-browser", status: "succeeded", kind: "image", shotId: "shot-browser", prompt: "An ivory silhouette in the desert", version: 1, model: "mock-image", params: { ratio: "16:9" }, creditsBilled: 3 }] : [] });
    if (path === "/api/workbench/atomik") {
      if (body.quoteOnly) return json({ estimateCredits: 2, estimateUsd: 0.02, model: "mock-reasoning", depth: "Quick", quoteOnly: true });
      if (request.method() === "POST") {
        atomikRequestId = body.requestId;
        atomikPlan = { id: "plan-browser", request: body.request, model: "mock-reasoning", depth: "Quick", intent: "shots", summary: "Build the scene from the shared reference bible.", steps: ["Establish the mirrored dunes.", "Introduce the character."], applied: false, refs: ["character", "environment"] };
        return json({ job: { id: "atomik-browser", requestId: atomikRequestId, status: "queued" } }, 202);
      }
      return json({ models: [{ id: "mock-reasoning", name: "Mock reasoning engine" }], jobs: atomikPlan ? [{ id: "atomik-browser", requestId: atomikRequestId, status: "succeeded", request: atomikPlan.request, model: atomikPlan.model, plan: atomikPlan, credits: 2 }] : [] });
    }
    if (path === "/api/uploads" || path === "/api/uploads/finish") return json({ id: "upload-browser", filename: "Reference.webp", mime: "image/webp", kind: "image", bytes: image.length, width: 1536, height: 1024, durationS: null, sha256: "test-sha", url: "/api/uploads/upload-browser" }, 201);
    if (path === "/api/uploads/chunk") return json({ ok: true });
    if (path.startsWith("/api/media/") || path.startsWith("/api/workbench/preview/") || path === "/api/uploads/upload-browser") return route.fulfill({ contentType: "image/webp", body: image });
    return json({ error: `Unexpected request in mocked browser workflow: ${path}` }, 501);
  });
  return { current: () => project, generationRequests };
}

test("mobile navigation waits for hydration and initial load, then accepts the first workflow tap", async ({page},testInfo)=>{
  test.skip(testInfo.project.name!=="workbench-360x640","one deterministic startup regression; responsive flow covers both phone sizes");
  await signInLocally(page.request);
  await fixture(page);
  let releaseScripts=()=>{};
  const scripts=new Promise<void>(resolve=>{releaseScripts=resolve;});
  await page.route("**/_next/static/**",async route=>{
    if(route.request().resourceType()==="script")await scripts;
    await route.continue();
  });
  let releaseProject=()=>{},projectRequested=false;
  const project=new Promise<void>(resolve=>{releaseProject=resolve;});
  await page.route("**/api/workbench/projects?*",async route=>{
    if(route.request().method()==="GET"){projectRequested=true;await project;}
    await route.fallback();
  });
  await page.goto("/workbench",{waitUntil:"commit"});
  const workflow=page.getByRole("navigation",{name:"Mobile studio navigation"}).getByRole("button",{name:"Workflow",exact:true});
  await expect(workflow).toBeVisible();
  await expect(workflow).toBeDisabled();
  releaseScripts();
  await expect.poll(()=>projectRequested).toBeTruthy();
  await expect(workflow).toBeDisabled();
  releaseProject();
  await expect(workflow).toBeEnabled();
  await workflow.click();
  await expect(page.getByRole("dialog",{name:"Production workflow"})).toBeVisible();

  // A verified workspace with no draft still completes initialization and keeps recovery/navigation available.
  await page.route("**/api/workbench/projects?*",route=>route.fulfill({contentType:"application/json",body:JSON.stringify({projects:[],productions:[],revision:0})}));
  await page.reload();
  await expect(workflow).toBeEnabled();
  await workflow.click();
  await expect(page.getByRole("dialog",{name:"Production workflow"})).toBeVisible();
});

test("responsive production: save, stages, node versions, jobs, refresh and editorial export", async ({ page }, testInfo) => {
  await signInLocally(page.request);
  const state = await fixture(page);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/workbench");
  await expect(page.getByRole("button", { name: "Particl home", exact: true })).toBeVisible();
  const mobile = page.viewportSize()!.width < 760;
  if (mobile) await expect(page.getByRole("navigation", { name: "Mobile studio navigation" })).toBeVisible();
  await goStage(page, "Brief & ideas");
  const title = `Browser production ${testInfo.project.name}`;
  await page.getByLabel("Production title", { exact: true }).fill(title);
  await expect.poll(() => state.current().name).toBe(title);

  for (const stage of STAGES) {
    await goStage(page, stage.label);
    await expect(page.locator("[data-nextjs-dialog]")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBeTruthy();
  }
  await goStage(page, "Script & breakdown");
  await page.getByLabel("Production screenplay", { exact: true }).fill("EXT. TEST DUNES - DAY\n\nMIRA walks into the light.");
  await expect(page.locator(".breakdown-scene")).toHaveCount(1);
  await page.getByRole("button", { name: "Build scene canvas", exact: true }).click();
  await expect.poll(() => state.current().nodes.some(node => node.title.includes("TEST DUNES"))).toBeTruthy();
  await goStage(page, "Assets & takes");
  await page.getByLabel("Upload production files", { exact: true }).setInputFiles({ name: "Uploaded reference.webp", mimeType: "image/webp", buffer: await readFile("public/campaign/hero.webp") });
  await expect.poll(() => state.current().assets.some(asset => asset.uploadId === "upload-browser")).toBeTruthy();
  await goStage(page, "Production canvas");
  if (mobile) {
    await page.locator(".mobile-node-viewbar").getByRole("tab", { name: "List", exact: true }).click();
    await page.locator(".mobile-node-list button").filter({ hasText: "Browser test shot" }).click();
    await expect(page.getByRole("dialog", { name: "Node controls", exact: true })).toBeVisible();
  } else {
    const node = page.getByRole("article", { name: "Generate node: Browser test shot", exact: true });
    await node.focus();
    await node.press("Enter");
  }
  await page.getByLabel("Node name", { exact: true }).fill("Browser revised shot");
  await page.getByRole("tab", { name: /^Versions/ }).click();
  await page.getByLabel("Version name", { exact: true }).fill("Before generation");
  await page.getByRole("button", { name: "Save version", exact: true }).click();
  await expect.poll(() => state.current().nodes.find(node => node.id === "generate-browser")?.versions?.length).toBe(1);
  await page.getByRole("tab", { name: "Controls", exact: true }).click();
  await page.getByRole("button", { name: "Generate take", exact: true }).click();
  const generation = page.getByRole("dialog", { name: "Generate a new take", exact: true });
  await expect(generation).toBeVisible();
  await generation.getByRole("button", { name: "Generate · 3 cr estimated", exact: true }).click();
  await expect(generation.getByRole("alert")).toContainText("budget is exhausted");
  const dialogBounds = await generation.boundingBox();
  expect(dialogBounds!.x).toBeGreaterThanOrEqual(0);
  expect(dialogBounds!.y).toBeGreaterThanOrEqual(0);
  expect(dialogBounds!.x + dialogBounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  expect(dialogBounds!.y + dialogBounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
  await page.screenshot({ path: testInfo.outputPath("generation-before-close.png") });
  await generation.getByRole("button", { name: "Close", exact: true }).click();
  await expect(generation).not.toBeVisible();
  if (mobile) {
    await page.locator(".mobile-node-list button").filter({ hasText: "Browser revised shot" }).click();
  }
  await page.getByRole("button", { name: "Generate take", exact: true }).click();
  await expect(generation).toBeVisible();
  await expect(generation.getByLabel("Generation direction", { exact: true })).toBeDisabled();
  await generation.getByRole("button", { name: "Recover submitted take", exact: true }).click();
  await expect(generation).not.toBeVisible();
  expect(state.generationRequests).toHaveLength(2);
  expect(state.generationRequests[0].key).toBeTruthy();
  expect(state.generationRequests[1].key).toBe(state.generationRequests[0].key);
  expect(state.generationRequests[1].body).toMatchObject({ projectId: "prod-browser", shotId: "shot-browser" });
  await expect.poll(() => state.current().assets.some(asset => asset.generationId === "generated-browser")).toBeTruthy();

  if (mobile) {
    const nodeSheet = page.getByRole("dialog", { name: "Node controls", exact: true });
    if (await nodeSheet.isVisible()) await nodeSheet.getByRole("button", { name: "Close Node controls", exact: true }).last().click();
  }
  await page.getByRole("tab", { name: "Genie", exact: true }).click();
  await page.getByLabel("Ask Atomik", { exact: true }).fill("Build a two-shot sequence from the shared bible");
  await page.getByRole("button", { name: "Run Atomik", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "Plan with Genie", exact: true });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "Run · 2 cr estimated", exact: true }).click();
  await expect(confirmation).not.toBeVisible();
  await expect.poll(() => state.current().plans.some(plan => plan.id === "plan-browser")).toBeTruthy();
  await page.getByRole("tab", { name: "Genie", exact: true }).click();
  await expect(page.getByText("Build the scene from the shared reference bible.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Build in my space", exact: true }).click();
  await expect.poll(() => state.current().plans.find(plan => plan.id === "plan-browser")?.applied).toBeTruthy();

  await page.reload();
  await goStage(page, "Brief & ideas");
  await expect(page.getByLabel("Production title", { exact: true })).toHaveValue(title);
  await goStage(page, "Delivery");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download package" }).click();
  expect((await download).suggestedFilename()).toMatch(/_editorial\.zip$/);
  await goStage(page, "Production canvas");
  await page.screenshot({ path: testInfo.outputPath("workbench.png"), fullPage: false });
  expect(errors).toEqual([]);
});

test("switching drains final edits, failed saves retain work, and asset publishing reaches the server", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "workbench-1440x900", "desktop persistence regression; responsive flow covers every viewport separately");
  await signInLocally(page.request);
  await fixture(page);
  const first = { ...seedProject(), name: "First production", productionProjectId: "production-first" };
  const second = { ...seedProject(), id: "second-production", name: "Second production", productionProjectId: "production-second" };
  const documents = new Map<string, Project>([[first.id, first], [second.id, second]]);
  const revisions = new Map([[first.id, 1], [second.id, 1]]);
  let release: () => void = () => {};
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let delayNext = false, held = false, failSaves = false;
  const published: string[] = [];
  const reads: string[] = [];
  await page.route("**/api/workbench/projects**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.method() === "GET" ? {} : request.postDataJSON();
    const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    if (request.method() === "PUT") {
      if (delayNext) { delayNext = false; held = true; await barrier; }
      if (failSaves) return json({ error: "Test persistence unavailable" }, 503);
      documents.set(body.project.id, body.project);
      revisions.set(body.project.id, (revisions.get(body.project.id) || 0) + 1);
      return json({ revision: revisions.get(body.project.id), productionProjectId: body.project.productionProjectId, shotMappings: {} });
    }
    if (request.method() === "POST" && body.action === "publish") {
      published.push(body.projectId);
      return json({ version: 2 });
    }
    const id = url.searchParams.get("id") || first.id;
    reads.push(id);
    return json({ project: documents.get(id), revision: revisions.get(id), projects: [...documents.values()].map(project => ({ id: project.id, name: project.name })), productions: [] });
  });
  await page.goto("/workbench");
  await expect(page.locator(".project-switch")).toContainText("First production");
  await expect(page.locator(".save-label")).toContainText("Saved");
  delayNext = true;
  await goStage(page, "Brief & ideas");
  await page.getByLabel("Production title", { exact: true }).fill("First edit in flight");
  await expect.poll(() => held).toBeTruthy();
  await page.getByLabel("Production title", { exact: true }).fill("Final edit before switch");
  await page.locator(".project-switch").click();
  await page.getByRole("menuitem", { name: "Second production", exact: true }).click();
  release();
  await expect(page.locator(".project-switch")).toContainText("Second production");
  expect(documents.get(first.id)?.name).toBe("Final edit before switch");

  await goStage(page, "Assets & takes");
  await page.getByRole("button", { name: `Edit ${second.assets[0].name}`, exact: true }).click();
  const editor = page.getByRole("dialog");
  await editor.getByRole("button", { name: "Publish this version", exact: true }).click();
  await expect.poll(() => published).toEqual([second.id]);
  expect(documents.get(second.id)?.sharedAssets?.some(asset => asset.id === second.assets[0].id)).toBeTruthy();
  await editor.getByRole("button", { name: "Close", exact: true }).click();

  await goStage(page, "Brief & ideas");
  failSaves = true;
  await page.getByLabel("Production title", { exact: true }).fill("Keep this unsaved work");
  await expect(page.locator(".save-banner")).toContainText("Test persistence unavailable");
  const readsBeforeFailedSwitch = reads.length;
  await page.locator(".project-switch").click();
  await page.getByRole("menuitem", { name: "Final edit before switch", exact: true }).click();
  await expect(page.locator(".save-banner")).toBeVisible();
  await expect(page.locator(".project-switch")).toContainText("Keep this unsaved work");
  expect(reads).toHaveLength(readsBeforeFailedSwitch);
  await goStage(page, "Brief & ideas");
  await expect(page.getByLabel("Production title", { exact: true })).toHaveValue("Keep this unsaved work");
});
