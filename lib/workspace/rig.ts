import { MODELS } from "../models";
import type { MediaJob } from "../workbench/job-recovery";
import { mediaQuoteReferences } from "../workbench/media-reference-input";
import { NODE_DEFS, createNode, generationReferenceIds, nodeHeight, resolveAsset } from "../workbench/node-graph";
import type { Asset, CanvasNode, Project } from "../workbench/studio";
import { engineLabel, type ShotSettings } from "./engines";
import { isShotNode, jobUnbilled, liveJob, ShotPatchError } from "./shots";
import { vendorNameIn } from "./vendor-names";

/**
 * Pure helpers behind the workspace Rig: adding a shot, what feeds it, its
 * versions, its preview, the generation phase of its job, and the dispatch
 * gate. Everything here is derived from the draft and the real job list.
 */

/* ── Adding a shot ────────────────────────────────────────────────────── */

/** Same ceiling the graph's duplicate uses. */
export const NODE_LIMIT = 250;
const GAP = 40;

/**
 * A new scene node appended to the draft, placed below everything already on
 * the graph so it never lands on another node. It is an ordinary graph node
 * (createNode), saved through the same revision-checked draft save.
 */
export function addShotNode(project: Project): { project: Project; id: string } {
  if (project.nodes.length >= NODE_LIMIT) throw new ShotPatchError("This project has reached its node limit.");
  const index = project.nodes.filter(isShotNode).length;
  const bottom = project.nodes.reduce((max, n) => Math.max(max, n.y + nodeHeight(n)), Number.NEGATIVE_INFINITY);
  const left = project.nodes.length ? Math.min(...project.nodes.map((n) => n.x)) : 100;
  const position = project.nodes.length ? { x: left, y: bottom + GAP } : { x: 100, y: 100 };
  const node: CanvasNode = { ...createNode("scene", index, position), mode: "Video" };
  return { project: { ...project, nodes: [...project.nodes, node] }, id: node.id };
}

/* ── What feeds a shot ───────────────────────────────────────────────── */

const allNodes = (project: Project) => {
  const own = new Set(project.nodes.map((n) => n.id));
  return [...project.nodes, ...(project.sharedNodes ?? []).filter((n) => !own.has(n.id))];
};
const allAssets = (project: Project) => [...project.assets, ...(project.sharedAssets ?? [])];

export type InputRow = { id: string; name: string; kind: string; version: string; asset: Asset | null };

/** The shot's connected inputs, resolved through the graph (the Inspector's Inputs tab). */
export function shotInputs(project: Project, shotId: string): InputRow[] {
  const nodes = allNodes(project), assets = allAssets(project);
  const node = project.nodes.find((n) => n.id === shotId);
  if (!node) return [];
  return node.linked.flatMap((id) => {
    const input = nodes.find((n) => n.id === id);
    if (!input) return [];
    const asset = resolveAsset(input, nodes, assets) ?? null;
    return [{ id: input.id, name: input.title, kind: NODE_DEFS[input.type].label, version: asset ? `v${asset.version}` : "—", asset }];
  });
}

/** Image and video references bound to the shot, exactly as the Rig's Generate take collects them. */
export function shotReferenceAssets(project: Project, node: CanvasNode): Asset[] {
  const assets = allAssets(project);
  return generationReferenceIds(node, project)
    .map((id) => assets.find((a) => a.id === id))
    .filter((a): a is Asset => !!a && (a.kind === "image" || a.kind === "video"));
}

/** The GET /api/workbench/engines query GenerationDialog prices a node with, references included. */
export function dispatchQuoteQuery(settings: ShotSettings, refs: Asset[]): string {
  const query = new URLSearchParams({ model: settings.engine, resolution: settings.resolution, ratio: settings.ratio, duration: String(settings.durationS ?? 5) });
  const references = mediaQuoteReferences(refs);
  return query.toString() + (references ? "&" + references : "");
}

/** Role of a bound reference when no first frame is chosen (GenerationDialog's default). */
export const referenceRole = (asset: Pick<Asset, "kind">) => (asset.kind === "video" ? "reference_video" : "reference_image");

/* ── Takes and versions ──────────────────────────────────────────────── */

const visual = (a: Asset) => a.kind === "image" || a.kind === "video";

/** What the Inspector previews: the take on the node, else the newest take filed for it. */
export function shotPreviewAsset(project: Project, shotId: string): Asset | null {
  const node = project.nodes.find((n) => n.id === shotId);
  if (!node) return null;
  const current = project.assets.find((a) => a.id === node.assetId);
  if (current && visual(current)) return current;
  return project.assets.filter((a) => a.nodeId === shotId && visual(a)).sort((a, b) => b.version - a.version)[0] ?? null;
}

export type VersionState = "rendered" | "rendering" | "failed";
export type VersionRow = { id: string; v: string; label: string; meta: string; current: boolean; state: VersionState };

export function relativeAge(at: number | null | undefined, now: number): string {
  if (!at) return "";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hr`;
  return `${Math.round(h / 24)} d`;
}

/**
 * Every version of a shot: takes filed in the draft plus jobs that have not
 * produced one (in flight or failed). Newest first; the take on the node is
 * current. Failed renders are shown as not billed when nothing was charged.
 */
export function shotVersions(project: Project, shotId: string, jobs: readonly MediaJob[], now = Date.now()): VersionRow[] {
  const node = project.nodes.find((n) => n.id === shotId);
  if (!node) return [];
  const productionShot = project.shotMappings?.[shotId];
  const own = productionShot ? jobs.filter((j) => j.shotId === productionShot) : [];
  const byId = new Map(own.map((j) => [j.id, j] as const));
  const rows: (VersionRow & { order: number; at: number })[] = [];
  const filed = project.assets.filter((a) => a.nodeId === shotId && a.generationId && visual(a));
  for (const asset of filed) {
    const job = byId.get(asset.generationId!);
    rows.push({ id: asset.id, v: `v${asset.version}`, label: [node.assetId === asset.id ? "Current" : "Take", engineLabel(asset.description || job?.model).long].join(" · "),
      meta: relativeAge(job?.createdAt, now), current: node.assetId === asset.id, state: "rendered", order: asset.version, at: job?.createdAt ?? 0 });
  }
  const seen = new Set(filed.map((a) => a.generationId));
  for (const job of own) {
    if (seen.has(job.id) || job.kind === "audio") continue;
    const failed = job.status === "failed" || job.status === "cancelled";
    const state: VersionState = job.status === "succeeded" ? "rendered" : failed ? "failed" : "rendering";
    const label = state === "failed" ? (jobUnbilled(job) ? "Failed · not billed" : "Failed")
      : state === "rendering" ? (job.status === "held" ? "Held for approval" : liveJob(job) && job.status === "queued" ? "Queued" : "Rendering")
      : `Rendered · ${engineLabel(job.model).long}`;
    rows.push({ id: job.id, v: `v${job.version ?? 1}`, label, meta: relativeAge(job.createdAt, now), current: false, state, order: job.version ?? 1, at: job.createdAt ?? 0 });
  }
  return rows.sort((a, b) => b.order - a.order || b.at - a.at)
    .map((r): VersionRow => ({ id: r.id, v: r.v, label: r.label, meta: r.meta, current: r.current, state: r.state }));
}

/* ── Generation phase ────────────────────────────────────────────────── */

export type GenerationTone = "blue" | "green" | "red";
export type GenerationPhase = { label: string; pct: number; tone: GenerationTone; done: boolean };

/**
 * The strip's state from the real job: submitting → queued/held → rendering
 * → complete, or failed (not billed when nothing was charged). The bar marks
 * the stage reached; engines report no percentage, so none is invented.
 */
export function generationPhase(job: Pick<MediaJob, "status" | "creditsBilled"> | null): GenerationPhase {
  if (!job) return { label: "Submitting", pct: 4, tone: "blue", done: false };
  switch (job.status) {
    case "succeeded": return { label: "Complete", pct: 100, tone: "green", done: true };
    case "failed":
    case "cancelled": return { label: jobUnbilled({ id: "", status: job.status, creditsBilled: job.creditsBilled }) ? "Failed · not billed" : "Failed", pct: 100, tone: "red", done: true };
    case "running": return { label: "Rendering", pct: 50, tone: "blue", done: false };
    case "held": return { label: "Held for approval", pct: 10, tone: "blue", done: false };
    default: return { label: "Queued", pct: 10, tone: "blue", done: false };
  }
}

/* ── Duration and the dispatch gate ──────────────────────────────────── */

/** The previous or next second the engine lists, from the current value. */
export function stepDuration(durations: readonly number[], current: number | undefined, direction: -1 | 1): number | undefined {
  const list = [...durations].sort((a, b) => a - b);
  if (!list.length) return undefined;
  if (current == null) return list[0];
  if (direction > 0) return list.find((d) => d > current) ?? list[list.length - 1];
  return [...list].reverse().find((d) => d < current) ?? list[0];
}

export type DispatchGate = { ok: true } | { ok: false; credits: number; reason: string };

/**
 * The price on the button is what the person approves. If the fresh quote
 * taken at submit differs from it, nothing is sent: the button shows the new
 * figure and must be pressed again.
 */
export function dispatchGate(shown: number | null, fresh: number): DispatchGate {
  if (shown !== null && shown === fresh) return { ok: true };
  return { ok: false, credits: fresh, reason: `The price is now ${fresh.toLocaleString("en-US")} cr. Press Generate again to approve it.` };
}

/* ── Copy ─────────────────────────────────────────────────────────────── */

const LABELS = MODELS.map((m) => [m.label, engineLabel(m.id).long] as const).sort((a, b) => b[0].length - a[0].length);

/**
 * Server and validation messages can name an engine by its vendor label.
 * Engine labels are swapped for their neutral names; anything still naming a
 * vendor falls back to a neutral sentence (workspace brief, decision 5).
 */
export function neutralCopy(message: string, fallback = "The engine could not take this request. Nothing was charged."): string {
  let text = message;
  for (const [label, neutral] of LABELS) text = text.split(label).join(neutral);
  return vendorNameIn(text) ? fallback : text;
}
