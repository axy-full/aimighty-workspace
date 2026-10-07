import { test, expect, type Page, type Route } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Asset, type Project } from "../lib/workbench/studio";
import { DESKTOP, forbidPaidWork, mockLibrary, mockMedia, mockProjects, generation, type ProjectRoute } from "./helpers/workspaceFixtures";

/**
 * Edit & Sound over the board (the editor the Cut card opens): each new-sound door opens the existing SoundGenerate with the live
 * credit quote on its button; a stale or missing quote blocks, and the route's price ceiling (maxCredits) refuses a quote that no
 * longer holds; a sound made while the composer is closed still lands on its lane, at the length that was typed.
 *
 * Retargeted from the old /workspace page's stem rows ("Generate" on the SFX and Music stems), which Edit & Sound's own screen
 * replaced: its New voice line, New sound effect and New music open the same panel. The assembly, the lanes, the transport and the
 * export are tests/demo-gaps-l3-edit-workbench.spec.ts and tests/demo-s05-cut-deliver-workbench.spec.ts; what is here is what
 * can cost credits.
 */

const media = (id: string, name: string, kind: Asset["kind"], extra: Partial<Asset> = {}): Asset => ({
  id, name, kind, category: kind === "audio" ? "Audio" : "Shot", url: `/api/uploads/${id}`, uploadId: id, description: "", prompt: "",
  status: "Draft", locked: false, version: 1, refs: [], ...extra,
});

function fixture(): Project {
  return {
    ...newProject("Coastal light study"),
    id: "ws-edit",
    fps: 24,
    productionProjectId: "prod-ws",
    shotMappings: {},
    assets: [
      media("take_a", "The approach v2", "image", { generationId: "gen_a", uploadId: undefined, url: "/api/media/gen_a" }),
      media("take_b", "The encounter v1", "image", { generationId: "gen_b", uploadId: undefined, url: "/api/media/gen_b" }),
      media("vo_1", "Opening line.wav", "audio", { seconds: 4 }),
      media("score_1", "Slow piano.mp3", "audio", { seconds: 30 }),
    ],
    shots: [
      { id: "cut_1", name: "The approach", assetId: "take_a", duration: 120, sourceIn: 0, note: "" },
      { id: "cut_2", name: "The encounter", assetId: "take_b", duration: 96, sourceIn: 0, note: "" },
    ],
    audioClips: [
      { id: "clip_vo", assetId: "vo_1", lane: "dialogue", startFrame: 12, sourceIn: 0, duration: 96, gainDb: 0, pan: 0, fadeIn: 0, fadeOut: 0, muted: false, solo: false },
      { id: "clip_score", assetId: "score_1", lane: "music", startFrame: 0, sourceIn: 0, duration: 216, gainDb: -6, pan: 0, fadeIn: 0, fadeOut: 0, muted: false, solo: false },
    ],
  };
}

type Audio = { price: number; quoteDelayMs: number; quotes: Record<string, unknown>[]; submissions: Record<string, unknown>[] };

async function open(page: Page, store: ProjectRoute, audio: Audio) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, store);
  await mockLibrary(page, {
    uploads: [],
    generations: [generation({ id: "gen_a", title: "The approach", reviewState: "approved", creditsBilled: 18 }), generation({ id: "gen_b", title: "The encounter", creditsBilled: 18 })],
  });
  const json = (route: Route, value: unknown, status = 200, headers: Record<string, string> = {}) =>
    route.fulfill({ status, headers, contentType: "application/json", body: JSON.stringify(value) });
  await page.route("**/api/jobs?**", (route) => json(route, { generations: [], nextCursor: null }));
  await page.route("**/api/workbench/atomik**", (route) => json(route, { models: [], jobs: [] }));
  await page.route("**/api/audio/voices**", (route) => json(route, { configured: true, voices: [{ id: "voice_a", name: "Avery", category: "premade" }] }));
  await page.route(/\/api\/audio$/, async (route) => {
    const request = route.request();
    if (request.method() === "GET")
      return json(route, { configured: true, speechModels: [{ id: "speech-a", label: "Speech" }], defaultSpeechModel: "speech-a", voices: [], voicesError: null });
    const body = request.postDataJSON() as Record<string, unknown>;
    if (body.quoteOnly) {
      audio.quotes.push(body);
      const price = audio.price;
      if (audio.quoteDelayMs) await new Promise((resolve) => setTimeout(resolve, audio.quoteDelayMs));
      return json(route, { estimatedCredits: price, price, unit: "cr" });
    }
    audio.submissions.push({ ...body, idempotencyKey: request.headers()["idempotency-key"] });
    /* As lib/audioAdmission.ts: an estimate above the approved ceiling is refused, settled, before any spend. */
    if (typeof body.maxCredits !== "number" || audio.price > body.maxCredits)
      return json(route, { error: "The audio estimate exceeds the approved credit amount. Review the price before submitting." }, 409, { "Idempotency-Status": "complete" });
    return json(route, { id: "job_sfx_1", status: "running", estimatedCredits: audio.price });
  });
  /* The cut's editor opens over the board from the Cut card. */
  await page.goto(`/suites?project=${store.current.id}&view=board&region=cut`);
  await expect(page.getByTestId("cut-card")).toBeVisible();
  /* The press can land before the page is hydrated (a dev server that has just compiled it): press again until it opens. */
  await expect(async () => {
    await page.getByTestId("cut-open-edit").click({ timeout: 3_000 });
    await expect(page.getByTestId("edit-sound")).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 40_000 });
  await expect(page.getByTestId("es")).toBeVisible();
}

const laneOf = (page: Page, id: string) => page.getByTestId(`es-lane-${id}`);
const door = (page: Page, id: "es-new-voice" | "es-new-effect" | "es-new-music") => page.getByTestId(id);

test("New sound effect carries the live quote; a stale or missing quote blocks, and the ceiling refuses a moved price", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  const store: ProjectRoute = { current: fixture() };
  const audio: Audio = { price: 3, quoteDelayMs: 0, quotes: [], submissions: [] };
  await open(page, store, audio);

  await door(page, "es-new-effect").click();
  const composer = page.getByTestId("es-compose");
  await expect(composer.getByRole("group", { name: "Sound type" }).getByRole("button", { name: "Sound effect" })).toHaveAttribute("aria-pressed", "true");
  const button = composer.locator("[data-sound-generate]");
  /* No description, no quote: nothing to submit. */
  await expect(button).toBeDisabled();
  await composer.getByLabel("Describe the sound").fill("Wind over dunes, a low constant bed");
  await expect(button).toHaveText("Generate sound effect · 3 cr");
  await expect(button).toBeEnabled();
  expect(audio.quotes.at(-1)).toMatchObject({ task: "sound", text: "Wind over dunes, a low constant bed", quoteOnly: true });

  /* Edit the request: the shown price is stale until the new quote lands, and the button is blocked meanwhile. */
  audio.quoteDelayMs = 1500;
  audio.price = 4;
  await composer.getByLabel("Describe the sound").fill("Wind over dunes, gusting, with sand hiss");
  await expect(button).toBeDisabled();
  await expect(button).toHaveText("Generate sound effect");
  await expect(button).toHaveText("Generate sound effect · 4 cr");
  await expect(button).toBeEnabled();

  /* The price moves after the quote was shown: the route's ceiling refuses it, nothing is queued. */
  audio.quoteDelayMs = 0;
  audio.price = 6;
  await button.click();
  await expect(composer.getByRole("alert")).toContainText("The audio estimate exceeds the approved credit amount");
  expect(audio.submissions).toHaveLength(1);
  expect(audio.submissions[0]).toMatchObject({ task: "sound", maxCredits: 4, projectId: "prod-ws" });
  expect(String(audio.submissions[0].shotId)).toMatch(/^shot_/);
  expect(audio.submissions[0].idempotencyKey).toBeTruthy();
  await expect(laneOf(page, "sfx")).toHaveCount(0);
  /* The lane node was created and saved through the draft before submitting. */
  expect(store.current.nodes.some((n) => n.role === "sound-lane:sound")).toBe(true);
});

test("generated music lands on its lane after the composer is closed, with the length that was typed", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  const store: ProjectRoute = { current: fixture() };
  const audio: Audio = { price: 5, quoteDelayMs: 0, quotes: [], submissions: [] };
  await open(page, store, audio);
  /* As the route: map-shot records the node's shot, and every save and read returns the mappings it holds. */
  await page.route("**/api/workbench/projects**", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      const body = request.postDataJSON() as { action?: string; nodeId?: string };
      if (body.action !== "map-shot") return route.fallback();
      const shotId = "shot_" + String(body.nodeId).replace(/[^a-zA-Z0-9_-]/g, "");
      store.current = { ...store.current, shotMappings: { ...store.current.shotMappings, [String(body.nodeId)]: shotId } };
      return route.fulfill({ json: { productionProjectId: "prod-ws", shotId } });
    }
    return route.fallback();
  });
  /* The job feed: running until the composer is closed, then finished. */
  let finished = false;
  await page.route("**/api/jobs?**", (route) => {
    const submitted = audio.submissions.find((s) => typeof s.maxCredits === "number");
    const generations = submitted
      ? [{ id: "job_sfx_1", status: finished ? "succeeded" : "running", kind: "audio", shotId: submitted.shotId, prompt: String(submitted.text), model: "music-model", version: 1, createdAt: Date.now(), durationS: 45, params: { task: "music" } }]
      : [];
    return route.fulfill({ json: { generations, nextCursor: null } });
  });

  await door(page, "es-new-music").click();
  const composer = page.getByTestId("es-compose");
  await composer.getByLabel("Describe the music").fill("Slow strings under the reveal");
  /* Typed key by key: 45 stays 45 (clamping each keystroke made it 105). */
  const length = composer.getByLabel("Length in seconds");
  await length.fill("");
  await length.pressSequentially("45");
  await expect(length).toHaveValue("45");
  await expect(composer.locator("[data-sound-generate]")).toHaveText("Generate music · 5 cr");
  expect(audio.quotes.at(-1)).toMatchObject({ task: "music", lengthMs: 45000 });
  await length.blur();
  await expect(length).toHaveValue("45");

  await composer.locator("[data-sound-generate]").click();
  await expect(composer.getByRole("status")).toContainText("lands on the music lane");
  expect(audio.submissions).toHaveLength(1);
  expect(audio.submissions[0]).toMatchObject({ task: "music", lengthMs: 45000, maxCredits: 5 });
  /* Close the composer before the track is ready. */
  await door(page, "es-new-music").click();
  await expect(page.getByTestId("es-compose")).toHaveCount(0);
  finished = true;
  await expect(laneOf(page, "music").locator(".gx-es-clip--sound")).toHaveCount(2, { timeout: 20_000 });
  await expect(page.getByTestId("es").getByRole("status").filter({ hasText: "placed on the music lane" })).toBeVisible();
  /* The lane's mapping reached the draft, and the placed clip was saved. */
  await expect.poll(() => (store.current.audioClips ?? []).filter((c) => c.lane === "music").length).toBe(2);
  const lane = store.current.nodes.find((n) => n.role === "sound-lane:music")!;
  expect(store.current.shotMappings?.[lane.id]).toBe(audio.submissions[0].shotId);
  expect(store.current.assets.some((a) => a.generationId === "job_sfx_1")).toBe(true);
});
