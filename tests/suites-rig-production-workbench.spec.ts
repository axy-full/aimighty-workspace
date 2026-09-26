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

const WIRED_ID = "wb_development_11111111-2222-3333-4444-555555555555";
async function open(page: Page, options: { store?: { current: Project }; wiring?: { status: "running" | "succeeded" } } = {}) {
  await signInLocally(page.request);
  await mockMedia(page);
  const store = options.store ?? { current: fixture() };
  const wiring = options.wiring ?? { status: "succeeded" };
  await mockProjects(page, store);
  await mockLibrary(page, { uploads: [], generations: [
    generation({ id: "gen_clip", title: "Harbour plate", prompt: "Harbour plate", kind: "video", model: "dreamina-seedance-2-5-260628", durationS: 5, projectId: "prod-rig" }),
    generation({ id: "gen_frame", title: "Frame 1.1", projectId: "prod-rig" }),
  ] });
  await page.route(/\/api\/workbench\/engines\?/, (route) => route.fulfill({ json: { models: [], credits: 12 } }));
  /* A finished wiring run for the old shot: the agent's prompt, notes and one input. */
  const wired = { id: WIRED_ID, requestId: "req-wired-1", projectId: "ws-rig", kind: "rig", nodeId: "n-old", model: "anthropic/claude-sonnet-4.6", effort: "auto", instructions: "", status: "succeeded", completedChunks: 1, totalChunks: 1, currentStage: "complete", completedSteps: 3, totalSteps: 3, estimateCredits: 2, credits: 1, error: null, createdAt: 1, updatedAt: 1,
    result: { summary: "", recommendation: "", ideas: [], scenes: [], critique: [], assumptions: [], rig: { nodeId: "n-old", prompt: "Wired: Mara watches the fox from the hut window.", notes: "Hold on her eyes.", inputs: ["gen_mara"], firstFrame: null } } };
  const running = { ...wired, status: "running", completedChunks: 0, currentStage: "planning", completedSteps: 1, credits: null, result: null };
  await page.route(/\/api\/workbench\/development/, (route) => route.fulfill({ json: { configured: true, models: [{ id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6", vision: true, efforts: [{ value: "auto", label: "Auto" }] }], jobs: [wiring.status === "running" ? running : wired] } }));
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

  /* A wiring of the old shot that finished before this tab watched it (and the shot never recorded one) is offered, not laid over the shot. */
  await list.getByText("Old shot", { exact: true }).click();
  await tabs.getByRole("button", { name: /Controls/ }).click();
  await expect(page.getByTestId("rig-wire-offer")).toBeVisible();
  await expect(page.getByTestId("rig-prompt-input")).not.toHaveValue("Wired: Mara watches the fox from the hut window.");
  /* Applied on request: prompt, notes, an input from the cast, and the run recorded on the shot. */
  await page.getByTestId("rig-wire-apply").click();
  await expect(page.getByTestId("rig-prompt-input")).toHaveValue("Wired: Mara watches the fox from the hut window.");
  await expect(page.getByLabel("Direction note")).toHaveValue("Hold on her eyes.");
  await expect(page.getByTestId("rig-wire-offer")).toHaveCount(0);
  await expect.poll(() => store.current.nodes.find((n) => n.id === "n-old")?.wiredJobId ?? null, { timeout: 15_000 }).toBe(WIRED_ID);
  await tabs.getByRole("button", { name: /Inputs/ }).click();
  await expect(page.getByTestId("rig-input")).toContainText("Mara");

  /* Build another rig from a take of the old shot. */
  await tabs.getByRole("button", { name: /Versions/ }).click();
  await page.getByTestId("rig-branch").first().click();
  await expect(page.getByTestId("inspector-title")).toHaveText("Old shot · from Old take");
  await expect.poll(() => store.current.nodes.find((n) => n.title === "Old shot · from Old take")?.firstFrameId ?? null, { timeout: 10_000 }).toBe("gen_take");
  expect(errors).toEqual([]);
});

test("Rig: a shot can be deleted — from its Inspector, the right-click menu or ⌫ — and ⌘Z brings it back", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "the Rig's list and inspector on a desktop");
  const { errors, store } = await open(page);
  const list = page.getByTestId("rig-list");
  const row = () => list.getByText("Old shot", { exact: true });
  const saved = () => store.current.nodes.some((n) => n.id === "n-old");
  const undo = () => page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");

  /* The Inspector's Delete shot. */
  await row().click();
  await page.getByTestId("rig-delete-shot").click();
  await expect(row()).toHaveCount(0);
  await expect.poll(saved, { timeout: 15_000 }).toBe(false);
  await undo();
  await expect(row()).toHaveCount(1);
  await expect.poll(saved, { timeout: 15_000 }).toBe(true);

  /* The right-click menu on the row. */
  await row().click({ button: "right" });
  await page.getByRole("menuitem", { name: /Delete/ }).click();
  await expect(row()).toHaveCount(0);
  await undo();
  await expect(row()).toHaveCount(1);

  /* ⌫ on the selected shot. */
  await row().click();
  await page.keyboard.press("Backspace");
  await expect(row()).toHaveCount(0);
  await expect.poll(saved, { timeout: 15_000 }).toBe(false);
  expect(errors).toEqual([]);
});

test("Rig: the agent's wiring lands once, when this tab watched it finish; a hand edit survives a new tab", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "the Rig's list and inspector on a desktop");
  const store = { current: fixture() };
  const wiring: { status: "running" | "succeeded" } = { status: "running" };
  const { errors } = await open(page, { store, wiring });
  const list = page.getByTestId("rig-list");
  const tabs = page.getByRole("group", { name: "Inspector tabs" });
  await list.getByText("Old shot", { exact: true }).click();
  await tabs.getByRole("button", { name: /Controls/ }).click();
  await expect(page.getByTestId("rig-wire")).toContainText("The agent is wiring this shot.");
  /* It finishes while the shot is open: laid on at once, and recorded. */
  wiring.status = "succeeded";
  await expect(page.getByTestId("rig-prompt-input")).toHaveValue("Wired: Mara watches the fox from the hut window.", { timeout: 15_000 });
  await expect(page.getByTestId("toast")).toContainText("The agent wired Old shot: 1 input");
  await expect(page.getByTestId("rig-wire-offer")).toHaveCount(0);
  await expect.poll(() => store.current.nodes.find((n) => n.id === "n-old")?.wiredJobId ?? null, { timeout: 15_000 }).toBe(WIRED_ID);

  /* The director rewrites it; a new tab (a reload, another device, a teammate) never lays the old wiring back over it. */
  await page.getByTestId("rig-prompt-input").fill("Mine: the keeper lowers the lamp.");
  await expect.poll(() => store.current.nodes.find((n) => n.id === "n-old")?.text ?? null, { timeout: 15_000 }).toBe("Mine: the keeper lowers the lamp.");
  /* A new tab: nothing of this one's session survives, only what the draft saved. */
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await expect(page.getByTestId("project-name")).toHaveText("Harbour rig");
  await list.getByText("Old shot", { exact: true }).click();
  await tabs.getByRole("button", { name: /Controls/ }).click();
  await expect(page.getByTestId("rig-prompt-input")).toHaveValue("Mine: the keeper lowers the lamp.");
  await expect(page.getByTestId("rig-wire-offer")).toHaveCount(0);
  await page.waitForTimeout(1500);
  await expect(page.getByTestId("rig-prompt-input")).toHaveValue("Mine: the keeper lowers the lamp.");
  expect(store.current.nodes.find((n) => n.id === "n-old")?.text).toBe("Mine: the keeper lowers the lamp.");
  expect(errors).toEqual([]);
});
