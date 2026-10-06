import { test, expect, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { projectName } from "./helpers/projectName";

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

test("Gen's well takes a picture straight from the desktop as a reference", async ({ page }, info) => {
  test.skip(!DESKTOPS.includes(info.project.name), "one desktop: HTML drag and drop");
  const { project, errors } = await setup(page);
  await page.goto(`/suites?make=video&project=${project.id}`);
  /* The composer settles on the project first (it starts that project's own composer state). */
  await expect(projectName(page)).toHaveText(project.name);
  await expect(page.getByTestId("gen-well")).toBeVisible();
  await dropFiles(page.getByTestId("gen-well"), [{ name: "look.png", type: "image/png", b64: await png("#7a4a2b") }]);
  await expect(page.getByTestId("gen-well")).toContainText("look.png", { timeout: 30_000 });
  expect(errors).toEqual([]);
});
