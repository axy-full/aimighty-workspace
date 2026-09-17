import { goWorkbenchStage as goStage, openWorkbenchProject } from "./helpers/workbenchNavigation";
import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { readFile } from "node:fs/promises";
import { seedProject, STAGES, type Plan, type Project } from "../lib/workbench/studio";
import { RING_DOTS } from "../lib/ring";




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
      expect(request.headers()["x-workbench-scope"]).toBe(`particl-active-${me.workspace.id}-${me.id}`);
      if (request.method() === "PUT") {
        project = { ...body.project, productionProjectId: "prod-browser", shotMappings: { "generate-browser": "shot-browser" } };
        return json({ revision: ++revision, productionProjectId: project.productionProjectId, shotMappings: project.shotMappings });
      }
      if (request.method() === "POST") return json(body.action === "map-shot" ? { shotId: "shot-browser", productionProjectId: "prod-browser" } : { version: 1, project });
      return json({ project, revision, projects: [{ id: project.id, name: project.name }], productions: [] });
    }
    if (path === "/api/workbench/engines") return json({ models: [{ id: "mock-image", label: "Mock image engine", kind: "image", resolutions: ["1k"], ratios: ["16:9", "9:16", "1:1"], durations: [], maxReferenceImages: 8, maxReferenceVideos: 0 }], credits: 3 });
    if (path === "/api/generate") {
      expect(request.headers()["x-workbench-scope"]).toBe(`particl-active-${me.workspace.id}-${me.id}`);
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

test("studio context actions edit the right node, respect locks, support keyboard and reuse assets", async ({ page }, testInfo) => {
  await signInLocally(page.request);
  const state = await fixture(page);
  await page.goto("/workbench");
  await goStage(page, "Production canvas");
  const mobile = page.viewportSize()!.width < 760;
  if (mobile) await page.locator(".mobile-node-viewbar").getByRole("tab", {name:"List",exact:true}).click();
  const nodeTarget = () => mobile
    ? page.locator(".mobile-node-list button").filter({hasText:"Browser test shot"}).first()
    : page.getByRole("article", {name:"Generate node: Browser test shot",exact:true});
  await nodeTarget().click({button:"right",position:{x:12,y:12},timeout:8000});
  const menu = page.getByRole("menu", {name:"Browser test shot actions",exact:true});
  await expect(menu).toBeVisible();
  const box = await menu.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  await menu.getByRole("menuitem", {name:"Lock node",exact:true}).click();
  await expect.poll(() => state.current().nodes.find(n=>n.id==='generate-browser')?.locked).toBe(true);
  await nodeTarget().focus();
  await nodeTarget().press("Shift+F10");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem",{name:"Remove node",exact:true})).toBeDisabled();
  await menu.getByRole("menuitem",{name:"Unlock node",exact:true}).click();
  await nodeTarget().click({button:"right",position:{x:12,y:12},timeout:8000});
  await menu.getByRole("menuitem",{name:"Duplicate node",exact:true}).click();
  await expect.poll(() => state.current().nodes.filter(n=>n.title==='Browser test shot / copy').length).toBe(1);
  await nodeTarget().click({button:"right",position:{x:12,y:12},timeout:8000});
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await goStage(page, "Assets & takes");
  const asset=state.current().assets[0];
  const target=page.getByRole('article',{name:'Asset: '+asset.name,exact:true,includeHidden:true});
  const assetMenu=page.getByRole('menu',{name:asset.name+' actions',exact:true});
  if (mobile) {
    await target.scrollIntoViewIfNeeded();
    const point=await target.boundingBox();
    const pointer={pointerId:8,pointerType:'touch',button:0,clientX:point!.x+20,clientY:point!.y+20};
    await target.dispatchEvent('pointerdown',pointer);
    await expect(assetMenu).toBeVisible();
    await target.dispatchEvent('pointerup',pointer,{timeout:5000});
    await target.locator('.asset-image').dispatchEvent('click',{}, {timeout:5000});
    await expect(assetMenu).toBeVisible();
    await page.keyboard.press('Escape');
  }
  await target.click({button:'right'});
  await expect(assetMenu).toBeVisible();
  await expect.poll(async () => {
    const bounds = await assetMenu.boundingBox();
    const viewport = page.viewportSize()!;
    return !!bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width + 1 && bounds.y + bounds.height <= viewport.height + 1;
  }).toBe(true);
  await page.screenshot({path:testInfo.outputPath('studio-context-menu.png')});
  if (mobile) {
    const nodesBeforeDismiss = state.current().nodes.length;
    // A single outside tap must dismiss the sheet without running a command.
    await page.mouse.click(8, 8);
    await expect(assetMenu).toHaveCount(0);
    expect(state.current().nodes).toHaveLength(nodesBeforeDismiss);
    await target.focus();
    await target.press('Shift+F10');
    await expect(assetMenu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(assetMenu).toHaveCount(0);
    await expect(target).toBeFocused();
    await target.press('Shift+F10');
    await expect(assetMenu).toBeVisible();
  }
  const before=state.current().nodes.length;
  await assetMenu.getByRole('menuitem',{name:'Add to canvas',exact:true}).click();
  await expect.poll(()=>state.current().nodes.length).toBe(before+1);
  expect(state.current().nodes.at(-1)?.assetId).toBe(asset.id);
  await page.reload();
  await expect.poll(()=>state.current().nodes.length).toBe(before+1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});

test("studio exposes Gen, collective Library and workspace navigation with the original Atomik brand", async ({ page }, testInfo) => {
  await signInLocally(page.request);
  await fixture(page);
  await page.goto("/workbench");
  const sections = page.getByRole("navigation", { name: "Project tools", exact: true }).filter({visible:true});
  await expect(sections.getByRole("button", { name: "Gen", exact: true })).toBeVisible();
  await expect(sections.getByRole("button", { name: "Library", exact: true })).toBeVisible();
  await expect(sections.getByRole("button", { name: "Workspace", exact: true })).toBeVisible();
  await expect(page.getByRole("button",{name:"All assets",exact:true}).filter({visible:true})).toBeVisible();
  const mark = page.getByRole("button", { name: "Toggle Atomik creative engine", exact: true }).locator("svg.atom-mark");
  await expect(mark).toHaveAttribute("viewBox", "20 20 160 160");
  expect(await mark.locator("circle").evaluateAll(dots => dots.map(dot => ["cx", "cy", "r"].map(key => Number(dot.getAttribute(key)))))).toEqual(RING_DOTS);
  expect(await mark.evaluate(el => ({ fill: getComputedStyle(el).fill, stroke: getComputedStyle(el).stroke }))).toEqual({ fill: "rgb(245, 245, 247)", stroke: "none" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  if (page.viewportSize()!.width < 760) {
    await page.getByRole("button", { name: "Open workspace navigation", exact: true }).click();
  }
  await page.getByRole("button", { name: "Workspace menu", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Credits & plan", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("studio-sections-and-account.png") });
});

test("navigation waits for hydration and initial load, then accepts the first workflow tap", async ({page},testInfo)=>{
  test.skip(!["workbench-360x640", "workbench-1440x900"].includes(testInfo.project.name),"deterministic startup regressions on desktop and phone; responsive flow covers every size");
  const mobile = page.viewportSize()!.width < 760;
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
  const workflow=mobile ? page.getByRole("navigation",{name:"Mobile studio navigation"}).getByRole("button",{name:"Workflow",exact:true}) : page.locator(".workflow-stages").getByRole("tab").last();
  await expect(workflow).toBeVisible();
  await expect(workflow).toBeDisabled();
  releaseScripts();
  await expect.poll(()=>projectRequested).toBeTruthy();
  if (mobile) {
    // Hydration reveals the workspace dock; the project is still loading.
    await expect(page.locator(".phone-home-dock")).toBeVisible();
    await expect(page.locator(".home-current")).toBeDisabled();
  } else await expect(workflow).toBeDisabled();
  releaseProject();
  if (mobile) await openWorkbenchProject(page);
  await expect(workflow).toBeEnabled();
  await workflow.click();
  if (!mobile) {
    await expect(page.getByRole("button", {name: "Open movie renderer", exact: true})).toBeVisible();
    return;
  }
  await expect(page.getByRole("dialog",{name:"Project workflow"})).toBeVisible();

  // A verified workspace with no draft still completes initialization and keeps recovery/navigation available.
  await page.route("**/api/workbench/projects?*",route=>route.fulfill({contentType:"application/json",body:JSON.stringify({projects:[],productions:[],revision:0})}));
  await page.reload();
  await expect(page.getByRole("button", { name: "Explore sample", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Explore sample", exact: true }).click();
  await expect(workflow).toBeEnabled();
  await workflow.click();
  await expect(page.getByRole("dialog",{name:"Project workflow"})).toBeVisible();
});

test("responsive production: save, stages, node versions, jobs, refresh and editorial export", async ({ page }, testInfo) => {
  await signInLocally(page.request);
  const state = await fixture(page);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/workbench");
  await expect(page.locator(page.viewportSize()!.width<760?".phone-project-header":".project-bar")).toBeVisible();
  const mobile = page.viewportSize()!.width < 760;
  if (mobile) await openWorkbenchProject(page);
  if (mobile) await expect(page.getByRole("navigation", { name: "Mobile studio navigation" })).toBeVisible();
  await goStage(page, "Brief & ideas");
  const title = `Browser production ${testInfo.project.name}`;
  await page.getByLabel("Project title", { exact: true }).fill(title);
  await expect.poll(() => state.current().name).toBe(title);

  for (const stage of STAGES) {
    await goStage(page, stage.label);
    await expect(page.locator("[data-nextjs-dialog]")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBeTruthy();
  }
  await goStage(page, "Script & breakdown");
  await page.getByLabel("Project screenplay", { exact: true }).fill("EXT. TEST DUNES - DAY\n\nMIRA walks into the light.");
  await expect(page.getByRole("region", { name: "Screenplay scene breakdown" }).getByRole("checkbox")).toHaveCount(1);
  await page.getByRole("button", { name: "Select all scenes", exact: true }).click();
  await page.getByRole("button", { name: "Build 1 scene nodes", exact: true }).click();
  await expect.poll(() => state.current().nodes.some(node => node.title.includes("TEST DUNES"))).toBeTruthy();
  await goStage(page, "Assets & takes");
  await page.getByLabel("Upload project files", { exact: true }).setInputFiles({ name: "Uploaded reference.webp", mimeType: "image/webp", buffer: await readFile("public/campaign/hero.webp") });
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
  await expect(page.getByLabel("Project title", { exact: true })).toHaveValue(title);
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
  await page.getByLabel("Project title", { exact: true }).fill("First edit in flight");
  await expect.poll(() => held).toBeTruthy();
  await page.getByLabel("Project title", { exact: true }).fill("Final edit before switch");
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
  await page.getByLabel("Project title", { exact: true }).fill("Keep this unsaved work");
  await expect(page.locator(".save-banner")).toContainText("Test persistence unavailable");
  const readsBeforeFailedSwitch = reads.length;
  await page.locator(".project-switch").click();
  await page.getByRole("menuitem", { name: "Final edit before switch", exact: true }).click();
  await expect(page.locator(".save-banner")).toBeVisible();
  await expect(page.locator(".project-switch")).toContainText("Keep this unsaved work");
  expect(reads).toHaveLength(readsBeforeFailedSwitch);
  await goStage(page, "Brief & ideas");
  await expect(page.getByLabel("Project title", { exact: true })).toHaveValue("Keep this unsaved work");
});

test("a shared publication conflict preserves private edits and requires saving before loading the newer context", async ({ page }, testInfo) => {
  test.skip(!["workbench-1440x900", "workbench-390x844"].includes(testInfo.project.name), "focused desktop and phone collaboration recovery regression");
  await signInLocally(page.request);
  await fixture(page);
  let draft = { ...seedProject(), productionProjectId: "shared-production", bibleVersion: 1 };
  let revision = 1, latest = 1, failSaves = false, reads = 0;
  const attempts: number[] = [];
  await page.route("**/api/workbench/projects**", async route => {
    const req = route.request(), body = req.method() === "GET" ? {} : req.postDataJSON();
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    const shared = { assets: draft.sharedAssets, nodes: draft.sharedNodes, version: latest };
    if (req.method() === "PUT") {
      if (failSaves) return json({ error: "Keep the private edit on screen" }, 503);
      draft = body.project; revision++;
      return json({ revision, productionProjectId: draft.productionProjectId, shotMappings: {} });
    }
    if (req.method() === "POST" && body.action === "publish") {
      attempts.push(body.expectedBibleVersion);
      if (body.expectedBibleVersion !== latest) return json({ error: "Another collaborator published newer context.", code: "bible_conflict", currentVersion: latest }, 409);
      latest++;
      return json({ version: latest, shared });
    }
    reads++;
    return json({ project: draft, revision, shared, projects: [{ id: draft.id, name: draft.name }], productions: [] });
  });
  await page.goto("/workbench");
  await expect(page.locator(".save-label")).toHaveText("Saved");
  latest = 2; // A second collaborator publishes while this tab is editing v1.
  await goStage(page, "Assets & takes");
  await page.getByRole("button", { name: `Edit ${draft.assets[0].name}`, exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Publish this version", exact: true }).click();
  await expect.poll(() => attempts).toEqual([1]);
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  const reload = page.getByRole("button", { name: "Save & load latest shared context", exact: true });
  await expect(reload).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
  await page.screenshot({path:testInfo.outputPath('publication-conflict.png')});
  await goStage(page, "Brief & ideas");
  failSaves = true;
  await page.getByLabel("Project title", { exact: true }).fill("My private changes survive");
  await expect(page.locator(".save-banner").filter({ hasText: "Keep the private edit on screen" })).toBeVisible();
  const before = reads;
  await reload.click();
  await expect(page.getByLabel("Project title", { exact: true })).toHaveValue("My private changes survive");
  expect(reads).toBe(before);
  failSaves = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.locator(".save-label")).toHaveText("Saved");
  await reload.click();
  await expect(reload).not.toBeVisible();
  await expect(page.getByLabel("Project title", { exact: true })).toHaveValue("My private changes survive");
  expect(draft.name).toBe("My private changes survive");
  expect(attempts).toEqual([1]); // Refresh never automatically republishes.
  await goStage(page, "Assets & takes");
  await page.getByRole("button", { name: `Edit ${draft.assets[0].name}`, exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Publish this version", exact: true }).click();
  await expect.poll(() => attempts).toEqual([1, 2]);
});

test("thinking model library groups and searches every provider, and effort survives quote and request recovery", async ({ page }, testInfo) => {
  await signInLocally(page.request);
  await fixture(page);
  const efforts = [{ value: "low", label: "Low", description: "Faster planning" }, { value: "high", label: "High", description: "More time for complex planning" }];
  const models = [
    { id: "anthropic/claude-opus-4.6", name: "Claude Opus 4.6", vision: true, efforts },
    { id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6", vision: true, efforts },
    { id: "openai/gpt-5.5", name: "GPT-5.5", vision: true, efforts },
    { id: "google/gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview", vision: true, efforts },
    ...Array.from({length:24}, (_, i) => ({ id:`openai/test-${i}`, name:`OpenAI archived model ${i}`, vision:false, efforts:[] })),
  ];
  const quotes: Record<string, unknown>[] = [];
  const submissions: string[] = [];
  await page.route("**/api/workbench/atomik**", async route => {
    const request = route.request();
    const body = request.method() === "POST" ? request.postDataJSON() : {};
    const reply = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (body.quoteOnly) {
      quotes.push(body);
      return reply({ model: body.model === "auto" ? models[0].id : body.model, effort: body.effort, estimateCredits: body.effort === "high" ? 8 : 2, estimateUsd: body.effort === "high" ? .08 : .02 });
    }
    if (request.method() === "POST") {
      submissions.push(request.postData()!);
      if (submissions.length === 1) return reply({ error: "The original request is unconfirmed. Recover this request." }, 503);
      return reply({ job: { id: "effort-recovered", requestId: body.requestId, status: "queued" } }, 202);
    }
    return reply({ models, jobs: [] });
  });
  await page.goto("/workbench");
  if (!(await page.getByRole("tab", {name:"Genie",exact:true}).isVisible()))
    await page.getByRole("button", {name:"Toggle Atomik creative engine",exact:true}).click();
  await page.getByRole("tab", {name:"Genie",exact:true}).click();
  const modelTrigger = page.getByRole("button", {name:"Reasoning model",exact:true});
  await modelTrigger.click();
  const picker = page.getByRole("dialog", {name:"Choose a thinking model",exact:true});
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("group", {name:"Claude",exact:true})).toHaveCount(1);
  await expect(picker.getByRole("group", {name:"OpenAI",exact:true})).toHaveCount(1);
  await expect(picker.getByRole("group", {name:"Gemini",exact:true})).toHaveCount(1);
  await expect(picker.getByRole("option")).toHaveCount(models.length + 1);
  await expect.poll(async () => {
    const bounds = await picker.boundingBox(), viewport = page.viewportSize()!;
    return !!bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width + 1 && bounds.y + bounds.height <= viewport.height + 1;
  }).toBe(true);
  await page.screenshot({path:testInfo.outputPath("thinking-model-library.png")});
  await picker.getByRole("button", {name:"Gemini",exact:true}).click();
  await expect(picker.getByRole("option")).toHaveCount(1);
  await picker.getByRole("button", {name:"All",exact:true}).click();
  const search = picker.getByRole("combobox", {name:"Search thinking models",exact:true});
  await search.fill("claude");
  await search.press("ArrowDown");
  await search.press("Enter");
  await expect(picker).not.toBeVisible();
  await expect(modelTrigger).toContainText("Claude Sonnet 4.6");
  await expect(modelTrigger).toBeFocused();
  await modelTrigger.click();
  await picker.getByRole("combobox", {name:"Search thinking models",exact:true}).fill("no-model-matches-this");
  await expect(picker.getByRole("listbox", {name:"Thinking models",exact:true})).toContainText("No models found.");
  await page.keyboard.press("Escape");
  await expect(modelTrigger).toBeFocused();
  await page.getByRole("combobox", {name:"Reasoning effort",exact:true}).click();
  await page.getByRole("option", {name:/^High/}).click();
  await page.getByLabel("Ask Atomik", {exact:true}).fill("Plan a cinematic studio sequence with the selected references");
  await page.getByRole("button", {name:"Run Atomik",exact:true}).click();
  const confirmation = page.getByRole("dialog", {name:"Plan with Genie",exact:true});
  await expect(confirmation.getByRole("button", {name:"Atomik request model",exact:true})).toContainText("Claude Sonnet 4.6");
  await expect(confirmation.getByRole("combobox", {name:"Atomik request effort",exact:true})).toContainText("High");
  await expect(confirmation.getByRole("button", {name:"Run · 8 cr estimated",exact:true})).toBeEnabled();
  await confirmation.getByRole("combobox", {name:"Atomik request effort",exact:true}).click();
  await page.getByRole("option", {name:/^Low/}).click();
  await expect(confirmation.getByRole("button", {name:"Run · 2 cr estimated",exact:true})).toBeEnabled();
  expect(quotes.at(-1)).toMatchObject({ model: "anthropic/claude-sonnet-4.6", effort: "low" });
  await confirmation.getByRole("combobox", {name:"Atomik request effort",exact:true}).click();
  await page.getByRole("option", {name:/^High/}).click();
  await confirmation.getByRole("button", {name:"Run · 8 cr estimated",exact:true}).click();
  await expect(confirmation.getByRole("alert")).toContainText("unconfirmed");
  expect(JSON.parse(submissions[0])).toMatchObject({ model: "anthropic/claude-sonnet-4.6", effort: "high", maxCredits: 8 });
  await confirmation.getByRole("button", {name:"Close",exact:true}).click();
  await page.getByRole("button", {name:"Run Atomik",exact:true}).click();
  await expect(confirmation.getByRole("button", {name:"Atomik request model",exact:true})).toBeDisabled();
  await expect(confirmation.getByRole("combobox", {name:"Atomik request effort",exact:true})).toBeDisabled();
  await expect(confirmation.getByRole("combobox", {name:"Atomik request effort",exact:true})).toContainText("High");
  await confirmation.getByRole("button", {name:"Recover this request",exact:true}).click();
  await expect(confirmation).not.toBeVisible();
  expect(submissions).toHaveLength(2);
  expect(submissions[1]).toBe(submissions[0]);
});

test("node original downloads preserve source bytes independently of rendered adjustments", async ({ page }) => {
  await signInLocally(page.request);
  const me = await page.request.get('/api/me').then(response => response.json());
  const sharp = (await import('sharp')).default;
  const originalBytes = await sharp({ create: { width: 4096, height: 2160, channels: 3, background: '#647c91' } }).png().toBuffer();
  const upload = await page.request.post('/api/uploads', {
    headers: { 'X-Workbench-Scope': `particl-active-${me.workspace.id}-${me.id}` },
    multipart: { file: { name: 'Camera original.png', mimeType: 'image/png', buffer: originalBytes } },
  });
  expect(upload.ok(), await upload.text()).toBeTruthy();
  const uploaded = await upload.json();
  const state = await fixture(page);
  // Chrome's download manager must reach the real authenticated streaming route.
  await page.route(`**${uploaded.url}*`, route => route.continue());
  const source = state.current().assets.find(asset => asset.id === 'hero')!;
  source.url = uploaded.url;
  source.uploadId = uploaded.id;
  source.mime = uploaded.mime;
  const node = state.current().nodes.find(item => item.id === 'generate-browser')!;
  node.assetId = source.id;
  node.operations = [{ id: 'bright-preview', kind: 'grade', enabled: true, values: { brightness: 150, contrast: 120, saturation: 30 } }];
  await page.goto('/workbench');
  await goStage(page, 'Production canvas');
  const mobile = page.viewportSize()!.width < 760;
  if (mobile) await page.locator('.mobile-node-viewbar').getByRole('tab', { name: 'List', exact: true }).click();
  const target = mobile
    ? page.locator('.mobile-node-list button').filter({ hasText: 'Browser test shot' }).first()
    : page.getByRole('article', { name: 'Generate node: Browser test shot', exact: true });
  await target.click();
  const inspector = page.getByRole('complementary', { name: 'Node inspector' });
  // Short landscape starts with more canvas space; Enter opens the selected node.
  if (!(await inspector.isVisible())) await target.press('Enter');
  await expect(inspector.getByRole('button', { name: 'Download original', exact: true })).toBeVisible();
  await expect(inspector.getByRole('button', { name: 'Source-size PNG', exact: true })).toBeVisible();
  const first = page.waitForEvent('download');
  await inspector.getByRole('button', { name: 'Download original', exact: true }).click();
  const original = await first;
  expect(new URL(original.url()).pathname).toBe(uploaded.url);
  expect(new URL(original.url()).search).toBe('?download=1');
  expect(original.suggestedFilename()).toBe('Camera original.png');
  const downloaded = await readFile((await original.path())!);
  expect(downloaded).toEqual(originalBytes);
  expect(await sharp(downloaded).metadata()).toMatchObject({ width: 4096, height: 2160 });
  if (mobile) await page.getByRole('dialog', { name: 'Node controls', exact: true }).locator('.mobile-sheet-done').click();
  await target.focus();
  await target.press('Shift+F10');
  const menu = page.getByRole('menu', { name: 'Browser test shot actions', exact: true });
  const next = page.waitForEvent('download');
  await menu.getByRole('menuitem', { name: 'Download original', exact: true }).click();
  expect(await readFile((await (await next).path())!)).toEqual(originalBytes);
});
