import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { SIZES, expectBusinessFloors, fixture, openBusiness, still } from "./helpers/businessOwn";
import { EMPTY_MOLECULR } from "../lib/workbench/moleculr";
import { EMPTY_BRAND_KIT } from "../lib/workbench/moleculr-creative";
import { referenceAdAnalysisSchema } from "../lib/workbench/reference-ad-analysis";
import type { Asset } from "../lib/workbench/studio";

/**
 * Business › Hooks, Reference and Design in the Suites shell: the hooks list and
 * the Campaign agent that writes more of them, the reference-ad review of twelve
 * sampled stills, and the poster designer's editable layers exported as a PNG
 * original. Each paid agent step shows its approximate price in the Atomik
 * dialog before it runs, and runs only when Run is pressed. Real local sign-in on
 * an ENGINE_MOCK server; the agent route, the project store, the Library and
 * stored media are route-mocked. (Brand, Product, Format, Setup:
 * suites-business-own-workbench.spec.ts.)
 */
const MODEL = "anthropic/claude-sonnet-4.6";
const MODELS = [{ id: MODEL, name: "Claude Sonnet 4.6", vision: true, efforts: [{ value: "high", label: "High" }, { value: "low", label: "Low" }] }];
const VIDEO = readFileSync("tests/fixtures/astra-source.mp4");

type Agent = { jobs: Record<string, unknown>[]; quotes: Record<string, unknown>[]; paid: Record<string, unknown>[]; frames: string[]; failing: boolean };
/** The existing Atomik route, as it answers: priced models, a quote for exactly the request, then the run with its plan. While `failing`, every read of the runs fails. */
async function mockAgent(page: Page, estimate: number, failing = false): Promise<Agent> {
  const agent: Agent = { jobs: [], quotes: [], paid: [], frames: [], failing };
  await page.route(/\/api\/workbench\/atomik\/frames(\?.*)?$/, (route) => {
    const id = `review-frame-${agent.frames.length}`;
    agent.frames.push(id);
    return route.fulfill({ json: { id } });
  });
  await page.route(/\/api\/workbench\/atomik(\?.*)?$/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET") {
      if (agent.failing) return route.fulfill({ status: 503, json: { error: "Atomik could not read this project’s runs." } });
      const requestId = url.searchParams.get("requestId");
      return route.fulfill({ json: requestId ? { jobs: agent.jobs.filter((job) => job.requestId === requestId) } : { configured: true, models: MODELS, defaultModel: MODEL, jobs: agent.jobs } });
    }
    const body = request.postDataJSON() as Record<string, unknown> & { requestId: string; projectId: string; request: string; referenceAd?: { assetId: string; sourceKey: string }; videoFrames?: { uploadId: string; timeSeconds: number }[] };
    if (body.quoteOnly) { agent.quotes.push(body); return route.fulfill({ json: { model: MODEL, effort: body.effort, estimateCredits: estimate } }); }
    agent.paid.push(body);
    if (body.maxCredits !== estimate) return route.fulfill({ status: 409, json: { error: "Review the credit estimate before starting this request." } });
    const base = { requestId: body.requestId, projectId: body.projectId, productionProjectId: "prod-granite", request: body.request, model: MODEL, depth: body.depth, effort: body.effort, role: "marketing", refs: body.refs, estimateCredits: estimate, credits: estimate - 1, error: null, createdAt: Date.now(), updatedAt: Date.now() };
    if (body.suite === "moleculr") {
      const job = { ...base, id: "job-hooks", suite: "moleculr", status: "succeeded", plan: {
        id: "job-hooks", request: body.request, model: MODEL, depth: body.depth, effort: body.effort, refs: [], role: "marketing", intent: "campaign", summary: "Opening lines against the brief.", steps: ["Hooks written against the approved facts."], applied: false,
        suiteAgent: { suite: "moleculr", projectId: body.projectId, actions: [{ kind: "note", title: "Hooks", prompt: "Opening lines for the campaign.", referenceIds: [] }], hooks: ["Stop scrolling", "Salt, not sugar.", "Made at sea."], assumptions: [] },
      } };
      agent.jobs.push(job);
      return route.fulfill({ json: { job } });
    }
    const samples = (body.videoFrames ?? []).map((frame) => ({ uploadId: frame.uploadId, timeSeconds: frame.timeSeconds, sha256: "a".repeat(64) }));
    const analysis = referenceAdAnalysisSchema.parse({
      projectId: body.projectId, jobId: "job-reference", model: MODEL, createdAt: new Date().toISOString(),
      evidence: { source: body.referenceAd, durationSeconds: Math.max(...samples.map((s) => s.timeSeconds)) + 0.1, samples },
      result: {
        summary: "A dark open becomes a bright product reveal.", beats: [{ sampleIndex: 0, observation: "A centred silhouette.", adaptation: "Open on the bottle in frost." }],
        camera: "Centred framing; movement is not established.", pacing: "A tonal change is inferred between stills.", colors: ["deep blue", "warm white"],
        direction: "Adapt the dark open into a frost-lit bottle reveal.", uncertainties: ["No audio or cut timing was assessed."],
      },
    });
    const job = { ...base, id: "job-reference", status: "succeeded", plan: { id: "job-reference", request: body.request, model: MODEL, depth: body.depth, effort: body.effort, refs: body.refs, role: "marketing", intent: "campaign", summary: analysis.result.summary, steps: [analysis.result.direction], applied: false, referenceAdAnalysis: analysis } };
    agent.jobs.push(job);
    return route.fulfill({ json: { job } });
  });
  return agent;
}

test("Hooks: twelve lines kept by hand; the Campaign agent is priced at about N cr before it runs, and only the lines taken join the list", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.setTimeout(150_000);
  let agent: Agent | null = null;
  const brief = { ...EMPTY_MOLECULR, productName: "Salt bottle", productDescription: "Hand-blown glass, 500 ml.", hooks: ["Stop scrolling"], brandKit: { ...EMPTY_BRAND_KIT, name: "Granite" } };
  const seen = await openBusiness(page, "hooks", fixture({ moleculr: brief }), { routes: async () => { agent = await mockAgent(page, 3, true); } });
  await expect(page.getByTestId("page-title")).toHaveText("Hooks");
  /* The agent's runs could not be read: nothing can be priced until they are, and Try again reads them once more. */
  await expect(page.getByTestId("hooks-blocked")).toHaveText("The agent’s runs could not be read. Try again below.");
  await expect(page.getByTestId("hooks-agent").getByRole("alert")).toContainText("Atomik could not read this project’s runs.");
  await expect(page.getByTestId("hooks-price")).toBeDisabled();
  agent!.failing = false;
  await page.getByTestId("hooks-agent").getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("hooks-blocked")).toHaveCount(0);
  await expect(page.getByTestId("hooks-price")).toBeEnabled();
  await expect(page.getByTestId("hooks-list")).toContainText("Hooks · 1 of 12");
  await page.getByTestId("hooks-add").click();
  await page.getByTestId("hooks-line").nth(1).fill("Harvested by hand.");
  await expect.poll(() => seen.store.project.moleculr?.hooks, { timeout: 15_000 }).toEqual(["Stop scrolling", "Harvested by hand."]);
  await page.getByRole("button", { name: "Remove hook 2" }).click();
  await expect(page.getByTestId("hooks-line")).toHaveCount(1);

  /* The agent: its request is the hooks writer's; the price comes first, in the Atomik dialog. */
  await expect(page.getByTestId("hooks-request")).toHaveValue(/Write 12 distinct opening lines/);
  await page.getByTestId("hooks-price").click();
  const dialog = page.getByRole("dialog", { name: "Campaign agent" });
  const run = dialog.getByRole("button", { name: "Run · about 3 cr" });
  await expect(run).toBeEnabled({ timeout: 30_000 });
  await expect(dialog.getByTestId("atomik-run-estimate")).toContainText("about 3 cr · up to 3 cr reserved");
  expect(agent!.quotes.length).toBeGreaterThan(0);
  expect(agent!.quotes[0]).toMatchObject({ suite: "moleculr", role: "marketing", projectId: "ws-granite", refs: [] });
  expect(String(agent!.quotes[0].request)).toMatch(/^\[moleculr\] Write 12 distinct opening lines/);
  expect(seen.paid).toEqual([]);
  await run.click();
  await expect(dialog).toHaveCount(0);
  expect(agent!.paid).toHaveLength(1);
  expect(agent!.paid[0]).toMatchObject({ maxCredits: 3, model: MODEL });

  const result = page.getByTestId("hooks-run");
  await expect(result).toContainText("Salt, not sugar.");
  await expect(page.getByTestId("hooks-run-cost")).toHaveText("2 cr");
  /* One of the three is on the list already: two are new. */
  await result.getByTestId("hooks-take").click();
  await expect(page.getByTestId("hooks-line")).toHaveCount(3);
  await expect(result.getByTestId("hooks-take")).toHaveText("All on the list");
  await expect.poll(() => seen.store.project.moleculr?.hooks, { timeout: 15_000 }).toEqual(["Stop scrolling", "Salt, not sugar.", "Made at sea."]);
  await expectBusinessFloors(page, info.project.name, "hooks-tool", "hooks-save");
  expect(seen.paid).toEqual(["/api/workbench/atomik"]);
  expect(seen.store.refused).toEqual([]);
  expect(seen.account).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test("Reference: a project video is chosen; its review of twelve stills is priced at about N cr before it runs; the reviewed direction is applied only when taken", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.setTimeout(180_000);
  let agent: Agent | null = null;
  const ad: Asset = { ...still("up_ad"), kind: "video", mime: "video/mp4", name: "Founder unboxing.mp4", category: "Reference" };
  const seen = await openBusiness(page, "reference", fixture({ assets: [ad], moleculr: { ...EMPTY_MOLECULR, productName: "Salt bottle" } }), { routes: async () => {
    agent = await mockAgent(page, 7);
    await page.route(/\/api\/uploads\/up_ad(\?.*)?$/, (route) => route.fulfill({ body: VIDEO, contentType: "video/mp4", headers: { "accept-ranges": "bytes" } }));
  } });
  await expect(page.getByTestId("page-title")).toHaveText("Reference ad");
  await expect(page.getByTestId("reference-blocked")).toHaveText("Choose the reference video first.");
  await page.getByTestId("reference-originals").getByRole("button", { name: "Founder unboxing.mp4" }).click();
  await expect(page.getByTestId("reference-name")).toContainText("Founder unboxing.mp4 · the original, unchanged");
  await page.getByTestId("reference-notes").fill("The cold open.");
  await page.getByTestId("reference-direction").fill("Keep my direction until I review.");
  await expect.poll(() => seen.store.project.moleculr?.referenceAd, { timeout: 15_000 }).toMatchObject({ assetId: "up_ad", notes: "The cold open.", direction: "Keep my direction until I review." });

  await page.getByTestId("reference-price").click();
  const dialog = page.getByRole("dialog", { name: "Analyze reference ad" });
  const run = dialog.getByRole("button", { name: "Run · about 7 cr" });
  await expect(run).toBeEnabled({ timeout: 60_000 });
  /* Twelve stills were sampled from the original to price it; nothing paid has run. */
  expect(agent!.frames).toHaveLength(12);
  expect(agent!.quotes.at(-1)).toMatchObject({ referenceAd: { assetId: "up_ad", sourceKey: JSON.stringify({ uploadId: "up_ad" }) }, refs: ["up_ad"] });
  expect(seen.paid).toEqual([]);
  await run.click();
  await expect(dialog).toHaveCount(0);
  expect(agent!.paid).toHaveLength(1);

  const analysis = page.getByTestId("reference-analysis");
  await expect(analysis).toContainText("A dark open becomes a bright product reveal.");
  /* Read, not yet taken: the direction on the reference is still the person's. */
  await expect(page.getByTestId("reference-direction")).toHaveValue("Keep my direction until I review.");
  await page.getByTestId("reference-reviewed").fill("A frost-lit reveal of our own bottle.");
  await page.getByTestId("reference-apply").click();
  await expect(page.getByTestId("reference-direction")).toHaveValue("A frost-lit reveal of our own bottle.");
  await expect.poll(() => seen.store.project.moleculr?.referenceAd?.analysis?.jobId, { timeout: 15_000 }).toBe("job-reference");
  expect(seen.store.project.moleculr?.referenceAd).toMatchObject({ assetId: "up_ad", notes: "The cold open.", direction: "A frost-lit reveal of our own bottle." });
  /* The original is untouched. */
  expect(seen.store.project.assets.find((a) => a.id === "up_ad")).toMatchObject({ uploadId: "up_ad", url: "/api/uploads/up_ad", kind: "video" });
  await expectBusinessFloors(page, info.project.name, "reference-tool", "reference-save");
  expect(seen.store.refused).toEqual([]);
  expect(seen.account).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test("Design: a poster of editable text, shape and image layers is saved with the project, exported as a full-size PNG and filed as a new original", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  test.setTimeout(180_000);
  const seen = await openBusiness(page, "design", fixture({ moleculr: { ...EMPTY_MOLECULR, productName: "Salt bottle", brandKit: { ...EMPTY_BRAND_KIT, name: "Granite", tagline: "Salt of the north", colors: ["#102030", "#F4F1EA"] } } }));
  await expect(page.getByTestId("page-title")).toHaveText("Poster designer");
  await page.getByTestId("design-create").click();
  await expect(page.getByTestId("design-layers").locator("li")).toHaveCount(2);
  await expect.poll(() => seen.store.project.moleculr?.poster?.background, { timeout: 15_000 }).toBe("#102030");
  expect(seen.store.project.moleculr?.poster?.layers.map((l) => l.name)).toEqual(["Headline", "Call to action"]);
  expect(seen.store.project.moleculr?.poster?.layers[0]).toMatchObject({ kind: "text", text: "Salt of the north" });

  await page.getByTestId("design-add-text").click();
  await page.getByTestId("design-text").fill("Harvested by hand.");
  await page.getByTestId("design-add-shape").click();
  await page.getByTestId("design-add-image").click();
  await page.getByTestId("design-picker").getByRole("button", { name: "harbour-plate.webp" }).click();
  await expect(page.getByTestId("design-layers").locator("li")).toHaveCount(5);
  /* Moved by number, like any layer: the image sits 20% in. */
  await page.getByTestId("design-inspector").getByLabel("Left (%)").fill("20");
  await page.getByTestId("design-aspect").getByRole("button", { name: "9:16" }).click();
  /* Lock the headline: its inspector cannot change it. */
  await page.getByRole("button", { name: "Lock Headline", exact: true }).click();
  await page.getByTestId("design-layers").getByRole("button", { name: "Headline", exact: true }).click();
  await expect(page.getByTestId("design-inspector")).toHaveAttribute("disabled", "");
  await expect(page.getByTestId("design-locked")).toHaveText("Headline is locked. Unlock it in the layers to change it.");
  await expect.poll(() => seen.store.project.moleculr?.poster?.layers.length, { timeout: 15_000 }).toBe(5);
  await expect.poll(() => seen.store.project.moleculr?.poster?.aspect, { timeout: 15_000 }).toBe("9:16");
  const layers = seen.store.project.moleculr!.poster!.layers;
  expect(layers.map((l) => l.kind)).toEqual(["text", "text", "text", "shape", "image"]);
  expect(layers[2]).toMatchObject({ text: "Harvested by hand." });
  expect(layers[4]).toMatchObject({ kind: "image", assetId: "up_plate", x: 20 });
  expect(layers[0]).toMatchObject({ locked: true });
  /* The image layer's original joined the draft with its upload identity. */
  expect(seen.store.project.assets.find((a) => a.id === "up_plate")).toMatchObject({ uploadId: "up_plate", kind: "image" });
  await expect(page.getByTestId("design-canvas")).toBeVisible();

  const download = page.waitForEvent("download");
  await page.getByTestId("design-export").click();
  expect((await download).suggestedFilename()).toBe("Salt_of_the_north-1215x2160.png");
  await expect(page.getByTestId("design-notice")).toContainText("is downloaded");
  await page.getByTestId("design-save").click();
  await expect(page.getByTestId("design-notice")).toContainText("is in this project’s Library", { timeout: 60_000 });
  await expect.poll(() => seen.store.project.assets.find((a) => a.category === "Campaign design" && a.mime === "image/png"), { timeout: 15_000 }).toBeTruthy();
  const saved = seen.store.project.assets.find((a) => a.category === "Campaign design" && a.mime === "image/png")!;
  expect(saved).toMatchObject({ kind: "image", name: "Salt_of_the_north-1215x2160.png", refs: ["up_plate"] });
  expect(saved.uploadId).toBe(saved.id);
  await expectBusinessFloors(page, info.project.name, "design-tool", "design-save-state");
  expect(seen.paid).toEqual([]);
  expect(seen.store.refused).toEqual([]);
  expect(seen.account).toEqual([]);
  expect(seen.errors).toEqual([]);
});
