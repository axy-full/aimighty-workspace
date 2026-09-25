import { test, expect, type Locator, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";

/**
 * Owner, 25 September: "all forms of media uploads from device in every
 * prompt box should be allowed." Every prompt box has Attach, and takes
 * pasted and dropped files: each goes into the project's Library, then where
 * that box's engine takes it — a reference, a shot input, a place's
 * reference, a cast reference — and an agent's box sends pictures to the
 * agent itself. What an engine cannot take stays in the Library, and says so.
 * Real local routes, mock engine.
 */
const DESKTOPS = ["workbench-1440x900"];
const png = async (fill: string) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="${fill}"/></svg>`)).png().toBuffer();

async function setup(page: Page, shape: (p: Project) => void = () => {}) {
  const account = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${account.workspace.id}-${me.id}` };
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await platform.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), account.workspace.id, 5000, "Attach test", "admin", "test", Date.now()] });
  } finally { platform.close(); }
  const project = newProject(`Attach ${randomUUID().slice(0, 6)}`);
  project.brief = "A fox crosses a frozen harbour at dusk; an old harbour master keeps watch.";
  shape(project);
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const bodies: Record<string, unknown>[] = [];
  page.on("request", (request) => { if (request.url().includes("/api/workbench/development") && request.method() === "POST") bodies.push(request.postDataJSON()); });
  const read = async () => (await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers }).then((r) => r.json())).project as Project;
  return { project, errors, bodies, read };
}
const hydrated = (target: Locator) => expect.poll(() => target.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps"))), { timeout: 30_000 }).toBe(true);
/** Pasting a file into a box, as ⌘V does with a copied picture. */
async function pasteFile(target: Locator, name: string, type: string, bytes: Buffer) {
  await hydrated(target);
  await target.evaluate((el, f) => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, { name, type, b64: bytes.toString("base64") });
}

test("Brief: a picture attached to the prompt goes to the writer — priced with it, and seen by it", async ({ page }, info) => {
  test.skip(!DESKTOPS.includes(info.project.name), "one desktop");
  test.setTimeout(120_000);
  const { project, errors, bodies, read } = await setup(page);
  await page.goto(`/suites?suite=studio&page=brief&project=${project.id}`);
  await page.getByTestId("agent-bar").getByRole("radio", { name: "Claude" }).click();
  await page.getByTestId("brief-attach-file").setInputFiles({ name: "mood.png", mimeType: "image/png", buffer: await png("#6a3d2b") });
  await expect(page.getByTestId("agent-attachments")).toContainText("mood.png", { timeout: 30_000 });
  await expect(page.getByTestId("brief-attach-note")).toContainText("The agent sees mood.png on its next run.");
  const asset = (await read()).assets.find((a) => a.name === "mood.png");
  expect(asset).toMatchObject({ kind: "image", category: "Reference" });

  await page.getByTestId("brief-estimate").click();
  await expect(page.getByTestId("brief-quote")).toContainText("agent steps");
  expect(bodies.at(-1)).toMatchObject({ kind: "write", quoteOnly: true, attachmentAssetIds: [asset!.id] });
  await page.getByTestId("brief-write").click();
  await expect(page.getByTestId("brief-review")).toContainText("Mock: saw 1 attached picture and 0 text files.", { timeout: 60_000 });
  expect(errors).toEqual([]);
});

test("Gen: a pasted picture becomes a reference; a sound file is kept in the Library, and the box says why", async ({ page }, info) => {
  test.skip(!DESKTOPS.includes(info.project.name), "one desktop");
  const { project, errors } = await setup(page);
  await page.goto(`/suites?view=gen&project=${project.id}`);
  /* The composer settles on the project first (it starts that project's own composer state). */
  await expect(page.getByTestId("project-name")).toHaveText(project.name);
  const box = page.getByTestId("gen-attach");
  await pasteFile(box.getByRole("textbox", { name: "Direction" }), "look.png", "image/png", await png("#2b6a4a"));
  await expect(page.getByTestId("gen-well")).toContainText("look.png", { timeout: 30_000 });
  await box.getByTestId("gen-attach-file").setInputFiles({ name: "tone.wav", mimeType: "audio/wav", buffer: wav() });
  await expect(page.getByTestId("gen-attach-note")).toContainText("tone.wav is kept in the Library", { timeout: 30_000 });
  expect(errors).toEqual([]);
});

test("Rig, Environment and Cast: attachments land where each engine takes them", async ({ page }, info) => {
  test.skip(!DESKTOPS.includes(info.project.name), "one desktop");
  test.setTimeout(120_000);
  const { project, errors, read } = await setup(page, (p) => {
    p.nodes = [{ id: "n1", title: "Opening", type: "scene", x: 0, y: 0, width: 238, linked: [], role: "Director", status: "draft", mode: "Video", durationS: 5, ratio: "16:9", resolution: "720p" } as Project["nodes"][number]];
    p.production = {
      environment: { world: "", model: "gemini-3.1-flash-image", entries: [{ id: "env-1", name: "Harbour", notes: "", prompt: "", references: [], plates: [] }] },
      cast: { entries: [{ id: "cast-1", kind: "character", name: "Mara", description: "", prompt: "", takes: [] }] } as NonNullable<Project["production"]>["cast"],
    };
  });

  /* Environment: the plate prompt's attachment is the place's reference. */
  await page.goto(`/suites?suite=studio&page=boards&sp=environment&project=${project.id}`);
  const place = page.getByTestId("environment-entry").first();
  await place.getByTestId("environment-prompt-attach-file").setInputFiles({ name: "quay.png", mimeType: "image/png", buffer: await png("#556677") });
  await expect(place.getByTestId("environment-references")).toContainText("References 1/6", { timeout: 30_000 });
  /* Saved before the next page opens, as anyone moving on would find it. */
  await expect(page.locator(".pd-save")).toHaveText(/^Saved/, { timeout: 15_000 });

  /* Cast: the prompt's picture is the entry's reference image. */
  await page.goto(`/suites?suite=studio&page=cast&sp=cast&project=${project.id}`);
  const mara = page.getByTestId("cast-entry").first();
  await mara.getByTestId("cast-prompt-attach-file").setInputFiles({ name: "mara.png", mimeType: "image/png", buffer: await png("#775544") });
  await expect(mara.getByTestId("cast-reference")).toContainText("mara.png", { timeout: 30_000 });

  /* The Rig last (its team canvas saves on the way out): the shot prompt's attachment is an input of the shot. */
  await page.goto(`/suites?suite=studio&page=rig&project=${project.id}`);
  await page.locator(".pxw-rig-row[data-shot-id='n1']").click();
  await page.getByTestId("rig-prompt-attach-file").setInputFiles({ name: "blocking.png", mimeType: "image/png", buffer: await png("#224466") });
  await expect(page.getByTestId("rig-prompt-attach-note")).toContainText("blocking.png is an input of Opening", { timeout: 30_000 });

  await expect.poll(async () => { const p = await read(); return [p.production?.environment?.entries[0].references.length, p.production?.cast?.entries[0].referenceAssetId ? 1 : 0]; }, { timeout: 15_000 }).toEqual([1, 1]);
  expect(errors).toEqual([]);
});

/** A tenth of a second of silence, as a WAV. */
function wav() {
  const samples = 800, data = Buffer.alloc(samples * 2), head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVEfmt ", 8); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(8000, 24); head.writeUInt32LE(16000, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write("data", 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}
