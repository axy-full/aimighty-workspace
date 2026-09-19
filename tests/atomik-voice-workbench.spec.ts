import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { saveSchema } from "../lib/workbench/studio-schema";
import { parseConnectedCatalogue } from "../lib/higgsfield-consumer/catalogue";
import { CONNECTED_TOOLS } from "../lib/higgsfield-consumer/tools";
import { DUBBING_LANGUAGES, VOICE_TOOLS, findVoiceTool } from "../lib/higgsfield-consumer/voice-tools";

const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=", "base64");
const wallet = "22222222-2222-4222-8222-222222222222";
const providerId = "33333333-3333-4333-8333-333333333333";
const generationId = `gen_hfc_${"c".repeat(40)}`;
const catalogue = parseConnectedCatalogue(JSON.parse(readFileSync("tests/fixtures/connected-models.json", "utf8")), 1_758_000_000_000);
type Job = Record<string, unknown> & { id: string; status: string; input: { tool: string; targetLanguage?: string } };
const uploads = {
  still: { id: "still-original", filename: "Bottle.png", kind: "image", mime: "image/png", bytes: 500, width: 512, height: 512, durationS: null, sha256: "f".repeat(64), createdAt: Date.now(), url: "/api/uploads/still-original" },
  clip: { id: "clip-original", filename: "Hero take.mp4", kind: "video", mime: "video/mp4", bytes: 4000, width: 640, height: 360, durationS: 2, sha256: "e".repeat(64), createdAt: Date.now(), url: "/api/uploads/clip-original" },
};

/** Same mocked owner surface as the Tools spec, plus the audio-tools endpoint. */
async function fixture(page: Page, options: { analysis?: boolean } = {}) {
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((response) => response.json());
  me.owner = true;
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  let project: Project = { ...newProject("Atomik film"), id: "atomik-draft", productionProjectId: "actual-production" };
  let revision = 1;
  const jobs: Job[] = [], posts: Record<string, unknown>[] = [], unexpected: string[] = [], external: string[] = [], errors: string[] = [];
  const tools = VOICE_TOOLS.filter((tool) => tool.name !== "video_analysis" || options.analysis === true).map((tool) => ({ name: tool.name, label: tool.label, output: tool.output, suffix: tool.suffix }));
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (["localhost", "127.0.0.1"].includes(url.hostname)) return route.continue();
    external.push(url.href);
    return route.abort("blockedbyclient");
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    if (path === "/api/me") return json(me);
    if (path === "/api/uploads/still-original") return route.fulfill({ body: pixel, contentType: "image/png" });
    if (path === "/api/uploads/clip-original" || path === `/api/media/${generationId}`) return route.fulfill({ body: pixel, contentType: "video/mp4" });
    if (path === "/api/higgsfield/consumer/connection") return json({ connected: true, requiresReconnect: false });
    if (path === "/api/higgsfield/consumer/generation") {
      expect(request.headers()["x-workbench-scope"]).toBe(scope);
      if (request.method() === "GET")
        return json({ connection: { connected: true, requiresReconnect: false }, capabilities: { types: ["image", "video", "audio", "3d"], tools: CONNECTED_TOOLS, promptLimit: 5000, maxMedias: 30, maxMediaBytes: 52428800, maxOriginalBytes: 104857600, importsMediaForQuote: true, cancel: false }, jobs: [] });
      const body = request.postDataJSON();
      posts.push(body);
      if (body.action === "catalogue") return json({ catalogue: { models: catalogue.models, unlim: { available: false, remaining: null, expiresAt: null }, complete: true, fetchedAt: catalogue.fetchedAt } });
      unexpected.push(`generation ${body.action}`);
      return json({ error: "No generation call expected." }, 409);
    }
    if (path === "/api/higgsfield/consumer/audio-tools") {
      expect(request.headers()["x-workbench-scope"]).toBe(scope);
      if (request.method() === "GET") {
        expect(url.searchParams.get("draftId")).toBe(project.id);
        return json({ connection: { connected: true, requiresReconnect: false }, capabilities: { voice: true, dubbing: true, analysis: options.analysis === true, reframe: true, tools, languages: DUBBING_LANGUAGES, sourceKind: "video", maxSourceBytes: 52428800, maxOriginalBytes: 104857600, importsMediaForQuote: true, priceSources: ["get_cost"], cancel: false }, jobs: [...jobs].reverse() });
      }
      const body = request.postDataJSON();
      posts.push(body);
      if (body.action === "voices") {
        expect(body).toEqual({ action: "voices" });
        return json({ voices: { voices: [{ id: "voice-nova", type: "preset", name: "Nova", language: "en-US" }, { id: "voice-atlas", type: "preset", name: "Atlas" }, { id: "elem-1", type: "element", name: "My studio voice" }], complete: true, fetchedAt: Date.now() } });
      }
      expect(body.draftId).toBe(project.id);
      if (body.action === "quote") {
        expect(body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
        const tool = findVoiceTool(body.input.tool)!;
        const job: Job = { id: `11111111-1111-4111-8111-${String(jobs.length + 1).padStart(12, "0")}`, draftId: project.id, status: "quoted", input: body.input,
          tool: { name: tool.name, label: tool.label, suffix: tool.suffix, output: tool.output }, source: { kind: "video", name: "Hero take.mp4" }, priceSource: "get_cost", ...(tool.name === "reframe" ? { pricedSeconds: 2 } : {}),
          workspaceId: wallet, workspaceName: "Studio wallet", quoteCredits: 9, creditUnit: "higgsfield_credits", quoteExpiresAt: Date.now() + 300000, providerJobId: null, result: null, createdAt: Date.now() };
        jobs.push(job);
        return json({ job });
      }
      const job = jobs.find((item) => item.id === body.id)!;
      expect(job).toBeTruthy();
      if (body.action === "submit") {
        expect(body).toEqual({ action: "submit", draftId: project.id, id: job.id, workspaceId: wallet, credits: 9 });
        job.status = "accepted"; job.providerJobId = providerId; job.providerReceipt = { job_id: providerId, response: { results: [{ id: providerId, model: job.input.tool, type: "video" }] } };
        return json({ job });
      }
      if (body.action === "status") {
        expect(body).toEqual({ action: "status", draftId: project.id, id: job.id });
        job.status = "completed";
        if (job.input.tool === "video_analysis") {
          job.originalAvailable = false; job.originalAvailability = "not_collected";
          job.result = { report: { figures: [{ key: "scores.hook_strength", label: "hook strength", value: 72 }, { key: "scores.attention", label: "attention", value: 64 }, { key: "scores.retention", label: "retention", value: 0.6 }, { key: "virality_score", label: "virality score", value: 58 }], scenes: [{ index: 0, start: 0, end: 3, text: "Opening on the bottle." }, { index: 1, start: 3, end: 9, text: "Hands turn the cap." }], sceneCount: 2, summary: "A short product demo with a strong opening." }, providerResult: { tool: "video_analysis", estimate: true } };
        } else {
          job.originalAvailable = true; job.originalAvailability = "available";
          job.result = { original: { generationId, providerJobId: providerId, bytes: pixel.length, sha256: "b".repeat(64), width: 640, height: 360, seconds: 2, credits: 9, creditUnit: "higgsfield_credits",
            asset: { generationId, url: `/api/media/${generationId}`, kind: "video", mime: "video/mp4", width: 640, height: 360, durationS: 2 } }, providerResult: { tool: job.input.tool, type: "video" } };
        }
        return json({ job, pollAfterSeconds: 15 });
      }
    }
    if (path === "/api/workbench/projects") {
      expect(request.headers()["x-workbench-scope"]).toBe(scope);
      if (request.method() === "PUT") {
        project = saveSchema.parse(request.postDataJSON()).project as Project;
        posts.push({ action: "save-project", assets: project.assets.map((asset) => asset.name) });
        return json({ revision: ++revision, productionProjectId: project.productionProjectId, shotMappings: {} });
      }
      return json({ project: !url.searchParams.get("id") || url.searchParams.get("id") === project.id ? project : null, projects: [{ id: project.id, name: project.name }], revision, productions: [] });
    }
    if (path === "/api/workbench/library") return json({ uploads: url.searchParams.get("source") === "generations" ? [] : Object.values(uploads), generations: [], nextCursor: null, nextPageCursor: null });
    if (path === "/api/uploads") return json({ uploads: Object.values(uploads), nextCursor: null, nextPageCursor: null });
    for (const upload of Object.values(uploads))
      if (path === `/api/uploads/${upload.id}/metadata`) { expect(request.headers()["x-workbench-scope"]).toBe(scope); return json({ upload }); }
    if (path === "/api/pipelines") return json({ runs: [], publications: [], models: [], audioModels: { speech: [], sound: "", music: "" } });
    if (path === "/api/jobs") return json({ generations: [], nextCursor: null, nextPageCursor: null });
    if (path === "/api/atomik") return json({ chats: [], models: { featured: [], rest: [] }, engines: [] });
    if (path === "/api/workbench/atomik") return json({ configured: false, models: [], jobs: [] });
    if (path === "/api/projects") return json({ projects: [] });
    if (path === "/api/settings") return json({ settings: {}, models: { image: "", video: "", text: {} } });
    if (request.method() !== "GET") { unexpected.push(`${request.method()} ${path}`); return json({ error: "No other mutation permitted." }, 409); }
    return json({});
  });
  return { scope, posts, jobs, unexpected, external, errors, get project() { return project; } };
}
async function useSource(page: Page, id: string) {
  const card = page.locator(`[data-library-id="${id}"]`);
  await expect(card).toBeVisible();
  if (page.viewportSize()!.width < 760) {
    await card.getByRole("button", { name: /^Actions for / }).click();
    await page.getByRole("menuitem", { name: "Use as reference", exact: true }).click();
  } else await card.getByRole("button", { name: "Use as reference", exact: true }).click();
}
const noOverflow = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
/** Quote → approve exact credits → submit once → check result. */
async function runTool(page: Page, state: Awaited<ReturnType<typeof fixture>>, label: string, checkQuote: (quote: ReturnType<Page["getByLabel"]>) => Promise<void>) {
  const panel = page.getByRole("region", { name: "Generate on the connected account", exact: true });
  const quoteButton = panel.getByRole("button", { name: "Get connected-credit quote", exact: true });
  await expect(quoteButton).toBeDisabled();
  await panel.getByRole("checkbox", { name: /copied to the connected account/ }).check();
  await expect(quoteButton).toBeEnabled();
  await quoteButton.click();
  const quote = panel.getByLabel("Connected-credit quote", { exact: true });
  await expect(quote.getByText("9 connected credits · Studio wallet", { exact: true })).toBeVisible();
  await expect(quote).toContainText("Priced by the connected account’s own quote for exactly these settings.");
  await checkQuote(quote);
  await noOverflow(page);
  const run = quote.getByRole("button", { name: `${label} · 9 connected credits`, exact: true });
  await expect(run).toBeDisabled();
  await quote.getByRole("checkbox", { name: `Charge 9 connected credits to Studio wallet for this ${label.toLowerCase()} run.`, exact: true }).check();
  await run.click();
  const results = panel.getByRole("region", { name: "Saved voice jobs", exact: true });
  const card = results.locator("article").first();
  await expect(card.getByText("In progress", { exact: true })).toBeVisible();
  expect(state.posts.filter((body) => body.action === "submit")).toHaveLength(1);
  await card.getByRole("button", { name: "Check result", exact: true }).click();
  await noOverflow(page);
  return card;
}

test("Change voice picks a listed voice and one project video, quotes at the exact price, runs once and files “<source> · voice changed”", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/atomik?project=atomik-draft&page=generate");
  const panel = page.getByRole("region", { name: "Generate on the connected account", exact: true });
  const voiceGroup = panel.getByRole("group", { name: "Voice tools", exact: true });
  // Analyse video is absent while the capability stays off.
  await expect(voiceGroup.getByRole("button")).toHaveText(["Change voice", "Dub"]);
  await noOverflow(page);
  await voiceGroup.getByRole("button", { name: "Change voice", exact: true }).click();
  await expect(voiceGroup.getByRole("button", { name: "Change voice", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByRole("group", { name: "Generate workflow", exact: true }).getByRole("button", { name: "Image", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(panel.getByRole("textbox", { name: "Generate prompt", exact: true })).toHaveCount(0);
  await expect(panel.getByRole("combobox", { name: "Generate model", exact: true })).toHaveCount(0);
  await expect(panel.getByLabel("Selected tool", { exact: true })).toContainText("Change voice: Replace the spoken voice in a project video");
  // Voices come from the connected account's listing, grouped by kind, with no preview links.
  const voice = panel.getByRole("combobox", { name: "Voice", exact: true });
  await expect(voice.locator("option")).toHaveText(["Choose a voice", "Nova · en-US", "Atlas", "My studio voice"]);
  await expect(voice.locator("optgroup").nth(0)).toHaveAttribute("label", "Preset voices");
  await expect(voice.locator("optgroup").nth(1)).toHaveAttribute("label", "Your voices");
  await expect(panel.getByText("3 voices", { exact: false })).toBeVisible();
  expect(state.posts.filter((body) => body.action === "voices")).toHaveLength(1);
  expect((await panel.innerText()).toLowerCase()).not.toContain("higgsfield");
  await expect(panel.getByText("Change voice needs one video from this project.", { exact: true })).toBeVisible();
  await voice.selectOption("preset:voice-nova");
  // Only a video can be the source; the role chip says so and an image is refused.
  await expect(panel.getByRole("group", { name: "Source role", exact: true }).getByRole("button")).toHaveText(["video source"]);
  await useSource(page, "upload:still-original");
  await expect(panel.getByRole("alert")).toContainText("Change voice needs a video file.");
  await useSource(page, "upload:clip-original");
  await expect(panel.getByRole("group", { name: "Source file", exact: true })).toContainText("Hero take.mp4");
  const card = await runTool(page, state, "Change voice", async (quote) => {
    await expect(quote).toContainText("Change voice · Hero take.mp4 · voice Nova");
    await expect(quote).toContainText("Result: “Hero take · voice changed”.");
  });
  const quoted = state.posts.find((body) => body.action === "quote")!;
  expect(quoted.input).toEqual({ tool: "voice_change", source: { uploadId: "clip-original" }, voice: { id: "voice-nova", type: "preset", name: "Nova" } });
  await expect(card.getByText("Original ready", { exact: true })).toBeVisible();
  await expect(card).toContainText("Change voice · voice Nova · Studio wallet");
  await expect(card.locator("video")).toHaveAttribute("src", `/api/media/${generationId}`);
  await expect(card.getByRole("link", { name: "Download original", exact: true })).toHaveAttribute("href", `/api/media/${generationId}?download=1`);
  await card.getByRole("button", { name: "Save to project", exact: true }).click();
  await expect(card.getByRole("button", { name: "In project library", exact: true })).toBeDisabled();
  expect(state.posts.find((body) => body.action === "save-project")).toEqual({ action: "save-project", assets: ["Hero take · voice changed"] });
  expect(state.project.assets.at(-1)).toMatchObject({ name: "Hero take · voice changed", kind: "video", mime: "video/mp4", category: "Voice", generationId, url: `/api/media/${generationId}`, description: "Change voice · voice Nova · 9 connected credits" });
  expect(state.posts.map((body) => body.action)).toEqual(["catalogue", "voices", "quote", "submit", "status", "save-project"]);
  await noOverflow(page);
  // Reload: the saved job and its original survive without re-quoting or resubmitting.
  await page.reload();
  await page.getByRole("region", { name: "Generate on the connected account", exact: true }).getByRole("group", { name: "Voice tools", exact: true }).getByRole("button", { name: "Change voice", exact: true }).click();
  const results = page.getByRole("region", { name: "Saved voice jobs", exact: true });
  await expect(results.getByText("Original ready", { exact: true })).toBeVisible();
  await expect(results.getByRole("button", { name: "In project library", exact: true })).toBeDisabled();
  expect(state.posts.filter((body) => body.action === "submit")).toHaveLength(1);
  expect(state.posts.filter((body) => body.action === "quote")).toHaveLength(1);
  await noOverflow(page);
  // Back to a workflow: the prompt returns and the voice tool is cleared.
  await page.getByRole("group", { name: "Generate workflow", exact: true }).getByRole("button", { name: "Video", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Generate prompt", exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Voice tools", exact: true }).getByRole("button", { name: "Change voice", exact: true })).toHaveAttribute("aria-pressed", "false");
  expect(state.unexpected).toEqual([]); expect(state.external).toEqual([]); expect(state.errors).toEqual([]);
});

test("Dub chooses one of the advertised target languages, quotes and runs once, and files “<source> · dubbed (<language>)”", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/atomik?project=atomik-draft&page=generate");
  const panel = page.getByRole("region", { name: "Generate on the connected account", exact: true });
  await panel.getByRole("group", { name: "Voice tools", exact: true }).getByRole("button", { name: "Dub", exact: true }).click();
  await expect(panel.getByRole("combobox", { name: "Voice", exact: true })).toHaveCount(0);
  expect(state.posts.filter((body) => body.action === "voices")).toHaveLength(0);
  const language = panel.getByRole("combobox", { name: "Target language", exact: true });
  await expect(language.locator("option")).toHaveCount(DUBBING_LANGUAGES.length + 1);
  await expect(language.locator("option").nth(3)).toHaveText("French · fra");
  await expect(panel.getByText("Dub needs one video from this project.", { exact: true })).toBeVisible();
  await useSource(page, "upload:clip-original");
  await expect(panel.getByText("Choose the language to dub into.", { exact: true })).toBeVisible();
  await language.selectOption("fra");
  await noOverflow(page);
  const card = await runTool(page, state, "Dub", async (quote) => {
    await expect(quote).toContainText("Dub · Hero take.mp4 · into French");
    await expect(quote).toContainText("Result: “Hero take · dubbed (French)”.");
  });
  const quoted = state.posts.find((body) => body.action === "quote")!;
  expect(quoted.input).toEqual({ tool: "dubbing", source: { uploadId: "clip-original" }, targetLanguage: "fra" });
  await expect(card.getByText("Original ready", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Save to project", exact: true }).click();
  await expect(card.getByRole("button", { name: "In project library", exact: true })).toBeDisabled();
  expect(state.project.assets.at(-1)).toMatchObject({ name: "Hero take · dubbed (French)", kind: "video", category: "Voice", description: "Dub · into French · 9 connected credits" });
  expect(state.posts.map((body) => body.action)).toEqual(["catalogue", "quote", "submit", "status", "save-project"]);
  expect((await panel.innerText()).toLowerCase()).not.toContain("higgsfield");
  await noOverflow(page);
  expect(state.unexpected).toEqual([]); expect(state.external).toEqual([]); expect(state.errors).toEqual([]);
});

test("Analyse video appears only when the capability is on, and a completed report is shown as the connected account’s estimate and saved as a project note", async ({ page }) => {
  const state = await fixture(page, { analysis: true });
  await page.goto("/atomik?project=atomik-draft&page=generate");
  const panel = page.getByRole("region", { name: "Generate on the connected account", exact: true });
  const voiceGroup = panel.getByRole("group", { name: "Voice tools", exact: true });
  await expect(voiceGroup.getByRole("button")).toHaveText(["Change voice", "Dub", "Analyse video"]);
  await voiceGroup.getByRole("button", { name: "Analyse video", exact: true }).click();
  await expect(panel.getByLabel("Selected tool", { exact: true })).toContainText("Shorter clips give the most reliable report.");
  await useSource(page, "upload:clip-original");
  const card = await runTool(page, state, "Analyse video", async (quote) => {
    await expect(quote).toContainText("Result: a scene-by-scene report filed as a project note.");
  });
  expect(state.posts.find((body) => body.action === "quote")!.input).toEqual({ tool: "video_analysis", source: { uploadId: "clip-original" } });
  await expect(card.getByText("Report ready", { exact: true })).toBeVisible();
  const report = card.getByLabel("Analysis report", { exact: true });
  await expect(report).toContainText("The connected account’s estimate for this video, not a measurement.");
  await expect(report).toContainText("A short product demo with a strong opening.");
  for (const [label, value] of [["hook strength", "72"], ["attention", "64"], ["retention", "0.6"], ["virality score", "58"]]) {
    const figure = report.locator("dt", { hasText: label }).first();
    await expect(figure).toBeVisible();
    await expect(figure.locator("xpath=following-sibling::dd")).toHaveText(value);
  }
  await expect(report).toContainText("2 scenes");
  await expect(report).toContainText("Scene 1 · 0–3 s · Opening on the bottle.");
  await expect(card.locator("video")).toHaveCount(0);
  await report.getByRole("button", { name: "Save report to project", exact: true }).click();
  await expect(report.getByRole("button", { name: "In project library", exact: true })).toBeDisabled();
  expect(state.project.assets.at(-1)).toMatchObject({ name: "Hero take · analysed", kind: "document", category: "Voice", id: `analysis_${providerId}` });
  expect(String(state.project.assets.at(-1)!.description)).toContain("hook strength: 72");
  expect(String(state.project.assets.at(-1)!.description)).toContain("not a measurement");
  expect(state.posts.map((body) => body.action)).toEqual(["catalogue", "quote", "submit", "status", "save-project"]);
  await noOverflow(page);
  expect(state.unexpected).toEqual([]); expect(state.external).toEqual([]); expect(state.errors).toEqual([]);
});

test("Reframe sits with the Tools, takes an advertised aspect ratio and resolution, is priced for the stored length and files “<source> · reframed (<ratio>)”", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/atomik?project=atomik-draft&page=generate");
  const panel = page.getByRole("region", { name: "Generate on the connected account", exact: true });
  await expect(panel.getByRole("group", { name: "Voice tools", exact: true }).getByRole("button", { name: "Reframe", exact: true })).toHaveCount(0);
  await panel.getByRole("group", { name: "Tools", exact: true }).getByRole("button", { name: "Reframe", exact: true }).click();
  await expect(panel.getByRole("group", { name: "Tools", exact: true }).getByRole("button", { name: "Reframe", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByRole("textbox", { name: "Generate prompt", exact: true })).toHaveCount(0);
  const ratio = panel.getByRole("combobox", { name: "Target aspect ratio", exact: true });
  await expect(ratio.locator("option")).toHaveCount(7);
  await expect(panel.getByRole("combobox", { name: "Resolution", exact: true })).toHaveValue("720p");
  await useSource(page, "upload:clip-original");
  await expect(panel.getByText("Choose the target aspect ratio.", { exact: true })).toBeVisible();
  await ratio.selectOption("9:16");
  await panel.getByRole("combobox", { name: "Resolution", exact: true }).selectOption("1080p");
  await noOverflow(page);
  const card = await runTool(page, state, "Reframe", async (quote) => {
    await expect(quote).toContainText("Reframe · Hero take.mp4 · to 9:16 at 1080p · 2 s");
    await expect(quote).toContainText("Result: “Hero take · reframed (9:16)”.");
  });
  const quoted = state.posts.find((body) => body.action === "quote")!;
  expect(quoted.input).toEqual({ tool: "reframe", source: { uploadId: "clip-original" }, aspectRatio: "9:16", resolution: "1080p" });
  await expect(card.getByText("Original ready", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Save to project", exact: true }).click();
  await expect(card.getByRole("button", { name: "In project library", exact: true })).toBeDisabled();
  expect(state.project.assets.at(-1)).toMatchObject({ name: "Hero take · reframed (9:16)", kind: "video", category: "Tools", description: "Reframe · to 9:16 at 1080p · 2 s · 9 connected credits" });
  expect(state.posts.map((body) => body.action)).toEqual(["catalogue", "quote", "submit", "status", "save-project"]);
  expect((await panel.innerText()).toLowerCase()).not.toContain("higgsfield");
  await noOverflow(page);
  expect(state.unexpected).toEqual([]); expect(state.external).toEqual([]); expect(state.errors).toEqual([]);
});
