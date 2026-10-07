import type { Generation } from "@/lib/jobs";
import { boardShots, type NumberedShot } from "@/lib/production/boards";
import { recreateBlock } from "@/lib/shell/recipe";
import { ACTIVE_STATES, type RigAgentRunView } from "@/lib/workbench/rig-agent-plan";
import { resolveAsset } from "@/lib/workbench/node-graph";
import type { CanvasNode, Project } from "@/lib/workbench/studio";
import type { TakeVerification } from "@/lib/workbench/verify";
import { VERIFY_CHECK_LABELS } from "@/lib/workbench/verify";
import { engineLabel } from "@/lib/workspace/engines";
import type { LibraryEntry } from "@/lib/workspace/library";
import { isShotNode } from "@/lib/workspace/shots";
import { takeChargeLine, takeReasonLine, type ReviewState, type TakeStatus } from "@/lib/workspace/takes";

/*
 * The board's Shots region (design/particl-graphite/README.md § 3.1, frames f and g), derived from today's data
 * and nothing else. Pure: no React, no fetch.
 *
 * - A shot is a Rig shot card (`scene` or `generate`) in draft order, the order lib/workspace/shots.ts uses.
 * - Its takes are the project library's generations filed on the card's production shot (`shotMappings`),
 *   v1…vn by the stored `version`. Nothing is ever dropped from the list: a rejected take stays a version.
 * - Words about money come from lib/workspace/takes.ts and lib/errors.ts. "Nothing billed" is said only when
 *   the ledger or the provider confirmed nothing was charged (`failedUnbilled`).
 * - A time estimate comes only from this workspace's own finished takes of the same engine and settings,
 *   and only while the take is still under that time (DECISIONS 20). Otherwise the bar is indeterminate.
 * - "Look anchor" and "follows shot 1" are said only when a take's request carried shot 1's take as a
 *   reference: the board never claims an anchor the work did not use.
 */

export type ShotVersion = {
  /** The library id, `generation:<id>`. */
  id: string;
  genId: string;
  version: number;
  /** "v2". */
  label: string;
  status: TakeStatus;
  stage: "queued" | "rendering" | "held" | null;
  media: "image" | "video" | "audio" | null;
  url: string | null;
  createdAt: number;
  /** "Seedance 2.5 · 1080p · 5 s". */
  engine: string;
  prompt: string;
  task: string;
  /** Why it failed or waits, in the library's words. */
  reason: string | null;
  /** What a failed take's charge came to, in the ledger's or its provider's words; null when unconfirmed. */
  charge: string | null;
  /** Confirmed: the ledger holds nothing for it, or its provider refunded or did not charge it. */
  nothingBilled: boolean;
  /** Recreate can hand its recipe to Make (a failed take's Retry). */
  retry: boolean;
  /** A take held for credits: what it needs to start. */
  needs: number | null;
  approvedBy: string | null;
  approvedAt: number | null;
  reviewBy: string | null;
  updatedAt: number;
  /** The takes its request cited as references (generation ids). */
  references: string[];
  /** The library entry, for the components that take one (ReleaseTake, LazyMedia). Plain data. */
  entry: LibraryEntry;
};

export type ShotTakes = {
  nodeId: string;
  /** 1-based, in production order. */
  index: number;
  productionShotId: string | null;
  /** "Shot 1 · Extreme wide". */
  title: string;
  /** "Medium, slow push": the shot's framing and camera, for the review card and review mode. */
  name: string;
  /** "1 · 0:00 · 4 s · Locked off". */
  line: string;
  /** Oldest first. */
  versions: ShotVersion[];
  /** The version the board shows for the shot (`shownVersion`). */
  shown: ShotVersion | null;
  /** The shot card's own picture (its storyboard frame or newest filed take), shown until a take of it has one. */
  frame: { url: string; kind: "image" | "video" } | null;
  /** The workspace's typical render time for the shown version's engine and settings, while it renders. */
  typicalMs: number | null;
  anchor: "anchor" | "follows" | null;
};

const FINISHED: ReadonlySet<TakeStatus> = new Set<TakeStatus>(["review", "picked", "approved", "changes"]);
export const isFinished = (v: Pick<ShotVersion, "status">) => FINISHED.has(v.status);
export const inFlight = (v: Pick<ShotVersion, "status">) => v.status === "rendering" || v.status === "held";
/** A take a person can judge: finished, with its picture (or sound) here to look at. */
export const judgeable = (v: Pick<ShotVersion, "status" | "url" | "media">) => isFinished(v) && Boolean(v.url) && v.media !== null;
/** Waits for a person: finished and not yet judged. */
export const needsReview = (v: Pick<ShotVersion, "status" | "url" | "media">) => (v.status === "review" || v.status === "picked") && judgeable(v);

/** The review trail's state for a take's status: what PATCH /api/jobs/:id `reviewState` writes back on Undo. */
export function reviewStateOf(status: TakeStatus): ReviewState {
  return status === "approved" ? "approved" : status === "picked" ? "picked" : status === "changes" ? "changes" : "";
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const seconds = (n: number) => `${Number.isInteger(n) ? n : Math.round(n * 10) / 10} s`;
/** "0:04". */
export const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** The engine's real name in the UI. Topaz's video upscale is "Topaz upscale" (docs/handoff-diff.md, where the repo wins, c). */
function engineName(model: string, kind: string): string {
  if (model === "topaz/upscale/video/creative") return "Topaz upscale";
  return engineLabel(model, kind).long;
}

/** "Seedance 2.5 · 1080p · 5 s", "Nano Banana Pro · 1K": what made it, from the request. */
export function engineLine(g: Pick<Generation, "model" | "kind" | "params" | "durationS">): string {
  const p = g.params ?? {};
  const resolution = str(p.resolution);
  const length = num(g.durationS) ?? num(p.duration);
  return [engineName(g.model, g.kind), resolution, g.kind === "video" || g.kind === "audio" ? (length != null && length > 0 ? seconds(length) : "") : ""].filter(Boolean).join(" · ");
}

/** The generation ids a take's request cited (params.references, as admission stores them). */
export function referencedTakes(params: Record<string, unknown> | null | undefined): string[] {
  const refs = params?.references;
  if (!Array.isArray(refs)) return [];
  return refs.flatMap((r) => (r && typeof r === "object" && typeof (r as { genId?: unknown }).genId === "string" ? [(r as { genId: string }).genId] : []));
}

export function shotVersion(entry: LibraryEntry): ShotVersion | null {
  if (entry.asset.origin !== "generation") return null;
  const g = entry.asset.value;
  const t = entry.take;
  return {
    id: t.id, genId: g.id, version: g.version, label: `v${g.version}`, status: t.status, stage: t.stage ?? null,
    media: entry.media, url: entry.url, createdAt: g.createdAt, engine: engineLine(g), prompt: g.prompt ?? "", task: g.task || str(g.params?.task) || "generate",
    reason: takeReasonLine(t), charge: takeChargeLine(t), nothingBilled: t.failedUnbilled === true,
    retry: t.status === "failed" && !t.cancelled && recreateBlock(g) === null,
    needs: t.status === "held" ? t.needs ?? null : null,
    approvedBy: g.approvedBy ?? null, approvedAt: g.approvedAt ?? null, reviewBy: g.reviewBy ?? null, updatedAt: g.updatedAt,
    references: referencedTakes(g.params), entry,
  };
}

/**
 * The version the board shows for a shot: the newest when it is still in flight (its progress is the news);
 * else the newest that waits for a person; else the approved one; else the newest.
 */
export function shownVersion(versions: readonly ShotVersion[]): ShotVersion | null {
  if (!versions.length) return null;
  const newest = versions[versions.length - 1];
  if (inFlight(newest)) return newest;
  const waiting = [...versions].reverse().find(needsReview);
  if (waiting) return waiting;
  const approved = [...versions].reverse().find((v) => v.status === "approved");
  return approved ?? newest;
}

/* ── Time: only from this workspace's own past renders ──────────────────── */

/** At least this many finished takes of the same engine and settings before anything is estimated. */
export const ESTIMATE_SAMPLES = 3;
const ESTIMATE_WINDOW = 20;

/** The settings a render's time depends on: kind, engine, task, length and resolution as requested. */
export function renderKey(g: Pick<Generation, "kind" | "model" | "task" | "params">): string {
  const p = g.params ?? {};
  return [g.kind, g.model, g.task || str(p.task) || "generate", num(p.duration) ?? "", str(p.resolution)].join("|");
}

/**
 * The median submit-to-delivery time (`durationMs`) of the newest finished takes with the same key, or null
 * when fewer than ESTIMATE_SAMPLES exist: no figure is made up from too little.
 */
export function typicalRenderMs(key: string, library: readonly LibraryEntry[]): number | null {
  const times = library
    .flatMap((e) => (e.asset.origin === "generation" ? [e.asset.value] : []))
    .filter((g) => g.status === "succeeded" && (g.durationMs ?? 0) > 0 && renderKey(g) === key)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, ESTIMATE_WINDOW)
    .map((g) => g.durationMs as number)
    .sort((a, b) => a - b);
  if (times.length < ESTIMATE_SAMPLES) return null;
  const mid = Math.floor(times.length / 2);
  return times.length % 2 ? times[mid] : Math.round((times[mid - 1] + times[mid]) / 2);
}

export type RenderEstimate = { fraction: number; minutesLeft: number };
/** The bar never reads done before the take is: a cap under 100 %. */
export const ESTIMATE_CAP = 0.95;

/**
 * How far along a render probably is and about how long is left, from its start and the typical time. Null
 * (an indeterminate bar, no words) without a typical time, and once the render has run past it: past the
 * usual time there is nothing honest to say.
 */
export function renderEstimate(startedAt: number, typicalMs: number | null, now: number): RenderEstimate | null {
  if (!typicalMs || typicalMs <= 0 || !Number.isFinite(startedAt)) return null;
  const elapsed = Math.max(0, now - startedAt);
  if (elapsed >= typicalMs) return null;
  return { fraction: Math.min(ESTIMATE_CAP, elapsed / typicalMs), minutesLeft: Math.max(1, Math.ceil((typicalMs - elapsed) / 60_000)) };
}

/** "about 2 min left". */
export const estimateWords = (e: RenderEstimate) => `about ${e.minutesLeft} min left`;

/* ── The shots ───────────────────────────────────────────────────────────── */

const lowerFirst = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

function beatShotOf(node: CanvasNode, beats: ReadonlyMap<string, NumberedShot>): NumberedShot | null {
  return node.boardShotId ? beats.get(node.boardShotId) ?? null : null;
}

/** The Rig shot cards of a project in draft order, each with its takes. */
type ShotSource = Pick<Project, "nodes" | "shotMappings" | "production"> & Partial<Pick<Project, "assets" | "sharedAssets">>;

function frameOf(node: CanvasNode, project: ShotSource): ShotTakes["frame"] {
  const asset = resolveAsset(node, project.nodes, [...(project.assets ?? []), ...(project.sharedAssets ?? [])]);
  return asset?.url && (asset.kind === "image" || asset.kind === "video") ? { url: asset.url, kind: asset.kind } : null;
}

export function shotTakes(project: ShotSource, library: readonly LibraryEntry[]): ShotTakes[] {
  const beats = new Map(boardShots(project.production?.beats).map((s) => [s.id, s] as const));
  const mapping = project.shotMappings ?? {};
  const byShot = new Map<string, ShotVersion[]>();
  for (const entry of library) {
    const v = shotVersion(entry);
    const shotId = entry.asset.origin === "generation" ? entry.asset.value.shotId : null;
    if (!v || !shotId || entry.asset.origin !== "generation" || entry.asset.value.kind === "model") continue;
    const list = byShot.get(shotId) ?? [];
    list.push(v);
    byShot.set(shotId, list);
  }
  let start: number | null = 0;
  const rows = project.nodes.filter(isShotNode).map((node, i): ShotTakes => {
    const beat = beatShotOf(node, beats);
    const framing = (beat?.shot.framing ?? "").trim();
    const movement = (beat?.shot.movement ?? "").trim();
    const length = num(beat?.shot.duration) ?? num(node.durationS);
    const label = framing || node.title.trim() || `Shot ${i + 1}`;
    const line = [String(i + 1), start != null ? clock(start) : "", length != null && length > 0 ? seconds(length) : "", movement].filter(Boolean).join(" · ");
    start = start != null && length != null && length > 0 ? start + length : null;
    const productionShotId = mapping[node.id] ?? null;
    const versions = (productionShotId ? byShot.get(productionShotId) ?? [] : []).sort((a, b) => a.version - b.version || a.createdAt - b.createdAt);
    const shown = shownVersion(versions);
    const rendering = shown && shown.status === "rendering" && shown.stage === "rendering" && shown.entry.asset.origin === "generation"
      ? typicalRenderMs(renderKey(shown.entry.asset.value), library) : null;
    return {
      nodeId: node.id, index: i + 1, productionShotId, title: `Shot ${i + 1} · ${label}`,
      name: framing ? [framing, lowerFirst(movement)].filter(Boolean).join(", ") : label,
      line, versions, shown, frame: frameOf(node, project), typicalMs: rendering, anchor: null,
    };
  });
  return withAnchors(rows);
}

/** Shot 1 is the look anchor only when another shot's shown take was made with one of its takes as a reference. */
export function withAnchors(rows: ShotTakes[]): ShotTakes[] {
  if (rows.length < 2) return rows;
  const first = new Set(rows[0].versions.map((v) => v.genId));
  const follows = rows.map((row, i) => i > 0 && Boolean(row.shown?.references.some((id) => first.has(id))));
  if (!follows.some(Boolean)) return rows;
  return rows.map((row, i) => ({ ...row, anchor: i === 0 ? "anchor" : follows[i] ? "follows" : null }));
}

/** Stream 4's storyboard group gives way to the Shots group once a shot has a take, or a Board run's render is on its way. */
export function shotsTakeOver(rows: readonly ShotTakes[], run: Pick<RigAgentRunView, "paid"> | null | undefined): boolean {
  if (rows.some((r) => r.versions.length > 0)) return true;
  return Boolean(run?.paid.some((s) => s.tool === "render" && ["approved", "sending", "rendering"].includes(s.state)));
}

/* ── The Shots group's header ─────────────────────────────────────────────── */

export type ShotsHeader = {
  /** "Shots · rendering 1 of 3", "Shots · 2 of 3 approved", "Shots · stopped". */
  title: string;
  /** The run Stop stops, when a Board run is working on these shots. */
  stopRunId: string | null;
  /** A stopped run's charge: "N cr spent" is said with it. */
  spent: number | null;
  /** True while something renders: the cost line reads "so far". */
  live: boolean;
  /** The rail's one-line summary. */
  summary: string;
};

const STOPPABLE = new Set(["running", "paused", "needs_you"]);

export function shotsHeader(rows: readonly ShotTakes[], run: RigAgentRunView | null | undefined): ShotsHeader {
  const n = rows.length;
  const renderingAt = rows.findIndex((r) => r.shown?.status === "rendering");
  const approved = rows.filter((r) => r.shown?.status === "approved").length;
  const waiting = rows.filter((r) => r.shown && needsReview(r.shown)).length;
  const active = run && ACTIVE_STATES.includes(run.state) && STOPPABLE.has(run.state) && run.paid.some((s) => s.tool === "render" && !["done", "failed", "skipped"].includes(s.state));
  const stopped = run?.state === "stopped" && rows.some((r) => r.shown?.status !== "approved");
  const summary = renderingAt >= 0 ? `Rendering ${renderingAt + 1} of ${n}`
    : waiting ? `${n} ${n === 1 ? "shot" : "shots"} · ${waiting} ${waiting === 1 ? "needs" : "need"} review`
    : n && approved === n ? `${n} ${n === 1 ? "shot" : "shots"} · all approved`
    : `${n} ${n === 1 ? "shot" : "shots"}`;
  if (renderingAt >= 0) return { title: `Shots · rendering ${renderingAt + 1} of ${n}`, stopRunId: active ? run!.id : null, spent: null, live: true, summary };
  if (stopped) return { title: "Shots · stopped", stopRunId: null, spent: run!.credits, live: false, summary: "Stopped" };
  return { title: `Shots · ${approved} of ${n} approved`, stopRunId: active ? run!.id : null, spent: null, live: false, summary };
}

/* ── A take's words ──────────────────────────────────────────────────────── */

/** The rail state of a shot's card: needs (a take waits for you) > working (in flight) > done (approved) > empty. */
export function shotState(row: Pick<ShotTakes, "shown" | "versions">): "needs" | "working" | "done" | "empty" {
  const s = row.shown;
  if (!s) return "empty";
  if (needsReview(s)) return "needs";
  if (inFlight(s)) return "working";
  return s.status === "approved" ? "done" : "empty";
}

/** The State column of the List view (stream 4's table): the shown take's state in the words the cards use. */
export type ShotListState = { word: string; tone: "done" | "waiting" | "live" | "idle" | "failed" };
export function shotListState(row: Pick<ShotTakes, "shown">): ShotListState | null {
  const s = row.shown;
  if (!s) return null;
  switch (s.status) {
    case "approved": return { word: "Approved", tone: "done" };
    case "review": case "picked": return { word: "Needs review", tone: "waiting" };
    case "changes": return { word: "Rejected", tone: "idle" };
    case "held": return { word: "Held", tone: "waiting" };
    case "failed": return { word: s.entry.take.cancelled ? "Cancelled" : "Failed", tone: s.entry.take.cancelled ? "idle" : "failed" };
    case "rendering": return s.stage === "queued" ? { word: "Queued", tone: "idle" } : s.stage === "held" ? { word: "Held", tone: "waiting" } : { word: "Rendering", tone: "live" };
    default: return null;
  }
}

/** Every shot's State, keyed by its Rig card id and by its storyboard shot id (the List view's rows are beat-sheet shots). */
export function shotListRows(project: ShotSource, library: readonly LibraryEntry[]): Map<string, ShotListState> {
  const out = new Map<string, ShotListState>();
  const nodes = new Map(project.nodes.map((n) => [n.id, n] as const));
  for (const row of shotTakes(project, library)) {
    const state = shotListState(row);
    if (!state) continue;
    out.set(row.nodeId, state);
    const beat = nodes.get(row.nodeId)?.boardShotId;
    if (beat) out.set(beat, state);
  }
  return out;
}

/* ── Atomik's note and the history of a shot's versions ───────────────────── */

/** Atomik's one-line note on a take: its newest Verify check, in the judge's words where it found something. */
export function verifyNote(list: readonly TakeVerification[] | null | undefined, takeId: string): { text: string; at: number } | null {
  const v = (list ?? []).filter((x) => x.takeId === takeId).sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!v) return null;
  if (v.verdict === "pass") return { text: "Verified", at: v.createdAt };
  const off = v.checks.filter((c) => c.verdict === (v.verdict === "fail" ? "fail" : "unsure"));
  const reasons = off.flatMap((c) => c.reasons).map((r) => r.trim().replace(/[.\s]+$/, "")).filter(Boolean);
  const text = reasons.length ? reasons.slice(0, 2).join("; ") : off.length ? off.map((c) => VERIFY_CHECK_LABELS[c.check]).join(", ") : v.verdict === "fail" ? "Failed its check" : "Check needs you";
  const line = text.length > 120 ? `${text.slice(0, 117).trimEnd()}…` : text;
  return { text: `${line.charAt(0).toUpperCase()}${line.slice(1)}${/[.!?…]$/.test(line) ? "" : "."}`, at: v.createdAt };
}

export type TakeNote = { author: string; text: string; at: number; /** Said by a client through a review link, not by the team. */ guest?: boolean };
export type HistoryRow = { key: string; text: string; at: number };

const quote = (words: string) => {
  const one = words.replace(/\s+/g, " ").trim();
  return `“${one.length > 80 ? `${one.slice(0, 77).trimEnd()}…` : one}”`;
};

/**
 * A shot's history, newest first: each version as it was made (a change with its words), Atomik's check of
 * it, the team's notes on it (a reject's reason is one), and its sign-offs. Everything here is recorded data.
 */
export function shotHistory(versions: readonly ShotVersion[], extras: {
  verifications?: readonly TakeVerification[] | null;
  notes?: ReadonlyMap<string, readonly TakeNote[]>;
} = {}): HistoryRow[] {
  const rows: HistoryRow[] = [];
  for (const v of versions) {
    const changed = (v.task === "edit" || v.task === "extend") && v.prompt.trim();
    rows.push({ key: `${v.genId}:made`, text: changed ? `${v.label} · ${quote(v.prompt)}` : `${v.label} · ${v.engine}`, at: v.createdAt });
    const note = verifyNote(extras.verifications, v.id);
    if (note) rows.push({ key: `${v.genId}:check`, text: `${v.label} · Atomik: ${note.text.replace(/\.$/, "")}`, at: note.at });
    for (const [i, n] of (extras.notes?.get(v.genId) ?? []).entries()) rows.push({ key: `${v.genId}:note:${i}`, text: `${v.label} · ${n.author}: ${n.text.replace(/\s+/g, " ").trim()}`, at: n.at });
    if (v.status === "approved" && v.approvedAt) rows.push({ key: `${v.genId}:approved`, text: `${v.label} approved${v.approvedBy ? ` · ${v.approvedBy}` : ""}`, at: v.approvedAt });
    if (v.status === "changes") rows.push({ key: `${v.genId}:rejected`, text: `${v.label} rejected${v.reviewBy ? ` · ${v.reviewBy}` : ""}`, at: v.updatedAt });
  }
  return rows.sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
}

/** "10:19": a history row's time, in the viewer's clock. */
export const hhmm = (at: number) => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/* ── A reject's reason (S1's verdict rule; README § 4 "reject with a reason") ── */

export const REJECT_REASON_MIN = 3;
export const REJECT_REASON_MAX = 500;
export const REJECT_REASON_HINT = "Say why you are rejecting it.";
/** The reasons a person can tap instead of typing (the frame's chips); they are general words, never a name. */
export const REJECT_CHIPS = ["Off the brief", "Wrong framing", "Motion looks wrong", "Look or face drifted", "Artifacts"] as const;
/** The words recorded for the tapped reasons and the free line: the chips in the order drawn, then the line, one line. */
export function rejectReasonOf(picked: readonly string[], free: string): string {
  const chips = REJECT_CHIPS.filter((c) => picked.includes(c));
  return cleanRejectReason([...chips, free].filter((part) => part.trim()).join("; "));
}
/** The reason as it is recorded: one line, trimmed. */
export const cleanRejectReason = (text: string) => text.replace(/\s+/g, " ").trim();
/** Why this reason cannot be sent, or null: a reject needs one line of 3 to 500 characters. */
export function rejectReasonProblem(text: string): string | null {
  const why = cleanRejectReason(text);
  return why.length < REJECT_REASON_MIN || why.length > REJECT_REASON_MAX ? REJECT_REASON_HINT : null;
}
