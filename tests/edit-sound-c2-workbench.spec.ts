import { goWorkbenchStage as stage, openWorkbenchInspector } from "./helpers/workbenchNavigation";
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { signInLocally } from "./helpers/workbenchLocal";
import { seedProject, type Project } from "../lib/workbench/studio";

/**
 * Edit & Sound, PR C2: Change voice and Dub.
 *
 * The audio routes, the dub route, the job feed and the project save are
 * mocked at the browser (no paid call, no engine, no stored generation),
 * the way tests/edit-sound-workbench.spec.ts does. A voice change replaces
 * the dialogue clip it was made from, in place; a dub shows its progress
 * row while the vendor works and lands on the dialogue lane at the
 * remembered playhead when the feed reports it succeeded. Quotes come from
 * the mocked admissions per started minute of the 65-second source.
 */
type Submission = { path: string; key: string | undefined; body: Record<string, unknown> };

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

test("Edit & Sound re-voices a dialogue clip in place and dubs a source onto the dialogue lane, quoted per minute", async ({ page }, info) => {
  await signInLocally(page.request);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const me = await page.request.get("/api/me").then((r) => r.json()),
    scope = `particl-active-${me.workspace.id}-${me.id}`;
  let project: Project = { ...seedProject(), id: "edit-sound-c2-" + randomUUID().slice(0, 8), name: "Edit & Sound C2 test", productionProjectId: "production-fixture", shotMappings: {} };
  project.shots = project.shots.slice(0, 2).map((s) => ({ ...s, duration: 72 }));
  const fps = project.fps;
  // Two stored originals with server-read lengths, and one dialogue clip playing the audio one.
  project.assets.push(
    { ...project.assets[0], id: "interview", uploadId: "upload-src-1", generationId: undefined, name: "Interview.wav", kind: "audio", mime: "audio/wav", url: "/api/uploads/upload-src-1", refs: [], seconds: 65 },
    { ...project.assets[0], id: "hero-video", uploadId: "upload-src-2", generationId: undefined, name: "Hero.mp4", kind: "video", mime: "video/mp4", url: "/api/uploads/upload-src-2", refs: [], seconds: 12 },
  );
  project.audioClips = [{ id: "clip-interview", assetId: "interview", lane: "dialogue", startFrame: 6, sourceIn: 0, duration: 48, gainDb: -3, pan: 0, fadeIn: 0, fadeOut: 0, muted: false, solo: false }];
  let revision = 1;
  const mappings: Record<string, string> = {};
  const current = () => project;

  const submissions: Submission[] = [];
  let finished = 0;
  const quotes: Record<string, number> = { voiceChange: 4, v1: 15, "v1-watermark": 10 };
  const jobOf = (s: Submission, i: number) => {
    const dub = s.path === "/api/audio/dub";
    const done = i < finished;
    return {
      id: "mock-c2-" + (i + 1),
      status: done ? "succeeded" : "running",
      kind: "audio",
      shotId: s.body.shotId,
      prompt: dub ? "Dub · Interview.wav → Spanish" : "Voice change · Interview.wav",
      title: dub ? "Interview · dubbed (Spanish)" : s.body.title,
      model: dub ? "eleven_dubbing_v1" : "eleven_multilingual_sts_v2",
      version: 1,
      durationS: 65,
      params: dub ? { task: "dub", dubbingStatus: done ? "dubbed" : "dubbing" } : { task: "voiceChange" },
      createdAt: Date.now() - (submissions.length - i) * 1000,
    };
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (path === "/api/workbench/projects") {
      if (request.method() === "PUT") {
        project = { ...request.postDataJSON().project, productionProjectId: "production-fixture", shotMappings: { ...mappings } };
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
        speechModels: [{ id: "mock-speech", label: "Mock speech", creditsPerChar: 1, note: "Local test" }],
        defaultSpeechModel: "mock-speech",
        voices: [],
        voicesError: null,
        account: null,
        terms: { sfxCredits: 200, musicCreditsPerMinute: 900 },
      });
    if (path === "/api/audio/voices")
      return json({ configured: true, voices: [{ id: "mockvoice01", name: "Avery", category: "premade" }, { id: "mockvoice02", name: "Blake", category: "cloned" }] });
    if ((path === "/api/audio" || path === "/api/audio/dub") && request.method() === "POST") {
      const body = request.postDataJSON();
      const dub = path === "/api/audio/dub";
      if (!dub && body.task !== "voiceChange") return json({ error: "unexpected audio task " + body.task }, 400);
      if (body.sourceUploadId !== "upload-src-1") return json({ error: "unexpected source" }, 400);
      const credits = dub ? quotes[String(body.mode)] : quotes.voiceChange;
      if (body.quoteOnly) return json({ estimatedCredits: credits, price: credits, unit: "cr", sourceSeconds: 65, minutes: 2, ...(dub ? { mode: body.mode } : {}) });
      submissions.push({ path, key: request.headers()["idempotency-key"], body });
      return json({ id: "mock-c2-" + submissions.length, status: "running", estimatedCredits: credits, ...(dub ? { jobId: "dub_" + "0".repeat(32), minutes: 2 } : { estCredits: 0 }) });
    }
    if (path === "/api/jobs") return json({ generations: submissions.map(jobOf), nextCursor: null });
    if (/^\/api\/jobs\/mock-c2-\d+$/.test(path)) {
      const index = Number(path.split("-").pop()) - 1;
      return submissions[index] ? json({ generation: jobOf(submissions[index], index) }) : json({ error: "gone" }, 404);
    }
    if (path.startsWith("/api/media/mock-c2-") || path.startsWith("/api/uploads/upload-src-")) return route.fulfill({ status: 404, body: "Not found" });
    if (path === "/api/workbench/atomik") return json({ models: [], jobs: [] });
    if (request.method() !== "GET") throw new Error(`Unexpected paid/mutating browser request: ${request.method()} ${path}`);
    return route.fallback();
  });

  await page.addInitScript(({ scope, id }) => localStorage.setItem(scope, id), { scope, id: project.id });
  await page.goto("/workbench");
  await stage(page, "edit");
  await openWorkbenchInspector(page, "sound");
  const panel = page.getByRole("region", { name: "Generate sound" });
  await panel.scrollIntoViewIfNeeded();
  const types = panel.getByRole("group", { name: "Sound type" });
  await expect(types.getByRole("button", { name: "Voice-over", exact: true })).toHaveAttribute("aria-pressed", "true");
  const generate = panel.locator("[data-sound-generate]");

  // Change voice: the audio original, the first voice, replacing the clip it plays in.
  await types.getByRole("button", { name: "Change voice", exact: true }).click();
  await expect(types.getByRole("button", { name: "Change voice", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByLabel("Script", { exact: true })).toHaveCount(0);
  await expect(panel.getByLabel("Sound lane", { exact: true })).toHaveCount(0);
  const source = panel.getByLabel("Voice change source", { exact: true });
  await expect(source).toHaveValue("interview");
  await expect(source.locator("option")).toHaveText(["Interview.wav · 65 s"]);
  await expect(panel.getByLabel("Voice", { exact: true })).toHaveValue("mockvoice01");
  const result = panel.getByLabel("Voice change result", { exact: true });
  await expect(result.locator("option")).toHaveText(["Add a dialogue clip at the playhead", "Replace sound clip 1 at 00:00"]);
  await expect(generate).toContainText("Change voice · 4 cr");
  await expect(panel).toContainText("Per started minute of the source · 2 min");
  await result.selectOption("clip-interview");
  await expect(panel).toContainText("Replaces the chosen dialogue clip in place.");
  await panel.getByLabel("Remove background noise", { exact: true }).check();
  await generate.click();
  await expect(panel.getByRole("status")).toContainText("Change voice submitted. It replaces its dialogue clip when it is ready.");
  await expect(panel.getByRole("list", { name: "Sound in progress" })).toContainText("Change voice · replaces its dialogue clip · running");
  expect(submissions).toHaveLength(1);
  expect(submissions[0].path).toBe("/api/audio");
  expect(submissions[0].key).toBeTruthy();
  expect(submissions[0].body).toMatchObject({ task: "voiceChange", sourceUploadId: "upload-src-1", voiceId: "mockvoice01", voiceName: "Avery", removeBackgroundNoise: true, maxCredits: 4, projectId: "production-fixture", title: "Interview · voice changed (Avery)" });
  const vcNode = current().nodes.find((n) => n.role === "sound-lane:voiceChange");
  expect(vcNode).toMatchObject({ type: "audio", mode: "Audio", title: "Voice change" });
  expect(submissions[0].body.shotId).toBe(mappings[vcNode!.id]);

  finished = 1;
  await expect.poll(() => current().audioClips?.[0]?.assetId, { timeout: 45_000 }).toBe("mock-c2-1");
  // Same clip, same place, same mix: only the voice changed.
  expect(current().audioClips).toHaveLength(1);
  expect(current().audioClips![0]).toMatchObject({ id: "clip-interview", lane: "dialogue", startFrame: 6, sourceIn: 0, duration: 48, gainDb: -3 });
  const vcAsset = current().assets.find((a) => a.id === "mock-c2-1");
  expect(vcAsset).toMatchObject({ kind: "audio", generationId: "mock-c2-1", nodeId: vcNode!.id, name: "Interview · voice changed (Avery)", seconds: 65, url: "/api/media/mock-c2-1" });
  await expect(panel.getByRole("status")).toContainText("Change voice replaced its dialogue clip in place.");
  await expect(panel.getByRole("list", { name: "Sound in progress" })).toHaveCount(0);
  const mix = page.getByRole("region", { name: "Sound mix" });
  await expect(mix.getByRole("group", { name: "Sound clip 1" })).toContainText("Interview · voice changed (Avery)");

  // Dub: audio and video originals offered; the mode and language are settings; the quote follows the mode.
  await movePlayhead(page, 24);
  await types.getByRole("button", { name: "Dub", exact: true }).click();
  const dubSource = panel.getByLabel("Dub source", { exact: true });
  await expect(dubSource.locator("option")).toHaveText(["Interview.wav · 65 s", "Hero.mp4 · video · 12 s", "Interview · voice changed (Avery) · 65 s"]);
  await expect(dubSource).toHaveValue("interview");
  await expect(panel.getByLabel("Source language", { exact: true })).toHaveValue("auto");
  await panel.getByLabel("Target language", { exact: true }).selectOption({ label: "Spanish" });
  await expect(panel.getByLabel("Dub mode", { exact: true })).toHaveValue("v1");
  await expect(generate).toContainText("Dub · 15 cr");
  await expect(panel).toContainText("Standard mode, one language (Spanish), per started minute of the source · 2 min");
  await panel.getByLabel("Dub mode", { exact: true }).selectOption("v1-watermark");
  await expect(generate).toContainText("Dub · 10 cr");
  await expect(panel).toContainText("Watermarked mode");
  await panel.getByLabel("Dub mode", { exact: true }).selectOption("v1");
  await expect(generate).toContainText("Dub · 15 cr");
  await generate.click();
  await expect(panel.getByRole("status")).toContainText("Dub submitted. The dubbed track lands on the dialogue lane at 00:01 when the vendor has finished");
  await expect(panel.getByRole("list", { name: "Sound in progress" })).toContainText("Dub · Dialogue lane at 00:01 · dubbing…");
  expect(submissions).toHaveLength(2);
  expect(submissions[1].path).toBe("/api/audio/dub");
  expect(submissions[1].body).toMatchObject({ sourceUploadId: "upload-src-1", sourceLang: "auto", targetLang: "es", mode: "v1", maxCredits: 15, projectId: "production-fixture" });
  expect(submissions[1].body.task).toBeUndefined();
  const dubNode = current().nodes.find((n) => n.role === "sound-lane:dub");
  expect(dubNode).toMatchObject({ type: "audio", title: "Dub" });
  expect(submissions[1].body.shotId).toBe(mappings[dubNode!.id]);
  expect(new Set(submissions.map((s) => s.key)).size).toBe(2);

  finished = 2;
  await expect.poll(() => current().audioClips?.length ?? 0, { timeout: 45_000 }).toBe(2);
  // The dubbed track: on the dialogue lane at the remembered playhead, the stored length as its duration.
  expect(current().audioClips![1]).toMatchObject({ lane: "dialogue", startFrame: 24, sourceIn: 0, duration: 65 * fps, gainDb: 0, pan: 0, fadeIn: 0, fadeOut: 0, muted: false, solo: false });
  const dubAsset = current().assets.find((a) => a.id === current().audioClips![1].assetId);
  expect(dubAsset).toMatchObject({ kind: "audio", generationId: "mock-c2-2", nodeId: dubNode!.id, name: "Interview · dubbed (Spanish)", seconds: 65 });
  await expect(panel.getByRole("status")).toContainText("Dub placed on the dialogue lane at 00:01.");
  await expect(mix.getByRole("group", { name: "Sound clip 2" })).toContainText("Interview · dubbed (Spanish)");
  await expect(mix.getByRole("group", { name: "Sound clip 2" }).getByLabel("Timeline start", { exact: true })).toHaveValue("24");

  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("edit-sound-c2.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
});
