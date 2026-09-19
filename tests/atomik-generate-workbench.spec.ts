import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { saveSchema } from "../lib/workbench/studio-schema";
import { parseConnectedCatalogue } from "../lib/higgsfield-consumer/catalogue";

const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=", "base64");
const wallet = "22222222-2222-4222-8222-222222222222";
const providerId = "33333333-3333-4333-8333-333333333333";
const generationId = `gen_hfc_${"d".repeat(40)}`;
const catalogue = parseConnectedCatalogue(JSON.parse(readFileSync("tests/fixtures/connected-models.json", "utf8")), 1_758_000_000_000);
type Job = Record<string, unknown> & { id: string; status: string };

async function fixture(page: Page, options: { connected?: boolean; unlim?: boolean } = {}) {
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((response) => response.json());
  me.owner = true;
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  let project: Project = { ...newProject("Atomik film"), id: "atomik-draft", productionProjectId: "actual-production" };
  let revision = 1;
  const jobs: Job[] = [], posts: Record<string, unknown>[] = [], unexpected: string[] = [], external: string[] = [], errors: string[] = [];
  const upload = { id: "still-original", filename: "Bottle.png", kind: "image", mime: "image/png", bytes: 500, width: 512, height: 512, durationS: null, sha256: "f".repeat(64), createdAt: Date.now(), url: "/api/uploads/still-original" };
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
    if (path === `/api/media/${generationId}` || path === "/api/uploads/still-original") return route.fulfill({ body: pixel, contentType: "image/png" });
    if (path === "/api/higgsfield/consumer/connection") return json({ connected: options.connected ?? true, requiresReconnect: false });
    if (path === "/api/higgsfield/consumer/generation") {
      expect(request.headers()["x-workbench-scope"]).toBe(scope);
      if (request.method() === "GET") {
        expect(url.searchParams.get("draftId")).toBe(project.id);
        return json({ connection: { connected: options.connected ?? true, requiresReconnect: false }, capabilities: { types: ["image", "video", "audio", "3d"], promptLimit: 5000, maxMedias: 30, maxMediaBytes: 52428800, maxOriginalBytes: 104857600, importsMediaForQuote: true, cancel: false }, jobs: [...jobs].reverse() });
      }
      const body = request.postDataJSON();
      posts.push(body);
      if (body.action === "catalogue")
        return json({ catalogue: { models: catalogue.models, unlim: { available: options.unlim === true, remaining: options.unlim ? 5 : null, expiresAt: null }, complete: true, fetchedAt: catalogue.fetchedAt } });
      expect(body.draftId).toBe(project.id);
      if (body.action === "quote") {
        expect(body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
        const model = catalogue.models.find((item) => item.id === body.input.model)!;
        const job: Job = { id: `11111111-1111-4111-8111-${String(jobs.length + 1).padStart(12, "0")}`, draftId: project.id, status: "quoted", input: body.input,
          model: { id: model.id, name: model.name, outputType: model.outputType }, workspaceId: wallet, workspaceName: "Studio wallet", quoteCredits: 9, creditUnit: "higgsfield_credits",
          quoteExpiresAt: Date.now() + 300000, providerJobId: null, result: null, createdAt: Date.now() };
        jobs.push(job);
        return json({ job });
      }
      const job = jobs.find((item) => item.id === body.id)!;
      expect(job).toBeTruthy();
      if (body.action === "submit") {
        expect(body).toEqual({ action: "submit", draftId: project.id, id: job.id, workspaceId: wallet, credits: 9 });
        job.status = "accepted"; job.providerJobId = providerId; job.providerReceipt = { job_id: providerId, response: { results: [{ id: providerId, model: "nano_banana_2", type: "image" }] } };
        return json({ job });
      }
      if (body.action === "status") {
        expect(body).toEqual({ action: "status", draftId: project.id, id: job.id });
        job.status = "completed"; job.originalAvailable = true; job.originalAvailability = "available";
        job.result = { original: { generationId, providerJobId: providerId, bytes: pixel.length, sha256: "b".repeat(64), width: 1024, height: 1024, mime: "image/png", credits: 9, creditUnit: "higgsfield_credits",
          asset: { generationId, url: `/api/media/${generationId}`, kind: "image", mime: "image/png", width: 1024, height: 1024 } }, providerResult: { model: "nano_banana_2", type: "image" } };
        return json({ job, pollAfterSeconds: 15 });
      }
    }
    if (path === "/api/higgsfield/consumer/audio-tools" && request.method() === "POST") {
      const body = request.postDataJSON();
      posts.push(body);
      if (body.action === "voices")
        return json({ voices: { voices: [{ id: "voice-nova", type: "preset", name: "Nova", language: "en-US" }, { id: "elem-1", type: "element", name: "My studio voice" }], complete: true, fetchedAt: Date.now() } });
      unexpected.push(`voice ${body.action}`);
      return json({ error: "No other mutation permitted." }, 409);
    }
    if (path === "/api/workbench/projects") {
      expect(request.headers()["x-workbench-scope"]).toBe(scope);
      if (request.method() === "PUT") {
        project = saveSchema.parse(request.postDataJSON()).project as Project;
        posts.push({ action: "save-project", assets: project.assets.map((asset) => asset.generationId) });
        return json({ revision: ++revision, productionProjectId: project.productionProjectId, shotMappings: {} });
      }
      return json({ project: !url.searchParams.get("id") || url.searchParams.get("id") === project.id ? project : null, projects: [{ id: project.id, name: project.name }], revision, productions: [] });
    }
    if (path === "/api/workbench/library") return json({ uploads: url.searchParams.get("source") === "generations" ? [] : [upload], generations: [], nextCursor: null, nextPageCursor: null });
    if (path === "/api/uploads") return json({ uploads: [upload], nextCursor: null, nextPageCursor: null });
    if (path === "/api/uploads/still-original/metadata") { expect(request.headers()["x-workbench-scope"]).toBe(scope); return json({ upload }); }
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
async function useReference(page: Page, id: string) {
  const card = page.locator(`[data-library-id="${id}"]`);
  await expect(card).toBeVisible();
  if (page.viewportSize()!.width < 760) {
    await card.getByRole("button", { name: /^Actions for / }).click();
    await page.getByRole("menuitem", { name: "Use as reference", exact: true }).click();
  } else await card.getByRole("button", { name: "Use as reference", exact: true }).click();
}
const noOverflow = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

test("Generate picks a catalogue model, quotes in connected credits, approves the exact price, collects the original and saves it to the project", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/atomik?project=atomik-draft&page=generate");
  const panel = page.getByRole("region", { name: "Generate on the connected account", exact: true });
  await expect(page.getByRole("heading", { name: "Generate", exact: true }).first()).toBeVisible();
  await expect(panel.getByRole("combobox", { name: "Generate model", exact: true })).toBeVisible();
  await noOverflow(page);
  expect(state.posts).toEqual([{ action: "catalogue" }]);
  // The picker is grouped by workflow; provider names never appear in copy.
  const workflows = panel.getByRole("group", { name: "Generate workflow", exact: true });
  await expect(workflows.getByRole("button")).toHaveText(["Image", "Video", "Sound", "3D"]);
  await workflows.getByRole("button", { name: "3D", exact: true }).click();
  await expect(panel.getByText("17 3d models", { exact: false })).toBeVisible();
  await workflows.getByRole("button", { name: "Image", exact: true }).click();
  await expect(panel.getByText("34 image models", { exact: false })).toBeVisible();
  expect((await panel.innerText()).toLowerCase()).not.toContain("higgsfield");
  const model = panel.getByRole("combobox", { name: "Generate model", exact: true });
  await model.selectOption("nano_banana_2");
  const selected = panel.getByLabel("Selected model", { exact: true });
  await expect(selected.getByText("Image 2", { exact: true })).toBeVisible();
  await expect(selected).toContainText("auto · 1:1 · 3:2");
  await expect(selected).toContainText("image_references, mask");
  // Settings are generated from the model's declared parameters.
  const settings = panel.getByRole("group", { name: "Model settings", exact: true });
  await settings.getByRole("combobox", { name: "resolution", exact: true }).selectOption("2k");
  await settings.getByRole("combobox", { name: "aspect ratio", exact: true }).selectOption("1:1");
  await expect(settings.getByRole("checkbox", { name: "is inpaint", exact: true })).not.toBeChecked();
  await panel.getByRole("textbox", { name: "Generate prompt", exact: true }).fill("A plain bottle on a clean studio background.");
  // A project original becomes a reference under a declared role, with the copy disclosure.
  const roles = panel.getByRole("group", { name: "Reference role", exact: true });
  await expect(roles.getByRole("button", { name: "image references · image", exact: true })).toHaveAttribute("aria-pressed", "true");
  await useReference(page, "upload:still-original");
  await expect(panel.getByRole("combobox", { name: "Role for Bottle.png", exact: true })).toHaveValue("image_references");
  const quoteButton = panel.getByRole("button", { name: "Get connected-credit quote", exact: true });
  await expect(quoteButton).toBeDisabled();
  await panel.getByRole("checkbox", { name: /copied to the connected account/ }).check();
  await expect(quoteButton).toBeEnabled();
  await quoteButton.click();
  const quote = panel.getByLabel("Connected-credit quote", { exact: true });
  await expect(quote.getByText("9 connected credits · Studio wallet", { exact: true })).toBeVisible();
  await expect(quote).toContainText("Image · Image 2 · resolution 2k · aspect ratio 1:1 · 1 reference file");
  await noOverflow(page);
  const quoted = state.posts.find((body) => body.action === "quote")!;
  expect(quoted.input).toEqual({ type: "image", model: "nano_banana_2", prompt: "A plain bottle on a clean studio background.", parameters: { resolution: "2k", aspect_ratio: "1:1" }, medias: [{ role: "image_references", source: { uploadId: "still-original" } }] });
  const generate = quote.getByRole("button", { name: "Generate · 9 connected credits", exact: true });
  await expect(generate).toBeDisabled();
  await quote.getByRole("checkbox", { name: "Charge 9 connected credits to Studio wallet for this generation.", exact: true }).check();
  await generate.click();
  const results = page.getByRole("region", { name: "Saved generation jobs", exact: true });
  const card = results.locator("article").first();
  await expect(card.getByText("In progress", { exact: true })).toBeVisible();
  expect(state.posts.filter((body) => body.action === "submit")).toHaveLength(1);
  await card.getByRole("button", { name: "Check result", exact: true }).click();
  await expect(card.getByText("Original ready", { exact: true })).toBeVisible();
  await expect(card.getByRole("img")).toHaveAttribute("src", `/api/media/${generationId}`);
  await expect(card.getByRole("link", { name: "Download original", exact: true })).toHaveAttribute("href", `/api/media/${generationId}?download=1`);
  await card.getByRole("button", { name: "Save to project", exact: true }).click();
  await expect(card.getByRole("button", { name: "In project library", exact: true })).toBeDisabled();
  expect(state.posts.find((body) => body.action === "save-project")).toEqual({ action: "save-project", assets: [generationId] });
  expect(state.project.assets.at(-1)).toMatchObject({ generationId, kind: "image", mime: "image/png", category: "Generate", url: `/api/media/${generationId}` });
  expect(state.posts.map((body) => body.action)).toEqual(["catalogue", "quote", "submit", "status", "save-project"]);
  await noOverflow(page);
  // Reload: the saved job and its original survive without re-quoting or resubmitting.
  await page.reload();
  await expect(page.getByRole("region", { name: "Saved generation jobs", exact: true }).getByText("Original ready", { exact: true })).toBeVisible();
  expect(state.posts.filter((body) => body.action === "submit")).toHaveLength(1);
  expect(state.unexpected).toEqual([]); expect(state.external).toEqual([]); expect(state.errors).toEqual([]);
});

test("a disconnected account cannot quote, unlimited-eligible models are flagged, and settings the model does not declare cannot be sent", async ({ page }) => {
  const state = await fixture(page, { connected: false, unlim: true });
  await page.goto("/atomik?project=atomik-draft&page=generate");
  const panel = page.getByRole("region", { name: "Generate on the connected account", exact: true });
  await expect(panel.getByText("Connect or reconnect the owner’s account", { exact: false })).toBeVisible();
  await expect(panel.getByText("The connected catalogue is not loaded.", { exact: false })).toBeVisible();
  expect(state.posts.filter((body) => body.action === "catalogue")).toHaveLength(0);
  await expect(panel.getByRole("button", { name: "Get connected-credit quote", exact: true })).toBeDisabled();
  await noOverflow(page);
  expect(state.posts.filter((body) => body.action === "quote")).toEqual([]);
  expect(state.unexpected).toEqual([]); expect(state.external).toEqual([]); expect(state.errors).toEqual([]);
});

test("the Sound and Video workflows expose declared enum, number and toggle settings and refuse an incomplete required setting", async ({ page }) => {
  const state = await fixture(page, { unlim: true });
  await page.goto("/atomik?project=atomik-draft&page=generate");
  const panel = page.getByRole("region", { name: "Generate on the connected account", exact: true });
  const workflows = panel.getByRole("group", { name: "Generate workflow", exact: true });
  await workflows.getByRole("button", { name: "Sound", exact: true }).click();
  const model = panel.getByRole("combobox", { name: "Generate model", exact: true });
  await expect(model.locator("option", { hasText: "Audio 1.0 · unlimited-eligible" })).toHaveCount(1);
  // Game-pipeline-only models are never offered for standalone sound.
  await expect(model.locator("option:not([value=''])")).toHaveCount(3);
  for (const hidden of ["sonilo_music", "mirelo_text_to_audio", "inworld_text_to_speech"]) await expect(model.locator(`option[value="${hidden}"]`)).toHaveCount(0);
  await model.selectOption("text2speech_v2");
  await panel.getByRole("textbox", { name: "Generate prompt", exact: true }).fill("Welcome to the studio.");
  const settings = panel.getByRole("group", { name: "Model settings", exact: true });
  // Voice is chosen from the connected account's voices, not typed.
  await expect(settings.getByRole("textbox", { name: "voice id", exact: true })).toHaveCount(0);
  const voice = panel.getByRole("combobox", { name: "Voice", exact: true });
  await expect(voice.locator("option", { hasText: "Nova · en-US" })).toHaveCount(1);
  await expect(voice.locator("optgroup").nth(1)).toHaveAttribute("label", "Your voices");
  await voice.selectOption("preset:voice-nova");
  await expect(panel.getByText("requires the setting “variant”.", { exact: false })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Get connected-credit quote", exact: true })).toBeDisabled();
  await settings.getByRole("combobox", { name: "variant", exact: true }).selectOption("minimax");
  await expect(panel.getByRole("button", { name: "Get connected-credit quote", exact: true })).toBeEnabled();
  await panel.getByRole("button", { name: "Get connected-credit quote", exact: true }).click();
  await expect(panel.getByLabel("Connected-credit quote", { exact: true })).toBeVisible();
  expect(state.posts.filter((body) => body.action === "voices")).toHaveLength(1);
  expect(state.posts.find((body) => body.action === "quote")!.input).toEqual({ type: "audio", model: "text2speech_v2", prompt: "Welcome to the studio.", parameters: { voice_type: "preset", voice_id: "voice-nova", variant: "minimax" }, medias: [] });
  await workflows.getByRole("button", { name: "Video", exact: true }).click();
  await model.selectOption("kling3_0");
  await expect(panel.getByLabel("Selected model", { exact: true })).toContainText("Unlimited-eligible");
  await expect(panel.getByLabel("Selected model", { exact: true })).toContainText("3–15 s");
  await settings.getByRole("combobox", { name: "sound", exact: true }).selectOption("off");
  await settings.getByRole("spinbutton", { name: "duration", exact: true }).fill("20");
  await panel.getByRole("textbox", { name: "Generate prompt", exact: true }).fill("Slow push in.");
  await expect(panel.getByText("The setting “duration” must be at most 15.", { exact: true })).toBeVisible();
  await settings.getByRole("spinbutton", { name: "duration", exact: true }).fill("10");
  await panel.getByRole("button", { name: "Get connected-credit quote", exact: true }).click();
  const quoted = state.posts.filter((body) => body.action === "quote")[1];
  expect(quoted.input).toEqual({ type: "video", model: "kling3_0", prompt: "Slow push in.", parameters: { sound: "off", duration: 10 }, medias: [] });
  await noOverflow(page);
  expect(state.unexpected).toEqual([]); expect(state.external).toEqual([]); expect(state.errors).toEqual([]);
});
