import { goWorkbenchStage as stage, openWorkbenchInspector } from "./helpers/workbenchNavigation";
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { signInLocally } from "./helpers/workbenchLocal";
import { seedProject, type Project } from "../lib/workbench/studio";
import { legacyShell } from "./helpers/legacyShell";

/**
 * Edit & Sound: quote → generate → clip on the right lane at the playhead.
 *
 * The audio routes, the job feed and the project save are mocked at the
 * browser (no paid call, no engine, no stored generation to validate), the
 * way tests/project-generation-workbench.spec.ts does for node audio. A
 * finished generation arrives as a succeeded job under the lane node's shot,
 * which the production job recovery turns into a project asset; the panel
 * then places it, and the placement shows up in the next project save.
 */
type Submission = { key: string | undefined; body: Record<string, unknown> };
const SCRIPT = "An isolated voice-over line for the edit.";

async function movePlayhead(page: Page, to: number) {
  const playhead = page.getByRole("slider", { name: "Sequence playhead" });
  await playhead.focus();
  await playhead.press("Home");
  await expect(playhead).toHaveAttribute("aria-valuenow", "0");
  for (let i = 0; i < to; i++) {
    await playhead.press("ArrowRight");
    await expect(playhead).toHaveAttribute("aria-valuenow", String(i + 1));
  }
}

test("Edit & Sound quotes, generates and places voice-over, sound effect and music on their lanes at the playhead", async ({ page }, info) => {
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
  await page.goto(await legacyShell(page, "/workbench"));
  await stage(page, "edit");
  await openWorkbenchInspector(page, "sound");
  const panel = page.getByRole("region", { name: "Generate sound" });
  await panel.scrollIntoViewIfNeeded();
  await expect(panel.getByRole("group", { name: "Sound type" }).getByRole("button", { name: "Voice-over", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByLabel("Voice", { exact: true })).toHaveValue("mockvoice01");
  await expect(panel.getByLabel("Speech model", { exact: true })).toHaveValue("mock-speech");
  await expect(panel.getByLabel("Sound lane", { exact: true })).toHaveValue("dialogue");
  const generate = panel.locator("[data-sound-generate]");
  await expect(generate).toBeDisabled();

  // Voice-over at frame 12 on the dialogue lane.
  await movePlayhead(page, 12);
  await expect(panel).toContainText("frame 12");
  await panel.getByLabel("Voice", { exact: true }).selectOption("mockvoice02");
  await panel.getByLabel("Script", { exact: true }).fill(SCRIPT);
  await expect(generate).toContainText("Generate voice-over · 14 cr");
  await expect(generate).toBeEnabled();
  await generate.click();
  await expect(panel.getByRole("status")).toContainText("Voice-over submitted");
  await expect(panel.getByRole("list", { name: "Sound in progress" })).toContainText("Voice-over · Dialogue lane at 00:00");
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
    startFrame: 12,
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
  await expect(clip1.getByLabel("Timeline start", { exact: true })).toHaveValue("12");
  await expect(panel.getByRole("status")).toContainText("Voice-over placed on the dialogue lane at 00:00");
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
  expect(current().audioClips![1]).toMatchObject({ lane: "sfx", startFrame: 12, duration: 3 * fps });

  // Music: ten seconds, instrumental, on the music lane, from a moved playhead.
  await movePlayhead(page, 30);
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
  expect(current().audioClips![2]).toMatchObject({ lane: "music", startFrame: 30, duration: 10 * fps });
  const clip3 = mix.getByRole("group", { name: "Sound clip 3" });
  await expect(clip3).toContainText("Music · v1");
  await expect(clip3.getByLabel("Timeline start", { exact: true })).toHaveValue("30");

  // Three lane nodes, one per task; every generation's idempotency key is its own; the edit still validates.
  expect(current().nodes.filter((n) => n.type === "audio" && n.role?.startsWith("sound-lane:")).map((n) => n.title).sort()).toEqual(["Music", "Sound effects", "Voice-over"]);
  expect(new Set(submissions.map((s) => s.key)).size).toBe(3);
  expect(saves.length).toBeGreaterThan(0);
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("edit-sound.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
});
