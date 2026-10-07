import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { openAdvanced } from "./helpers/makeAdvanced";
import { DESKTOP, forbidPaidWork, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";

/**
 * Grok Voice reads in xAI's own voices. The Make composer swaps its voice list with the speech model, so a Grok line
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

const optionLabels = (select: ReturnType<Page["getByRole"]>) => select.locator("option").allTextContents();
/** The picker fits the viewport: the page never scrolls sideways. */
const noSideScroll = (page: Page) => expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);

/* Make's own audio composer runs at the desktop sizes; the phone's simple Make has no voice list (demo-s10-phone-make-workbench). Edit & Sound's voice picker is desktop's alone (see its test). */
test("the Make composer swaps to Grok Voice's voices, and a Grok-only workspace has only voice", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "the phone app draws its own simple Make with no voice list (demo-s10-phone-make-workbench); the desktop keeps every assertion here");
  const f = await fixture(page, "both");
  await page.goto("/suites?make=audio&project=grok-voice-fixture");
  await expect(page.getByTestId("gen-view")).toBeVisible();
  await openAdvanced(page);
  /* A voice, effects and music are the sound kinds Make offers when ElevenLabs is connected too. */
  const kinds = page.getByRole("group", { name: "Sound", exact: true });
  await kinds.getByRole("button", { name: /Voice/ }).click();
  const list = page.getByTestId("make-engines");
  await list.locator('[data-testid="make-engine-row"][data-engine="grok-tts"]').click();
  await openAdvanced(page);
  const voice = page.getByTestId("gen-voice");
  /* Picking the speech model swaps the voice list with it: Grok's own voices, never Rachel. */
  await expect(page.getByTestId("make-voice-name")).toHaveText("VoiceEve");
  await expect(voice).toHaveValue("eve");
  expect(await optionLabels(voice)).toEqual(["Eve", "Ara"]);
  await page.getByTestId("gen-prompt").fill("Not tonight. The ice will hold.");
  /* The line is quoted with Grok's voice, and never with an ElevenLabs one. */
  await expect.poll(() => f.quotes.at(-1)).toMatchObject({ task: "speech", modelId: "grok-tts", voiceId: "eve" });
  await voice.selectOption("ara");
  await expect.poll(() => f.quotes.at(-1)).toMatchObject({ task: "speech", modelId: "grok-tts", voiceId: "ara" });
  expect(f.quotes.some((q) => q.modelId === "grok-tts" && q.voiceId === ELEVEN_VOICE.id)).toBe(false);
  await expect(page.getByTestId("make-engine-price")).toHaveText(/^(up to )?2 cr$/, { timeout: 30_000 });
  await expect(page.getByTestId("gen-generate")).toHaveText(/^Make · (up to )?2 cr$/);

  await page.unrouteAll({ behavior: "ignoreErrors" });
  await fixture(page, "grokOnly");
  await page.reload();
  await expect(page.getByTestId("gen-view")).toBeVisible();
  await openAdvanced(page);
  const only = page.getByRole("group", { name: "Sound", exact: true });
  /* A workspace on Grok Voice alone speaks: effects and music (ElevenLabs') are not offered, and the voice is Grok's. */
  await expect(only.getByRole("button", { name: /Voice/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("make-sound-sound")).toHaveCount(0);
  await expect(page.getByTestId("make-sound-music")).toHaveCount(0);
  await expect(page.getByTestId("make-voice-name")).toHaveText("VoiceEve");
  await noSideScroll(page);
  await page.screenshot({ path: info.outputPath("make-grok-only.png") });
});

test("Edit & Sound on Grok Voice alone: voice-over speaks, and the ElevenLabs doors say they are not connected", async ({ page }, info) => {
  /* Phones (844x390 included) get the phone shell's Cut, which watches and approves and has no Edit & Sound. */
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
  /* Edit & Sound over the board (the old /workspace page's stem rows became its New voice line / sound effect / music doors). */
  await page.goto(`/suites?project=${project.id}&view=board&region=cut`);
  await expect(page.getByTestId("cut-card")).toBeVisible();
  await expect(async () => {
    await page.getByTestId("cut-open-edit").click({ timeout: 3_000 });
    await expect(page.getByTestId("edit-sound")).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 40_000 });
  await expect(page.getByTestId("es")).toBeVisible();
  await page.getByTestId("es-new-effect").click();
  const composer = page.getByTestId("es-compose");
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
