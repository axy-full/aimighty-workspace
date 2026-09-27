import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Asset, type CanvasNode, type Project } from "../lib/workbench/studio";
import { DESKTOP, PHONE, forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, upload, type ProjectRoute } from "./helpers/workspaceFixtures";

/**
 * The workspace's controls do what they say, or are not there (audit, 25 September):
 * the composer's library offers only what the composer can do and holds a sound's
 * length to what is billed; a failed read of the edit offers Retry; Brief opens the
 * shell's own agent, and only once the brief is saved; the header carries no toggle
 * that changes nothing; the Suites Cast Inspector shows the stage it can show; the
 * Rig's Estimate is the Generate button's own figure.
 */

const image = (id: string, name: string, extra: Partial<Asset> = {}): Asset => ({
  id, name, kind: "image", category: "Element", url: `/api/uploads/${id}`, uploadId: id, description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [], ...extra,
});
const shot = (id: string, title: string, linked: string[] = [], extra: Partial<CanvasNode> = {}): CanvasNode => ({
  id, title, type: "scene", x: 0, y: 0, width: 300, linked, role: "Director", status: "draft", mode: "Video",
  engine: "dreamina-seedance-2-5-260628", durationS: 5, ratio: "16:9", resolution: "720p", ...extra,
});

function fixture(): Project {
  return {
    ...newProject("Coastal light study"), id: "ws-honest", productionProjectId: "prod-honest", shotMappings: {}, fps: 24,
    brief: "A lighthouse keeper's last night.",
    assets: [image("up_plate", "Harbour plate")],
    nodes: [
      { id: "n-plate", title: "Harbour plate", type: "element", assetId: "up_plate", role: "", x: 0, y: 0, width: 240, linked: [] },
      shot("s1", "The approach", ["n-plate"]),
      shot("s2", "The encounter"),
    ],
  };
}

/** `routes` runs after the paid-work guard, so a test's own mock of a paid route (a quote) answers first. */
async function open(page: Page, url: string, store: ProjectRoute = { current: fixture() }, routes?: () => Promise<unknown>) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await routes?.();
  await mockMedia(page);
  await mockProjects(page, store);
  await mockLibrary(page, { uploads: [upload({ id: "up_plate", filename: "plate.webp" })], generations: [generation({ id: "gen_one", title: "Wide on the water", prompt: "Wide on the water" })] });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && /Maximum update depth/.test(message.text())) errors.push(message.text()); });
  await page.goto(url);
  return { errors, store };
}

test("the composer's library offers only what the composer does, and a sound's length is the length billed", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  const quotes: Record<string, unknown>[] = [];
  const paid: string[] = [];
  const { errors } = await open(page, "/workspace?project=ws-honest&suite=particl&page=brief", undefined, () => page.route(/\/api\/audio$/, async (route) => {
    const request = route.request();
    if (request.method() === "GET")
      return route.fulfill({ json: { configured: true, speechModels: [{ id: "speech-a", label: "Speech" }], defaultSpeechModel: "speech-a", voices: [{ id: "voice-a", name: "Narrator" }], voicesError: null } });
    const body = request.postDataJSON() as Record<string, unknown>;
    if (body.quoteOnly) { quotes.push(body); return route.fulfill({ json: { estimatedCredits: 7 } }); }
    paid.push("POST /api/audio");
    return route.fulfill({ status: 409, json: { error: "Nothing is rendered in this test." } });
  }));
  await expect(page.getByTestId("project-title")).toHaveText("Coastal light study");
  /* No scope toggle that changes nothing. */
  await expect(page.getByRole("tab", { name: "Shared view" })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "View scope" })).toHaveCount(0);

  await page.getByTestId("topbar-generate").click();
  const composer = page.getByTestId("generate-composer");
  await expect(composer).toBeVisible();
  const library = composer.getByRole("complementary", { name: "Project library" });
  await expect(library.getByRole("button", { name: "Use as reference" }).first()).toBeVisible();
  /* The composer cannot edit or upscale: no card offers it, in its buttons or its menu. */
  await expect(library.getByRole("button", { name: /^Edit (image|clip)$/ })).toHaveCount(0);
  await library.getByRole("button", { name: /^Actions for / }).first().click();
  await expect(page.getByRole("menuitem", { name: /Upscale|Edit image|Edit clip/ })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Preview" })).toBeVisible();
  /* Esc would close the composer too: the menu is dismissed by a click elsewhere in it. */
  await composer.locator(".pxw-composer-title").click({ force: true });
  await expect(page.getByRole("menuitem", { name: "Preview" })).toHaveCount(0);

  /* Music has a ten-second floor and a five-minute ceiling: what the field shows is what is priced. */
  await composer.getByRole("group", { name: "Output type" }).getByRole("button", { name: "Audio" }).click();
  await composer.getByTestId("composer-model").selectOption("eleven_music");
  await composer.getByTestId("composer-prompt").fill("A slow piano under the harbour wind.");
  const seconds = composer.getByRole("spinbutton", { name: "Seconds" });
  await seconds.fill("5");
  await seconds.blur();
  await expect(seconds).toHaveValue("10");
  await expect.poll(() => quotes.at(-1)?.lengthMs).toBe(10_000);
  await seconds.fill("999");
  await seconds.blur();
  await expect(seconds).toHaveValue("300");
  await expect.poll(() => quotes.at(-1)?.lengthMs).toBe(300_000);
  /* A sound effect runs to 30 s: switching holds the length already typed to it. */
  await composer.getByTestId("composer-model").selectOption("eleven_sfx");
  await expect(seconds).toHaveValue("30");
  await expect.poll(() => quotes.at(-1)?.durationSeconds).toBe(30);
  expect(paid).toEqual([]);
  expect(errors).toEqual([]);
});

test("Edit & Sound: a failed read of the edit says so and offers Retry, never a loading line that will not change", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  const { errors } = await open(page, "/workspace?project=ws-honest&suite=particl&page=takes");
  await expect(page.getByTestId("project-title")).toHaveText("Coastal light study");
  /* From here on, reading the project fails until the connection comes back. */
  let down = true;
  await page.route(/\/api\/workbench\/projects\?id=/, (route) => (down && route.request().method() === "GET" ? route.fulfill({ status: 503, json: { error: "Studio could not load this project (503)." } }) : route.fallback()));
  await page.getByRole("navigation", { name: "Pages" }).locator('[data-page="edit"]').click();
  await expect(page.getByRole("alert").filter({ hasText: "could not load this project" })).toBeVisible();
  await expect(page.getByText("Loading the edit…")).toHaveCount(0);
  down = false;
  await page.getByTestId("edit-retry").click();
  await expect(page.getByTestId("assembly")).toBeVisible();
  expect(errors).toEqual([]);
});

test("phone Edit & Sound: a failed read of the edit says so and offers Retry", async ({ page }, info) => {
  test.skip(!PHONE.includes(info.project.name), "phone viewports");
  const store: ProjectRoute = { current: { ...fixture(), shots: [{ id: "c1", name: "01 — The approach", assetId: "up_plate", duration: 48, sourceIn: 0, note: "" }] } };
  const { errors } = await open(page, "/workspace?project=ws-honest&suite=particl&page=takes", store);
  await expect(page.getByTestId("mobile-page-title")).toHaveText("Takes");
  /* From here on, reading the project fails until the connection comes back. */
  let down = true;
  await page.route(/\/api\/workbench\/projects\?id=/, (route) => (down && route.request().method() === "GET" ? route.fulfill({ status: 503, json: { error: "Studio could not load this project (503)." } }) : route.fallback()));
  await page.locator('[data-tab="stages"]').click();
  await page.locator('[data-screen="suite"] [data-page="edit"]').click();
  await expect(page.getByTestId("mobile-page-title")).toHaveText("Edit & Sound");
  await expect(page.getByRole("alert").filter({ hasText: "could not load this project" })).toBeVisible();
  await expect(page.getByText("Loading the edit…")).toHaveCount(0);
  const retry = page.getByTestId("mobile-edit-retry");
  const box = (await retry.boundingBox())!;
  expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
  down = false;
  await retry.click();
  await expect(page.getByTestId("mobile-edit")).toBeVisible();
  expect(errors).toEqual([]);
});

test("Brief opens the shell's own Atomik conversation, and only once the brief is saved", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  const { errors } = await open(page, "/workspace?project=ws-honest&suite=particl&page=brief");
  const body = page.locator('[data-tool-body="brief"]');
  await expect(body).toBeVisible();
  /* The save does not get through: the button says so and stays with the edits. */
  let offline = true;
  await page.route("**/api/workbench/projects**", (route) => (offline && route.request().method() === "PUT" ? route.abort("internetdisconnected") : route.fallback()));
  await body.getByRole("textbox").first().fill("A lighthouse keeper's last night, told from the lamp room.");
  await body.getByRole("button", { name: "Open the Atomik conversation" }).click();
  await expect(page.getByText("The brief is not saved yet.")).toBeVisible();
  await expect(page).toHaveURL(/page=brief/);
  await expect(page).not.toHaveURL(/workbench|atomik=open/);
  /* Saved: it opens Atomik › Agent in this shell, never the retired one. */
  offline = false;
  await page.reload();
  await expect(body).toBeVisible();
  await body.getByRole("button", { name: "Open the Atomik conversation" }).click();
  await expect(page).toHaveURL(/suite=atomik/);
  await expect(page).toHaveURL(/page=agent/);
  await expect(page).toHaveURL(/\/workspace\?/);
  await expect(page.getByTestId("page-title")).toHaveText("Agent");
  expect(errors).toEqual([]);
});

test("the Rig's Estimate is the Generate button's own figure when references are bound", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  /* The settings alone price at 90; with the bound reference, 140. */
  await page.route("**/api/workbench/engines**", (route) => {
    const url = new URL(route.request().url());
    const withReferences = url.searchParams.has("uploadId") || url.searchParams.has("genId") || Number(url.searchParams.get("imageRefs") ?? 0) > 0;
    return route.fulfill({ json: { credits: withReferences ? 140 : 90, models: [] } });
  });
  const { errors } = await open(page, "/workspace?project=ws-honest&suite=particl&page=rig&sel=shot:s1");
  const estimate = page.getByTestId("shot-estimate");
  await expect(estimate.locator(".pxw-insp-estimate-value")).toHaveText("140 cr");
  await expect(estimate).toContainText("With references");
  await expect(page.locator(".pxw-insp-generate")).toHaveText("Generate take · 140 cr");
  /* A shot with no references: the settings estimate, and the button agrees. */
  await page.locator('.pxw-rig-row[data-shot-id="s2"]').click();
  await expect(estimate.locator(".pxw-insp-estimate-value")).toHaveText("90 cr");
  await expect(page.locator(".pxw-insp-generate")).toHaveText("Generate take · 90 cr");
  expect(errors).toEqual([]);
});

test("Suites › Cast: the Inspector shows the stage, not a selection the stage cannot make", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  await open(page, "/suites?suite=studio&page=cast");
  await expect(page.getByTestId("project-name")).toHaveText("Coastal light study");
  const inspector = page.getByTestId("inspector");
  await expect(inspector).toBeVisible();
  await expect(inspector.locator(".gx-pill")).toHaveText("Stage");
  await expect(inspector).toContainText("Cast & Elements");
  await expect(inspector).not.toContainText("Select a cast member");
  await expect(inspector).not.toContainText("appear here");
});

test("Deliver › Package: a retime whose save is refused says so, with the saved version one press away", async ({ page }, info) => {
  test.skip(!DESKTOP.includes(info.project.name), "desktop viewports");
  const store: ProjectRoute = { current: { ...fixture(), shots: [{ id: "c1", name: "01 — The approach", assetId: "up_plate", duration: 48, sourceIn: 0, note: "" }] } };
  const { errors } = await open(page, "/suites?suite=studio&page=deliver", store);
  await expect(page.getByTestId("project-name")).toHaveText("Coastal light study");
  const fps = page.getByTestId("deliver-fps");
  await expect(fps).toHaveValue("24");
  /* Another window saved first: this save is refused. */
  await page.route("**/api/workbench/projects**", (route) => (route.request().method() === "PUT" ? route.fulfill({ status: 409, json: { error: "This project changed in another window." } }) : route.fallback()));
  await fps.selectOption("25");
  const status = page.locator('[data-tool-body="package"] .pxw-draft-status');
  await expect(status.getByRole("alert")).toContainText("This project changed in another window.");
  await expect(status.getByRole("button", { name: "Load the saved version" })).toBeVisible();
  expect(errors).toEqual([]);
});
