import { test, expect, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";

/**
 * Owner, 25 September: "anything should be draggable and droppable across the
 * site." One payload every drag carries and every target reads (lib/drop);
 * device files dropped on any target are uploaded into the project first and
 * then used like a Library tile; a file dropped where no target takes it is
 * kept in the Library instead of the browser opening it. Real local routes.
 */
const DESKTOPS = ["workbench-1440x900"];
const png = async (fill: string) => (await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="${fill}"/></svg>`)).png().toBuffer()).toString("base64");

async function setup(page: Page, shape: (p: Project) => void = () => {}) {
  const account = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${account.workspace.id}-${me.id}` };
  const project = newProject(`Drops ${randomUUID().slice(0, 6)}`);
  shape(project);
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const read = async () => (await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers }).then((r) => r.json())).project as Project;
  return { project, errors, read };
}

/** React has attached its handlers to this element (a drop before hydration would reach nothing). */
async function hydrated(target: Locator) {
  await expect.poll(() => target.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps"))), { timeout: 30_000 }).toBe(true);
}
/** Files from the desktop, dropped on an element (a synthetic drag the page cannot tell from a real one). */
async function dropFiles(target: Locator, files: { name: string; type: string; b64: string }[]) {
  await hydrated(target);
  await target.evaluate((el, list) => {
    const dt = new DataTransfer();
    for (const f of list) dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
    for (const type of ["dragenter", "dragover", "drop"]) el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, files);
}
/** A tile dragged onto a target: the drag layer writes the payload on dragstart, the target reads it on drop. */
async function dragOnto(source: Locator, target: Locator) {
  const handle = await source.page().evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent("dragstart", { dataTransfer: handle });
  await target.dispatchEvent("dragenter", { dataTransfer: handle });
  await target.dispatchEvent("dragover", { dataTransfer: handle });
  await target.dispatchEvent("drop", { dataTransfer: handle });
  await source.dispatchEvent("dragend", { dataTransfer: handle });
  return handle;
}

test("a file dropped anywhere is kept in the Library; its tile then drags with the one payload and joins the cut", async ({ page }, info) => {
  test.skip(!DESKTOPS.includes(info.project.name), "one desktop: HTML drag and drop");
  const { project, errors, read } = await setup(page);
  await page.goto(`/suites?suite=studio&page=edit&project=${project.id}`);
  await expect(page.getByTestId("project-name")).toHaveText(project.name);
  await hydrated(page.getByTestId("timeline-cut"));

  /* No target under it: the file is kept in the project's Library, not opened by the browser. */
  await dropFiles(page.locator("header").first(), [{ name: "harbour.png", type: "image/png", b64: await png("#2b4a6f") }]);
  await expect(page.getByTestId("toast")).toContainText("1 file added to the Library", { timeout: 30_000 });
  await page.getByTestId("library").getByRole("tab", { name: /Assets/ }).click();
  const tile = page.getByTestId("library").locator(".gx-asset-thumb").filter({ has: page.locator("[data-preview-name='harbour.png']") }).first();
  await expect(tile).toBeVisible();

  /* Its drag carries the Library id three ways, so every target reads it. */
  const dt = await dragOnto(tile, page.getByTestId("timeline-cut"));
  const payload = await dt.evaluate((d) => ({ plain: d.getData("text/plain"), id: d.getData("application/x-particl-id"), json: d.getData("application/x-particl-asset") }));
  expect(payload.plain).toMatch(/^upload:/);
  expect(payload.id).toBe(payload.plain);
  expect(JSON.parse(payload.json)).toMatchObject({ kind: "upload", upload: { id: payload.plain.slice(7) } });
  /* …and the cut took it. */
  await expect(page.getByTestId("timeline-shot")).toHaveCount(1);
  await expect.poll(async () => (await read()).shots.length, { timeout: 15_000 }).toBe(1);
  expect(errors).toEqual([]);
});

test("Gen's well takes a picture straight from the desktop as a reference", async ({ page }, info) => {
  test.skip(!DESKTOPS.includes(info.project.name), "one desktop: HTML drag and drop");
  const { project, errors } = await setup(page);
  await page.goto(`/suites?view=gen&project=${project.id}`);
  await expect(page.getByTestId("gen-well")).toBeVisible();
  await dropFiles(page.getByTestId("gen-well"), [{ name: "look.png", type: "image/png", b64: await png("#7a4a2b") }]);
  await expect(page.getByTestId("gen-well")).toContainText("look.png", { timeout: 30_000 });
  expect(errors).toEqual([]);
});

test("Environment: a picture file on the plate becomes the plate; on the card, a reference", async ({ page }, info) => {
  test.skip(!DESKTOPS.includes(info.project.name), "one desktop: HTML drag and drop");
  const { project, errors, read } = await setup(page, (p) => {
    p.production = { environment: { world: "", model: "gemini-3.1-flash-image", entries: [{ id: "env-1", name: "Harbour", notes: "", prompt: "", references: [], plates: [] }] } };
  });
  await page.goto(`/suites?suite=studio&page=boards&sp=environment&project=${project.id}`);
  const place = page.getByTestId("environment-entry").first();
  await dropFiles(place.getByTestId("environment-plate-drop"), [{ name: "plate.png", type: "image/png", b64: await png("#335566") }]);
  await expect(page.getByTestId("environment-counts")).toHaveText("1 place · 1 with a plate", { timeout: 30_000 });
  await dropFiles(place.getByTestId("environment-references"), [{ name: "ref.png", type: "image/png", b64: await png("#665533") }]);
  await expect(place.getByTestId("environment-references")).toContainText("References 1/6", { timeout: 30_000 });
  await expect.poll(async () => (await read()).production?.environment?.entries[0].plates.length, { timeout: 15_000 }).toBe(1);
  expect(errors).toEqual([]);
});

test("the Rig: a picture file dropped on a shot becomes its input", async ({ page }, info) => {
  test.skip(!DESKTOPS.includes(info.project.name), "one desktop: HTML drag and drop");
  const { project, errors } = await setup(page, (p) => {
    p.nodes = [{ id: "n1", title: "Opening", type: "scene", x: 0, y: 0, width: 238, linked: [], role: "Director", status: "draft", mode: "Video", durationS: 5, ratio: "16:9", resolution: "720p" } as Project["nodes"][number]];
  });
  await page.goto(`/suites?suite=studio&page=rig&project=${project.id}`);
  await expect(page.getByTestId("rig-library")).toBeVisible();
  const row = page.locator(".pxw-rig-row[data-shot-id='n1']");
  await dropFiles(row, [{ name: "blocking.png", type: "image/png", b64: await png("#224422") }]);
  await expect(page.getByTestId("toast")).toContainText("blocking.png is an input of Opening", { timeout: 30_000 });
  await row.click();
  await page.getByTestId("inspector").getByText(/^Inputs/).click();
  await expect(page.getByTestId("rig-input")).toHaveCount(1);
  expect(errors).toEqual([]);
});
