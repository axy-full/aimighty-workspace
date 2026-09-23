import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { newProject } from "../lib/workbench/studio";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";

/**
 * Production › Storyboards (owner's brief, 23 September): every beat-sheet shot
 * is a frame with a prompt button; the agent writes the prompts; the director
 * picks the look (live action, coloured sketch, black-and-white sketch); a frame
 * is priced, then rendered and filed as a Storyboard asset; a rough drawing is
 * uploaded, the agent reads it (the drawing is sent to a vision model), and the
 * frame renders with the drawing as its reference. Real local routes, mock engine.
 */
const SIZES = ["workbench-1440x900", "workbench-390x844"];
const SCRIPT = "EXT. FROZEN HARBOUR - DUSK\n\nA red fox crosses the ice.\n";
const shot = (id: string, description: string) => ({ id, description, framing: "Wide", movement: "Static", lighting: "Dusk", sound: "Wind" });

async function setup(page: Page) {
  const account = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${account.workspace.id}-${me.id}` };
  const platform = createClient({ url: localPlatformDbUrl() });
  try {
    await platform.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), account.workspace.id, 5000, "Storyboards test", "admin", "test", Date.now()] });
  } finally { platform.close(); }
  const project = newProject(`Boards ${randomUUID().slice(0, 6)}`);
  project.script = SCRIPT;
  const sha256 = createHash("sha256").update(SCRIPT).digest("hex");
  project.production = {
    scriptApproval: { at: new Date().toISOString(), source: "hand", sha256 },
    beats: { scriptSha256: sha256, updatedAt: new Date().toISOString(), scenes: [
      { id: "scene-a", heading: "EXT. FROZEN HARBOUR - DUSK", summary: "The crossing", beats: [{ id: "beat-a", text: "The fox crosses" }], shots: [shot("shot-a1", "The fox on the ice"), shot("shot-a2", "Mara at the window")], characters: ["Mara"], locations: ["Harbour"], props: [] },
    ] },
  };
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const quotes: Record<string, unknown>[] = [];
  const agent: Record<string, unknown>[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    if (request.url().endsWith("/api/generate/quote")) quotes.push(request.postDataJSON());
    if (request.url().includes("/api/workbench/development")) agent.push(request.postDataJSON());
  });
  await page.goto(`/suites?suite=studio&page=boards&project=${project.id}`);
  await expect(page.getByTestId("boards-stage")).toBeVisible();
  const read = async () => (await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers }).then((r) => r.json())).project;
  return { errors, quotes, agent, read };
}

test("Storyboards: agent prompts, the look, a priced frame filed as an asset, a drawing read by the agent and kept as the reference", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "one desktop, one phone");
  test.setTimeout(180_000);
  const { errors, quotes, agent, read } = await setup(page);
  await expect(page.getByTestId("page-title")).toHaveText("Storyboards");
  const frames = page.getByTestId("board-frame");
  await expect(frames).toHaveCount(2);
  await expect(page.getByTestId("boards-counts")).toHaveText("2 shots · 0 framed");
  await expect(page.getByTestId("boards-style-live")).toHaveAttribute("aria-checked", "true");

  /* The agent writes every frame's prompt, priced first. */
  await page.getByTestId("boards-prompts-estimate").click();
  await expect(page.getByTestId("boards-prompts-quote")).toContainText("2 shots · 3 agent steps");
  await page.getByTestId("boards-prompts-start").click();
  await frames.nth(0).getByTestId("frame-prompt-toggle").click();
  await expect(frames.nth(0).getByTestId("frame-prompt")).toHaveValue("Frame 1.1: The fox on the ice — mock storyboard prompt.", { timeout: 60_000 });
  expect(agent.find((b) => b.kind === "frames" && !b.quoteOnly)).toBeTruthy();

  /* Black-and-white sketch; price, then render at that price. */
  await page.getByTestId("boards-style-bw-sketch").click();
  await frames.nth(0).getByTestId("frame-price").click();
  await expect(frames.nth(0).getByTestId("frame-render")).toContainText(/Render · \d+ credits/);
  const priced = quotes.at(-1)!;
  expect(priced).toMatchObject({ model: "gemini-3.1-flash-image", references: [] });
  expect(String(priced.prompt)).toContain("black-and-white pencil sketch");
  await frames.nth(0).getByTestId("frame-render").click();
  await expect(frames.nth(0).locator(".pd-frame-image img")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("boards-counts")).toHaveText("2 shots · 1 framed");
  await expect.poll(async () => (await read()).assets.filter((a: { category: string }) => a.category === "Storyboard").length, { timeout: 15_000 }).toBe(1);

  /* A rough drawing for shot 1.2: uploaded, read by the agent, then the frame's reference. */
  await frames.nth(1).getByTestId("frame-prompt-toggle").click();
  /* A rough line drawing: two stick figures on a white page (reference uploads need 300px or more). */
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450"><rect width="800" height="450" fill="#fff"/><g stroke="#000" stroke-width="6" fill="none"><circle cx="220" cy="170" r="30"/><path d="M220 200v110M220 230l-50 40M220 230l50 40M220 310l-40 70M220 310l40 70"/><circle cx="560" cy="190" r="26"/><path d="M560 216v95M560 240l-45 35M560 240l45 35M560 311l-35 60M560 311l35 60M300 250h160l-20-15m20 15-20 15"/></g></svg>`;
  const drawing = await sharp(Buffer.from(svg)).png().toBuffer();
  await frames.nth(1).getByTestId("frame-sketch-upload").setInputFiles({ name: "blocking.png", mimeType: "image/png", buffer: drawing });
  await expect(frames.nth(1).locator(".pd-sketch")).toBeVisible();
  await frames.nth(1).getByTestId("frame-read-shot-a2-estimate").click();
  await expect(frames.nth(1).getByTestId("frame-read-shot-a2-quote")).toContainText("with the drawing");
  const sketchQuote = agent.at(-1)!;
  expect(sketchQuote).toMatchObject({ kind: "sketch", shotId: "shot-a2", quoteOnly: true });
  await frames.nth(1).getByTestId("frame-read-shot-a2-start").click();
  await expect(frames.nth(1).getByTestId("frame-reading")).toContainText("(1 image seen)", { timeout: 60_000 });
  await expect(frames.nth(1).getByTestId("frame-prompt")).toHaveValue(/blocked as drawn/);
  await frames.nth(1).getByTestId("frame-price").click();
  await expect(frames.nth(1).getByTestId("frame-render")).toBeVisible();
  const withDrawing = quotes.at(-1)!;
  expect(withDrawing.references).toEqual([{ uploadId: sketchQuote.sketchAssetId, role: "reference_image" }]);
  expect(String(withDrawing.prompt)).toContain("keep its composition, camera angle and the position, pose and direction of every figure");
  await page.screenshot({ path: info.outputPath("boards.png") });
  expect(errors).toEqual([]);
});

test("a frame's own agent prompt reads its beat; a line drawing is put on its beat, read, and converted in its own look", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one desktop width");
  test.setTimeout(180_000);
  const { errors, quotes, agent } = await setup(page);
  const frames = page.getByTestId("board-frame");

  /* Prompt with the agent, for one frame: the request names the shot; its prompt replaces the frame's. */
  await frames.nth(0).getByTestId("frame-agent-shot-a1-estimate").click();
  await expect(frames.nth(0).getByTestId("frame-agent-shot-a1-quote")).toContainText("The agent reads beat 1.1");
  expect(agent.at(-1)).toMatchObject({ kind: "frames", shotId: "shot-a1", quoteOnly: true });
  await frames.nth(0).getByTestId("frame-agent-shot-a1-start").click();
  await frames.nth(0).getByTestId("frame-prompt-toggle").click();
  await expect(frames.nth(0).getByTestId("frame-prompt")).toHaveValue("Frame 1.1: The fox on the ice — mock storyboard prompt.", { timeout: 60_000 });

  /* Line drawings: upload, put on beat 1.2, live action, read, convert. */
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450"><rect width="800" height="450" fill="#fff"/><g stroke="#000" stroke-width="6" fill="none"><circle cx="400" cy="160" r="30"/><path d="M400 190v120M400 220l-60 40M400 220l60 40"/></g></svg>`;
  await page.getByTestId("drawings-upload").setInputFiles({ name: "window.png", mimeType: "image/png", buffer: await sharp(Buffer.from(svg)).png().toBuffer() });
  const drawing = page.getByTestId("line-drawing");
  await expect(drawing).toHaveCount(1);
  await drawing.getByTestId("drawing-shot").selectOption("shot-a2");
  await drawing.getByTestId("drawing-look-live").click();
  await expect(drawing.getByTestId("drawing-price")).toBeDisabled();
  await drawing.locator("[data-testid$='-estimate']").click();
  await drawing.locator("[data-testid$='-start']").click();
  await expect(drawing.getByTestId("drawing-reading")).toContainText("(1 image seen)", { timeout: 60_000 });
  await drawing.getByTestId("drawing-price").click();
  await expect(drawing.getByTestId("drawing-render")).toContainText(/Convert · \d+ credits/);
  const converted = quotes.at(-1)!;
  expect(String(converted.prompt)).toContain("Cinematic live-action storyboard frame");
  expect(converted.references).toEqual([{ uploadId: expect.any(String), role: "reference_image" }]);
  expect(errors).toEqual([]);
});
