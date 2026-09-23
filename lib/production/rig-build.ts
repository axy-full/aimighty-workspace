import { PROJECT_LIMITS } from "../workbench/project-limits";
import { createNode } from "../workbench/node-graph";
import { uid, type Asset, type CanvasNode, type Project } from "../workbench/studio";
import { boardShots } from "./boards";

/**
 * Production › Rig operations (owner's brief, 23 September), pure so the Rig's
 * draft applies them in one step: inputs from uploads, the library, previous
 * shots and the cast; a first frame; a new rig from a take; and one shot per
 * storyboard frame.
 */
export class RigBuildError extends Error {}
const NODE_LIMIT = PROJECT_LIMITS.nodes;
const MEDIA_WIDTH = 220;

/* The canvas holds x and y within -10,000…20,000. Shots stack down a column;
   a full column starts the next one to its right (inputs sit to each shot's left). */
const COLUMN_WIDTH = 720, COLUMN_FLOOR = 19_000, CANVAS_RIGHT = 19_000;
function place(project: Project, near?: CanvasNode) {
  if (near) return { x: near.x - MEDIA_WIDTH - 60, y: Math.min(COLUMN_FLOOR, near.y + near.linked.length * 90) };
  const column = project.nodes.reduce((max, n) => (n.boardShotId || n.type === "scene" ? Math.max(max, n.x) : max), 100);
  const bottom = project.nodes.reduce((max, n) => (n.x > column - COLUMN_WIDTH / 2 - MEDIA_WIDTH && n.x < column + COLUMN_WIDTH / 2 ? Math.max(max, n.y + 260) : max), 60);
  if (bottom <= COLUMN_FLOOR) return { x: column, y: bottom };
  if (column + COLUMN_WIDTH > CANVAS_RIGHT) throw new RigBuildError("The Rig canvas is full. Remove unused shots or start another project.");
  return { x: column + COLUMN_WIDTH, y: 60 };
}
function roomFor(project: Project, n: number) { if (project.nodes.length + n > NODE_LIMIT) throw new RigBuildError(`This rig holds ${NODE_LIMIT} nodes; there is room for ${NODE_LIMIT - project.nodes.length} more.`); }
const withAsset = (project: Project, asset: Asset) => (project.assets.some((a) => a.id === asset.id) ? project : { ...project, assets: [...project.assets, asset] });

/** A media node holding the asset, linked into the shot. The asset is filed on the project if it is not already. */
export function addInput(project: Project, shotId: string, asset: Asset, title = asset.name): Project {
  const shot = project.nodes.find((n) => n.id === shotId);
  if (!shot) throw new RigBuildError("Choose a shot first.");
  if (shot.locked) throw new RigBuildError("Unlock this shot before changing its inputs.");
  if (asset.kind !== "image" && asset.kind !== "video") throw new RigBuildError("Inputs are images and videos.");
  const existing = project.nodes.find((n) => n.type === "media" && n.assetId === asset.id && shot.linked.includes(n.id));
  if (existing) throw new RigBuildError(`${title} is already an input of this shot.`);
  if (shot.linked.length >= 100) throw new RigBuildError("This shot has reached its input limit.");
  roomFor(project, 1);
  const next = withAsset(project, asset);
  const media: CanvasNode = { ...createNode("media", project.nodes.length, place(project, shot)), id: uid("node"), title: title.slice(0, 300), assetId: asset.id, width: MEDIA_WIDTH, linked: [] };
  return { ...next, nodes: [...next.nodes.map((n) => (n.id === shotId ? { ...n, linked: [...n.linked, media.id] } : n)), media] };
}

/** Unlinks an input; a media node nothing else uses goes with it. */
export function removeInput(project: Project, shotId: string, inputId: string): Project {
  const nodes = project.nodes.map((n) => (n.id === shotId ? { ...n, linked: n.linked.filter((id) => id !== inputId), ...(n.firstFrameId && project.nodes.find((m) => m.id === inputId)?.assetId === n.firstFrameId ? { firstFrameId: undefined } : {}) } : n));
  const input = nodes.find((n) => n.id === inputId);
  const orphan = input?.type === "media" && !nodes.some((n) => n.linked.includes(inputId));
  return { ...project, nodes: orphan ? nodes.filter((n) => n.id !== inputId) : nodes };
}

/** Marks an input image as the shot's first frame (or clears it). */
export function setFirstFrame(project: Project, shotId: string, assetId: string | null): Project {
  const asset = assetId ? project.assets.find((a) => a.id === assetId) : null;
  if (assetId && asset?.kind !== "image") throw new RigBuildError("A first frame is an image.");
  return { ...project, nodes: project.nodes.map((n) => (n.id === shotId ? { ...n, firstFrameId: assetId ?? undefined } : n)) };
}

/** A new shot that refers to a take: the same prompt and engine, the take as its input (and first frame, for a still). */
export function branchFromTake(project: Project, shotId: string, take: Asset): { project: Project; id: string } {
  const shot = project.nodes.find((n) => n.id === shotId);
  if (!shot) throw new RigBuildError("Choose a shot first.");
  roomFor(project, 2);
  const title = `${shot.title} · from ${take.name}`.slice(0, 300);
  const node: CanvasNode = { ...shot, id: uid("node"), title, x: shot.x, y: shot.y + 320, linked: [], versions: undefined, status: "draft", locked: false, condensed: undefined, firstFrameId: undefined, boardShotId: undefined };
  let next: Project = { ...project, nodes: [...project.nodes, node] };
  next = addInput(next, node.id, take, `Take · ${take.name}`);
  if (take.kind === "image") next = setFirstFrame(next, node.id, take.id);
  return { project: next, id: node.id };
}

/** One shot per framed storyboard shot not yet in the Rig: its prompt, its frame as the input (first frame for live action). */
export function buildFromBoards(project: Project, engine: string): { project: Project; added: number } {
  const boards = project.production?.boards;
  const framed = boardShots(project.production?.beats).filter((s) => {
    const frame = boards?.frames[s.id];
    return frame && (frame.selected ?? frame.takes[0]?.genId) && !project.nodes.some((n) => n.boardShotId === s.id);
  });
  if (!framed.length) throw new RigBuildError(boards ? "Every framed shot is already in the Rig." : "Frame the shots in Storyboards first.");
  roomFor(project, framed.length * 2);
  let next = project;
  for (const s of framed) {
    const frame = boards!.frames[s.id];
    const genId = frame.selected ?? frame.takes[0].genId;
    const asset = next.assets.find((a) => a.id === genId) ?? { id: genId, generationId: genId, kind: "image" as const, category: "Storyboard", name: `Frame ${s.number}`, url: `/api/media/${genId}`, description: s.scene, prompt: frame.prompt, status: "Draft" as const, locked: false, version: 1, refs: [] };
    const base = createNode("scene", next.nodes.length, place(next));
    const text = [frame.prompt || s.shot.description, s.shot.movement && `Camera: ${s.shot.movement}.`, s.shot.sound && `Sound: ${s.shot.sound}.`].filter(Boolean).join("\n").slice(0, 20_000);
    const shot: CanvasNode = { ...base, id: uid("node"), title: `${s.number} — ${s.shot.description || s.scene}`.slice(0, 300), text, mode: "Video", engine, ...(s.shot.duration ? { durationS: Math.round(s.shot.duration) } : {}), boardShotId: s.id };
    next = { ...next, nodes: [...next.nodes, shot] };
    next = addInput(next, shot.id, asset, `Frame ${s.number}`);
    if (boards!.style === "live") next = setFirstFrame(next, shot.id, asset.id);
  }
  return { project: next, added: framed.length };
}

/** A new shot built on one asset (an Astra render, a take): its prompt, and the asset as input — first frame for a still. */
export function shotFromAsset(project: Project, asset: Asset, engine: string): { project: Project; id: string } {
  roomFor(project, 2);
  const base = createNode("scene", project.nodes.length, place(project));
  const shot: CanvasNode = { ...base, id: uid("node"), title: `From ${asset.name}`.slice(0, 300), mode: "Video", engine, ...(asset.prompt?.trim() ? { text: asset.prompt.slice(0, 20_000) } : {}) };
  let next: Project = withAsset({ ...project, nodes: [...project.nodes, shot] }, asset);
  next = addInput(next, shot.id, asset);
  if (asset.kind === "image") next = setFirstFrame(next, shot.id, asset.id);
  return { project: next, id: shot.id };
}

/** "Send to Rig" from another stage: the asset travels by session, and the Rig builds the shot when it opens — one editor writes the project. */
export const RIG_INTENT_KEY = "particl:rig-intent:v1";
export type RigIntent = { projectId: string; asset: Asset };
export function sendToRig(intent: RigIntent) {
  try { sessionStorage.setItem(RIG_INTENT_KEY, JSON.stringify(intent)); } catch { /* the Rig simply opens without it */ }
}
export function takeRigIntent(projectId: string): Asset | null {
  try {
    const raw = sessionStorage.getItem(RIG_INTENT_KEY);
    if (!raw) return null;
    const intent = JSON.parse(raw) as RigIntent;
    if (intent.projectId !== projectId || !intent.asset?.id) return null;
    sessionStorage.removeItem(RIG_INTENT_KEY);
    return intent.asset;
  } catch { return null; }
}
