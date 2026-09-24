import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { createHash, randomUUID } from "node:crypto";
import { newProject } from "../lib/workbench/studio";
import type { BeatScene } from "../lib/production/beats";
import { localPlatformDbUrl, signInLocally } from "./helpers/workbenchLocal";
import { screenplayPdf } from "./helpers/screenplayPdf";

/**
 * Production › Beats (owner, 24 September): a beat sheet exported from Final
 * Draft as a PDF is uploaded, read in the browser, and summarised by the agent
 * (priced first) into scenes and beats with their acts; and the beat sheet can
 * be seen as a graph — act lanes, scenes along the story spine, beats beneath —
 * that zooms, pans, opens a scene to edit, and moves a scene to another act by
 * dragging it. Real local routes, mock engine.
 */
const SIZES = ["workbench-1440x900", "workbench-390x844"];
/** An original synthetic beat board export: acts, cards and beats, over two pages. */
const SHEET = [
  ["THE CROSSING - Beat Board", "", "ACT ONE", "EXT. FROZEN HARBOUR - DUSK", "A red fox crosses the ice.", "Mara sees it from the hut.", "INT. HARBOUR HUT - NIGHT", "Mara loads the old rifle.", "1"],
  ["ACT TWO", "EXT. LIGHTHOUSE ROAD - DAWN", "Mara tracks the fox along the road.", "The fox leads her to the wreck.", "ACT THREE", "EXT. FROZEN HARBOUR - DAY", "Mara lets the fox go.", "2"],
];

async function setup(page: Page, production: Record<string, unknown> = {}, script = "") {
  const account = await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${account.workspace.id}-${me.id}` };
  const platform = createClient({ url: localPlatformDbUrl(), timeout: 10_000 });
  try {
    await platform.execute({ sql: "INSERT INTO credit_grants(id,workspace_id,credits,note,kind,created_by,created_at) VALUES(?,?,?,?,?,?,?)", args: [randomUUID(), account.workspace.id, 5000, "Beats import test", "admin", "test", Date.now()] });
  } finally { platform.close(); }
  const project = newProject(`Beat sheet ${randomUUID().slice(0, 6)}`);
  project.brief = "A fox and a harbour master.";
  project.script = script;
  project.production = production;
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const bodies: Record<string, unknown>[] = [];
  page.on("request", (request) => { if (request.url().includes("/api/workbench/development") && request.method() === "POST") bodies.push(request.postDataJSON()); });
  await page.goto(`/suites?suite=studio&page=brief&sp=beats&project=${project.id}`);
  await expect(page.getByTestId("beats-stage")).toBeVisible();
  const read = async () => (await page.request.get(`/api/workbench/projects?id=${project.id}`, { headers }).then((r) => r.json())).project;
  return { errors, bodies, read };
}

test("a Final Draft beat sheet PDF is read, priced, and summarised by the agent into scenes and beats in their acts — with no script yet", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "one desktop, one phone");
  test.setTimeout(120_000);
  const { errors, bodies, read } = await setup(page);
  await page.evaluate(() => localStorage.removeItem("particl.beats.view"));
  await expect(page.getByTestId("beats-no-script")).toContainText("upload a beat sheet below");

  await page.getByTestId("beats-import-file").setInputFiles({ name: "The Crossing - Beat Board.pdf", mimeType: "application/pdf", buffer: screenplayPdf(SHEET) });
  await expect(page.getByTestId("beats-import-source")).toContainText(/The Crossing - Beat Board\.pdf · 2 pages · [\d,]+ characters read/);
  const source = (await read()).production.beatSource;
  expect(source).toMatchObject({ name: "The Crossing - Beat Board.pdf", pages: 2 });
  expect(source.text).toContain("Mara lets the fox go.");

  /* Priced first: nothing runs until the start. */
  await page.getByTestId("beats-import-estimate").click();
  await expect(page.getByTestId("beats-import-quote")).toContainText(/\d+ agent steps/);
  expect(bodies.at(-1)).toMatchObject({ kind: "beatsheet", quoteOnly: true });
  await page.getByTestId("beats-import-start").click();
  await expect(page.getByTestId("beats-counts")).toHaveText("4 scenes · 6 beats · 0 shots", { timeout: 60_000 });

  /* Each act as the sheet labelled it, on the board and saved. */
  const board = page.getByTestId("beat-board");
  await expect(board.locator('[data-testid="beat-scene"]')).toHaveCount(4);
  await expect(board.locator('.pd-act[data-act="1"] [data-testid="beat-scene"]')).toHaveCount(2);
  await expect(board.locator('.pd-act[data-act="2"] [data-testid="beat-scene"]')).toHaveCount(1);
  await expect(board.locator('.pd-act[data-act="3"] [data-testid="beat-scene"]')).toHaveCount(1);
  await expect(page.getByTestId("beats-breakdown")).toContainText("these beats came from The Crossing - Beat Board.pdf");
  const beats = (await read()).production.beats;
  expect(beats).toMatchObject({ source: "upload", sourceName: "The Crossing - Beat Board.pdf" });
  expect(beats.scenes.map((s: BeatScene) => [s.heading, s.act])).toEqual([
    ["EXT. FROZEN HARBOUR - DUSK", 1], ["INT. HARBOUR HUT - NIGHT", 1], ["EXT. LIGHTHOUSE ROAD - DAWN", 2], ["EXT. FROZEN HARBOUR - DAY", 3],
  ]);
  expect(beats.scenes[0].beats.map((b: { text: string }) => b.text)).toEqual(["A red fox crosses the ice.", "Mara sees it from the hut."]);
  expect(errors).toEqual([]);
});

test("a PDF with no text is refused in words, and nothing is saved", async ({ page }, info) => {
  test.skip(info.project.name !== "workbench-1440x900", "one desktop");
  const { read } = await setup(page);
  await page.getByTestId("beats-import-file").setInputFiles({ name: "scan.pdf", mimeType: "application/pdf", buffer: screenplayPdf([[""]]) });
  await expect(page.getByTestId("beats-import-error")).toContainText("No text could be read from this PDF");
  expect((await read()).production.beatSource).toBeUndefined();
});

const scene = (id: string, heading: string, beats: string[], act?: 1 | 2 | 3): BeatScene => ({
  id, heading, summary: `${heading} summary`, ...(act ? { act } : {}), beats: beats.map((text, i) => ({ id: `${id}-b${i}`, text })),
  shots: [{ id: `${id}-s`, description: "Wide", framing: "", movement: "", lighting: "", sound: "" }], characters: [], locations: [], props: [],
});

test("the beat graph: act lanes, the story spine and beats; it zooms and fits; a scene opens to edit; a scene dragged to Act One moves there, saved", async ({ page }, info) => {
  test.skip(!SIZES.includes(info.project.name), "one desktop, one phone");
  test.setTimeout(120_000);
  const script = "EXT. HARBOUR - DUSK\n\nA fox.\n";
  const sha = createHash("sha256").update(script).digest("hex");
  const { errors, read } = await setup(page, {
    scriptApproval: { at: new Date().toISOString(), source: "hand", sha256: sha },
    beats: { scriptSha256: sha, updatedAt: new Date().toISOString(), scenes: [
      scene("scene-a", "EXT. HARBOUR - DUSK", ["The fox crosses", "Mara sees it"], 1),
      scene("scene-b", "INT. HUT - NIGHT", ["Mara loads the rifle"], 2),
      scene("scene-c", "EXT. ROAD - DAWN", ["She follows"], 2),
      scene("scene-d", "EXT. HARBOUR - DAY", ["She lets it go"], 3),
    ] },
  }, script);

  await page.getByTestId("beats-view-graph").click();
  await expect(page.getByTestId("beats-view-graph")).toHaveAttribute("aria-checked", "true");
  const surface = page.getByTestId("beat-graph-surface");
  await surface.scrollIntoViewIfNeeded();
  await expect(page.getByTestId("beat-graph-lane")).toHaveCount(3);
  await expect(page.getByTestId("beat-graph-scene")).toHaveCount(4);
  await expect(page.getByTestId("beat-graph-beat")).toHaveCount(5);
  await expect(page.locator(".pd-graph-spine")).toHaveCount(3);
  await expect(page.getByTestId("beat-board")).toHaveCount(0);

  /* It opens fitted: every scene inside the board. Zoom steps and Fit come back. */
  const fitted = Number(await surface.getAttribute("data-zoom"));
  const box = (await surface.boundingBox())!;
  for (const n of await page.getByTestId("beat-graph-scene").all()) {
    const b = (await n.boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(box.x - 1);
    expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width + 1);
  }
  await page.getByTestId("beat-zoom-in").click();
  await expect.poll(async () => Number(await surface.getAttribute("data-zoom"))).toBeGreaterThan(fitted);
  await page.getByTestId("beat-zoom-fit").click();
  await expect(surface).toHaveAttribute("data-zoom", String(fitted));

  /* Click a scene: its editor opens; an edit shows on the graph and is saved. */
  const b = page.locator('[data-testid="beat-graph-scene"][data-scene-id="scene-b"]');
  await b.click();
  await expect(b).toHaveAttribute("data-open", "true");
  const heading = page.getByLabel("Scene 2 heading");
  await heading.fill("INT. HARBOUR MASTER'S HUT - NIGHT");
  await expect(b).toContainText("INT. HARBOUR MASTER'S HUT - NIGHT");
  await page.getByTestId("beat-close").click();

  /* Drag scene d from Act Three into the Act One lane, just right of scene a: it becomes scene 2, in Act One. */
  const d = page.locator('[data-testid="beat-graph-scene"][data-scene-id="scene-d"]');
  const a = page.locator('[data-testid="beat-graph-scene"][data-scene-id="scene-a"]');
  await surface.scrollIntoViewIfNeeded();
  await d.scrollIntoViewIfNeeded();
  const from = (await d.boundingBox())!, target = (await a.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width * 1.05, target.y + target.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(d).toHaveAttribute("data-act", "1");
  await expect.poll(async () => (await read()).production.beats.scenes.map((s: BeatScene) => `${s.id}:${s.act}`), { timeout: 15_000 })
    .toEqual(["scene-a:1", "scene-d:1", "scene-b:2", "scene-c:2"]);
  expect((await read()).production.beats.scenes[2].heading).toBe("INT. HARBOUR MASTER'S HUT - NIGHT");

  /* The choice is remembered on this device: the board is back only when asked for. */
  await page.reload();
  await expect(page.getByTestId("beat-graph-surface")).toBeVisible();
  await page.getByTestId("beats-view-board").click();
  await expect(page.getByTestId("beat-board")).toBeVisible();
  expect(errors).toEqual([]);
});
