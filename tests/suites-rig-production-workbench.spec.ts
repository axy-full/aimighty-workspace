import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Asset, type Project } from "../lib/workbench/studio";
import { generation, mockLibrary, mockMedia, mockProjects } from "./helpers/workspaceFixtures";

/**
 * Production › Rig (owner's brief, 23 September): a shot per storyboard frame;
 * each shot's own 20,000-character prompt and notes; inputs from the library,
 * previous shots and the cast, one image as the first frame (and the engine's
 * rule that a first frame and references do not mix); a render prompt over the
 * engine's 10,000 characters is held for the agent to condense; "build another
 * rig" from a take; Generate sends the shot's own prompt and roles at the price
 * shown.
 */
const SIZES = ["workbench-1440x900"];
const img = (id: string, name: string, category: string, extra: Partial<Asset> = {}): Asset => ({ id, generationId: id, name, kind: "image", category, url: `/api/media/${id}`, description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [], ...extra });
function fixture(): Project {
  const p = newProject("Harbour rig");
  const at = new Date().toISOString();
  return {
    ...p, id: "ws-rig", productionProjectId: "prod-rig", shotMappings: {},
    assets: [img("gen_frame", "Frame 1.1", "Storyboard"), img("gen_mara", "Mara", "Character"), img("gen_take", "Old take", "Generate", { nodeId: "n-old" })],
    nodes: [{ id: "n-old", title: "Old shot", type: "scene", x: 100, y: 100, width: 300, linked: [], mode: "Video", engine: "dreamina-seedance-2-5-260628", assetId: "gen_take" }],
    production: {
      beats: { scriptSha256: "a".repeat(64), updatedAt: at, scenes: [{ id: "scene-a", heading: "EXT. FROZEN HARBOUR - DUSK", summary: "", beats: [], shots: [{ id: "shot-a1", description: "The fox on the ice", framing: "Wide", movement: "Slow push", lighting: "Dusk", sound: "Wind", duration: 5 }], characters: [], locations: [], props: [] }] },
      boards: { style: "live", model: "gemini-3.1-flash-image", frames: { "shot-a1": { prompt: "A red fox crosses the frozen harbour at dusk, wide.", takes: [{ genId: "gen_frame", style: "live", at }], selected: "gen_frame" } } },
    },
  };
}

async function open(page: Page) {
  await signInLocally(page.request);
  await mockMedia(page);
  const store = { current: fixture() };
  await mockProjects(page, store);
  await mockLibrary(page, { uploads: [], generations: [
    generation({ id: "gen_clip", title: "Harbour plate", prompt: "Harbour plate", kind: "video", model: "dreamina-seedance-2-5-260628", durationS: 5, projectId: "prod-rig" }),
    generation({ id: "gen_frame", title: "Frame 1.1", projectId: "prod-rig" }),
  ] });
  await page.route(/\/api\/workbench\/engines\?/, (route) => route.fulfill({ json: { models: [], credits: 12 } }));
  /* A finished wiring run for the old shot: the agent's prompt, notes and one input. */
  const wired = { id: "wb_development_11111111-2222-3333-4444-555555555555", requestId: "req-wired-1", projectId: "ws-rig", kind: "rig", nodeId: "n-old", model: "anthropic/claude-sonnet-4.6", effort: "auto", instructions: "", status: "succeeded", completedChunks: 1, totalChunks: 1, currentStage: "complete", completedSteps: 3, totalSteps: 3, estimateCredits: 2, credits: 1, error: null, createdAt: 1, updatedAt: 1,
    result: { summary: "", recommendation: "", ideas: [], scenes: [], critique: [], assumptions: [], rig: { nodeId: "n-old", prompt: "Wired: Mara watches the fox from the hut window.", notes: "Hold on her eyes.", inputs: ["gen_mara"], firstFrame: null } } };
  await page.route(/\/api\/workbench\/development/, (route) => route.fulfill({ json: { configured: true, models: [{ id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6", vision: true, efforts: [{ value: "auto", label: "Auto" }] }], jobs: [wired] } }));
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  await page.route(/\/api\/generate(\/quote)?$/, (route) => {
    const request = route.request();
    posts.push({ url: request.url(), body: request.postDataJSON() });
    return route.fulfill({ json: request.url().endsWith("/quote") ? { estimatedCredits: 12, fingerprint: "e".repeat(64), price: 0.12, unit: "cr" } : { id: "gen_new" } });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/suites?suite=studio&page=rig");
  await expect(page.getByTestId("project-name")).toHaveText("Harbour rig");
  return { errors, store, posts };
}

test("Rig: shots from Storyboards, prompt and inputs, the first-frame rule, the engine limit, a rig from a take, and what Generate sends", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "the Rig's graph and inspector on a desktop");
  const { errors, store, posts } = await open(page);
  const list = page.getByTestId("rig-list");

  /* One shot per framed storyboard shot, its prompt from the frame, the frame as its first frame (live action). */
  await list.getByTestId("rig-from-boards").click();
  await expect(list.getByText("1.1 — The fox on the ice")).toBeVisible();
  await list.getByText("1.1 — The fox on the ice").click();
  await expect(page.getByTestId("rig-prompt-input")).toHaveValue(/A red fox crosses the frozen harbour at dusk, wide\.\nCamera: Slow push\.\nSound: Wind\./);
  const tabs = page.getByRole("group", { name: "Inspector tabs" });
  await tabs.getByRole("button", { name: /Inputs/ }).click();
  await expect(page.getByTestId("rig-input")).toHaveCount(1);
  await expect(page.getByTestId("rig-input")).toContainText("First frame");

  /* Inputs from the library and the cast; a first frame with references is refused, so it is unmarked. */
  await page.getByTestId("rig-add-library").selectOption({ label: "Harbour plate" });
  await page.getByTestId("rig-add-cast").selectOption({ label: "Cast · Mara" });
  await expect(page.getByTestId("rig-input")).toHaveCount(3);
  await expect(page.getByTestId("rig-inputs")).toContainText("A first frame cannot be combined with reference images or videos");
  await page.getByRole("button", { name: "Unmark first frame" }).click();
  await expect(page.getByTestId("rig-input").first()).toContainText("Reference image");

  /* The prompt holds 20,000 characters; over the engine's 10,000 the agent is asked to condense, and Generate says why it waits. */
  await tabs.getByRole("button", { name: /Controls/ }).click();
  const long = "The fox pauses, ears forward, breath smoking in the cold. ".repeat(210).slice(0, 12_000);
  await page.getByTestId("rig-prompt-input").fill(long);
  await expect(page.getByTestId("rig-condense")).toContainText("engines take 10,000");
  await expect(page.getByTestId("rig-condense-estimate")).toBeEnabled();
  await expect(page.locator(".pxw-insp-generate")).toBeDisabled();
  await page.getByTestId("rig-prompt-input").fill("A red fox crosses the frozen harbour at dusk; hold wide, then push in on its eyes.");
  await expect(page.getByTestId("rig-condense")).toHaveCount(0);

  /* Generate: the shot's own prompt, its inputs listed, references by kind, at the price shown. */
  await expect(page.locator(".pxw-insp-generate")).toHaveText("Generate take · 12 cr", { timeout: 15_000 });
  await page.locator(".pxw-insp-generate").click();
  await expect.poll(() => posts.find((p) => p.url.endsWith("/api/generate"))?.body ?? null, { timeout: 15_000 }).toMatchObject({ maxCredits: 12 });
  const sent = posts.find((p) => p.url.endsWith("/api/generate"))!.body;
  expect(String(sent.prompt)).toMatch(/^A red fox crosses the frozen harbour at dusk; hold wide, then push in on its eyes\.\n\nInputs:\nInput 1 — Frame 1\.1 \(storyboard\): reference image/);
  expect(sent.references).toEqual(expect.arrayContaining([{ genId: "gen_frame", role: "reference_image" }, { genId: "gen_clip", role: "reference_video" }, { genId: "gen_mara", role: "reference_image" }]));

  /* The agent's wiring of the old shot lands on it: prompt, notes, an input from the cast. */
  await list.getByText("Old shot", { exact: true }).click();
  await tabs.getByRole("button", { name: /Controls/ }).click();
  await expect(page.getByTestId("rig-prompt-input")).toHaveValue("Wired: Mara watches the fox from the hut window.");
  await expect(page.getByLabel("Direction note")).toHaveValue("Hold on her eyes.");
  await tabs.getByRole("button", { name: /Inputs/ }).click();
  await expect(page.getByTestId("rig-input")).toContainText("Mara");

  /* Build another rig from a take of the old shot. */
  await tabs.getByRole("button", { name: /Versions/ }).click();
  await page.getByTestId("rig-branch").first().click();
  await expect(page.getByTestId("inspector-title")).toHaveText("Old shot · from Old take");
  await expect.poll(() => store.current.nodes.find((n) => n.title === "Old shot · from Old take")?.firstFrameId ?? null, { timeout: 10_000 }).toBe("gen_take");
  expect(errors).toEqual([]);
});
