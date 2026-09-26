import { test, expect } from "@playwright/test";
import { addInput, branchFromTake, buildFromBoards, removeInput, setFirstFrame, shotFromAsset, RigBuildError } from "../../lib/production/rig-build";
import { ENGINE_PROMPT_LIMIT, renderPromptFor, shotRenderPrompt, textKey } from "../../lib/production/rig-prompt";
import { newProject, type Asset, type CanvasNode, type Project } from "../../lib/workbench/studio";

/** Production › Rig: the shot's own prompt, the engine limit and the agent's pinned condensation, and the pure Rig operations. */
const img = (id: string, name = id): Asset => ({ id, generationId: id, name, kind: "image", category: "Storyboard", url: `/api/media/${id}`, description: "", prompt: "", status: "Draft", locked: false, version: 1, refs: [] });
const scene = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, title: id, type: "scene", x: 0, y: 0, width: 300, linked: [], mode: "Video", ...extra });
function project(nodes: CanvasNode[] = [scene("s1")], assets: Asset[] = [img("a1"), img("a2")]): Project { return { ...newProject("Rig"), nodes, assets }; }

test("the render prompt is the shot's own prompt, its notes and its inputs; without one the Rig's earlier composition stands", () => {
  let p = project([scene("s1", { text: "A fox on the ice.", operations: [{ id: "o", kind: "direction", enabled: true, values: { note: "Hold wide." } }] })]);
  p = addInput(p, "s1", p.assets[0], "Frame 1.1");
  p = setFirstFrame(p, "s1", "a1");
  expect(shotRenderPrompt(p.nodes[0], p)).toBe("A fox on the ice.\n\nDirector's notes: Hold wide.\n\nInputs:\nInput 1 — Frame 1.1 (storyboard): first frame — the shot starts on this image");
  expect(shotRenderPrompt(scene("s2"), p)).toContain("PROJECT BRIEF");
});

test("over the engine's limit only a condensation pinned to that exact prompt is sent; an edit asks again", () => {
  const long = "x".repeat(ENGINE_PROMPT_LIMIT + 5);
  const node = scene("s1", { text: long });
  const p = project([node]);
  expect(renderPromptFor(node, p)).toEqual({ prompt: null, length: long.length });
  const pinned = { ...node, condensed: { key: textKey(shotRenderPrompt(node, p)), text: "short" } };
  expect(renderPromptFor(pinned, project([pinned]))).toEqual({ prompt: "short", condensed: true });
  const edited = { ...pinned, text: long + "y" };
  expect(renderPromptFor(edited, project([edited]))).toMatchObject({ prompt: null });
  expect(textKey("abc")).toMatch(/^[a-f0-9]{16}$/);
  expect(textKey("abc")).not.toBe(textKey("abd"));
});

test("inputs: added once, unlinked with their orphan media node, first frame only on an image, refusals in words", () => {
  let p = addInput(project(), "s1", img("a1"));
  expect(() => addInput(p, "s1", img("a1"))).toThrow(RigBuildError);
  p = setFirstFrame(p, "s1", "a1");
  const media = p.nodes.find((n) => n.type === "media")!;
  p = removeInput(p, "s1", media.id);
  expect(p.nodes.find((n) => n.id === "s1")!.linked).toEqual([]);
  expect(p.nodes.find((n) => n.id === "s1")!.firstFrameId).toBeUndefined();
  expect(p.nodes.some((n) => n.type === "media")).toBe(false);
  expect(() => setFirstFrame({ ...p, assets: [...p.assets, { ...img("v1"), kind: "video" }] }, "s1", "v1")).toThrow("A first frame is an image.");
});

test("a rig from a take keeps the prompt and engine and starts on a still take; a shot from an asset does the same", () => {
  const p = project([scene("s1", { text: "Prompt", engine: "dreamina-seedance-2-5-260628" })]);
  const out = branchFromTake(p, "s1", img("a2", "Take 2"));
  const made = out.project.nodes.find((n) => n.id === out.id)!;
  expect(made).toMatchObject({ title: "s1 · from Take 2", text: "Prompt", engine: "dreamina-seedance-2-5-260628", firstFrameId: "a2" });
  const sent = shotFromAsset(p, { ...img("astra-1_preview", "Astra render"), category: "Astra", prompt: "The blocked scene" }, "dreamina-seedance-2-5-260628");
  expect(sent.project.nodes.find((n) => n.id === sent.id)).toMatchObject({ title: "From Astra render", text: "The blocked scene", firstFrameId: "astra-1_preview" });
});

test("storyboards build one shot per framed shot, once", () => {
  const at = new Date().toISOString();
  const p: Project = { ...project([]), production: {
    beats: { scriptSha256: "a".repeat(64), updatedAt: at, scenes: [{ id: "sc", heading: "EXT. HARBOUR", summary: "", beats: [], shots: [{ id: "sh1", description: "Fox", framing: "", movement: "", lighting: "", sound: "" }, { id: "sh2", description: "Hut", framing: "", movement: "", lighting: "", sound: "" }], characters: [], locations: [], props: [] }] },
    boards: { style: "bw-sketch", model: "gemini-3.1-flash-image", frames: { sh1: { prompt: "Fox frame", takes: [{ genId: "a1", style: "bw-sketch", at }] }, sh2: { prompt: "No picture yet", takes: [] } } },
  } };
  const first = buildFromBoards(p, "dreamina-seedance-2-5-260628");
  expect(first.added).toBe(1);
  const shot = first.project.nodes.find((n) => n.boardShotId === "sh1")!;
  /* A sketch board is a reference, not the first frame: the video must not start on a drawing. */
  expect(shot).toMatchObject({ title: "1.1 — Fox", text: "Fox frame" });
  expect(shot.firstFrameId).toBeUndefined();
  expect(() => buildFromBoards(first.project, "dreamina-seedance-2-5-260628")).toThrow("Every framed shot is already in the Rig.");
});

test("a frame's own look decides the first frame, not the board's", () => {
  const at = new Date().toISOString();
  const beats = { scriptSha256: "a".repeat(64), updatedAt: at, scenes: [{ id: "sc", heading: "EXT. HARBOUR", summary: "", beats: [], shots: ["sh1", "sh2", "sh3"].map((id) => ({ id, description: id, framing: "", movement: "", lighting: "", sound: "" })), characters: [], locations: [], props: [] }] };
  const p: Project = { ...project([], [img("a1"), img("a2"), img("a3")]), production: { beats, boards: { style: "color-sketch", model: "gemini-3.1-flash-image", frames: {
    // A line drawing converted as live action on a sketch board: the take is a photographic first frame.
    sh1: { prompt: "Converted", style: "live", takes: [{ genId: "a1", style: "live", at }] },
    // A pencil frame on a board later switched to live: the take stays a reference.
    sh2: { prompt: "Pencil", style: "bw-sketch", takes: [{ genId: "a2", style: "bw-sketch", at }] },
    // No take record for the selected picture: the frame's own look decides.
    sh3: { prompt: "Own look", style: "live", takes: [], selected: "a3" },
  } } } };
  const built = buildFromBoards(p, "dreamina-seedance-2-5-260628").project;
  const shot = (id: string) => built.nodes.find((n) => n.boardShotId === id)!;
  expect(shot("sh1").firstFrameId).toBe("a1");
  expect(shot("sh3").firstFrameId).toBe("a3");
  const onLive = buildFromBoards({ ...p, production: { ...p.production, boards: { ...p.production!.boards!, style: "live" } } }, "dreamina-seedance-2-5-260628").project;
  expect(onLive.nodes.find((n) => n.boardShotId === "sh2")!.firstFrameId).toBeUndefined();
  expect(shot("sh2").firstFrameId).toBeUndefined();
});

test("a branch near the canvas floor stays inside the saved bounds", () => {
  const p = project([scene("s1", { x: 100, y: 19_900 })]);
  const out = branchFromTake(p, "s1", img("a2", "Take 2"));
  for (const n of out.project.nodes) {
    expect(n.y).toBeLessThanOrEqual(20_000);
    expect(n.x).toBeLessThanOrEqual(20_000);
  }
  const made = out.project.nodes.find((n) => n.id === out.id)!;
  expect(made.y).toBeLessThan(19_900);
  // Higher up the column, the branch still sits right below its parent.
  const mid = branchFromTake(project([scene("s1", { x: 100, y: 400 })]), "s1", img("a2"));
  expect(mid.project.nodes.find((n) => n.id === mid.id)).toMatchObject({ x: 100, y: 720 });
});
