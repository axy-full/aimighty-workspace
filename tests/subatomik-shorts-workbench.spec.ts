import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { saveSchema } from "../lib/workbench/studio-schema";
import { legacyShell } from "./helpers/legacyShell";

const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=", "base64");
const wallet = "22222222-2222-4222-8222-222222222222";
const session = "33333333-3333-4333-8333-333333333333";
const clipIds = ["44444444-4444-4444-8444-444444444441", "44444444-4444-4444-8444-444444444442", "44444444-4444-4444-8444-444444444443"];
const genIds = [`gen_hfc_${"a".repeat(40)}`, `gen_hfc_${"b".repeat(40)}`];
const presetId = "7fa32a45-2f1e-45ed-8cc7-03296ddcf07f";
type Job = Record<string, unknown> & { id: string; status: string };

async function fixture(page: Page, options: { connected?: boolean } = {}) {
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((response) => response.json());
  me.owner = true;
  const scope = `particl-active-${me.workspace.id}-${me.id}`;
  let project: Project = { ...newProject("Viral launch"), id: "shorts-draft", productionProjectId: "shorts-production" };
  let revision = 1;
  const jobs: Job[] = [], posts: Record<string, unknown>[] = [], unexpected: string[] = [], external: string[] = [], errors: string[] = [];
  const uploads = [
    { id: "launch-original", filename: "Launch cut.mp4", kind: "video", mime: "video/mp4", bytes: 4000, width: 640, height: 360, durationS: 31, sha256: "e".repeat(64), createdAt: Date.now(), url: "/api/uploads/launch-original" },
    { id: "still-original", filename: "Bottle.png", kind: "image", mime: "image/png", bytes: 500, width: 512, height: 512, durationS: null, sha256: "f".repeat(64), createdAt: Date.now(), url: "/api/uploads/still-original" },
  ];
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
    if (path === "/api/uploads/launch-original" || genIds.some((id) => path === `/api/media/${id}`)) return route.fulfill({ body: pixel, contentType: "video/mp4" });
    if (path === "/api/higgsfield/consumer/connection") return json({ connected: options.connected ?? true, requiresReconnect: false });
    if (path === "/api/higgsfield/consumer/shorts") {
      expect(request.headers()["x-workbench-scope"]).toBe(scope);
      if (request.method() === "GET") {
        expect(url.searchParams.get("draftId")).toBe(project.id);
        return json({ connection: { connected: true, requiresReconnect: false }, capabilities: { shorts: true, aspectRatios: ["9:16", "16:9"], resolution: "720p", minSourceSeconds: 4, maxSourceSeconds: 120, maxClips: 20, cancel: false }, jobs: [...jobs].reverse() });
      }
      const body = request.postDataJSON();
      posts.push(body);
      if (body.action === "presets")
        return json({ presets: { presets: [{ id: presetId, source: "cms", name: "Bold Urban" }], complete: true, fetchedAt: Date.now() } });
      expect(body.draftId).toBe(project.id);
      if (body.action === "quote") {
        expect(body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
        const job: Job = { id: `11111111-1111-4111-8111-${String(jobs.length + 1).padStart(12, "0")}`, draftId: project.id, status: "quoted", input: body.input, source: { kind: "video", name: "Launch cut.mp4" },
          pricedSeconds: 31.01, priceSource: "get_cost", workspaceId: wallet, workspaceName: "Studio wallet", quoteCredits: 40, creditUnit: "higgsfield_credits", quoteExpiresAt: Date.now() + 300000,
          providerJobId: null, clips: [], settlement: null, createdAt: Date.now() };
        jobs.push(job);
        return json({ job });
      }
      const job = jobs.find((item) => item.id === body.id)!;
      expect(job).toBeTruthy();
      if (body.action === "submit") {
        expect(body).toEqual({ action: "submit", draftId: project.id, id: job.id, workspaceId: wallet, credits: 40 });
        job.status = "accepted"; job.providerJobId = session;
        return json({ job });
      }
      if (body.action === "status") {
        expect(body).toEqual({ action: "status", draftId: project.id, id: job.id });
        const original = (index: number) => ({ generationId: genIds[index], providerJobId: clipIds[index === 0 ? 0 : 2], bytes: 4096, sha256: "c".repeat(64), width: 720, height: 1280, seconds: 6, credits: 40, creditUnit: "higgsfield_credits",
          asset: { generationId: genIds[index], url: `/api/media/${genIds[index]}`, kind: "video", mime: "video/mp4", width: 720, height: 1280, durationS: 6 } });
        job.status = "completed";
        job.clips = [
          { index: 0, providerJobId: clipIds[0], state: "collected", availability: "available", original: original(0) },
          { index: 1, providerJobId: clipIds[1], state: "failed", reason: "failed" },
          { index: 2, providerJobId: clipIds[2], state: "collected", availability: "available", original: original(1) },
        ];
        job.settlement = { clips: 3, collected: 2, failed: 1, credits: 40, creditUnit: "higgsfield_credits" };
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
    if (path === "/api/workbench/library") return json({ uploads: url.searchParams.get("source") === "generations" ? [] : uploads, generations: [], nextCursor: null, nextPageCursor: null });
    if (path === "/api/uploads") return json({ uploads, nextCursor: null, nextPageCursor: null });
    for (const upload of uploads) if (path === `/api/uploads/${upload.id}/metadata`) return json({ upload });
    if (path === "/api/jobs") return json({ generations: [], nextCursor: null, nextPageCursor: null });
    if (path === "/api/projects") return json({ projects: [] });
    if (path === "/api/settings") return json({ settings: {}, models: { image: "", video: "", text: {} } });
    if (request.method() !== "GET") { unexpected.push(`${request.method()} ${path}`); return json({ error: "No other mutation permitted." }, 409); }
    return json({});
  });
  return { posts, jobs, unexpected, external, errors, get project() { return project; } };
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

test("Shorts picks a style and one project video, quotes the whole set once, runs once, and files every collected clip", async ({ page }) => {
  const state = await fixture(page);
  await page.goto(await legacyShell(page, "/subatomik?project=shorts-draft&page=shorts"));
  const panel = page.getByRole("region", { name: "Shorts on the connected account", exact: true });
  await expect(panel.getByRole("heading", { name: "Shorts", exact: true })).toBeVisible();
  expect(state.posts.filter((body) => body.action === "presets")).toHaveLength(0);
  await expect(panel.getByText("Pick one video from this project.", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Load styles", exact: true }).click();
  const style = panel.getByRole("combobox", { name: "Style", exact: true });
  // Library styles only: styles saved on the account are never listed (the route never returns them).
  await expect(style.locator("optgroup")).toHaveCount(1);
  await expect(style.locator("optgroup")).toHaveAttribute("label", "Library styles");
  /* Shorts restyles a video: the library offers what it can do with one, not an Edit, Upscale or Use prompt that does nothing here. */
  const launch = page.locator('[data-library-id="upload:launch-original"]');
  await expect(launch).toBeVisible();
  await expect(launch.getByRole("button", { name: /^Edit (clip|image)$/ })).toHaveCount(0);
  await launch.getByRole("button", { name: /^Actions for / }).click();
  await expect(page.getByRole("menuitem", { name: "Use as reference", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /^(Edit clip|Upscale video|Use prompt)$/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await useSource(page, "upload:still-original");
  await expect(panel.getByRole("alert")).toContainText("Shorts need a video file.");
  await useSource(page, "upload:launch-original");
  await expect(panel.getByRole("group", { name: "Source video", exact: true })).toContainText("Launch cut.mp4 · 31 s");
  await expect(panel.getByText("Choose a style.", { exact: true })).toBeVisible();
  await style.selectOption(`cms:${presetId}`);
  await panel.getByRole("combobox", { name: "Orientation", exact: true }).selectOption("16:9");
  const quoteButton = panel.getByRole("button", { name: "Get connected-credit quote", exact: true });
  await expect(quoteButton).toBeDisabled();
  await panel.getByRole("checkbox", { name: /copied to the connected account/ }).check();
  await noOverflow(page);
  await quoteButton.click();
  const quote = panel.getByLabel("Connected-credit quote", { exact: true });
  await expect(quote.getByText("40 connected credits · Studio wallet", { exact: true })).toBeVisible();
  await expect(quote).toContainText("Shorts · Launch cut.mp4 · Bold Urban · 16:9 · priced for 31.01 s");
  await expect(quote).toContainText("One price for the whole set of clips");
  expect(state.posts.find((body) => body.action === "quote")!.input).toEqual({ source: { uploadId: "launch-original" }, preset: { id: presetId, source: "cms", name: "Bold Urban" }, aspectRatio: "16:9" });
  const run = quote.getByRole("button", { name: "Make shorts · 40 connected credits", exact: true });
  await expect(run).toBeDisabled();
  await quote.getByRole("checkbox", { name: "Charge 40 connected credits to Studio wallet for this set of shorts.", exact: true }).check();
  await run.click();
  const sessions = page.getByRole("region", { name: "Saved Shorts sessions", exact: true });
  const card = sessions.locator("article").first();
  await expect(card.getByText("In progress", { exact: true })).toBeVisible();
  expect(state.posts.filter((body) => body.action === "submit")).toHaveLength(1);
  await card.getByRole("button", { name: "Check result", exact: true }).click();
  await expect(card.getByText("2 of 3 clips ready", { exact: true })).toBeVisible();
  await expect(card).toContainText("1 clip failed on the connected account; the session was charged once.");
  const clips = card.getByRole("list", { name: "Clips", exact: true });
  await expect(clips.getByRole("listitem")).toHaveCount(3);
  await expect(clips.getByRole("listitem").nth(1)).toContainText("Clip 2 of 3 · failed");
  await expect(clips.locator("video")).toHaveCount(2);
  await expect(clips.getByRole("link", { name: "Download clip", exact: true }).first()).toHaveAttribute("href", `/api/media/${genIds[0]}?download=1`);
  await noOverflow(page);
  await card.getByRole("button", { name: "Save all 2 clips to project", exact: true }).click();
  await expect(card.getByRole("button", { name: "All clips in project library", exact: true })).toBeDisabled();
  expect(state.project.assets.map((asset) => [asset.name, asset.category, asset.generationId])).toEqual([
    ["Launch cut · short 1 of 3 (Bold Urban)", "Shorts", genIds[0]],
    ["Launch cut · short 3 of 3 (Bold Urban)", "Shorts", genIds[1]],
  ]);
  expect(state.posts.map((body) => body.action)).toEqual(["presets", "quote", "submit", "status", "save-project"]);
  expect((await page.locator(".suite-workspace").innerText()).toLowerCase()).not.toMatch(/higgsfield|supercomputer|genjutsu/);
  await noOverflow(page);
  expect(state.unexpected).toEqual([]); expect(state.external).toEqual([]); expect(state.errors).toEqual([]);
});

test("without a connected account Shorts shows the connect prompt and asks the provider nothing", async ({ page }) => {
  const state = await fixture(page, { connected: false });
  await page.goto(await legacyShell(page, "/subatomik?project=shorts-draft&page=shorts"));
  const panel = page.getByRole("region", { name: "Shorts on the connected account", exact: true });
  await expect(panel).toContainText("Shorts run on the owner’s connected account.");
  await expect(panel.getByRole("link", { name: "Workspace settings", exact: true })).toHaveAttribute("href", "/settings#engines");
  await expect(page.getByRole("button", { name: "Get connected-credit quote", exact: true })).toHaveCount(0);
  await noOverflow(page);
  expect(state.posts).toEqual([]);
  expect(state.unexpected).toEqual([]); expect(state.external).toEqual([]); expect(state.errors).toEqual([]);
});
