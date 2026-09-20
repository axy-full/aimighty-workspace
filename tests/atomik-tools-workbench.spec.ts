import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { saveSchema } from "../lib/workbench/studio-schema";
import { parseConnectedCatalogue } from "../lib/higgsfield-consumer/catalogue";
import { CONNECTED_TOOLS, requireConnectedTool } from "../lib/higgsfield-consumer/tools";
import { legacyShell } from "./helpers/legacyShell";

const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=", "base64");
const wallet = "22222222-2222-4222-8222-222222222222";
const providerId = "33333333-3333-4333-8333-333333333333";
const catalogue = parseConnectedCatalogue(JSON.parse(readFileSync("tests/fixtures/connected-models.json", "utf8")), 1_758_000_000_000);
type Job = Record<string, unknown> & { id: string; status: string; model: { id: string; name: string; outputType: string } };
const uploads = {
  still: { id: "still-original", filename: "Bottle.png", kind: "image", mime: "image/png", bytes: 500, width: 512, height: 512, durationS: null, sha256: "f".repeat(64), createdAt: Date.now(), url: "/api/uploads/still-original" },
  clip: { id: "clip-original", filename: "Hero take.mp4", kind: "video", mime: "video/mp4", bytes: 4000, width: 640, height: 360, durationS: 2, sha256: "e".repeat(64), createdAt: Date.now(), url: "/api/uploads/clip-original" },
};

/** Same mocked owner surface as the Generate spec, with an image and a video original in the library. */
async function fixture(page: Page) {
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((response) => response.json());
  me.owner = true;
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  let project: Project = { ...newProject("Atomik film"), id: "atomik-draft", productionProjectId: "actual-production" };
  let revision = 1;
  const jobs: Job[] = [], posts: Record<string, unknown>[] = [], unexpected: string[] = [], external: string[] = [], errors: string[] = [];
  const generationIds: string[] = [];
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
    if (path === "/api/uploads/clip-original") return route.fulfill({ body: pixel, contentType: "video/mp4" });
    if (generationIds.some((id) => path === `/api/media/${id}`)) return route.fulfill({ body: pixel, contentType: path.includes("bbbb") ? "video/mp4" : "image/png" });
    if (path === "/api/higgsfield/consumer/connection") return json({ connected: true, requiresReconnect: false });
    if (path === "/api/higgsfield/consumer/generation") {
      expect(request.headers()["x-workbench-scope"]).toBe(scope);
      if (request.method() === "GET") {
        expect(url.searchParams.get("draftId")).toBe(project.id);
        return json({ connection: { connected: true, requiresReconnect: false }, capabilities: { types: ["image", "video", "audio", "3d"], tools: CONNECTED_TOOLS, promptLimit: 5000, maxMedias: 30, maxMediaBytes: 52428800, maxOriginalBytes: 104857600, importsMediaForQuote: true, cancel: false }, jobs: [...jobs].reverse() });
      }
      const body = request.postDataJSON();
      posts.push(body);
      if (body.action === "catalogue")
        return json({ catalogue: { models: catalogue.models, unlim: { available: false, remaining: null, expiresAt: null }, complete: true, fetchedAt: catalogue.fetchedAt } });
      expect(body.draftId).toBe(project.id);
      if (body.action === "quote") {
        const model = catalogue.models.find((item) => item.id === body.input.model)!;
        const tool = body.input.tool ? requireConnectedTool(body.input.tool.name) : null;
        const sources = (body.input.medias as { role: string; source: { uploadId: string } }[]).map((media) => {
          const upload = Object.values(uploads).find((item) => item.id === media.source.uploadId)!;
          return { role: media.role, kind: upload.kind, name: upload.filename };
        });
        const job: Job = { id: `11111111-1111-4111-8111-${String(jobs.length + 1).padStart(12, "0")}`, draftId: project.id, status: "quoted", input: body.input,
          model: { id: model.id, name: model.name, outputType: model.outputType }, tool: tool ? { name: tool.name, label: tool.label, model: body.input.tool.model, suffix: tool.suffix } : null, sources,
          workspaceId: wallet, workspaceName: "Studio wallet", quoteCredits: 9, creditUnit: "higgsfield_credits", quoteExpiresAt: Date.now() + 300000, providerJobId: null, result: null, createdAt: Date.now() };
        jobs.push(job);
        return json({ job });
      }
      const job = jobs.find((item) => item.id === body.id)!;
      expect(job).toBeTruthy();
      if (body.action === "submit") {
        expect(body).toEqual({ action: "submit", draftId: project.id, id: job.id, workspaceId: wallet, credits: 9 });
        job.status = "accepted"; job.providerJobId = providerId; job.providerReceipt = { job_id: providerId, response: { results: [{ id: providerId, model: job.model.id, type: job.model.outputType }] } };
        return json({ job });
      }
      if (body.action === "status") {
        expect(body).toEqual({ action: "status", draftId: project.id, id: job.id });
        const video = job.model.outputType === "video";
        const generationId = `gen_hfc_${(video ? "b" : "a").repeat(40)}`;
        generationIds.push(generationId);
        job.status = "completed"; job.originalAvailable = true; job.originalAvailability = "available";
        job.result = { original: { generationId, providerJobId: providerId, bytes: pixel.length, sha256: "b".repeat(64), width: 1024, height: 1024, ...(video ? { seconds: 2 } : { mime: "image/png" }), credits: 9, creditUnit: "higgsfield_credits",
          asset: { generationId, url: `/api/media/${generationId}`, kind: video ? "video" : "image", mime: video ? "video/mp4" : "image/png", width: 1024, height: 1024 } }, providerResult: { model: job.model.id, type: job.model.outputType } };
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
/** Quote → approve exact credits → submit once → collect → save under the derived name. */
async function runTool(page: Page, state: Awaited<ReturnType<typeof fixture>>, expectedName: string) {
  const panel = page.getByRole("region", { name: "Generate on the connected account", exact: true });
  const quoteButton = panel.getByRole("button", { name: "Get connected-credit quote", exact: true });
  await expect(quoteButton).toBeDisabled();
  await panel.getByRole("checkbox", { name: /copied to the connected account/ }).check();
  await expect(quoteButton).toBeEnabled();
  await quoteButton.click();
  const quote = panel.getByLabel("Connected-credit quote", { exact: true });
  await expect(quote.getByText("9 connected credits · Studio wallet", { exact: true })).toBeVisible();
  await noOverflow(page);
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
  await card.getByRole("button", { name: "Save to project", exact: true }).click();
  await expect(card.getByRole("button", { name: "In project library", exact: true })).toBeDisabled();
  expect(state.posts.find((body) => body.action === "save-project")).toEqual({ action: "save-project", assets: [expectedName] });
  await noOverflow(page);
  return card;
}

test("Upscale image runs as a tool preset: one image source, declared settings only, filed as “<source> · upscaled”", async ({ page }) => {
  const state = await fixture(page);
  await page.goto(await legacyShell(page, "/atomik?project=atomik-draft&page=generate"));
  const panel = page.getByRole("region", { name: "Generate on the connected account", exact: true });
  const tools = panel.getByRole("group", { name: "Tools", exact: true });
  await expect(tools.getByRole("button")).toHaveText(["Upscale image", "Upscale video", "Remove background (image)", "Remove background (video)", "Extend canvas", "Deflicker", "Lip-sync"]);
  await noOverflow(page);
  await tools.getByRole("button", { name: "Upscale image", exact: true }).click();
  await expect(tools.getByRole("button", { name: "Upscale image", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByRole("group", { name: "Generate workflow", exact: true }).getByRole("button", { name: "Image", exact: true })).toHaveAttribute("aria-pressed", "false");
  // Tools take no prompt; the model list is the tool's candidates only.
  await expect(panel.getByRole("textbox", { name: "Generate prompt", exact: true })).toHaveCount(0);
  const model = panel.getByRole("combobox", { name: "Generate model", exact: true });
  await expect(model).toHaveValue("bytedance_image_upscale");
  await expect(model.locator("option")).toHaveText(["Choose a model for Upscale image", "Image Upscale", "Precision Upscale"]);
  await expect(panel.getByText("2 models for Upscale image", { exact: false })).toBeVisible();
  expect((await panel.innerText()).toLowerCase()).not.toContain("higgsfield");
  const settings = panel.getByRole("group", { name: "Model settings", exact: true });
  await settings.getByRole("combobox", { name: "resolution", exact: true }).selectOption("2k");
  await expect(settings.getByRole("checkbox", { name: "remove bg", exact: true })).not.toBeChecked();
  await expect(panel.getByText("Upscale image needs one image from this project.", { exact: true })).toBeVisible();
  // The source picker offers only the image role; a video original is refused.
  const roles = panel.getByRole("group", { name: "Source role", exact: true });
  await expect(roles.getByRole("button")).toHaveText(["image source"]);
  await useSource(page, "upload:clip-original");
  await expect(panel.getByRole("alert")).toContainText("Upscale image needs an image file.");
  await useSource(page, "upload:still-original");
  await expect(panel.getByRole("combobox", { name: "Role for Bottle.png", exact: true })).toHaveValue("image_references");
  // Switching to the precision upscaler keeps the tool but shows its own required settings.
  await model.selectOption("topaz_image");
  await expect(panel.getByText("Upscale image needs one image from this project.", { exact: true })).toBeVisible();
  await useSource(page, "upload:still-original");
  await expect(panel.getByText("Precision Upscale requires the setting “output_width”.", { exact: true })).toBeVisible();
  await settings.getByRole("spinbutton", { name: "output width", exact: true }).fill("2048");
  await settings.getByRole("spinbutton", { name: "output height", exact: true }).fill("2048");
  const card = await runTool(page, state, "Bottle · upscaled");
  await expect(card).toContainText("Upscale image · Precision Upscale");
  await expect(card.getByRole("img")).toHaveAttribute("src", /\/api\/media\/gen_hfc_a{40}$/);
  const quoted = state.posts.find((body) => body.action === "quote")!;
  expect(quoted.input).toEqual({ type: "image", model: "topaz_image", prompt: "", parameters: { output_width: 2048, output_height: 2048 }, medias: [{ role: "image_references", source: { uploadId: "still-original" } }], tool: { name: "upscale_image", model: "topaz_image" } });
  expect(state.project.assets.at(-1)).toMatchObject({ name: "Bottle · upscaled", kind: "image", mime: "image/png", category: "Tools", description: "Upscale image · Precision Upscale · 9 connected credits" });
  expect(state.posts.map((body) => body.action)).toEqual(["catalogue", "quote", "submit", "status", "save-project"]);
  // Back to a workflow: the prompt returns and the tool is cleared.
  await panel.getByRole("group", { name: "Generate workflow", exact: true }).getByRole("button", { name: "Image", exact: true }).click();
  await expect(panel.getByRole("textbox", { name: "Generate prompt", exact: true })).toBeVisible();
  await expect(tools.getByRole("button", { name: "Upscale image", exact: true })).toHaveAttribute("aria-pressed", "false");
  await noOverflow(page);
  expect(state.unexpected).toEqual([]); expect(state.external).toEqual([]); expect(state.errors).toEqual([]);
});

test("Remove background (video) runs on one project video and files the result as “<source> · background removed”", async ({ page }) => {
  const state = await fixture(page);
  await page.goto(await legacyShell(page, "/atomik?project=atomik-draft&page=generate"));
  const panel = page.getByRole("region", { name: "Generate on the connected account", exact: true });
  await panel.getByRole("group", { name: "Tools", exact: true }).getByRole("button", { name: "Remove background (video)", exact: true }).click();
  const model = panel.getByRole("combobox", { name: "Generate model", exact: true });
  await expect(model).toHaveValue("video_background_remover");
  await expect(panel.getByText("1 models for Remove background (video)", { exact: false })).toBeVisible();
  await expect(panel.getByRole("group", { name: "Model settings", exact: true })).toHaveCount(0);
  await expect(panel.getByText("Remove background (video) needs one video from this project.", { exact: true })).toBeVisible();
  await expect(panel.getByRole("group", { name: "Source role", exact: true }).getByRole("button")).toHaveText(["video source"]);
  await useSource(page, "upload:still-original");
  await expect(panel.getByRole("alert")).toContainText("Remove background (video) needs a video file.");
  await useSource(page, "upload:clip-original");
  await expect(panel.getByRole("combobox", { name: "Role for Hero take.mp4", exact: true })).toHaveValue("video_references");
  await noOverflow(page);
  const card = await runTool(page, state, "Hero take · background removed");
  await expect(card).toContainText("Remove background (video) · Video Background Remover");
  await expect(card.locator("video")).toHaveAttribute("src", /\/api\/media\/gen_hfc_b{40}$/);
  const quoted = state.posts.find((body) => body.action === "quote")!;
  expect(quoted.input).toEqual({ type: "video", model: "video_background_remover", prompt: "", parameters: {}, medias: [{ role: "video_references", source: { uploadId: "clip-original" } }], tool: { name: "remove_background_video", model: "video_background_remover" } });
  expect(state.project.assets.at(-1)).toMatchObject({ name: "Hero take · background removed", kind: "video", mime: "video/mp4", category: "Tools" });
  // Reload: the tool job survives with its label and derived name, without re-quoting.
  await page.reload();
  const results = page.getByRole("region", { name: "Saved generation jobs", exact: true });
  await expect(results.getByText("Original ready", { exact: true })).toBeVisible();
  await expect(results.locator("article").first()).toContainText("Remove background (video) · Video Background Remover");
  await expect(results.getByRole("button", { name: "In project library", exact: true })).toBeDisabled();
  expect(state.posts.filter((body) => body.action === "quote")).toHaveLength(1);
  await noOverflow(page);
  expect(state.unexpected).toEqual([]); expect(state.external).toEqual([]); expect(state.errors).toEqual([]);
});
