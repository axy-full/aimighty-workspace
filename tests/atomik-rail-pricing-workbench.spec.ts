import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { legacyShell } from "./helpers/legacyShell";

/**
 * The Atomik rail's own-engine checkpoint (audit: suites-atomik-ui).
 *
 * Continue shows the price the route that will run the step quoted for the
 * exact request it will send, asks again before it claims, and sends that
 * price as the ceiling; a moved price is shown, not spent; a step no route
 * can price is not offered; an unpriced step never reads as free; and a
 * failed claim leaves Continue ready to be pressed again.
 *
 * The API is mocked in its real shapes (GET /api/atomik/:id as getChat
 * returns it to a workspace that pays in credits). Nothing is rendered.
 */
const fingerprint = "b".repeat(64);
async function fixture(page: Page, checkpoint: "video" | "speech") {
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((response) => response.json());
  me.owner = true;
  const project: Project = { ...newProject("Atomik film"), id: "atomik-draft", productionProjectId: "actual-production" };
  const chat = { id: "ach_1", projectId: null, title: "Bottle spot", model: "auto", agentMode: "ask", status: "waiting", textCostUsd: 0.02, textCredits: 1, createdBy: me.id, createdAt: 1, updatedAt: 2 };
  const base = { chatId: "ach_1", messageId: "amsg_2", refs: [], genId: null, error: null, createdAt: 3, billedCredits: null };
  const video = { ...base, id: "astp_1", position: 0, kind: "video", title: "Push in", prompt: "A slow push in on a bottle.", model: "seedance-2.0",
    params: { ratio: "16:9", resolution: "1080p", seconds: 5 }, status: "proposed", estCostUsd: 0.9, estCredits: 14 };
  const speech = { ...base, id: checkpoint === "speech" ? "astp_1" : "astp_2", position: checkpoint === "speech" ? 0 : 1, kind: "audio", title: "Narration", prompt: "Cold, clear, and yours.",
    model: "elevenlabs", params: { task: "speech" }, status: "proposed", estCostUsd: null, estCredits: null };
  const steps = checkpoint === "video" ? [video, speech] : [speech];
  const messages = [
    { id: "amsg_1", chatId: "ach_1", role: "user", text: "A bottle spot.", activity: [], ask: null, attachments: [], workedMs: null, costUsd: 0, model: "", createdAt: 1 },
    { id: "amsg_2", chatId: "ach_1", role: "assistant", text: "A push in, then a line.", activity: [], ask: null, attachments: [], workedMs: 1, costUsd: 0.02, model: "auto", createdAt: 2 },
  ];
  const state = { price: 15, quotes: [] as unknown[], audioQuotes: [] as unknown[], claims: 0, renders: [] as { body: unknown; key: string | undefined }[], patches: [] as unknown[], unexpected: [] as string[], errors: [] as string[] };
  page.on("pageerror", (error) => state.errors.push(error.message));
  await page.route("**/*", (route) => (["localhost", "127.0.0.1"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort("blockedbyclient")));
  await page.route("**/api/**", async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ status, json: value });
    if (path === "/api/me") return json(me);
    if (path === "/api/atomik")
      return json({ chats: [{ ...chat, needsApproval: steps.some((s) => s.status === "proposed") }], models: { featured: [], rest: [] },
        engines: [
          { id: "seedance-2.0", label: "Seedance 2.0", kind: "video", note: "", own: true, ratios: ["16:9"], resolutions: ["1080p"], durations: [5], supportsAudio: true },
          { id: "elevenlabs", label: "Voice, sound and music", kind: "audio", note: "", own: true, ratios: [], resolutions: [], durations: [], supportsAudio: true },
        ] });
    if (path === "/api/atomik/ach_1") return json({ chat, messages, steps });
    if (path === "/api/generate/quote" && request.method() === "POST") {
      state.quotes.push(request.postDataJSON());
      return json({ estimatedCredits: state.price, price: state.price, unit: "cr", fingerprint });
    }
    if (path === "/api/audio" && request.method() === "POST") {
      const body = request.postDataJSON();
      if (body.quoteOnly === true) { state.audioQuotes.push(body); return json({ error: "Pick a voice." }, 400); }
      state.unexpected.push("POST /api/audio"); return json({ error: "Not priced." }, 409);
    }
    if (path === "/api/atomik/steps/astp_1/claim") {
      state.claims++;
      if (state.claims === 1) return json({ error: "The claim could not be saved." }, 500);
      video.status = "running";
      return json({ step: video });
    }
    if (path === "/api/generate" && request.method() === "POST") {
      state.renders.push({ body: request.postDataJSON(), key: request.headers()["idempotency-key"] });
      return json({ id: "gen_1", status: "queued" }, 202);
    }
    if (path === "/api/atomik/steps/astp_1" && request.method() === "PATCH") {
      state.patches.push(request.postDataJSON());
      video.status = "done";
      return json({ step: video });
    }
    if (path.startsWith("/api/atomik/steps/")) { state.unexpected.push(`${request.method()} ${path}`); return json({ error: "Not this route." }, 409); }
    if (path === "/api/workbench/projects") return json({ project, projects: [{ id: project.id, name: project.name }], revision: 1, productions: [] });
    if (path === "/api/workbench/atomik") return json({ configured: false, models: [], jobs: [] });
    if (path === "/api/projects") return json({ projects: [] });
    if (path === "/api/pipelines") return json({ runs: [], publications: [], models: [], audioModels: { speech: [], sound: "", music: "" } });
    if (path === "/api/jobs") return json({ generations: [], nextCursor: null, nextPageCursor: null });
    if (path === "/api/settings") return json({ settings: {}, models: { image: "", video: "", text: {} } });
    if (request.method() !== "GET") { state.unexpected.push(`${request.method()} ${path}`); return json({ error: "No other mutation permitted." }, 409); }
    return json({});
  });
  return state;
}
const surfaceOf = (page: Page) =>
  page.viewportSize()!.width < 760
    ? page.getByRole("group", { name: "Checkpoint", exact: true })
    : page.getByRole("complementary", { name: "Atomik" }).or(page.getByLabel("Atomik", { exact: true })).filter({ visible: true }).first();
const noOverflow = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

test("Continue shows the route's own quote, sends it as the ceiling, and can be pressed again after a failed claim", async ({ page }) => {
  const state = await fixture(page, "video");
  await page.goto(await legacyShell(page, "/atomik?project=atomik-draft&page=generate"));
  const surface = surfaceOf(page);
  const cont = surface.getByRole("button", { name: /^Continue/ }).first();
  // The live quote (15), not the estimate, and never the engine's dollars as credits ("1 cr").
  await expect(cont).toContainText("15 cr");
  await expect(cont).toBeEnabled();
  expect(state.quotes[0]).toEqual({ prompt: "A slow push in on a bottle.", model: "seedance-2.0", projectId: null, ratio: "16:9", resolution: "1080p", duration: 5, refine: false });
  expect(state.audioQuotes).toEqual([]);

  // The plan: the unpriced voice line reads as unpriced, never as free, and the total says so.
  await page.getByRole("button", { name: /^Expand/ }).filter({ visible: true }).first().click();
  await expect(page.getByText("priced at checkpoint", { exact: true }).filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText(/\+ 1 at checkpoint/).filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText("0 cr", { exact: true }).filter({ visible: true })).toHaveCount(0);
  await noOverflow(page);

  const again = surfaceOf(page).getByRole("button", { name: /^Continue/ }).first();
  await again.click();
  await expect(page.getByText("The claim could not be saved.").filter({ visible: true }).first()).toBeVisible();
  expect(state.renders).toEqual([]);
  // The price moved while the button was up: Continue asks again before it claims, and shows the new price instead of spending it.
  state.price = 16;
  await again.click();
  await expect(page.getByText("The price changed to 16 cr. Continue runs at that price.").filter({ visible: true }).first()).toBeVisible();
  await expect(again).toContainText("16 cr");
  expect(state.claims).toBe(1);
  expect(state.renders).toEqual([]);
  // Neither the failed claim nor the moved price stranded the step: the next press claims and renders at the shown ceiling.
  await again.click();
  await expect.poll(() => state.renders.length).toBe(1);
  expect(state.claims).toBe(2);
  expect(state.renders[0]).toEqual({
    key: "atomik-step:astp_1",
    body: { prompt: "A slow push in on a bottle.", model: "seedance-2.0", projectId: null, ratio: "16:9", resolution: "1080p", duration: 5, refine: false, maxCredits: 16, quoteFingerprint: fingerprint },
  });
  await expect.poll(() => state.patches.length).toBe(1);
  expect(state.patches[0]).toEqual({ status: "done", genId: "gen_1" });
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("a step its route cannot price is not offered, and says why", async ({ page }) => {
  const state = await fixture(page, "speech");
  await page.goto(await legacyShell(page, "/atomik?project=atomik-draft&page=generate"));
  const surface = surfaceOf(page);
  await expect(surface.getByText("Pick a voice.", { exact: true })).toBeVisible();
  const cont = surface.getByRole("button", { name: /^Continue/ }).first();
  await expect(cont).toBeDisabled();
  await expect(cont).not.toContainText(/\b0 cr\b/);
  expect(state.audioQuotes[0]).toEqual({ task: "speech", text: "Cold, clear, and yours.", projectId: null, title: "Narration", quoteOnly: true });
  await noOverflow(page);
  expect(state.claims).toBe(0);
  expect(state.renders).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("the Suites shell hosts no Atomik rail, so it offers no control that only a rail could act on", async ({ page }, info) => {
  test.skip(!["workbench-1440x900", "workbench-1920x1080"].includes(info.project.name), "the desktop studio shell");
  await signInLocally(page.request);
  const project = { ...newProject("Coastal light study"), id: "ws-atomik-a", productionProjectId: "ws-atomik-production" };
  const reads = { recipes: 0, index: 0 };
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/workbench/projects**", (route) =>
    route.request().method() !== "GET" ? route.fulfill({ status: 409, json: { error: "Read-only fixture." } })
      : route.fulfill({ json: { projects: [{ id: project.id, name: project.name, revision: 1, updatedAt: "2026-09-18T10:00:00Z" }], productions: [], project, revision: 1, shared: null } }));
  await page.route("**/api/pipelines**", (route) => route.request().method() !== "GET" ? route.fulfill({ status: 403, json: { error: "Read-only fixture." } })
    : route.fulfill({ json: { runs: [], publications: [], models: [], audioModels: { speech: [], sound: "", music: "" } } }));
  await page.route("**/api/projects", (route) => route.fulfill({ json: { projects: [{ id: "ws-atomik-production", name: project.name, spend: 0, credits: 0, capCredits: null, capUsd: null, capUnlocked: false }] } }));
  await page.route("**/api/atomik/recipes", (route) => { reads.recipes++; return route.fulfill({ json: { recipes: [{ name: "character-sheet", description: "A turnaround sheet." }] } }); });
  await page.route("**/api/atomik", (route) => { reads.index++; return route.fulfill({ json: { chats: [], models: { featured: [], rest: [] }, engines: [] } }); });

  await page.goto(`/workspace?project=${project.id}&suite=atomik&page=recipes`);
  const recipes = page.getByTestId("spec-work").locator('[data-tool-body="recipes"]');
  await expect(recipes.getByText(/Each saved run retains its reusable plan/)).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  await expect(page.getByRole("button", { name: "Use in Atomik" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Connected recipes" })).toHaveCount(0);

  await page.goto(`/workspace?project=${project.id}&suite=atomik&page=models`);
  const models = page.getByTestId("spec-work").locator('[data-tool-body="models"]');
  await expect(models.getByRole("heading", { name: "Effective routing", exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(models.getByRole("heading", { name: "Atomik thinking", exact: true })).toHaveCount(0);
  await expect(models.getByRole("button", { name: "Thinking model", exact: true })).toHaveCount(0);
  expect(reads).toEqual({ recipes: 0, index: 0 });
  await noOverflow(page);
  expect(errors).toEqual([]);
});
