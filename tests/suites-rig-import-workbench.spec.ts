import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { signInLocally } from "./helpers/workbenchLocal";
import { newProject, type Project } from "../lib/workbench/studio";


/** An old board's card and wire, as its page saves them. */
const card = (id: string, kind: string, x: number, y: number, extra: Record<string, unknown> = {}) =>
  ({ id, kind, x, y, label: kind, ref: null, ports: [], inputs: [], output: null, settings: {}, state: "idle", credits: 0, staleSince: null, ...extra });
const wire = (id: string, from: string, to: string, slotId: string, kind = "inherited") => ({ id, from: { nodeId: from, portId: "out" }, to: { nodeId: to, slotId }, kind });
const SLOTS = ["CHARACTER", "PROP", "BACKGROUND", "LOOK", "PROMPT"].map((label) => ({ id: label.toLowerCase(), label }));

/** The production, its Suites draft, three elements (Noor with a picture) and the old board: eight cards, six inputs and a filing line. */
async function setUp(page: Page, name: string) {
  await signInLocally(page.request);
  const me = await page.request.get("/api/me").then((r) => r.json());
  const headers = { "X-Workbench-Scope": `particl-active-${me.workspace.id}-${me.id}` };
  const draft: Project = { ...newProject(name), id: `import-${Date.now().toString(36)}` };
  const saved = await page.request.put("/api/workbench/projects", { headers, data: { project: draft, revision: 0 } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const { productionProjectId: productionId } = (await saved.json()) as { productionProjectId: string };
  const uploaded = await page.request.post("/api/uploads", { headers, multipart: { file: { name: "Noor.webp", mimeType: "image/webp", buffer: readFileSync("public/campaign/character.webp") } } });
  expect(uploaded.ok(), await uploaded.text()).toBe(true);
  const face = ((await uploaded.json()) as { id: string }).id;
  const element = async (label: string, kind: string, extra: Record<string, unknown> = {}) => {
    const made = await page.request.post("/api/rig/elements", { headers, data: { name: label, kind, projectId: productionId, ...extra } });
    expect(made.status(), await made.text()).toBe(201);
    return ((await made.json()) as { element: { id: string } }).element.id;
  };
  const noor = await element("Noor", "character", { fromUploadId: face });
  const harbour = await element("Harbour", "location");
  const bag = await element("The bag", "prop");
  const made = await page.request.post("/api/rig/boards", { data: { projectId: productionId, name: "SH04 board" } });
  expect(made.ok(), await made.text()).toBe(true);
  const boardId = ((await made.json()) as { board: { id: string } }).board.id;
  const nodes = [
    card("nd_noor", "asset", 40, 60, { label: "@Noor", ref: { elementId: noor }, settings: { kind: "character", locked: false } }),
    card("nd_harbour", "asset", 40, 420, { label: "@Harbour", ref: { elementId: harbour }, settings: { kind: "location", locked: false } }),
    card("nd_bag", "asset", 40, 780, { label: "@The bag", ref: { elementId: bag }, settings: { kind: "prop", locked: false } }),
    card("nd_shot", "shot", 380, 60, { label: "SH04", inputs: SLOTS, settings: { title: "Noor at the harbour wall", takes: 0, spent: 0 } }),
    card("nd_prompt", "prompt", 380, 480, { label: "Prompt", text: "Wind in her hair." }),
    card("nd_image", "image", 720, 60, { label: "Nano Banana Pro", ref: { engine: "gemini-3-pro-image" }, inputs: [{ id: "spec", label: "SPEC" }, { id: "refs", label: "REFS" }], settings: { resolution: "1K", ratio: "16:9", count: 1 } }),
    card("nd_compare", "compare", 1060, 60, { label: "Compare", inputs: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }),
    card("nd_note", "note", 1060, 480, { label: "Note", text: "Keep the bag in every shot." }),
  ];
  const wires = [
    wire("w_cast", "nd_noor", "nd_shot", "character"),
    wire("w_place", "nd_harbour", "nd_shot", "background"),
    wire("w_prop", "nd_bag", "nd_shot", "prop"),
    wire("w_prompt", "nd_prompt", "nd_image", "refs"),
    wire("w_spec", "nd_shot", "nd_image", "spec"),
    wire("w_a", "nd_image", "nd_compare", "a"),
    wire("w_filed", "nd_image", "nd_shot", "takes", "filed"),
  ];
  const put = await page.request.put(`/api/rig/boards/${boardId}`, { data: { nodes, wires } });
  expect(put.ok(), await put.text()).toBe(true);
  return { draft, headers, productionId, boardId };
}






test("the import route: free, one bounded batch per call, refused for a production or board that is not here, and idempotent", async ({ page }) => {
  test.setTimeout(180_000);
  const { headers, productionId, boardId } = await setUp(page, "Harbour route");
  const post = (board: string, data: Record<string, unknown>) => page.request.post(`/api/rig/boards/${board}`, { headers, data });
  /* A production or a board that is not in this workspace: refused, and nothing is written. (A board of another production
     of this workspace is refused too, with a 409: tests/unit/boardImport.spec.ts.) */
  const nowhere = await post(boardId, { action: "import", productionId: "prj_nowhere" });
  expect(nowhere.status()).toBe(404);
  expect(((await nowhere.json()) as { error: string }).error).toBe("That project is not in this workspace.");
  expect((await post("brd_nope", { action: "import", productionId })).status()).toBe(404);
  expect((await post(boardId, { action: "tidy", productionId })).status()).toBe(400);
  /* A write needs this account's scope, like every canvas write. */
  expect((await page.request.post(`/api/rig/boards/${boardId}`, { data: { action: "import", productionId } })).status()).toBe(409);
  const first = await post(boardId, { action: "import", productionId });
  expect(first.ok(), await first.text()).toBe(true);
  expect(await first.json()).toMatchObject({ credits: 0, done: true, live: "off", filed: 1, brought: { cards: 8, wires: 6 }, cards: { total: 8, here: 8 }, wires: { total: 6, here: 6 } });
  const second = await post(boardId, { action: "import", productionId });
  expect(await second.json()).toMatchObject({ credits: 0, done: true, brought: { cards: 0, wires: 0 } });
});
