import { SHOT_NODE_TYPES, uid, type CanvasNode, type NodeOperation, type Project, type ShotFields } from "../workbench/studio";
import { NODE_DEFS, resolveAsset } from "../workbench/node-graph";
import { shotEngine, clampShotSeconds, defaultShotRatio, defaultShotResolution, resolveShotSettings } from "./engines";
import { shotEstimateKey } from "./cost";

/**
 * The Rig's shot list, derived from the draft graph (Project.nodes).
 *
 * WHICH NODES ARE SHOTS: the graph's Create family in NODE_DEFS — `scene`
 * ("Bring the cast, world and direction into a shot") and `generate` (image
 * and motion prompts with bound references). Those are the only node types
 * that render; references (brief, look board, character, element, media),
 * finishing operators and flow nodes feed or follow a shot but are not one.
 *
 * ORDER: draft order (the order of Project.nodes), which is creation order
 * and stays stable across graph moves. Graph position is layout, not
 * sequence, so it is deliberately ignored.
 */

export type RigShotStatus = "approved" | "queued" | "ready" | "failed" | "draft";

/** The fields of a production job (GET /api/jobs → Generation / MediaJob) this module reads. */
export type RigJob = {
  id: string;
  status: string;
  shotId?: string | null;
  createdAt?: number | null;
  creditsBilled?: number | null;
  costUsd?: number | null;
};

export type RigShot = {
  id: string;
  /** 1-based position in the list; the page zero-pads it. */
  index: number;
  name: string;
  /** The direction note (the node's direction operation). */
  note: string;
  role: string;
  /** Display name of the look: a look board's title when `look` names one, else the text. */
  look: string;
  /** The look board node id when the look references one. */
  lookNodeId: string | null;
  /** The catalogue model id this shot renders with (stored, else the default engine). */
  engine: string;
  durationS: number | undefined;
  ratio: string;
  resolution: string;
  status: RigShotStatus;
  nodeType: CanvasNode["type"];
  /** Set when the last job failed and nothing was billed for it. */
  failedUnbilled?: true;
  /** The most recent job for this shot, if any. */
  lastJobId: string | null;
  /** Key into the estimate cache (lib/workspace/cost.ts); same key the hook uses. */
  estimateKey: string | null;
  /** Why the shot is not ready, in plain words. Empty when every input resolves. */
  issues: string[];
};

export type RigShotOptions = {
  /**
   * Live credit quotes keyed by `shotEstimateKey`. A shot is only `ready`
   * when its key has a positive credit figure here: unpriced means not ready.
   */
  quotes?: Record<string, number | null | undefined>;
};

const LIVE_DONE = new Set(["succeeded", "failed", "cancelled"]);
/** Queued, running, held (awaiting approval) — anything not settled. */
export const liveJob = (job: RigJob) => !LIVE_DONE.has(job.status);
export const jobUnbilled = (job: RigJob) => !((job.creditsBilled ?? 0) > 0) && !((job.costUsd ?? 0) > 0);

export function isShotNode(node: CanvasNode): boolean {
  return (SHOT_NODE_TYPES as readonly string[]).includes(node.type);
}

function directionOp(node: CanvasNode): NodeOperation | undefined {
  return node.operations?.find((op) => op.kind === "direction");
}

/** The direction note: the node's direction operation, else its text. */
export function shotNote(node: CanvasNode): string {
  const note = directionOp(node)?.values.note;
  if (typeof note === "string" && note.trim()) return note.trim();
  return (node.text ?? "").trim();
}

function allNodes(project: Project): CanvasNode[] {
  const own = new Set(project.nodes.map((n) => n.id));
  return [...project.nodes, ...(project.sharedNodes ?? []).filter((n) => !own.has(n.id))];
}

function lookOf(node: CanvasNode, nodes: CanvasNode[]): { look: string; lookNodeId: string | null; missing: boolean } {
  const value = (node.look ?? "").trim();
  if (!value) return { look: "", lookNodeId: null, missing: false };
  const board = nodes.find((n) => n.id === value);
  if (board) return { look: board.title, lookNodeId: board.id, missing: board.type !== "moodboard" };
  /* Looks like a node id but the node is gone: a dangling reference, not a name. */
  if (/^node-[a-z0-9]{8}$/i.test(value)) return { look: "", lookNodeId: value, missing: true };
  return { look: value, lookNodeId: null, missing: false };
}

function inputIssues(node: CanvasNode, project: Project, nodes: CanvasNode[]): string[] {
  const issues: string[] = [];
  const assets = [...project.assets, ...(project.sharedAssets ?? [])];
  for (const id of node.linked) {
    const input = nodes.find((n) => n.id === id);
    if (!input) { issues.push("A connected input no longer exists."); continue; }
    if (input.bypassed) continue;
    const text = NODE_DEFS[input.type].shape === "text";
    if (text ? !(input.text ?? "").trim() && !shotNote(input) : !resolveAsset(input, nodes, assets))
      issues.push(`${input.title} has nothing attached yet.`);
  }
  return issues;
}

/** Derive the Rig shot list. Pure: same draft, jobs and quotes → same list. */
export function rigShots(project: Project, jobs: readonly RigJob[] = [], options: RigShotOptions = {}): RigShot[] {
  const nodes = allNodes(project);
  const mapping = project.shotMappings ?? {};
  return project.nodes.filter(isShotNode).map((node, i) => {
    const issues: string[] = [];
    const settings = resolveShotSettings(node, project.aspect);
    if (!settings) issues.push("This shot's engine is no longer available. Choose another engine.");
    const look = lookOf(node, nodes);
    if (look.missing) issues.push("The look board this shot cites is no longer in the project.");
    const note = shotNote(node);
    if (!note) issues.push("Add a direction note.");
    issues.push(...inputIssues(node, project, nodes));
    const key = settings ? shotEstimateKey(settings) : null;
    const credits = key ? options.quotes?.[key] : undefined;
    if (settings && !(typeof credits === "number" && credits > 0)) issues.push("Not priced yet.");

    const productionShot = mapping[node.id];
    const own = productionShot ? jobs.filter((job) => job.shotId === productionShot) : [];
    const last = own.reduce<RigJob | null>((a, b) => (!a || (b.createdAt ?? 0) >= (a.createdAt ?? 0) ? b : a), null);
    const failed = !!last && (last.status === "failed" || last.status === "cancelled");
    const status: RigShotStatus = node.status === "approved" ? "approved"
      : own.some(liveJob) ? "queued"
      : failed ? "failed"
      : issues.length === 0 ? "ready"
      : "draft";
    return {
      id: node.id,
      index: i + 1,
      name: node.title,
      note,
      role: node.role || NODE_DEFS[node.type].role,
      look: look.look,
      lookNodeId: look.lookNodeId,
      engine: settings?.engine ?? node.engine ?? "",
      durationS: settings ? settings.durationS : node.durationS,
      ratio: settings?.ratio ?? node.ratio ?? "",
      resolution: settings?.resolution ?? node.resolution ?? "",
      status,
      nodeType: node.type,
      ...(status === "failed" && jobUnbilled(last!) ? { failedUnbilled: true as const } : {}),
      lastJobId: last?.id ?? null,
      estimateKey: key,
      issues,
    };
  });
}

/** "6 shots · 1 approved" — counted from the list, never stored. */
export function rigSubtitle(shots: readonly { status?: string }[]): string {
  const n = shots.length, approved = shots.filter((s) => s.status === "approved").length;
  return `${n.toLocaleString("en-US")} ${n === 1 ? "shot" : "shots"} · ${approved.toLocaleString("en-US")} approved`;
}

export type ShotPatch = {
  name?: string;
  note?: string;
  role?: string;
  /** A look name or look board node id; empty string clears it. */
  look?: string;
  engine?: string;
  durationS?: number;
  ratio?: string;
  resolution?: string;
};

export class ShotPatchError extends Error {
  constructor(message: string) { super(message); this.name = "ShotPatchError"; }
}

const OPERATION_LIMIT = 20;

/**
 * Apply a Rig edit to the draft and return the new draft (the input is not
 * mutated). The result goes through the ordinary draft save
 * (PUT /api/workbench/projects), so it is revision-checked like any edit.
 *
 * Engine changes re-fit duration, ratio and resolution to the new engine;
 * a duration is always clamped to the engine's catalogue range.
 */
export function shotPatch(project: Project, id: string, patch: ShotPatch): Project {
  const node = project.nodes.find((n) => n.id === id);
  if (!node || !isShotNode(node)) throw new ShotPatchError("Choose a shot in this project.");
  if (node.locked) throw new ShotPatchError("Unlock this shot before changing it.");
  const next: CanvasNode = { ...node };

  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new ShotPatchError("A shot needs a name.");
    if (name.length > 300) throw new ShotPatchError("Keep the shot name under 300 characters.");
    next.title = name;
  }
  if (patch.role !== undefined) {
    const role = patch.role.trim();
    if (role.length > 100) throw new ShotPatchError("Keep the department under 100 characters.");
    next.role = role || NODE_DEFS[node.type].role;
  }
  if (patch.note !== undefined) {
    if (patch.note.length > 5000) throw new ShotPatchError("Keep the direction note under 5,000 characters.");
    const ops = node.operations ?? [];
    const at = ops.findIndex((op) => op.kind === "direction");
    if (at >= 0) next.operations = ops.map((op, i) => (i === at ? { ...op, values: { ...op.values, note: patch.note! } } : op));
    else {
      if (ops.length >= OPERATION_LIMIT) throw new ShotPatchError("This shot has reached its tool limit.");
      next.operations = [...ops, { id: uid("op"), kind: "direction", enabled: true, values: { note: patch.note } }];
    }
  }
  if (patch.look !== undefined) {
    const look = patch.look.trim();
    if (look.length > 300) throw new ShotPatchError("Keep the look name under 300 characters.");
    if (look) next.look = look; else delete next.look;
  }

  const engineId = patch.engine ?? node.engine;
  if (patch.engine !== undefined || patch.durationS !== undefined || patch.ratio !== undefined || patch.resolution !== undefined) {
    const model = shotEngine(engineId ?? resolveShotSettings({}, project.aspect)?.engine);
    if (!model) throw new ShotPatchError("Choose an available engine for this shot.");
    if (patch.engine !== undefined) next.engine = model.id;
    const fields: ShotFields = {};
    const ratio = patch.ratio ?? node.ratio;
    if (patch.ratio !== undefined && !model.ratios.includes(patch.ratio)) throw new ShotPatchError("This engine does not render that aspect ratio.");
    fields.ratio = ratio && model.ratios.includes(ratio) ? ratio : defaultShotRatio(model, project.aspect);
    const resolution = patch.resolution ?? node.resolution;
    if (patch.resolution !== undefined && !model.resolutions.includes(patch.resolution)) throw new ShotPatchError("This engine does not render that resolution.");
    fields.resolution = resolution && model.resolutions.includes(resolution) ? resolution : defaultShotResolution(model);
    if (patch.durationS !== undefined && !Number.isFinite(patch.durationS)) throw new ShotPatchError("Choose a duration in seconds.");
    fields.durationS = clampShotSeconds(model, patch.durationS ?? node.durationS);
    next.ratio = fields.ratio;
    next.resolution = fields.resolution;
    if (fields.durationS === undefined) delete next.durationS; else next.durationS = fields.durationS;
  }
  return { ...project, nodes: project.nodes.map((n) => (n.id === id ? next : n)) };
}
