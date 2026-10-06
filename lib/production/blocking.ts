import { type AstraObject, type AstraScene, type AstraVector3 } from "../astra-blender/scene";
import type { BeatShot } from "./beats";
import { boardShots } from "./boards";
import { BLOCKING_TOO_MANY, blockingSchema, type Blocking, type BlockingEntry, type Move, type MoveKind } from "./blocking-schema";
import type { Asset, Project } from "../workbench/studio";
import { RigBuildError, addInput } from "./rig-build";

/*
 * 3D blocking, per shot (gap screens): a rough 3D scene of one shot, a camera with a lens and a simple move, and the frame saved from it
 * as that shot's reference. The record's shape and its limits are lib/production/blocking-schema.ts (the part a build needs to accept
 * the field); this file is what the board does with it. Pure and server-safe: no React, no fetch. Nothing here prices or sends anything.
 */
export { blockingSchema, type Blocking, type BlockingEntry, type Move, type MoveKind };
export const LENSES = [24, 35, 50, 85] as const;
export type Lens = (typeof LENSES)[number];

export const blockingOf = (project: Pick<Project, "production">, nodeId: string): BlockingEntry | null =>
  (project.production?.blocking as Blocking | undefined)?.[nodeId] ?? null;

/* ── What an object is on the list ───────────────────────────────────────────────── */

export type ObjectRole = "figure" | "prop" | "set";
export const ROLE_LABEL: Record<ObjectRole, string> = { figure: "Figure", prop: "Prop", set: "Set" };
const PREFIX: Record<ObjectRole, string> = { figure: "fig", prop: "prop", set: "set" };
export const roleOf = (object: Pick<AstraObject, "id">): ObjectRole => (object.id.startsWith("fig-") ? "figure" : object.id.startsWith("set-") ? "set" : "prop");

const nextId = (scene: AstraScene, role: ObjectRole) => {
  for (let n = scene.objects.length + 1; n < 10_000; n++) { const id = `${PREFIX[role]}-${n}`; if (!scene.objects.some((o) => o.id === id)) return id; }
  return `${PREFIX[role]}-${Date.now()}`;
};
/** A name as the scene keeps it: trimmed and cut to 100, so a beat-sheet name of spaces is never one. */
export const cleanName = (name: string | undefined): string => (name ?? "").replace(/\s+/g, " ").trim().slice(0, 100);
const base = (id: string, name: string, type: AstraObject["type"], position: AstraVector3, scale: AstraVector3, color: string): AstraObject => ({
  id, name: cleanName(name) || id, type, position, rotation: [0, 0, 0], scale, visible: true, locked: false, material: { color, metalness: 0, roughness: 0.6 }, keyframes: [],
});

/** A standing figure: a 1.7 m pillar on its mark. */
export function addFigure(scene: AstraScene, name?: string): AstraScene {
  const n = scene.objects.filter((o) => roleOf(o) === "figure").length + 1;
  const id = nextId(scene, "figure");
  const x = Math.round(((n - 1) * 1.4 - 0.7) * 10) / 10;
  return { ...scene, objects: [...scene.objects, base(id, cleanName(name) || `Figure ${n}`, "cylinder", [x, 0, 0.85], [0.45, 0.45, 1.7], "#c9ccd4")] };
}
/** A prop: a 1 m block you can drag and resize. */
export function addProp(scene: AstraScene, name?: string): AstraScene {
  const n = scene.objects.filter((o) => roleOf(o) === "prop").length + 1;
  const id = nextId(scene, "prop");
  return { ...scene, objects: [...scene.objects, base(id, cleanName(name) || `Prop ${n}`, "box", [2 + (n - 1) * 1.2, 1, 0.5], [1, 1, 1], "#b9a98c")] };
}

/* ── The camera, in the words a director uses ────────────────────────────────────── */

export type CameraView = { x: number; depth: number; height: number; tilt: number; lens: number };
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

/** Where the camera stands (X across, depth along the ground), how high, how far it tips up or down, and its lens. */
export function cameraView(scene: AstraScene): CameraView {
  const [px, py, pz] = scene.camera.position, [tx, ty, tz] = scene.camera.target;
  const run = Math.hypot(tx - px, ty - py);
  return { x: round(px), depth: round(py), height: round(pz), tilt: round((Math.atan2(tz - pz, run || 1e-6) * 180) / Math.PI), lens: scene.camera.focalLength };
}

/** Moves the camera body (its view direction stays) to a new X, depth or height, or tips it to a new tilt. */
export function withCameraView(scene: AstraScene, patch: Partial<Omit<CameraView, "lens">>): AstraScene {
  const cur = cameraView(scene);
  const next = { ...cur, ...patch };
  const [px, py, pz] = scene.camera.position, [tx, ty, tz] = scene.camera.target;
  const position: AstraVector3 = [next.x, next.depth, next.height];
  /* The look direction keeps its heading; the tilt is the new angle above the ground. */
  const run = Math.hypot(tx - px, ty - py) || 1;
  const heading = run > 1e-6 ? [(tx - px) / run, (ty - py) / run] : [0, 1];
  const reach = Math.max(1, Math.hypot(run, tz - pz));
  const tilt = (next.tilt * Math.PI) / 180;
  const target: AstraVector3 = [position[0] + heading[0] * reach * Math.cos(tilt), position[1] + heading[1] * reach * Math.cos(tilt), position[2] + reach * Math.sin(tilt)];
  return { ...scene, camera: { ...scene.camera, position, target } };
}
export const withLens = (scene: AstraScene, lens: number): AstraScene => ({ ...scene, camera: { ...scene.camera, focalLength: lens } });

/** The camera at the end of its move (a push goes toward what it looks at, a pull away from it). Hold: where it started. */
export function moveEnd(scene: AstraScene, move: Move): AstraScene["camera"] {
  const { position, target } = scene.camera;
  if (move.kind === "hold" || move.meters <= 0) return scene.camera;
  const d = [target[0] - position[0], target[1] - position[1], target[2] - position[2]];
  const len = Math.hypot(d[0], d[1], d[2]) || 1;
  const s = (move.kind === "push" ? 1 : -1) * Math.min(move.meters, move.kind === "push" ? Math.max(0, len - 0.5) : move.meters) / len;
  const shift: AstraVector3 = [d[0] * s, d[1] * s, d[2] * s];
  return { ...scene.camera, position: [position[0] + shift[0], position[1] + shift[1], position[2] + shift[2]], target: [target[0] + shift[0], target[1] + shift[1], target[2] + shift[2]] };
}
/** The camera `t` (0 to 1) of the way along its move. */
export function moveAt(scene: AstraScene, move: Move, t: number): AstraScene["camera"] {
  const end = moveEnd(scene, move), a = scene.camera, k = Math.min(1, Math.max(0, t));
  const mix = (p: AstraVector3, q: AstraVector3): AstraVector3 => [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k, p[2] + (q[2] - p[2]) * k];
  return { ...a, position: mix(a.position, end.position), target: mix(a.target, end.target) };
}

/** "Slow push · 1.2 m", "Held", "Pull back · 2 m". */
export function moveWords(move: Move): string {
  if (move.kind === "hold" || move.meters <= 0) return "Held";
  return `${move.kind === "push" ? "Slow push" : "Pull back"} · ${round(move.meters)} m`;
}

/* ── A scene to start from, drawn from the shot ──────────────────────────────────── */

const SIZE_FOR_FRAMING: [RegExp, number][] = [[/extreme|establish/i, 14], [/wide|long/i, 9], [/medium|mid/i, 5.5], [/close|detail|insert|macro/i, 3]];
const nearestLens = (n: number): Lens => LENSES.reduce((best, l) => (Math.abs(l - n) < Math.abs(best - n) ? l : best), LENSES[1]);

/** The beat-sheet shot a Rig shot card was built from, with the scene's cast, places and props. */
export function shotSource(project: Project, nodeId: string): { shot: BeatShot; characters: string[]; locations: string[]; props: string[] } | null {
  const node = project.nodes.find((n) => n.id === nodeId);
  const found = node?.boardShotId ? boardShots(project.production?.beats).find((s) => s.id === node.boardShotId) : undefined;
  return found ? { shot: found.shot, characters: found.characters, locations: found.locations, props: [...new Set(project.production?.beats?.scenes.find((s) => s.shots.some((x) => x.id === found.id))?.props ?? [])] } : null;
}

/**
 * The scene "Add from Shot N" makes: a figure for each character in the shot's scene, a prop for each prop, a ground for the place,
 * a sun, and a camera from the shot's framing and lens words ("Close-up · 85mm"), with the move its words describe. Only what the
 * production already says: no name is made up, and a shot with no beat sheet gets an empty ground and a default camera.
 */
export function sceneFromShot(project: Project, nodeId: string): { scene: AstraScene; move: Move } {
  const source = shotSource(project, nodeId);
  const text = `${source?.shot.framing ?? ""} ${source?.shot.movement ?? ""}`;
  const lens = nearestLens(Number(/(\d{2,3})\s?mm/i.exec(text)?.[1]) || 35);
  const distance = SIZE_FOR_FRAMING.find(([re]) => re.test(source?.shot.framing ?? ""))?.[1] ?? 6;
  let scene: AstraScene = {
    schemaVersion: 1, name: "Shot blocking", objects: [], lights: [{ id: "sun", name: "Sun", type: "sun", position: [4, -4, 6], rotation: [40, 0, 30], color: "#fff1d6", power: 3, size: 0.1 }],
    camera: { position: [0, -distance, 1.6], target: [0, 0, 1.3], focalLength: lens },
    world: { color: "#23262c", strength: 0.6 }, timeline: { start: 1, end: 120, fps: 24 }, render: { width: 1280, height: 720, samples: 32, transparent: false },
  };
  const ground = base("set-1", cleanName(source?.locations.find((l) => cleanName(l))) || "Ground", "plane", [0, 0, 0], [40, 40, 1], "#4a4d56");
  scene = { ...scene, objects: [ground] };
  for (const name of (source?.characters ?? []).slice(0, 4)) scene = addFigure(scene, name);
  for (const name of (source?.props ?? []).slice(0, 6)) scene = addProp(scene, name);
  const seconds = Math.min(600, Math.max(0.5, source?.shot.duration ?? 5));
  const kind: MoveKind = /\bpush|dolly in|move in/i.test(text) ? "push" : /\bpull|dolly out|move out/i.test(text) ? "pull" : "hold";
  return { scene, move: { kind, meters: kind === "hold" ? 0 : 1.2, seconds } };
}

/* ── Saving a frame to the shot ──────────────────────────────────────────────────── */

/** The category a saved blocking frame is filed under, so its inputs can be told from a person's own. */
export const BLOCKING_CATEGORY = "3D blocking";
const isBlockingInput = (project: Project, node: Project["nodes"][number]) =>
  node.type === "media" && [...project.assets, ...(project.sharedAssets ?? [])].some((a) => a.id === node.assetId && a.category === BLOCKING_CATEGORY);

/** The blocking-frame inputs linked into a shot that are not its current frame, and used by no other card: what a second save, or two windows saving at once, leaves behind. */
function staleInputs(project: Project, nodeId: string, currentAssetId: string | undefined): string[] {
  const shot = project.nodes.find((n) => n.id === nodeId);
  if (!shot) return [];
  return project.nodes
    .filter((n) => shot.linked.includes(n.id) && isBlockingInput(project, n) && n.assetId !== currentAssetId && !project.nodes.some((o) => o.id !== nodeId && o.linked.includes(n.id)))
    .map((n) => n.id);
}
const without = (project: Project, gone: Set<string>): Project => ({
  ...project,
  nodes: project.nodes.filter((n) => !gone.has(n.id)).map((n) => (n.linked.some((id) => gone.has(id)) ? { ...n, linked: n.linked.filter((id) => !gone.has(id)), ...(n.activeInput && gone.has(n.activeInput) ? { activeInput: undefined } : {}) } : n)),
});

/** Whether a shot has blocking-frame inputs besides its current one (two windows saved at once): the board tidies them away. */
export const hasStaleBlockingInputs = (project: Project, nodeId: string): boolean => staleInputs(project, nodeId, blockingOf(project, nodeId)?.frameAssetId).length > 0;
/** The project without those extra inputs; the same project when there are none. */
export function tidyBlockingInputs(project: Project, nodeId: string): Project {
  const stale = staleInputs(project, nodeId, blockingOf(project, nodeId)?.frameAssetId);
  return stale.length ? without(project, new Set(stale)) : project;
}

/** Plain words for the first thing wrong with a record, never the raw validator text. */
function blockingProblem(issue: { path: PropertyKey[]; message: string } | undefined): string {
  if (!issue) return "This 3D blocking could not be saved.";
  if (issue.message === BLOCKING_TOO_MANY) return issue.message;
  const key = typeof issue.path[0] === "string" ? issue.path[0] : "";
  if (key && issue.path.length === 1) return `This shot cannot hold 3D blocking: ${issue.message.replace(/\.$/, "")}. Nothing was saved.`;
  return "This 3D blocking is not valid, so it was not saved. Nothing was changed.";
}

/**
 * The project once a frame is saved to a shot: the entry kept under the shot, the frame filed as an asset and linked into the shot as an
 * input (rig-build's addInput, as a Library file dropped on a shot is), and any input an earlier save made taken out, so a shot has one
 * blocking frame. Entries for shots that are no longer in the project are dropped as it saves. The whole record is checked with the
 * same schema the server saves with BEFORE it is applied: a record the server would refuse is refused here in words and the project is
 * left exactly as it was, so a later autosave is never held up by it.
 * Throws RigBuildError (a locked or missing shot, or a record that would not save): the caller shows its words.
 */
export function withBlockingFrame(project: Project, nodeId: string, entry: Omit<BlockingEntry, "frameAssetId">, asset: Asset, title: string): Project {
  const cleaned = cleanName(title) || "3D blocking";
  const cleared = without(project, new Set(staleInputs(project, nodeId, undefined)));
  const next = addInput(cleared, nodeId, { ...asset, name: cleanName(asset.name) || cleaned }, cleaned);
  const live = new Set(next.nodes.map((n) => n.id));
  const kept = Object.fromEntries(Object.entries((next.production?.blocking as Blocking | undefined) ?? {}).filter(([id]) => live.has(id)));
  const blocking: Blocking = { ...kept, [nodeId]: { ...entry, frameAssetId: asset.id } };
  const checked = blockingSchema.safeParse(blocking);
  if (!checked.success) throw new RigBuildError(blockingProblem(checked.error.issues[0]));
  return { ...next, production: { ...next.production, blocking } };
}
