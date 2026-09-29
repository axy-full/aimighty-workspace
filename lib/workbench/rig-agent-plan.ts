import { z } from "zod";
import { boardShots } from "../production/boards";
import type { CanvasOp, NodeChange } from "./canvas-ops-model";
import { createNode, nodeHeight } from "./node-graph";
import { REF_KIND_LABELS, REF_NODE_TYPES, cardLabel, isReferenceNode, isRefKind, withRefKind } from "./ref-kind";
import { stableId } from "./stable-id";
import { creditFigure } from "../runLimit";
import type { Asset, CanvasNode, NodeType, Project, RefKind } from "./studio";
import type { TeamCanvas } from "./team-canvas-model";

/*
 * Atomik builds the board (owner, 28 September: "an agentic canvas like
 * Luma"): the pure half, shared by the planner, the executor and the tests.
 *
 * Atomik plans with dry tools. They only check and record what it proposes —
 * the cards, the wires between them, a tidy, and the priced steps that would
 * come after — and never touch the canvas. The plan a person approves is
 * compiled here into steps, each one batch of canvas operations that the
 * executor applies through applyCanvasOps with the run as author. Every card
 * takes a stable id from the run and its key, so a step applied twice makes
 * nothing twice. A reference card keeps its node type (Cast is a character
 * card, Environment and Element are element cards, Ref is a media card) and
 * says what it is with its kind: no new node types.
 *
 * Building is free. A render the plan names is shown as a priced next step
 * and is never run here; locking a master is shown as a next step too.
 */

/** What Atomik may make: the four reference kinds, a shot, a note, a section heading. */
export const AGENT_KINDS = ["cast", "environment", "element", "ref", "shot", "note", "section"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];
export const AGENT_KIND_LABELS: Record<AgentKind, string> = { ...REF_KIND_LABELS, shot: "Shot", note: "Note", section: "Section" };

/** The node type each reference kind keeps: always one of REF_NODE_TYPES. */
const REF_TYPE: Record<RefKind, (typeof REF_NODE_TYPES)[number]> = { cast: "character", environment: "element", element: "element", ref: "media" };

/** A kind as a card on the canvas: the node type it keeps, and for a reference, the kind it says it is. */
export function cardShape(kind: AgentKind): { type: NodeType; refKind?: RefKind; mode?: string } {
  if (isRefKind(kind)) return { type: REF_TYPE[kind], refKind: kind };
  if (kind === "shot") return { type: "scene", mode: "Video" };
  if (kind === "section") return { type: "note", mode: "section" };
  return { type: "note" };
}

/** Bounds on one plan: what one build may make and wire. */
export const PLAN_LIMITS = { cards: 24, wires: 60, next: 24, title: 120, text: 2000, goal: 2000, summary: 400 } as const;
/** The ratios a planned shot may ask for (the Rig's own set; the engine's range is applied when the shot is read). */
export const SHOT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"] as const;
const KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;
const clip = (text: string, max: number) => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim().slice(0, max);

/* ── What Atomik sees: a bounded snapshot of the board and the production ── */

export type SnapshotCard = { id: string; kind: string; title: string; locked?: true; shot?: true; reference?: true };
export type SnapshotAsset = { id: string; name: string; kind: "image" | "video"; category: string };
export type BoardSnapshot = {
  production: string;
  brief: string;
  goal: string;
  cards: SnapshotCard[];
  assets: SnapshotAsset[];
  cast: { name: string; asset?: string; about?: string }[];
  places: { name: string; asset?: string; about?: string }[];
  boardShots: { number: string; title: string }[];
};
export const SNAPSHOT_LIMITS = { cards: 80, assets: 40, cast: 20, places: 20, boardShots: 24 } as const;

/**
 * The board and the production as the planner reads them: the cards on the
 * team canvas now (with their kinds), the pictures it may build a reference
 * from, the cast and places the production already has, and its storyboard
 * shots. Bounded; titles and names are clipped; none of it is instruction.
 */
export function boardSnapshot(project: Project, canvas: { nodes: CanvasNode[]; assets: Asset[] }, goal: string): BoardSnapshot {
  const assets = new Map<string, Asset>();
  for (const a of [...canvas.assets, ...project.assets, ...(project.sharedAssets ?? [])]) if (!assets.has(a.id) && (a.kind === "image" || a.kind === "video")) assets.set(a.id, a);
  const known = (id: string | undefined) => (id && assets.has(id) ? id : undefined);
  const cast = (project.production?.cast?.entries ?? []).slice(0, SNAPSHOT_LIMITS.cast).map((e) => {
    const asset = known(e.selected) ?? known(e.referenceAssetId) ?? e.takes.map((t) => known(t.genId)).find(Boolean);
    return { name: clip(e.name || "Unnamed", 80), ...(asset ? { asset } : {}), ...(e.description ? { about: clip(e.description, 200) } : {}) };
  });
  const places = (project.production?.environment?.entries ?? []).slice(0, SNAPSHOT_LIMITS.places).map((e) => {
    const asset = known(e.selected) ?? e.plates.map((p) => known(p.assetId)).find(Boolean);
    return { name: clip(e.name || "Unnamed place", 80), ...(asset ? { asset } : {}), ...(e.notes ? { about: clip(e.notes, 200) } : {}) };
  });
  /* The pictures the cast and places use come first, then the rest, newest last. */
  const first = new Set([...cast, ...places].map((e) => e.asset).filter((id): id is string => !!id));
  const ordered = [...[...assets.values()].filter((a) => first.has(a.id)), ...[...assets.values()].filter((a) => !first.has(a.id))];
  const filed = { assets: [...assets.values()] };
  return {
    production: clip(project.name, 120),
    brief: clip(project.brief ?? "", 1200),
    goal: clip(goal, PLAN_LIMITS.goal),
    cards: canvas.nodes.slice(0, SNAPSHOT_LIMITS.cards).map((n) => ({
      id: n.id, kind: cardLabel(n, filed), title: clip(n.title || "Untitled", 120),
      ...(n.locked ? { locked: true as const } : {}), ...(n.type === "scene" || n.type === "generate" ? { shot: true as const } : {}),
      ...(isReferenceNode(n) ? { reference: true as const } : {}),
    })),
    assets: ordered.slice(0, SNAPSHOT_LIMITS.assets).map((a) => ({ id: a.id, name: clip(a.name || a.id, 80), kind: a.kind as "image" | "video", category: clip(a.category || "", 40) })),
    cast, places,
    boardShots: boardShots(project.production?.beats).slice(0, SNAPSHOT_LIMITS.boardShots).map((s) => ({ number: s.number, title: clip(s.shot.description || s.scene || "Shot", 160) })),
  };
}

/* ── The dry tools: check and record, never apply ─────────────────────── */

export type PlannedCard = { key: string; kind: AgentKind; title: string; text?: string; from?: string; durationS?: number; ratio?: string };
export type PlannedWire = { from: string; to: string };
export type PlannedNext = { what: "render" | "lock"; card: string };
export type PlanDraft = { cards: PlannedCard[]; wires: PlannedWire[]; tidy: boolean; next: PlannedNext[] };
export type ToolAnswer = { ok: true; note?: string } | { ok: false; problem: string };

export const createNodeInput = z.object({
  key: z.string().describe("A short name for this card in the plan (lowercase letters, digits and dashes), used to wire it."),
  kind: z.enum(AGENT_KINDS),
  title: z.string().describe("The card's title."),
  text: z.string().optional().describe("A shot's prompt, or a note's text."),
  from: z.string().optional().describe("For a reference card: the id of a picture from inspect_board to hold."),
  durationS: z.number().optional().describe("A shot's length in seconds (1–30)."),
  ratio: z.enum(SHOT_RATIOS).optional().describe("A shot's frame ratio."),
}).strict();
export const wireInput = z.object({
  from: z.string().describe("The card that feeds: a key from this plan or the id of a card already on the board."),
  to: z.string().describe("The card it feeds into: a key from this plan or the id of a card already on the board."),
}).strict();
export const renderInput = z.object({ shot: z.string().describe("A shot's key from this plan, or the id of a shot on the board.") }).strict();
export const lockInput = z.object({ card: z.string().describe("A reference card's key from this plan, or the id of one on the board.") }).strict();

const problem = (text: string): ToolAnswer => ({ ok: false, problem: text });

/**
 * The board as Atomik plans it: each call is checked against the snapshot and
 * the plan so far, and answered — recorded, or the problem to fix. Nothing
 * here writes anywhere.
 */
export class DryBoard {
  private readonly cards = new Map<string, PlannedCard>();
  private readonly wires: PlannedWire[] = [];
  private readonly next: PlannedNext[] = [];
  private tidied = false;
  private readonly existing: Map<string, SnapshotCard>;
  private readonly assets: Map<string, SnapshotAsset>;

  constructor(readonly snapshot: BoardSnapshot) {
    this.existing = new Map(snapshot.cards.map((c) => [c.id, c]));
    this.assets = new Map(snapshot.assets.map((a) => [a.id, a]));
  }

  create(value: unknown): ToolAnswer {
    const parsed = createNodeInput.safeParse(value);
    if (!parsed.success) return problem("Give a key, a kind (cast, environment, element, ref, shot, note or section) and a title.");
    const input = parsed.data;
    const key = input.key.trim().toLowerCase();
    if (!KEY.test(key)) return problem("A key is 1–40 lowercase letters, digits or dashes, starting with a letter or digit.");
    if (this.cards.has(key) || this.existing.has(key)) return problem(`The key ${key} is taken; choose another.`);
    if (this.cards.size >= PLAN_LIMITS.cards) return problem(`One build makes at most ${PLAN_LIMITS.cards} cards.`);
    const title = clip(input.title, PLAN_LIMITS.title);
    if (!title) return problem("Give the card a title.");
    const card: PlannedCard = { key, kind: input.kind, title };
    const text = input.text ? clip(input.text, PLAN_LIMITS.text) : "";
    if (text) card.text = text;
    if (input.from !== undefined) {
      if (!isRefKind(input.kind)) return problem("Only a reference card (cast, environment, element or ref) holds a picture.");
      if (!this.assets.has(input.from)) return problem(`No picture has the id ${input.from}; use an id from inspect_board.`);
      card.from = input.from;
    }
    if (input.durationS !== undefined || input.ratio !== undefined) {
      if (input.kind !== "shot") return problem("Only a shot has a length and a ratio.");
      if (input.durationS !== undefined) {
        if (!Number.isFinite(input.durationS) || input.durationS < 1 || input.durationS > 30) return problem("A shot is 1 to 30 seconds long.");
        card.durationS = Math.round(input.durationS);
      }
      if (input.ratio) card.ratio = input.ratio;
    }
    this.cards.set(key, card);
    return { ok: true };
  }

  /** A card this plan makes (by key) or one on the board (by id). */
  private end(ref: string): { planned?: PlannedCard; existing?: SnapshotCard } | null {
    const key = ref.trim().toLowerCase();
    const planned = this.cards.get(key);
    if (planned) return { planned };
    const existing = this.existing.get(ref.trim());
    return existing ? { existing } : null;
  }

  wire(value: unknown): ToolAnswer {
    const parsed = wireInput.safeParse(value);
    if (!parsed.success) return problem("Give from and to: keys from this plan or ids of cards on the board.");
    const from = this.end(parsed.data.from), to = this.end(parsed.data.to);
    if (!from) return problem(`${parsed.data.from} is neither a card in this plan nor one on the board.`);
    if (!to) return problem(`${parsed.data.to} is neither a card in this plan nor one on the board.`);
    const a = from.planned?.key ?? from.existing!.id, b = to.planned?.key ?? to.existing!.id;
    if (a === b) return problem("A card cannot feed itself.");
    if (to.existing?.locked) return problem("That card is locked: its inputs stay as they are.");
    if (to.planned && (to.planned.kind === "note" || to.planned.kind === "section") && from.planned && (from.planned.kind === "note" || from.planned.kind === "section"))
      return problem("Wire notes into the shots they direct.");
    if (this.wires.some((w) => w.from === a && w.to === b)) return { ok: true, note: "Already wired." };
    if (this.wires.length >= PLAN_LIMITS.wires) return problem(`One build wires at most ${PLAN_LIMITS.wires} inputs.`);
    this.wires.push({ from: a, to: b });
    return { ok: true };
  }

  tidy(): ToolAnswer {
    this.tidied = true;
    return { ok: true };
  }

  render(value: unknown): ToolAnswer {
    const parsed = renderInput.safeParse(value);
    if (!parsed.success) return problem("Name the shot to render next.");
    const end = this.end(parsed.data.shot);
    if (!end || !(end.planned?.kind === "shot" || end.existing?.shot)) return problem("Only a shot is rendered.");
    return this.plan("render", end.planned?.key ?? end.existing!.id, "It is shown as the next step, priced; rendering is never part of this build.");
  }

  lock(value: unknown): ToolAnswer {
    const parsed = lockInput.safeParse(value);
    if (!parsed.success) return problem("Name the reference card to keep as a master.");
    const end = this.end(parsed.data.card);
    if (!end || !((end.planned && isRefKind(end.planned.kind)) || end.existing?.reference)) return problem("Only a reference card (cast, environment, element or ref) is kept as a master.");
    return this.plan("lock", end.planned?.key ?? end.existing!.id, "It is shown as a next step: a person locks masters.");
  }

  private plan(what: PlannedNext["what"], card: string, note: string): ToolAnswer {
    if (this.next.some((n) => n.what === what && n.card === card)) return { ok: true, note };
    if (this.next.length >= PLAN_LIMITS.next) return problem(`A plan names at most ${PLAN_LIMITS.next} next steps.`);
    this.next.push({ what, card });
    return { ok: true, note };
  }

  draft(): PlanDraft {
    return { cards: [...this.cards.values()], wires: [...this.wires], tidy: this.tidied, next: [...this.next] };
  }
}

/* ── The plan, compiled into steps of canvas operations ───────────────── */

export type CompiledCard = { key: string; kind: AgentKind; id: string; title: string };
export type StepTool = "create" | "wire" | "tidy" | "render" | "verify" | "lock";
export type CompiledStep = {
  seq: number; tool: StepTool; purpose: "build" | "take" | "verify" | "lock"; label: string;
  /** The card a next step is about. */
  nodeId: string | null;
  ops: CanvasOp[];
  /**
   * "proposed": part of the build, applied once approved. "next": after the build — a render
   * (paid: priced, then run inside the run's approved limit, lib/workbench/rig-agent-runs.ts),
   * the check of its take, or a master to lock (a person's).
   */
  state: "proposed" | "next";
};
export type CompiledPlan = {
  title: string; summary: string;
  cards: CompiledCard[];
  wires: { from: string; to: string }[];
  tidy: boolean;
  next: { what: PlannedNext["what"]; id: string; title: string }[];
  steps: CompiledStep[];
};

/** The id a run's card takes: the same from the same run and key, so a step applied twice makes it once. */
export const agentNodeId = (runId: string, key: string) => stableId("node", "agent", runId, key);

const COLUMN = 400, GAP = 38, TOP = 70, LEFT = 60;
const COLUMN_OF: Record<AgentKind, number> = { cast: 0, environment: 0, element: 0, ref: 0, shot: 1, note: 2, section: 2 };
const plural = (n: number, one: string, many = one + "s") => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** A planned card as a canvas node: its kind's node type, its kind for a reference, and the run and key it came from. */
export function agentCard(card: PlannedCard, id: string, runId: string, at: { x: number; y: number }, index: number): CanvasNode {
  const shape = cardShape(card.kind);
  const base = createNode(shape.type, index, at);
  let node: CanvasNode = {
    ...base, id, title: card.title,
    text: card.text ?? (shape.type === "note" ? card.title : ""),
    ...(card.from ? { assetId: card.from } : {}),
    ...(shape.mode ? { mode: shape.mode } : {}),
    ...(card.durationS ? { durationS: card.durationS } : {}),
    ...(card.ratio ? { ratio: card.ratio } : {}),
    agent: { runId, key: card.key },
  };
  if (shape.refKind) {
    /* The kind goes on through the one path a person's choice takes (lib/workbench/ref-kind.ts). */
    const kinded = withRefKind({ nodes: [node] } as unknown as Project, id, shape.refKind);
    if (typeof kinded === "string") throw new Error(kinded);
    node = kinded.nodes[0];
  }
  return node;
}

/**
 * The approved plan as steps: one batch of new cards per kind (Cast, then
 * Environment, Element, Ref, Shots, Notes), then the wires, then a tidy of the
 * run's own cards; then the next steps a person runs (renders, priced, and
 * master locks), which this build never applies. New cards are placed to the
 * right of what is on the board, one column per family, so each batch lands
 * clear of the team's cards before the tidy lays them out.
 */
export function compilePlan(draft: PlanDraft, input: { runId: string; title: string; summary: string; existing: readonly CanvasNode[]; assets: ReadonlyMap<string, Asset> }): CompiledPlan {
  const { runId } = input;
  const ids = new Map(draft.cards.map((c) => [c.key, agentNodeId(runId, c.key)]));
  const resolve = (ref: string) => ids.get(ref) ?? ref;
  const right = input.existing.reduce((max, n) => Math.max(max, n.x + n.width), 0);
  const originX = input.existing.length ? Math.min(19_000 - 3 * COLUMN, right + 160) : LEFT;
  const floors = [TOP, TOP, TOP];
  const cards: CompiledCard[] = [];
  const steps: CompiledStep[] = [];
  let index = input.existing.length;
  for (const kind of AGENT_KINDS) {
    const group = draft.cards.filter((c) => c.kind === kind);
    if (!group.length) continue;
    const ops: CanvasOp[] = group.map((card) => {
      const column = COLUMN_OF[kind];
      const node = agentCard(card, ids.get(card.key)!, runId, { x: originX + column * COLUMN, y: floors[column] }, index++);
      floors[column] = Math.min(19_000, floors[column] + nodeHeight(node) + GAP);
      cards.push({ key: card.key, kind, id: node.id, title: card.title });
      const asset = card.from ? input.assets.get(card.from) : undefined;
      return { kind: "create", node, ...(asset ? { assets: [asset] } : {}) };
    });
    steps.push({ seq: steps.length + 1, tool: "create", purpose: "build", label: `${AGENT_KIND_LABELS[kind]} · ${plural(group.length, "card")}`, nodeId: null, ops, state: "proposed" });
  }
  const wires = draft.wires.map((w) => ({ from: resolve(w.from), to: resolve(w.to) }));
  if (wires.length)
    steps.push({ seq: steps.length + 1, tool: "wire", purpose: "build", label: `Wires · ${plural(wires.length, "input")}`, nodeId: null, ops: wires.map((w) => ({ kind: "wire", ...w })), state: "proposed" });
  if (draft.tidy && cards.length)
    steps.push({ seq: steps.length + 1, tool: "tidy", purpose: "build", label: "Tidy the new cards", nodeId: null, ops: [{ kind: "tidy", nodeIds: cards.map((c) => c.id) }], state: "proposed" });
  const titleOf = (ref: string) => draft.cards.find((c) => c.key === ref)?.title ?? input.existing.find((n) => n.id === ref)?.title ?? "a card";
  const next = draft.next.map((n) => ({ what: n.what, id: resolve(n.card), title: titleOf(n.card) }));
  for (const n of next) {
    steps.push({ seq: steps.length + 1, tool: n.what, purpose: n.what === "render" ? "take" : "lock", label: n.what === "render" ? `Render ${n.title} · priced` : `Lock ${n.title} as a master`, nodeId: n.id, ops: [], state: "next" });
    /* Each take is checked against its masters once it lands (plan §6): the check is its own step. */
    if (n.what === "render")
      steps.push({ seq: steps.length + 1, tool: "verify", purpose: "verify", label: `Check ${n.title} against its masters`, nodeId: n.id, ops: [], state: "next" });
  }
  return { title: clip(input.title, 80) || "A board for this production", summary: clip(input.summary, PLAN_LIMITS.summary), cards, wires, tidy: draft.tidy && cards.length > 0, next, steps };
}

/** What a proposal's fingerprint covers: everything the person approves, in one canonical text. */
export function planFingerprintText(plan: CompiledPlan): string {
  return JSON.stringify({ title: plan.title, summary: plan.summary, cards: plan.cards, wires: plan.wires, tidy: plan.tidy, next: plan.next, steps: plan.steps.map((s) => [s.seq, s.tool, s.state, s.ops]) });
}

/* ── Undo ─────────────────────────────────────────────────────────────── */

/** The inputs a run wired into cards, from its logged changes: each `linked` it added. */
export function wiresOf(changes: readonly Pick<NodeChange, "id" | "made" | "removed" | "fields" | "before" | "after">[]): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  for (const change of changes) {
    if (change.made || change.removed || !change.fields.includes("linked")) continue;
    const before = new Set(Array.isArray(change.before.linked) ? (change.before.linked as string[]) : []);
    const after = Array.isArray(change.after.linked) ? (change.after.linked as string[]) : [];
    for (const from of after) if (!before.has(from)) out.push({ from, to: change.id });
  }
  return out;
}

/**
 * A run's undo, against the canvas as it is now: take out the inputs it wired
 * into cards it did not make, then take its own cards off (softly). The canvas
 * operations hold what a person has changed since: a card a teammate edited or
 * still uses stays, with the reason.
 */
export function undoOps(canvas: Pick<TeamCanvas, "nodes" | "serverMade">, author: string, wires: readonly { from: string; to: string }[]): CanvasOp[] {
  const own = Object.keys(canvas.nodes).filter((id) => canvas.serverMade[id] === author);
  const mine = new Set(Object.entries(canvas.serverMade).filter(([, by]) => by === author).map(([id]) => id));
  const seen = new Set<string>();
  const unwire: CanvasOp[] = [];
  for (const w of wires) {
    const key = `${w.from}>${w.to}`;
    if (mine.has(w.to) || seen.has(key) || !canvas.nodes[w.to]?.linked.includes(w.from)) continue;
    seen.add(key);
    unwire.push({ kind: "unwire", from: w.from, to: w.to });
  }
  return [...unwire, ...(own.length ? [{ kind: "remove" as const, nodeIds: own }] : [])];
}

/* ── What the run card shows (never a model, a cost or a key) ─────────── */

/** `needs_you`: the run waits for a person — a render to tap (Ask), one over the per-job line, the limit, or a refusal. */
export type RigAgentState = "planning" | "awaiting_approval" | "running" | "paused" | "needs_you" | "done" | "stopped" | "failed";
export const ACTIVE_STATES: readonly RigAgentState[] = ["planning", "awaiting_approval", "running", "paused", "needs_you"];
/**
 * A build step: proposed → queued → done (or skipped). A paid step (a render) after the build:
 * next → waiting (priced; waits for its approval) → approved → sending (its durable request key is
 * saved; the reply may be lost) → rendering (a take in flight) → done or failed; or paused (refused:
 * it waits for a person, with the reason), or skipped.
 */
export type RigAgentStepState =
  | "proposed" | "queued" | "done" | "skipped" | "next"
  | "waiting" | "approved" | "sending" | "rendering" | "failed" | "paused";
export type RigAgentStepView = { seq: number; label: string; state: RigAgentStepState; held: string[] };
export type RigAgentMode = "ask" | "auto";
export const RIG_AGENT_MODES: readonly RigAgentMode[] = ["ask", "auto"];

/** What the run may spend and what it has spent (credits only: never a vendor's cost). */
export type RigAgentMoneyView = {
  mode: RigAgentMode;
  /** The limit the person approved for this run. */
  limit: number;
  /** In Auto, a render priced up to this runs without asking; anything more asks. */
  jobCeiling: number;
  /** Charged so far: finished work at its final charge. */
  spent: number;
  /** Reserved by work in flight, at its estimate. */
  inFlight: number;
  /** What the limit still leaves, with room kept for work in flight at its worst case. */
  left: number;
  /** The planning turn, metered into the limit: reserved while Atomik plans, then what it was charged. */
  planning: { state: "reserved" | "settled" | "released"; credits: number | null } | null;
};

/** A render (or the check of its take) after the build, as the run card shows it. */
export type RigAgentPaidStepView = {
  seq: number;
  tool: "render" | "verify";
  title: string;
  state: RigAgentStepState;
  /** The approximate price before it runs ("about N cr"). */
  quote: number | null;
  /** The most it may settle at (its price times its band): what the run's limit keeps room for. */
  worst: number | null;
  /** Why it paused, when it did: the limit, the balance, an admin, a refusal, a price it has not got, or its record. */
  pause: "limit" | "credits" | "admin" | "refused" | "unpriced" | "record" | null;
  /** What it was charged, once the ledger has settled it. */
  charged: number | null;
  /** For a take that failed: what the ledger shows the provider did with the charge. */
  outcome: "not_billed" | "charged" | "unknown" | null;
  /** Why it waits, or why it stopped. */
  reason: string | null;
  /** The viewer may approve it now (the person who asked, while it waits or is paused). */
  canRender: boolean;
  /** The approval a tap gives: the price the card shows. */
  fingerprint: string | null;
};
export type RigAgentProposalView = {
  title: string; summary: string;
  groups: { kind: AgentKind; label: string; titles: string[] }[];
  cards: number; wires: number; tidy: boolean;
  /** Priced or person-only steps that come after this build: shown, never run here. */
  next: string[];
  fingerprint: string;
};
export type RigAgentRunView = {
  id: string; state: RigAgentState; reason: string | null; goal: string;
  /** The viewer asked for this build (only they approve it). */
  mine: boolean;
  proposal: RigAgentProposalView | null;
  steps: RigAgentStepView[];
  built: { cards: number; wires: number };
  held: string[];
  undo: { removed: number; kept: number; reasons: string[] } | null;
  canUndo: boolean;
  /** Charged to this run so far, in credits (building is free; planning, renders and checks are not). */
  credits: number;
  /** The approved limit and what the run has spent inside it; null for a run asked without a limit. */
  money: RigAgentMoneyView | null;
  /** The renders after the build, and the checks of their takes. */
  paid: RigAgentPaidStepView[];
  at: number;
};

export { creditFigure };

/**
 * The proposal as the card shows it: the cards by kind, the wires, the tidy, and what comes next.
 * In Auto, the renders say how much one may cost without asking.
 */
export function proposalView(plan: CompiledPlan, fingerprint: string, money?: Pick<RigAgentMoneyView, "mode" | "jobCeiling"> | null): RigAgentProposalView {
  const groups = AGENT_KINDS.map((kind) => ({ kind, label: AGENT_KIND_LABELS[kind], titles: plan.cards.filter((c) => c.kind === kind).map((c) => c.title) })).filter((g) => g.titles.length);
  const renders = plan.next.filter((n) => n.what === "render").length, locks = plan.next.filter((n) => n.what === "lock").length;
  const next = [
    ...(renders ? [money?.mode === "auto"
      ? `Next: render ${plural(renders, "shot")} · priced; up to about ${creditFigure(money.jobCeiling)} cr each runs on its own`
      : `Next: render ${plural(renders, "shot")} · priced, each one approved first`] : []),
    ...(locks ? [`Next: lock ${plural(locks, "master")} · a person locks them`] : []),
  ];
  return { title: plan.title, summary: plan.summary, groups, cards: plan.cards.length, wires: plan.wires.length, tidy: plan.tidy, next, fingerprint };
}

