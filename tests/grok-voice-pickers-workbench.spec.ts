import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { goWorkbenchStage } from "./helpers/workbenchNavigation";
import { legacyShell } from "./helpers/legacyShell";
import { DESKTOP, forbidPaidWork, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";

/**
 * Grok Voice reads in xAI's own voices. The Rig generation dialog and the
 * Make composer swap their voice list with the speech model, so a Grok line
 * is never quoted (or reserved) with an ElevenLabs voice; and a workspace on
 * Grok Voice alone can speak, with sound and music (ElevenLabs') switched off.
 * The audio setup and quote are mocked at the browser in the real shape of
 * GET /api/audio: nothing is priced or spent.
 */
test.setTimeout(60_000);
const ELEVEN_VOICE = { id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel", category: "premade", labels: {}, previewUrl: null, description: "Library voice" };
const GROK_VOICES = ["Eve", "Ara"].map((name) => ({ id: name.toLowerCase(), name, category: "grok", labels: { language: "en" }, previewUrl: null, description: "" }));
const ELEVEN_MODEL = { id: "eleven_multilingual_v2", label: "Multilingual v2", creditsPerChar: 1, note: "" };
const GROK_MODEL = { id: "grok-tts", label: "Grok Voice", creditsPerChar: 0, vendor: "xai", note: "" };
const terms = { sfxCredits: 200, musicCreditsPerMinute: 900 };
const setups = {
  both: { configured: true, vendors: { elevenlabs: true, xai: true }, envKey: "ELEVENLABS_API_KEY", speechModels: [ELEVEN_MODEL, GROK_MODEL], defaultSpeechModel: ELEVEN_MODEL.id,
    voices: [ELEVEN_VOICE], grokVoices: GROK_VOICES, voicesError: null, grokVoicesError: null, account: null, accountError: null, terms },
  grokOnly: { configured: true, vendors: { elevenlabs: false, xai: true }, envKey: "ELEVENLABS_API_KEY", speechModels: [GROK_MODEL], defaultSpeechModel: GROK_MODEL.id,
    voices: GROK_VOICES, grokVoices: GROK_VOICES, voicesError: null, grokVoicesError: null, account: null, accountError: null, terms },
};

async function fixture(page: Page, setup: keyof typeof setups) {
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json()), scope = `particl-active-${me.workspace.id}-${me.id}`;
  let project: Project = { ...newProject("Grok voice pickers"), id: "grok-voice-fixture", productionProjectId: "production-fixture", shotMappings: { "voice-node": "shot-fixture" },
    nodes: [{ id: "voice-node", type: "generate", title: "Night line", text: "Not tonight. The ice will hold.", mode: "Audio", x: 80, y: 80, width: 320, linked: [] }] };
  let revision = 1;
  const quotes: Record<string, unknown>[] = [];
  await page.addInitScript(({ scope, id }) => localStorage.setItem(scope, id), { scope, id: project.id });
  await page.route("**/api/**", async (route) => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ json: value, status });
    if (path === "/api/me") return json(me);
    if (path === "/api/audio" && req.method() === "GET") return json(setups[setup]);
    if (path === "/api/audio" && req.method() === "POST") {
      const body = req.postDataJSON();
      if (!body.quoteOnly) return json({ error: "This spec never submits." }, 500);
      quotes.push(body);
      return json({ estimatedCredits: 2, price: 2, unit: "cr" });
    }
    if (path === "/api/workbench/projects") {
      if (req.method() === "PUT") { project = req.postDataJSON().project; return json({ revision: ++revision, productionProjectId: project.productionProjectId, shotMappings: project.shotMappings }); }
      if (req.method() === "POST") return json({ productionProjectId: "production-fixture", shotId: "shot-fixture" });
      return json({ project, revision, projects: [{ id: project.id, name: project.name }], productions: [] });
    }
    if (path === "/api/workbench/engines") return json({ models: [] });
    if (path === "/api/workbench/library") return json({ projectId: project.id, uploads: [], generations: [], nextCursor: null, nextPageCursor: null });
    if (path === "/api/jobs") return json({ generations: [], nextCursor: null });
    if (path === "/api/workbench/atomik") return json({ models: [], jobs: [] });
    if (path === "/api/productions") return json({ productions: [] });
    if (path === "/api/projects") return json({ projects: [] });
    if (path === "/api/cast") return json({ cast: [] });
    return json({});
  });
  return { quotes };
}

async function openNode(page: Page) {
  await goWorkbenchStage(page, "canvas");
  if (page.viewportSize()!.width < 760) {
    await page.locator(".mobile-node-viewbar").getByRole("tab", { name: "List", exact: true }).click();
    await page.locator(".mobile-node-list button").filter({ hasText: "Night line" }).click();
  } else {
    const node = page.getByRole("article", { name: "Generate node: Night line", exact: true });
    await node.focus();
    await node.press("Enter");
  }
  await page.getByRole("button", { name: "Generate take", exact: true }).click();
  return page.getByRole("dialog", { name: "Generate a new take", exact: true });
}
const optionLabels = (select: ReturnType<Page["getByRole"]>) => select.locator("option").allTextContents();
/** The picker fits the viewport: the page never scrolls sideways. */
const noSideScroll = (page: Page) => expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);

/* Every picker below runs at all five sizes; Edit & Sound's voice picker is desktop's alone (see its test). */
test("the Rig dialog swaps to Grok Voice's own voices with the model, and quotes the line with one", async ({ page }, info) => {
  const f = await fixture(page, "both");
  await page.goto(await legacyShell(page, "/workbench?project=grok-voice-fixture&stage=canvas"));
  const dialog = await openNode(page);
  await dialog.getByRole("combobox", { name: "Audio type" }).selectOption("speech");
  const voice = dialog.getByRole("combobox", { name: "Audio voice" });
  await expect(voice).toHaveValue(ELEVEN_VOICE.id);
  expect(await optionLabels(voice)).toEqual(["Rachel"]);
  await dialog.getByRole("combobox", { name: "Speech model" }).selectOption("grok-tts");
  await expect(voice).toHaveValue("eve");
  expect(await optionLabels(voice)).toEqual(["Eve", "Ara"]);
  await voice.selectOption("ara");
  await expect.poll(() => f.quotes.at(-1)).toMatchObject({ task: "speech", modelId: "grok-tts", voiceId: "ara" });
  expect(f.quotes.some((q) => q.modelId === "grok-tts" && q.voiceId === ELEVEN_VOICE.id)).toBe(false);
  await noSideScroll(page);
  await page.screenshot({ path: info.outputPath("rig-grok-voices.png") });
});

test("a workspace on Grok Voice alone speaks in the Rig dialog, with sound and music off", async ({ page }, info) => {
  const f = await fixture(page, "grokOnly");
  await page.goto(await legacyShell(page, "/workbench?project=grok-voice-fixture&stage=canvas"));
  const dialog = await openNode(page);
  const task = dialog.getByRole("combobox", { name: "Audio type" });
  await expect(task).toHaveValue("speech");
  await expect(task.locator('option[value="sound"]')).toHaveJSProperty("disabled", true);
  await expect(task.locator('option[value="music"]')).toHaveJSProperty("disabled", true);
  await expect(dialog.getByRole("combobox", { name: "Audio voice" })).toHaveValue("eve");
  await expect.poll(() => f.quotes.at(-1)).toMatchObject({ task: "speech", modelId: "grok-tts", voiceId: "eve" });
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await noSideScroll(page);
  await page.screenshot({ path: info.outputPath("rig-grok-only.png") });
});

test("the Make composer swaps to Grok Voice's voices, and a Grok-only workspace has only Dialogue", async ({ page }, info) => {
  const f = await fixture(page, "both");
  await page.goto("/generate?mode=audio");
  await page.getByRole("group", { name: "Track kind" }).getByRole("button", { name: "Dialogue", exact: true }).click();
  await page.getByRole("combobox", { name: "Model", exact: true }).selectOption("grok-tts");
  const voices = page.getByRole("group", { name: "Voices" });
  await expect(voices).toContainText("Eve");
  await expect(voices).not.toContainText("Rachel");
  await page.getByRole("textbox", { name: "Prompt", exact: true }).fill("Not tonight. The ice will hold.");
  await expect.poll(() => f.quotes.at(-1)).toMatchObject({ task: "speech", modelId: "grok-tts", voiceId: "eve" });

  await page.unrouteAll({ behavior: "ignoreErrors" });
  await fixture(page, "grokOnly");
  await page.reload();
  const tracks = page.getByRole("group", { name: "Track kind" });
  await expect(tracks.getByRole("button", { name: "Ambient", exact: true })).toBeDisabled();
  await expect(tracks.getByRole("button", { name: "Music", exact: true })).toBeDisabled();
  await expect(tracks.getByRole("button", { name: "Dialogue", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("group", { name: "Voices" })).toContainText("Eve");
  await noSideScroll(page);
  await page.screenshot({ path: info.outputPath("make-grok-only.png") });
});

test("Edit & Sound on Grok Voice alone: voice-over speaks, and the ElevenLabs doors say they are not connected", async ({ page }, info) => {
  /* Phones (844x390 included) get the phone shell's Edit & Sound, whose doors are a
     read-only list with no voice picker and no quote (workspace-edit-workbench.spec). */
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  const project: Project = { ...newProject("Grok voice edit"), id: "grok-edit", fps: 24, productionProjectId: "prod-grok", shotMappings: {},
    assets: [{ id: "take_a", name: "The approach v1", kind: "image", category: "Shot", url: "/api/media/gen_a", generationId: "gen_a", description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [] }],
    shots: [{ id: "cut_1", name: "The approach", assetId: "take_a", duration: 96, sourceIn: 0, note: "" }], audioClips: [] };
  await mockProjects(page, { current: project });
  await mockLibrary(page, { uploads: [], generations: [] });
  const quotes: Record<string, unknown>[] = [];
  await page.route("**/api/jobs?**", (route) => route.fulfill({ json: { generations: [], nextCursor: null } }));
  await page.route("**/api/workbench/atomik**", (route) => route.fulfill({ json: { models: [], jobs: [] } }));
  await page.route("**/api/audio/voices**", (route) => route.fulfill({ json: new URL(route.request().url()).searchParams.get("model") === "grok-tts"
    ? { configured: true, voices: GROK_VOICES.map(({ id, name }) => ({ id, name })) } : { configured: false, voices: [] } }));
  await page.route(/\/api\/audio$/, async (route) => {
    const request = route.request();
    if (request.method() === "GET") return route.fulfill({ json: setups.grokOnly });
    const body = request.postDataJSON() as Record<string, unknown>;
    if (!body.quoteOnly) return route.fulfill({ status: 500, json: { error: "This spec never submits." } });
    quotes.push(body);
    return route.fulfill({ json: { estimatedCredits: 2, price: 2, unit: "cr" } });
  });
  await page.goto(`/workspace?project=${project.id}&suite=particl&page=edit`);
  await expect(page.getByTestId("page-title")).toHaveText("Edit & Sound");
  await page.locator('[data-stem="sfx"]').getByRole("button", { name: "Generate" }).click();
  const composer = page.getByTestId("composer-sfx");
  const kinds = composer.getByRole("group", { name: "Sound type" });
  for (const name of ["Sound effect", "Music", "Change voice", "Dub"]) await expect(kinds.getByRole("button", { name, exact: true })).toBeDisabled();
  await expect(composer.getByRole("alert")).toHaveText("Sound effect is not connected for this workspace.");
  await expect(composer.locator("[data-sound-generate]")).toBeDisabled();
  expect(quotes).toEqual([]);
  await kinds.getByRole("button", { name: "Voice-over", exact: true }).click();
  await expect(composer.getByRole("alert")).toHaveCount(0);
  await composer.getByLabel("Script").fill("Not tonight. The ice will hold.");
  await expect(composer.locator("[data-sound-generate]")).toHaveText("Generate voice-over · 2 cr");
  expect(quotes.at(-1)).toMatchObject({ task: "speech", modelId: "grok-tts", voiceId: "eve" });
  await page.screenshot({ path: info.outputPath("edit-grok-only.png") });
});
