import { test, expect, type Page } from "@playwright/test";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { forbidPaidWork, generation, mockLibrary, mockMedia, mockProjects, upload } from "./helpers/workspaceFixtures";

/**
 * Assets on every page (FINAL_SPEC §1 step 1): `+` and a drop land a
 * reference in Gen with its role named; right-click commands work or say
 * exactly why not; delete is undone with ⌘Z; cut/paste moves between
 * projects; the Inspector shows provenance and hides three ways.
 */
const SIZES = ["workbench-360x640", "workbench-390x844", "workbench-844x390", "workbench-1440x900", "workbench-1920x1080"];
const WIDE = ["workbench-1440x900", "workbench-1920x1080"];

const fixture = (): Project => ({ ...newProject("Coastal light study"), id: "ws-assets", productionProjectId: "prod-ws", shotMappings: {} });

async function open(page: Page) {
  await signInLocally(page.request);
  await forbidPaidWork(page);
  await mockMedia(page);
  await mockProjects(page, { current: fixture(), list: [{ id: "ws-assets", name: "Coastal light study" }, { id: "ws-other", name: "Northline" }] });
  await mockLibrary(page, {
    uploads: [upload({ id: "up_plate", filename: "harbour-plate.webp" }), upload({ id: "up_tone", filename: "room-tone.mp3", mime: "audio/mpeg", kind: "audio", width: 0, height: 0 })],
    generations: [generation({ id: "gen_wide", title: "Wide on the water", prompt: "Wide on the water", params: { rawPrompt: "wide on the water, raw", enhancedPrompt: "Wide on the water at dusk, 35mm, low sun" } })],
  });
  /* Registered after mockLibrary so it runs first: writes are recorded, reads fall through. */
  const calls: { method: string; path: string; body: unknown }[] = [];
  await page.route("**/api/workbench/library**", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") {
      calls.push({ method: request.method(), path: new URL(request.url()).pathname, body: request.postDataJSON() });
      return route.fulfill({ json: { ok: true } });
    }
    return route.fallback();
  });
  await page.route(/\/api\/jobs\/gen_wide(\?.*)?$/, (route) => {
    if (route.request().method() === "PATCH") { calls.push({ method: "PATCH", path: "/api/jobs/gen_wide", body: route.request().postDataJSON() }); return route.fulfill({ json: { ok: true } }); }
    return route.fulfill({ json: { generation: generation({ id: "gen_wide", title: "Wide on the water", prompt: "Wide on the water" }) } });
  });
  await page.route(/\/api\/uploads\/up_plate\/metadata$/, (route) => route.fulfill({ json: { upload: upload({ id: "up_plate", filename: "harbour-plate.webp" }) } }));
  await page.route("**/api/prompt/enhance", (route) => route.fulfill({ json: { model: "m", effort: "auto", estimateCredits: 1 } }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/suites?suite=particl&page=boards&sp=boards");
  await expect(page.getByTestId("project-name")).toHaveText("Coastal light study");
  return { errors, calls };
}

const openAssets = async (page: Page, wide: boolean) => {
  if (!wide) await page.getByTestId("toggle-library").click();
  await page.getByTestId("library").getByRole("tab", { name: /Assets/ }).click();
};

test("+ sends an asset into Gen as a reference, and names the role", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const wide = WIDE.includes(info.project.name);
  const { errors } = await open(page);
  await openAssets(page, wide);
  const library = page.getByTestId("library");
  await expect(library.getByRole("button", { name: "Use room-tone.mp3 as reference" })).toBeDisabled();
  await expect(library.getByRole("button", { name: "Use room-tone.mp3 as reference" })).toHaveAttribute("title", "References are images and videos.");
  await library.getByRole("button", { name: "Use harbour-plate.webp as reference" }).click();
  await expect(page.getByTestId("toast")).toHaveText("harbour-plate.webp added as Image");
  await expect(page.getByTestId("gen-view")).toBeVisible();
  await expect(page.getByTestId("gen-well")).toContainText("@Image1 · harbour-plate.webp");
  expect(errors).toEqual([]);
});

test("right-click: every command works or says exactly why not; delete is soft and ⌘Z restores it", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const wide = WIDE.includes(info.project.name);
  const { errors, calls } = await open(page);
  await openAssets(page, wide);
  const library = page.getByTestId("library");
  const wideTile = library.locator(".gx-asset-thumb[data-ctx='asset:generation:gen_wide']");
  await wideTile.click({ button: "right" });
  const menu = page.getByTestId("context-menu");
  await expect(menu.getByRole("menuitem", { name: "Recreate" })).toBeEnabled();
  await expect(menu.getByRole("menuitem", { name: /^Paste/ })).toBeDisabled();
  await expect(menu.getByRole("menuitem", { name: /^Duplicate/ })).toHaveAttribute("title", "A generation has one copy. Recreate makes a new take from the same recipe.");
  await expect(menu.getByRole("menuitem", { name: /^Move to/ })).toBeEnabled();
  await expect(menu.getByRole("menuitem", { name: /^Delete/ })).toBeEnabled();
  await menu.getByRole("menuitem", { name: /^Delete/ }).click();
  await expect(page.getByTestId("toast")).toHaveText("Deleted Wide on the water · ⌘Z to undo. The original stays on the server indefinitely.");
  expect(calls.at(-1)).toEqual({ method: "PATCH", path: "/api/jobs/gen_wide", body: { trashed: true } });
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByTestId("toast")).toHaveText("Wide on the water restored");
  expect(calls.at(-1)).toEqual({ method: "PATCH", path: "/api/jobs/gen_wide", body: { trashed: false } });

  /* Recreate opens Gen with the render's own recipe. */
  await wideTile.click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Recreate" }).click();
  await expect(page.getByTestId("gen-view")).toBeVisible();
  await expect(page.getByTestId("gen-prompt")).toHaveValue("wide on the water, raw");
  await expect(page.getByTestId("gen-recipe-name")).toHaveText("Wide on the water");
  expect(errors).toEqual([]);
});

test("cut here, paste in another project: the upload moves; Move to… does the same from the menu", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const wide = WIDE.includes(info.project.name);
  const { calls } = await open(page);
  await openAssets(page, wide);
  const library = page.getByTestId("library");
  const plate = library.locator(".gx-asset[data-asset='upload:up_plate']");
  await plate.locator(".gx-asset-thumb").click({ button: "right" });
  await page.getByTestId("context-menu").getByRole("menuitem", { name: /^Cut/ }).click();
  await expect(page.getByTestId("toast")).toHaveText("Cut harbour-plate.webp — paste to move it.");
  await expect(plate).toHaveAttribute("data-cut", "true");
  /* ⌘V where it already is does nothing. */
  if (!wide) await page.getByTestId("close-library").click();
  await page.keyboard.press("ControlOrMeta+v");
  await expect(page.getByTestId("toast")).toHaveText("harbour-plate.webp is already in Coastal light study.");
  expect(calls).toEqual([]);

  /* Move to… → Northline files it there and unfiles it here. */
  if (!wide) await page.getByTestId("toggle-library").click();
  await plate.locator(".gx-asset-thumb").click({ button: "right" });
  await page.getByTestId("context-menu").getByRole("menuitem", { name: /^Move to/ }).click();
  await page.getByRole("dialog", { name: "Move harbour-plate.webp to" }).getByRole("option", { name: "Northline" }).click();
  await expect(page.getByTestId("toast")).toHaveText("Moved harbour-plate.webp to Northline");
  expect(calls).toEqual([
    { method: "POST", path: "/api/workbench/library", body: { projectId: "ws-other", uploadId: "up_plate" } },
    { method: "DELETE", path: "/api/workbench/library", body: { projectId: "ws-assets", uploadId: "up_plate" } },
  ]);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByTestId("toast")).toHaveText("Moved harbour-plate.webp to Coastal light study");
  expect(calls.slice(2)).toEqual([
    { method: "POST", path: "/api/workbench/library", body: { projectId: "ws-assets", uploadId: "up_plate" } },
    { method: "DELETE", path: "/api/workbench/library", body: { projectId: "ws-other", uploadId: "up_plate" } },
  ]);
});

test("the Inspector shows provenance and hides three ways", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "every configured viewport");
  const wide = WIDE.includes(info.project.name);
  await open(page);
  await openAssets(page, wide);
  await page.getByTestId("library").locator(".gx-asset-thumb[data-ctx='asset:generation:gen_wide']").click();
  const inspector = page.getByTestId("inspector");
  await expect(inspector).toBeVisible();
  await expect(page.getByTestId("asset-inspector")).toBeVisible();
  expect(Math.round((await page.getByTestId("inspector-preview").boundingBox())!.height)).toBe(180);
  await expect(page.getByTestId("asset-facts")).toContainText("Generation");
  await expect(page.getByTestId("asset-facts")).toContainText("gemini-3.1-flash-image");
  await expect(page.getByTestId("asset-facts")).toContainText("Wide on the water");
  /* The prompt the account rendered sits beside the prompt that was sent. */
  await expect(page.getByTestId("asset-facts")).toContainText("Wide on the water at dusk, 35mm, low sun · on the account");
  await expect(page.getByTestId("asset-inspector").getByRole("button", { name: "Recreate" })).toBeVisible();

  await page.getByTestId("close-inspector").click();
  await expect(inspector).toHaveCount(0);
  await expect(page.getByTestId("toggle-inspector")).toHaveAttribute("aria-pressed", "false");
  await page.getByTestId("toggle-inspector").click();
  await expect(inspector).toBeVisible();
  await expect(page.getByTestId("toggle-inspector")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ControlOrMeta+j");
  await expect(inspector).toHaveCount(0);
});
