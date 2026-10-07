import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { signInLocally } from "./helpers/workbenchLocal";
import { seedProject, type Project } from "../lib/workbench/studio";

/**
 * Edit & Sound: quote → generate → clip on the right lane at the playhead.
 *
 * Retargeted from the old Studio's edit stage (retired in Release 1) to Edit & Sound over the board: the Cut card's "Open
 * Edit & Sound", then New voice line / New sound effect / New music, which mount the same SoundGenerate panel and its quote
 * → ceiling → key → placement rules. The playhead is the transport's frame: a click on a picture clip moves it to that clip's
 * start. The board and its Edit & Sound are the desktop's (the phone's Cut is watch-and-approve only).
 *
 * The audio routes, the job feed and the project save are mocked at the
 * browser (no paid call, no engine, no stored generation to validate), the
 * way tests/project-generation-workbench.spec.ts does for node audio. A
 * finished generation arrives as a succeeded job under the lane node's shot,
 * which the production job recovery turns into a project asset; the panel
 * then places it, and the placement shows up in the next project save.
 */
type Submission = { key: string | undefined; body: Record<string, unknown> };
const DESKTOPS = ["workbench-1440x900", "workbench-1920x1080"];
const SCRIPT = "An isolated voice-over line for the edit.";

/** Edit & Sound over the board, on one of its three new-sound doors. The picture lane's clips are the cut's two 72-frame shots. */
async function openComposer(page: Page, projectId: string, door: "es-new-voice" | "es-new-effect" | "es-new-music") {
  await page.goto(`/suites?project=${projectId}&view=board&region=cut`);
  await expect(page.getByTestId("cut-card")).toBeVisible();
  await page.getByTestId("cut-open-edit").click();
  await expect(page.getByTestId("es")).toBeVisible();
  const opener = page.getByTestId(door);
  if ((await opener.getAttribute("aria-expanded")) !== "true") await opener.click();
  const panel = page.getByTestId("es-compose").getByRole("region", { name: "Generate sound" });
  await expect(panel).toBeVisible();
  return panel;
}

/** The playhead at a picture clip's start (frame 0 for the first, 72 for the second). */
async function playheadAt(page: Page, clip: 0 | 1) {
  await page.getByTestId("es-clip").nth(clip).click();
}

test("Edit & Sound quotes, generates and places voice-over, sound effect and music on their lanes at the playhead", async ({ page }, info) => {
  test.skip(!DESKTOPS.includes(info.project.name), "the board and its Edit & Sound are the desktop's");
  await signInLocally(page.request);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const me = await page.request.get("/api/me").then((r) => r.json()),
    scope = `particl-active-${me.workspace.id}-${me.id}`;
  let project: Project = { ...seedProject(), id: "edit-sound-" + randomUUID().slice(0, 8), name: "Edit & Sound test", productionProjectId: "production-fixture", shotMappings: {} };
  project.shots = project.shots.slice(0, 2).map((s) => ({ ...s, duration: 72 }));
  const fps = project.fps;
  let revision = 1;
  const mappings: Record<string, string> = {};
  const saves: Project[] = [];
  const current = () => project;

  const submissions: Submission[] = [];
  let finished = 0;
  const quotes: Record<string, number> = { speech: 14, sound: 8, music: 21 };
  const jobOf = (s: Submission, i: number) => ({
    id: "mock-audio-" + (i + 1),
    status: i < finished ? "succeeded" : "running",
    kind: "audio",
    shotId: s.body.shotId,
    prompt: s.body.text,
    model: s.body.task === "speech" ? "eleven_multilingual_v2" : s.body.task === "sound" ? "eleven_sfx" : "eleven_music",
    version: 1,
    params: { task: s.body.task },
    createdAt: Date.now() - (submissions.length - i) * 1000,
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (path === "/api/workbench/projects") {
      if (request.method() === "PUT") {
        project = { ...request.postDataJSON().project, productionProjectId: "production-fixture", shotMappings: { ...mappings } };
        saves.push(project);
        return json({ revision: ++revision, productionProjectId: "production-fixture", shotMappings: { ...mappings } });
      }
      if (request.method() === "POST") {
        const body = request.postDataJSON();
        if (body.action !== "map-shot") return json({ error: "unexpected action " + body.action }, 400);
        if (!project.nodes.some((n) => n.id === body.nodeId)) return json({ error: "Save this node in a project first." }, 400);
        mappings[body.nodeId] ??= "shot-" + body.nodeId;
        return json({ productionProjectId: "production-fixture", shotId: mappings[body.nodeId] });
      }
      return json({ project: { ...project, shotMappings: { ...mappings } }, revision, projects: [{ id: project.id, name: project.name }], productions: [] });
    }
    if (path === "/api/audio" && request.method() === "GET")
      return json({
        configured: true,
        speechModels: [
          { id: "mock-speech", label: "Mock speech", creditsPerChar: 1, note: "Local test" },
          { id: "mock-flash", label: "Mock flash", creditsPerChar: 0.5, note: "Local test" },
        ],
        defaultSpeechModel: "mock-speech",
        voices: [],
        voicesError: null,
        account: null,
        terms: { sfxCredits: 200, musicCreditsPerMinute: 900 },
      });
    if (path === "/api/audio/voices")
      return json({
        configured: true,
        voices: [
          { id: "mockvoice01", name: "Avery", category: "premade" },
          { id: "mockvoice02", name: "Blake", category: "cloned" },
        ],
      });
    if (path === "/api/audio" && request.method() === "POST") {
      const body = request.postDataJSON();
      if (body.quoteOnly) return json({ estimatedCredits: quotes[String(body.task)], price: quotes[String(body.task)], unit: "cr" });
      submissions.push({ key: request.headers()["idempotency-key"], body });
      return json({ id: "mock-audio-" + submissions.length, status: "running", estCredits: 1, estimatedCredits: quotes[String(body.task)] });
    }
    if (path === "/api/jobs") return json({ generations: submissions.map(jobOf), nextCursor: null });
    if (/^\/api\/jobs\/mock-audio-\d+$/.test(path)) {
      const index = Number(path.split("-").pop()) - 1;
      return submissions[index] ? json({ generation: jobOf(submissions[index], index) }) : json({ error: "gone" }, 404);
    }
    if (path.startsWith("/api/media/mock-audio-")) return route.fulfill({ status: 404, body: "Not found" });
    if (path === "/api/workbench/atomik") return json({ models: [], jobs: [] });
    if (request.method() !== "GET") throw new Error(`Unexpected paid/mutating browser request: ${request.method()} ${path}`);
    return route.fallback();
  });

  await page.addInitScript(({ scope, id }) => localStorage.setItem(scope, id), { scope, id: project.id });
  const panel = await openComposer(page, project.id, "es-new-voice");
  /* The mix is folded away until asked for; its clip rows are read below. */
  await page.getByTestId("es-tool-mix").click();
  await expect(panel.getByRole("group", { name: "Sound type" }).getByRole("button", { name: "Voice-over", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByLabel("Voice", { exact: true })).toHaveValue("mockvoice01");
  await expect(panel.getByLabel("Speech model", { exact: true })).toHaveValue("mock-speech");
  await expect(panel.getByLabel("Sound lane", { exact: true })).toHaveValue("dialogue");
  const generate = panel.locator("[data-sound-generate]");
  await expect(generate).toBeDisabled();

  // Voice-over at frame 72 (the second shot's start) on the dialogue lane.
  await playheadAt(page, 1);
  await expect(panel).toContainText("frame 72");
  await panel.getByLabel("Voice", { exact: true }).selectOption("mockvoice02");
  await panel.getByLabel("Script", { exact: true }).fill(SCRIPT);
  await expect(generate).toContainText("Generate voice-over · 14 cr");
  await expect(generate).toBeEnabled();
  await generate.click();
  await expect(panel.getByRole("status")).toContainText("Voice-over submitted");
  await expect(panel.getByRole("list", { name: "Sound in progress" })).toContainText(/Voice-over · Dialogue lane at 00:0\d/);
  expect(submissions).toHaveLength(1);
  expect(submissions[0].key).toBeTruthy();
  expect(submissions[0].body).toMatchObject({ task: "speech", text: SCRIPT, voiceId: "mockvoice02", modelId: "mock-speech", maxCredits: 14, projectId: "production-fixture" });
  // The lane node was saved before the shot mapping and the track was filed under that shot.
  const voNode = current().nodes.find((n) => n.role === "sound-lane:speech");
  expect(voNode).toMatchObject({ type: "audio", mode: "Audio", title: "Voice-over" });
  expect(submissions[0].body.shotId).toBe(mappings[voNode!.id]);
  await expect.poll(() => current().shotMappings?.[voNode!.id]).toBe(submissions[0].body.shotId);

  finished = 1;
  await expect.poll(() => current().audioClips?.length ?? 0, { timeout: 45_000 }).toBe(1);
  expect(current().audioClips![0]).toMatchObject({
    lane: "dialogue",
    startFrame: 72,
    sourceIn: 0,
    duration: Math.ceil(SCRIPT.length / 15) * fps,
    gainDb: 0,
    pan: 0,
    fadeIn: 0,
    fadeOut: 0,
    muted: false,
    solo: false,
  });
  const voAsset = current().assets.find((a) => a.id === current().audioClips![0].assetId);
  expect(voAsset).toMatchObject({ kind: "audio", generationId: "mock-audio-1", nodeId: voNode!.id, url: "/api/media/mock-audio-1" });
  const mix = page.getByRole("region", { name: "Sound mix" });
  const clip1 = mix.getByRole("group", { name: "Sound clip 1" });
  await expect(clip1).toContainText("Voice-over · v1");
  await expect(clip1.getByLabel("Sound lane", { exact: true })).toHaveValue("dialogue");
  await expect(clip1.getByLabel("Timeline start", { exact: true })).toHaveValue("72");
  await expect(page.getByTestId("es").getByRole("status").filter({ hasText: "Voice-over placed on the dialogue lane at" })).toBeVisible();
  await expect(panel.getByRole("list", { name: "Sound in progress" })).toHaveCount(0);

  // Sound effect: three seconds at the same playhead, on the SFX lane.
  await panel.getByRole("group", { name: "Sound type" }).getByRole("button", { name: "Sound effect", exact: true }).click();
  await expect(panel.getByLabel("Sound lane", { exact: true })).toHaveValue("sfx");
  await panel.getByLabel("Describe the sound", { exact: true }).fill("Rain on a tin roof, no music.");
  await panel.getByLabel("Length in seconds", { exact: true }).fill("3");
  await expect(generate).toContainText("Generate sound effect · 8 cr");
  await generate.click();
  await expect(panel.getByRole("status")).toContainText("Sound effect submitted");
  expect(submissions).toHaveLength(2);
  expect(submissions[1].body).toMatchObject({ task: "sound", durationSeconds: 3, promptInfluence: 0.3, maxCredits: 8 });
  expect(submissions[1].body.shotId).not.toBe(submissions[0].body.shotId);
  finished = 2;
  await expect.poll(() => current().audioClips?.length ?? 0, { timeout: 45_000 }).toBe(2);
  expect(current().audioClips![1]).toMatchObject({ lane: "sfx", startFrame: 72, duration: 3 * fps });

  // Music: ten seconds, instrumental, on the music lane, from a moved playhead.
  await playheadAt(page, 0);
  await panel.getByRole("group", { name: "Sound type" }).getByRole("button", { name: "Music", exact: true }).click();
  await expect(panel.getByLabel("Sound lane", { exact: true })).toHaveValue("music");
  await panel.getByLabel("Describe the music", { exact: true }).fill("Slow piano, warm room tone.");
  await panel.getByLabel("Length in seconds", { exact: true }).fill("10");
  await panel.getByLabel("Instrumental", { exact: true }).check();
  await expect(generate).toContainText("Generate music · 21 cr");
  await generate.click();
  await expect(panel.getByRole("status")).toContainText("Music submitted");
  expect(submissions).toHaveLength(3);
  expect(submissions[2].body).toMatchObject({ task: "music", lengthMs: 10_000, instrumental: true, maxCredits: 21 });
  finished = 3;
  await expect.poll(() => current().audioClips?.length ?? 0, { timeout: 45_000 }).toBe(3);
  // Ten seconds asked for, but the 6 s cut ends first: the clip ends with the cut so the mix and render still work.
  expect(current().audioClips![2]).toMatchObject({ lane: "music", startFrame: 0, duration: 2 * 72 });
  const clip3 = mix.getByRole("group", { name: "Sound clip 3" });
  await expect(clip3).toContainText("Music · v1");
  await expect(clip3.getByLabel("Timeline start", { exact: true })).toHaveValue("0");

  // Three lane nodes, one per task; every generation's idempotency key is its own; the edit still validates.
  expect(current().nodes.filter((n) => n.type === "audio" && n.role?.startsWith("sound-lane:")).map((n) => n.title).sort()).toEqual(["Music", "Sound effects", "Voice-over"]);
  expect(new Set(submissions.map((s) => s.key)).size).toBe(3);
  expect(saves.length).toBeGreaterThan(0);
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("edit-sound.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
});

test("a sound request still mapping its lane when another project opens leaves that project's draft alone", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one project-switch race");
  await signInLocally(page.request);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const me = await page.request.get("/api/me").then((r) => r.json()),
    scope = `particl-active-${me.workspace.id}-${me.id}`;
  const first: Project = { ...seedProject(), id: "race-first-" + randomUUID().slice(0, 8), name: "First edit", productionProjectId: "production-first", shotMappings: {} };
  const second: Project = { ...seedProject(), id: "race-second-" + randomUUID().slice(0, 8), name: "Second edit", productionProjectId: "production-second", shotMappings: {} };
  const drafts = new Map([[first.id, first], [second.id, second]]);
  const revisions = new Map([[first.id, 1], [second.id, 1]]);
  const secondSaves: Project[] = [];
  const submissions: Record<string, unknown>[] = [];
  let mapping = "";
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (path === "/api/workbench/projects") {
      if (request.method() === "PUT") {
        const saved = request.postDataJSON().project as Project;
        const owned = drafts.get(saved.id)!.productionProjectId!;
        if (saved.id === second.id) secondSaves.push(saved);
        /* As saveDraft: a draft never changes its production. */
        if (saved.productionProjectId && saved.productionProjectId !== owned) return json({ error: "A draft cannot change its project. Open a separate space." }, 400);
        drafts.set(saved.id, { ...saved, productionProjectId: owned });
        const revision = revisions.get(saved.id)! + 1;
        revisions.set(saved.id, revision);
        return json({ revision, productionProjectId: owned, shotMappings: saved.id === first.id && mapping ? { [mapping]: "shot-" + mapping } : {} });
      }
      if (request.method() === "POST") {
        const body = request.postDataJSON();
        if (body.action !== "map-shot" || body.projectId !== first.id) return json({ error: "unexpected mapping" }, 400);
        mapping = body.nodeId;
        /* Held while the page opens the second project. */
        await released;
        return json({ productionProjectId: "production-first", shotId: "shot-" + body.nodeId });
      }
      const id = url.searchParams.get("id") ?? first.id;
      return json({ project: drafts.get(id), revision: revisions.get(id), projects: [...drafts.values()].map((p) => ({ id: p.id, name: p.name })), productions: [] });
    }
    if (path === "/api/audio" && request.method() === "GET")
      return json({ configured: true, speechModels: [{ id: "mock-speech", label: "Mock speech", creditsPerChar: 1, note: "Local test" }], defaultSpeechModel: "mock-speech", voices: [], voicesError: null, account: null, terms: { sfxCredits: 200, musicCreditsPerMinute: 900 } });
    if (path === "/api/audio/voices") return json({ configured: true, voices: [{ id: "mockvoice01", name: "Avery", category: "premade" }] });
    if (path === "/api/audio" && request.method() === "POST") {
      const body = request.postDataJSON();
      if (body.quoteOnly) return json({ estimatedCredits: 14, price: 14, unit: "cr" });
      submissions.push(body);
      return json({ id: "mock-race-audio", status: "running", estCredits: 1, estimatedCredits: 14 });
    }
    if (path === "/api/jobs") return json({ generations: [], nextCursor: null });
    if (path === "/api/workbench/atomik") return json({ models: [], jobs: [] });
    if (request.method() !== "GET") throw new Error(`Unexpected paid/mutating browser request: ${request.method()} ${path}`);
    return route.fallback();
  });

  await page.addInitScript(({ scope, id }) => localStorage.setItem(scope, id), { scope, id: first.id });
  const panel = await openComposer(page, first.id, "es-new-voice");
  await expect(panel.getByLabel("Voice", { exact: true })).toHaveValue("mockvoice01");
  await panel.getByLabel("Script", { exact: true }).fill(SCRIPT);
  const generate = panel.locator("[data-sound-generate]");
  await expect(generate).toContainText("Generate voice-over · 14 cr");
  await generate.click();
  await expect.poll(() => mapping).not.toBe("");

  /* The second project opens while the first one's lane is still being mapped. */
  await page.locator('[data-suite-tab="home"]').click();
  await page.locator(`[data-testid="home-project"][data-project="${second.id}"]`).click();
  await expect(page.locator('[data-suite-tab="project"] .gx-seg-label')).toHaveText("Second edit");
  release();
  /* The first project's request carries on to its own submission… */
  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0]).toMatchObject({ projectId: "production-first", shotId: "shot-" + mapping });
  /* …and the second project's draft never takes the first one's production or lane. */
  await page.waitForTimeout(2000);
  expect(secondSaves.filter((p) => p.productionProjectId === "production-first" || p.shotMappings?.[mapping])).toEqual([]);
  await expect(page.getByText("A draft cannot change its project")).toHaveCount(0);
  expect(errors).toEqual([]);
});
