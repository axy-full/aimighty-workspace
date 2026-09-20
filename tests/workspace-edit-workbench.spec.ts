import { test, expect, type Page, type Route } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Asset, type Project } from "../lib/workbench/studio";
import { CLIP_WIDTHS, DESKTOP, PHONE, assertNoClipping, forbidPaidWork, mockLibrary, mockMedia, mockProjects, generation, type ProjectRoute } from "./helpers/workspaceFixtures";

/**
 * Edit & Sound (workspace redesign): the assembly from the real edit
 * sequence with the real TimelinePreview transport, stem rows from the
 * edit's audio lanes (dialogue, sfx, music — no invented ambience lane),
 * each opening the existing SoundGenerate door with the live credit quote
 * on its button; a stale or missing quote blocks, and the route's price
 * ceiling (maxCredits) refuses a quote that no longer holds. The mix stays
 * reachable.
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
  await page.goto(`/workspace?project=${store.current.id}&suite=particl&page=edit`);
  await expect(page.getByTestId("page-title")).toHaveText("Edit & Sound");
}

const stem = (page: Page, id: string) => page.locator(`[data-stem="${id}"]`);

test("phones keep the existing phone surface for Edit & Sound", async ({ page }, info) => {
  test.skip(!PHONE.includes(info.project.name), "phone viewports");
  await signInLocally(page.request);
  await mockProjects(page, { current: fixture() });
  await page.goto(`/workspace?project=ws-edit&suite=particl&page=edit`);
  await expect(page).toHaveURL(/\/workbench\?project=ws-edit$/);
});

test("Edit & Sound: assembly from the sequence, stems from the lanes, transport and mix", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page, { current: fixture() }, { price: 3, quoteDelayMs: 0, quotes: [], submissions: [] });

  /* 216 frames at 24 fps = 9 s; one of the two clips is an approved take. */
  await expect(page.getByTestId("assembly-title")).toHaveText("Assembly · 00:09");
  await expect(page.getByTestId("assembly")).toContainText("2 clips · 1 approved take");
  await expect(page.getByTestId("assembly").locator("img")).toBeVisible();

  /* Three lanes, three rows; ambience is explained, not invented. */
  await expect(page.locator("[data-stem]")).toHaveCount(3);
  await expect(stem(page, "dialogue")).toHaveAttribute("data-state", "scored");
  await expect(stem(page, "dialogue")).toContainText("Opening line.wav");
  await expect(stem(page, "dialogue")).toContainText("1 clip");
  await expect(stem(page, "dialogue").getByRole("button")).toHaveText("Replace");
  await expect(stem(page, "sfx")).toHaveAttribute("data-state", "empty");
  await expect(stem(page, "sfx")).toContainText("No effects or ambience beds in the cut yet.");
  await expect(stem(page, "sfx").getByRole("button")).toHaveText("Generate");
  await expect(stem(page, "music")).toContainText("00:09");
  await expect(page.getByText("Ambience has no lane of its own")).toBeVisible();

  /* Play runs the real transport; Pause stops it. */
  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  await expect(page.getByTestId("assembly")).toContainText(/00:0[1-9]/, { timeout: 5000 });
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("button", { name: "Play" })).toBeVisible();

  /* The existing mix is one click away. */
  await expect(page.getByTestId("mix")).toBeHidden();
  await page.getByTestId("assembly").getByRole("button", { name: "Mix", exact: true }).click();
  await expect(page.getByRole("region", { name: "Sound mix" })).toBeVisible();

  /* Dialogue's Replace opens Change voice — the tool that replaces a clip in place. */
  await stem(page, "dialogue").getByRole("button", { name: "Replace" }).click();
  const composer = page.getByTestId("composer-dialogue");
  await expect(composer.getByRole("group", { name: "Sound type" }).getByRole("button", { name: "Change voice" })).toHaveAttribute("aria-pressed", "true");

  for (const size of CLIP_WIDTHS) {
    await page.setViewportSize(size);
    await assertNoClipping(page);
  }
  if (info.project.name === "workbench-1440x900") {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByTestId("assembly").getByRole("button", { name: "Mix", exact: true }).click();
    await stem(page, "dialogue").getByRole("button", { name: "Replace" }).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: info.outputPath("edit-1440x900.png") });
  }
  expect(errors).toEqual([]);
});

test("a stem's Generate carries the live quote; a stale or missing quote blocks, and the ceiling refuses a moved price", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  const store: ProjectRoute = { current: fixture() };
  const audio: Audio = { price: 3, quoteDelayMs: 0, quotes: [], submissions: [] };
  await open(page, store, audio);

  await stem(page, "sfx").getByRole("button", { name: "Generate" }).click();
  const composer = page.getByTestId("composer-sfx");
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
  await expect(stem(page, "sfx")).toHaveAttribute("data-state", "empty");
  /* The lane node was created and saved through the draft before submitting. */
  expect(store.current.nodes.some((n) => n.role === "sound-lane:sound")).toBe(true);
});
