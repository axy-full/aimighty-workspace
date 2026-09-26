import { test, expect } from "@playwright/test";
import { createClient } from "@libsql/client";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { newProject } from "../lib/workbench/studio";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";

/**
 * Owner, 23 September: in Storyboards, select several frames and storyboard
 * them together; revise any of them with a fresh prompt if they miss; delete a
 * line drawing. Real local routes, mock engine: nothing is spent.
 */
const SIZES = ["workbench-1440x900", "workbench-390x844"];
const SCRIPT = "EXT. FROZEN HARBOUR - DUSK\n\nA red fox crosses the ice.\n";
const shot = (id: string, description: string) => ({ id, description, framing: "Wide", movement: "Locked", lighting: "Dusk", sound: "Wind" });

test("Storyboards: pick frames and storyboard them together, revise one with a fresh prompt, delete a line drawing", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "one desktop, one phone");
  test.setTimeout(240_000);
  const account = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${account.workspace.id}-${me.id}` };
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try { await platform.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), account.workspace.id, 5000, "Boards batch test", "admin", "test", Date.now()] }); }
  finally { platform.close(); }
  const sha256 = createHash("sha256").update(SCRIPT).digest("hex");
  const at = new Date().toISOString();
  const project = newProject(`Boards batch ${randomUUID().slice(0, 6)}`);
  project.script = SCRIPT;
  project.production = {
    scriptApproval: { at, source: "hand", sha256 },
    beats: { scriptSha256: sha256, updatedAt: at, scenes: [{ id: "scene-a", heading: "EXT. FROZEN HARBOUR - DUSK", summary: "The crossing", beats: [], shots: [shot("shot-a1", "The fox on the ice"), shot("shot-a2", "Mara at the window"), shot("shot-a3", "The lamp goes out")], characters: [], locations: [], props: [] }] },
    boards: { style: "live", model: "gemini-3.1-flash-image", frames: { "shot-a1": { prompt: "A red fox crosses the frozen harbour at dusk, wide.", takes: [] } } },
  };
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const boards = async () => (await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers }).then((r) => r.json())).project;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/suites?suite=studio&page=boards&project=${project.id}`);
  await expect(page.getByTestId("boards-stage")).toBeVisible();
  await page.waitForLoadState("networkidle");
  const frames = page.getByTestId("board-frame");

  /* Pick shot 1 (its own prompt) and shot 3 (no prompt yet: it starts from its beat); storyboard both at one price. */
  await frames.nth(0).getByTestId("frame-select").check();
  await frames.nth(2).getByTestId("frame-select").check();
  await expect(page.getByTestId("boards-selection")).toContainText("2 selected");
  await page.getByTestId("boards-price-selected").click();
  await expect(page.getByTestId("boards-render-selected")).toContainText(/Storyboard 2 frames · \d+ credits?/, { timeout: 30_000 });
  await page.getByTestId("boards-render-selected").click();
  await expect.poll(async () => { const f = (await boards()).production.boards.frames; return [f["shot-a1"]?.takes.length ?? 0, f["shot-a3"]?.takes.length ?? 0, f["shot-a2"]?.takes.length ?? 0]; }, { timeout: 90_000 }).toEqual([1, 1, 0]);
  expect((await boards()).production.boards.frames["shot-a3"].prompt).toContain("The lamp goes out");

  /* Revise shot 1 with a fresh prompt: priced, rendered as a new frame beside the first. */
  await frames.nth(0).getByTestId("frame-revise").click();
  await frames.nth(0).getByTestId("frame-revise-prompt").fill("Close on the fox's eyes, frost on its whiskers, the lamp a blur behind.");
  await frames.nth(0).getByTestId("frame-revise-price").click();
  await expect(frames.nth(0).getByTestId("frame-render")).toContainText(/Render · \d+ credits?/, { timeout: 30_000 });
  await frames.nth(0).getByTestId("frame-render").click();
  await expect.poll(async () => { const f = (await boards()).production.boards.frames["shot-a1"]; return [f.takes.length, f.prompt]; }, { timeout: 90_000 })
    .toEqual([2, "Close on the fox's eyes, frost on its whiskers, the lamp a blur behind."]);
  await expect(frames.nth(0).getByRole("radiogroup", { name: "Shot 1.1 frames" }).getByRole("radio")).toHaveCount(2);

  /* Revise selected opens a fresh-prompt box on every picked frame that has a picture. */
  await page.getByTestId("boards-select-all").click();
  await page.getByTestId("boards-revise-selected").click();
  await expect(page.getByTestId("frame-reviser")).toHaveCount(2);

  /* A line drawing: uploaded, put on beat 1.2, then deleted — gone from the project and off its beat. */
  const png = await sharp({ create: { width: 800, height: 450, channels: 3, background: "#eee" } }).png().toBuffer();
  await page.getByTestId("drawings-upload").setInputFiles({ name: "mara-window.png", mimeType: "image/png", buffer: png });
  const drawing = page.getByTestId("line-drawing");
  await expect(drawing).toHaveCount(1, { timeout: 30_000 });
  await drawing.getByTestId("drawing-shot").selectOption("shot-a2");
  await expect.poll(async () => (await boards()).production.boards.frames["shot-a2"]?.sketch?.name ?? null, { timeout: 15_000 }).toBe("mara-window.png");
  await drawing.getByTestId("drawing-delete").click();
  await drawing.getByTestId("drawing-delete-confirm").click();
  await expect(drawing).toHaveCount(0);
  await expect.poll(async () => { const p = await boards(); return [p.assets.some((a: { name: string }) => a.name === "mara-window.png"), p.production.boards.frames["shot-a2"]?.sketch ?? null]; }, { timeout: 15_000 }).toEqual([false, null]);
  if (info.project.name === "workbench-390x844") await page.getByTestId("boards-selection").screenshot({ path: info.outputPath("selection-390.png") });
  expect(errors).toEqual([]);
});
