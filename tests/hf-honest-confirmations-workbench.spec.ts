import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { signInLocally } from "./helpers/workbenchLocal";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, upload } from "./helpers/workspaceFixtures";
import { newProject, type Project } from "../lib/workbench/studio";

/**
 * Idea 18 — confirmations say exactly what happened and link to it, in the
 * browser, against the real routes of a local ENGINE_MOCK server (the Crew
 * round is the mock room; nothing reaches an engine). Crew's → Rig writes a
 * draft shot on the Rig, so the toast says Rig and its Open lands on that
 * shot, selected — on a Rig that has read the saved draft again. → Brief
 * says Brief and opens it; the room stays put for the next solution. Open in
 * Gen goes to Gen with the solution as the prompt, and says only that. Filed
 * minutes open the Library.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const PHONES = ["workbench-360x640", "workbench-390x844"];
const TOUCH = [...PHONES, "workbench-844x390"];
const SHOT_AT: Record<string, string> = { "workbench-1440x900": "1440x900", "workbench-390x844": "390x844" };
const SHOTS = "/private/tmp/particl-suites/hf-connected/shots";
const GOAL = "Open the film without dialogue and still make the product unmistakable inside the first four seconds.";

async function shot(page: Page, name: string, project: string) {
  const size = SHOT_AT[project];
  if (!size) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/honest-${name}-${size}.png` });
}
/** Wait for the page's enter animations, so a screenshot shows the settled page. */
async function settle(page: Page) {
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => !(a.effect instanceof KeyframeEffect && a.effect.getComputedTiming().iterations === Infinity)).map((a) => a.finished.catch(() => undefined))));
}
async function noSideScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), "no horizontal page scroll").toBeLessThanOrEqual(1);
}

/** A saved project, the Crew room open on it, one round run: three solutions from the mock chair. */
async function roomWithSolutions(page: Page) {
  const account = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${account.workspace.id}-${me.id}` };
  const project = { ...newProject("Dune Studies"), brief: "One kitchen, one rainy dawn.", script: "INT. KITCHEN - DAWN\n\nRain on the window." };
  expect((await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } })).ok()).toBe(true);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (m) => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text().slice(0, 200)); });
  await page.goto(`/suites?project=${project.id}&view=crew`);
  await expect(page.getByTestId("crew-view")).toBeVisible();
  await expect(page.locator(".cw-project")).toContainText("Dune Studies");
  await page.getByTestId("crew-goal").fill(GOAL);
  await expect(page.getByTestId("crew-run")).toHaveText(/^Run round · \d+ cr$/);
  await page.getByTestId("crew-run").click();
  const solutions = page.getByTestId("crew-solutions").locator(".cw-solution");
  await expect(solutions).toHaveCount(3, { timeout: 45_000 });
  await expect(page.getByTestId("crew-run")).toHaveText(/^Run round · \d+ cr$/);
  return { errors, project, headers, solutions };
}

/** A phone's Open is a whole target, and the toast sits clear of the floating tab bar and the home indicator. */
async function reachable(page: Page, open: Locator, name: string) {
  const box = (await open.boundingBox())!;
  if (TOUCH.includes(name)) expect(box.height, "Open is a 44px target").toBeGreaterThanOrEqual(44);
  const toast = (await page.getByTestId("toast").boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(toast.x).toBeGreaterThanOrEqual(0);
  expect(toast.x + toast.width).toBeLessThanOrEqual(viewport.width);
  expect(toast.y + toast.height).toBeLessThanOrEqual(viewport.height);
  const bar = page.locator(".gx-tabbar");
  if (await bar.isVisible()) {
    const tabs = (await bar.boundingBox())!;
    expect(toast.y + toast.height, "the toast clears the tab bar").toBeLessThanOrEqual(tabs.y);
  }
}

test("Crew › → Rig says Rig, and its Open lands on that shot, selected, on a Rig that read the saved draft", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const { errors, project, headers, solutions } = await roomWithSolutions(page);
  const second = solutions.nth(1);
  await expect(second.getByRole("button", { name: "→ Rig" })).toBeVisible();
  await expect(page.getByTestId("crew-view").getByRole("button", { name: "Board it" })).toHaveCount(0);

  const routed = page.waitForResponse((r) => /\/api\/crew\/solutions\/[^/]+\/route$/.test(new URL(r.url()).pathname) && r.request().method() === "POST");
  await second.getByRole("button", { name: "→ Rig" }).click();
  const reply = await (await routed).json() as { status: string; nodeId: string; title: string };
  expect(reply).toMatchObject({ status: "boarded", title: "Cut on the drop" });

  /* The toast names the Rig and the shot; nothing about Boards or frames. The room stays where it was. */
  const toast = page.getByTestId("toast");
  await expect(toast).toContainText("Added to Rig · Cut on the drop");
  await expect(toast).not.toContainText(/Board|frame/);
  const open = page.getByTestId("toast-open");
  await expect(open).toHaveText("Open Rig");
  await expect(second.getByTestId("crew-solution-status")).toHaveText("Added to Rig");
  await expect(page.getByTestId("crew-view")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("view")).toBe("crew");
  await reachable(page, open, info.project.name);
  await noSideScroll(page);
  await settle(page);
  await shot(page, "crew-rig-toast", info.project.name);

  /* It really is on the saved project's Rig. */
  const saved = (await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers }).then((r) => r.json())).project as { nodes: { id: string; title: string; type: string }[] };
  expect(saved.nodes.find((n) => n.id === reply.nodeId)).toMatchObject({ title: "Cut on the drop", type: "scene" });

  await open.click();
  await expect(page.getByTestId("page-title")).toHaveText("Rig");
  await expect(toast).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.get("sel")).toBe(`shot:${reply.nodeId}`);
  /* The Rig read the saved draft again: the shot is listed, and it is the one selected. */
  const row = page.locator(`.pxw-rig-row[data-shot-id="${reply.nodeId}"]`);
  await expect(row).toHaveAttribute("aria-pressed", "true");
  await expect(row).toContainText("Cut on the drop");
  /* …in view, and clear of a phone's tab bar. */
  await settle(page);
  await expect(row).toBeInViewport();
  const bar = page.locator(".gx-tabbar");
  if (await bar.isVisible()) expect((await row.boundingBox())!.y + (await row.boundingBox())!.height).toBeLessThanOrEqual((await bar.boundingBox())!.y);
  await noSideScroll(page);
  await shot(page, "rig-opened", info.project.name);
  expect(errors).toEqual([]);
});

test("Crew › → Brief confirms with an Open to Brief; Open in Gen fills Gen's prompt and says only that; filed minutes open the Library", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  const { errors, project, headers, solutions } = await roomWithSolutions(page);

  await solutions.first().getByRole("button", { name: "→ Brief" }).click();
  await expect(page.getByTestId("toast")).toContainText("Added to the Brief");
  await expect(page.getByTestId("toast-open")).toHaveText("Open Brief");
  await expect(solutions.first().getByTestId("crew-solution-status")).toHaveText("Added to the Brief");
  const saved = (await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers }).then((r) => r.json())).project as { brief: string };
  expect(saved.brief).toContain("Crew · Locked dawn frame — ");

  /* Minutes: filed in this project's Library, and the toast opens it. */
  const file = page.getByTestId("crew-file-minutes");
  await file.scrollIntoViewIfNeeded();
  await file.click();
  await expect(page.getByTestId("toast")).toContainText("Minutes filed in the Library");
  /* Crew has no Library of its own: Open leaves the room for the suite page, with the Library's assets showing the file. */
  await expect(page.getByTestId("toast-open")).toHaveText("Open Library");
  await page.getByTestId("toast-open").click();
  const library = page.getByTestId("library");
  await expect(library).toBeVisible();
  await expect(library.getByRole("tab", { name: /Assets/ })).toHaveAttribute("aria-selected", "true");
  await expect(library).toContainText("crew-min");
  expect(new URL(page.url()).searchParams.get("view")).toBeNull();
  if (info.project.name === "workbench-390x844") await library.getByRole("button", { name: "Close" }).click();
  await page.getByRole("tablist", { name: "Suites" }).getByRole("tab", { name: "Crew" }).click();
  await expect(solutions).toHaveCount(3);

  /* Open in Gen goes to Gen: the solution is the prompt, and the toast does not ask for a paste. */
  const third = solutions.nth(2);
  const text = (await third.locator("p").innerText()).replace(/^3/, "").trim();
  await third.getByRole("button", { name: "Open in Gen" }).click();
  await expect(page.getByTestId("gen-view")).toBeVisible();
  await expect(page.getByTestId("gen-prompt")).toHaveValue(text);
  await expect(page.getByTestId("gen-preset-note")).toHaveText("Crew · solution");
  await expect(page.getByTestId("toast")).toHaveText("The solution is Gen’s prompt");
  await expect(page.getByTestId("toast-open"), "already there: no Open").toHaveCount(0);
  await noSideScroll(page);
  await settle(page);
  await shot(page, "gen-from-crew", info.project.name);
  expect(errors).toEqual([]);
});

const TAKE = `gen_hfc_${"d".repeat(40)}`;
const IMAGE_MODEL = { id: "marketing_studio_image", name: "Marketing Studio Image", outputType: "image", aspectRatios: ["auto", "1:1", "9:16"], medias: [{ name: "medias", roles: ["image"] }], parameters: [{ name: "resolution", options: ["1k", "2k", "4k"] }] };

test("Business › a finished image ad's Open in Takes lands on that take, not on the newest one", async ({ page }, info) => {
  test.skip(!["workbench-390x844", "workbench-1440x900"].includes(info.project.name), "one phone, one desktop");
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  const fixture: Project = { ...newProject("Coastal light study"), id: "ws-honest", productionProjectId: "prod-ws", shotMappings: {} };
  await mockProjects(page, { current: fixture });
  const now = Date.now();
  /* The ad lands filed in the project; a newer take sits above it, so landing on the ad is not luck. */
  await mockLibrary(page, {
    uploads: [upload({ id: "up_plate", filename: "harbour-plate.webp" })],
    generations: [generation({ id: "g_newer", title: "Evening pass", createdAt: now + 60_000 }), generation({ id: TAKE, title: "Marble hero", createdAt: now - 1_000 })],
  });
  const me = await page.request.get("/api/me").then((r) => r.json());
  await page.route("**/api/me", (route) => route.fulfill({ json: { ...me, owner: true } }));
  await page.route("**/api/higgsfield/consumer/connection", (route) => route.fulfill({ json: { connected: true, requiresReconnect: false } }));
  let quoted: unknown = null;
  await page.route("**/api/higgsfield/consumer/generation", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (body.action === "quote") quoted = body.input;
    if (body.action === "catalogue") return route.fulfill({ json: { catalogue: { models: [IMAGE_MODEL], unlim: { available: false, remaining: null, expiresAt: null }, complete: true, fetchedAt: Date.now() } } });
    const job = (status: string) => ({ id: "5d2b3c4e-5f60-4a7b-8c9d-0e1f2a3b4c5d", draftId: fixture.id, workflow: "generation", status, model: IMAGE_MODEL, input: quoted, workspaceId: "1f2e3d4c-5b6a-4798-8a9b-0c1d2e3f4a5b", workspaceName: "Connected wallet", quoteCredits: 40, creditUnit: "higgsfield_credits", quoteExpiresAt: Date.now() + 300_000, createdAt: now, providerJobId: status === "quoted" ? null : "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d", tool: null, result: null, originalAvailable: false, sources: [] });
    if (body.action === "quote") return route.fulfill({ json: { job: job("quoted") } });
    if (body.action === "submit") return body.credits === 40 ? route.fulfill({ json: { job: job("accepted") } }) : route.fulfill({ status: 409, json: { error: "Review the quote again." } });
    if (body.action === "status") {
      const done = job("completed");
      const original = { generationId: TAKE, providerJobId: done.providerJobId, creditUnit: "higgsfield_credits", credits: 40, sha256: "b".repeat(64), bytes: 2048, asset: { generationId: TAKE, mime: "image/webp", url: `/api/media/${TAKE}`, kind: "image" } };
      return route.fulfill({ json: { job: { ...done, originalAvailable: true, originalAvailability: "available", result: { original } } } });
    }
    return route.fulfill({ status: 400, json: { error: "Nothing else is priced or sent in this spec." } });
  });
  await page.route("**/api/higgsfield/consumer/marketing-templates**", (route) => route.request().method() === "GET"
    ? route.fulfill({ json: { connection: { connected: true, requiresReconnect: false }, capabilities: {}, jobs: [] } })
    : route.fulfill({ json: { catalogue: { templates: [], matched: 0, total: 0, loaded: 0, complete: true, fetchedAt: Date.now(), categories: [], costsVersion: "v1" } } }));
  await page.route("**/api/higgsfield/consumer/video", (route) => route.fulfill({ json: { connected: true, reads: [] } }));
  await page.route("**/api/prompt/enhance", (route) => route.fulfill({ json: { model: "m", effort: "auto", estimateCredits: 1 } }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/suites?suite=moleculr&page=marketing&sp=dtc");
  await expect(page.getByTestId("project-name")).toHaveText("Coastal light study");
  await page.getByTestId("dtc-prompt").fill("Bold hero shot on marble");
  await expect(page.getByTestId("dtc-generate")).toContainText("40 cr");
  await page.getByTestId("dtc-generate").click();
  const done = page.getByTestId("dtc-done");
  await expect(done.getByTestId("dtc-done-take").locator("img")).toBeVisible({ timeout: 15_000 });
  const open = done.getByTestId("dtc-done-open");
  await expect(open).toHaveText("Open in Takes");
  if (TOUCH.includes(info.project.name)) expect((await open.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await open.click();
  await expect(page.getByTestId("page-title")).toHaveText("Takes");
  await expect(page.getByTestId("edit-takes").locator('[data-testid="edit-take"][aria-checked="true"]')).toContainText("Marble hero");
  expect(new URL(page.url()).searchParams.get("sel")).toBe(`take:generation:${TAKE}`);
  await noSideScroll(page);
  expect(errors).toEqual([]);
});
