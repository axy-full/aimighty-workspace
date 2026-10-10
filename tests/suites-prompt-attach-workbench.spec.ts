import { test, expect, type Locator, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";
import { projectName } from "./helpers/projectName";
import { isCompact } from "./helpers/shellMode";

/* Release 1: the phone app draws its own simple Make (type, words, engine line with Change, References, Make at its price: demo-s10-phone-make-workbench), not this panel's composer; the desktop keeps every assertion here */
test.beforeEach(async ({}, info) => { test.skip(isCompact(info), "the phone app draws its own simple Make (type, words, engine line with Change, References, Make at its price: demo-s10-phone-make-workbench), not this panel's composer; the desktop keeps every assertion here"); });

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


test.fixme("Make: a pasted picture becomes a reference; a sound file is kept in the Library, and the box says why — Make's words box has no Attach, paste or drop (components/graphite/make/Compose.tsx does not mount PromptAttach; only the well takes a drop); owner question: do Make's words take pasted and dropped files, as the 25 September rule 'every prompt box takes media' says?", async ({ page }, info) => {
  test.skip(!DESKTOPS.includes(info.project.name), "one desktop");
  const { project, errors } = await setup(page);
  await page.goto(`/suites?make=video&project=${project.id}`);
  /* The composer settles on the project first (it starts that project's own composer state). */
  await expect(projectName(page)).toHaveText(project.name);
  const box = page.getByTestId("gen-attach");
  await pasteFile(box.getByRole("textbox", { name: "Direction" }), "look.png", "image/png", await png("#2b6a4a"));
  await expect(page.getByTestId("gen-well")).toContainText("look.png", { timeout: 30_000 });
  await box.getByTestId("gen-attach-file").setInputFiles({ name: "tone.wav", mimeType: "audio/wav", buffer: wav() });
  await expect(page.getByTestId("gen-attach-note")).toContainText("tone.wav is kept in the Library", { timeout: 30_000 });
  expect(errors).toEqual([]);
});


/** A tenth of a second of silence, as a WAV. */
function wav() {
  const samples = 800, data = Buffer.alloc(samples * 2), head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVEfmt ", 8); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(8000, 24); head.writeUInt32LE(16000, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write("data", 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}
