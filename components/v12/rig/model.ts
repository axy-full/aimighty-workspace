import { shotTakes, type ShotTakes } from "@/components/graphite/board/cards/take/take-model";
import { assetStill, type CastCardData, type CastStill } from "@/components/graphite/board/cards/cast/cast-model";
import type { LookData } from "@/components/graphite/board/cards/looks/derive";
import { CUT_CARD, DELIVER_CARD } from "@/components/graphite/board/cards/cut/cut-model";
import { fmtRenderPrice, type RenderPrice } from "@/lib/v12/renderState";
import type { BoardCard } from "@/lib/board/types";
import type { Project } from "@/lib/workbench/studio";
import type { Generation } from "@/lib/jobs";
import type { LibraryEntry } from "@/lib/workspace/library";

/**
 * The Rig, as a view of the board (redesign P5; docs/redesign/inventory.md § 9): what feeds what. From the board's own data,
 * nothing new stored: the Cast, Environment and Element cards and the picked look are the inputs; the shots are the work;
 * Takes, The cut and Masters are what comes out. A shot's inputs are the cards its script names (the beat sheet) and the
 * cards wired into it on the canvas (`CanvasNode.linked`). Pure.
 */
export type RigGroup = "cast" | "elements" | "look";
export const GROUP_LABEL: Record<RigGroup, string> = { cast: "Cast", elements: "Elements", look: "Look" };

export type RigInput = {
  id: string;
  group: RigGroup;
  kind: string;
  name: string;
  /** The canvas card behind it, when it has one (a wire can be added to and taken from a card). */
  nodeId: string | null;
  /** The shots (1-based, as the Shots stage numbers them) it feeds. */
  shots: number[];
  /** Of those, the ones a wire on the canvas joins it to: only these can be taken out here. */
  wired: number[];
  thumb: CastStill | null;
  /** A locked master or a card locked on the canvas: "never change". */
  locked: boolean;
  line: string | null;
};

export type RigShotState = "empty" | "ready" | "queued" | "rendering" | "held" | "failed";
export type RigShot = {
  nodeId: string;
  index: number;
  /** "Shot 3 · Medium". */
  label: string;
  line: string;
  thumb: CastStill | null;
  state: RigShotState;
  /** The take the shot shows: what a redraw would be made from, and its engine. */
  take: ShotTakes["shown"];
  locked: boolean;
  inputs: string[];
  row: ShotTakes;
};

export type RigOutput = { id: "takes" | "cut" | "masters"; name: string; meta: string; stage: "shots" | "cut" | "deliver" };
export type RigModel = { inputs: RigInput[]; shots: RigShot[]; outputs: RigOutput[]; heading: string };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const shotsWord = (n: number) => (n ? plural(n, "shot") : "no shot yet");

const stateOf = (v: ShotTakes["shown"]): RigShotState => !v ? "empty" : v.status === "failed" ? "failed" : v.status === "held" ? "held" : v.status === "rendering" ? (v.stage === "queued" ? "queued" : "rendering") : "ready";
export const STATE_WORD: Record<RigShotState, string | null> = { empty: null, ready: null, queued: "In queue", rendering: "Rendering", held: "Held", failed: "Didn’t finish" };

export function rigModel(args: { cards: readonly BoardCard[]; project: Project; library: readonly LibraryEntry[] }): RigModel {
  const { cards, project, library } = args;
  const rows = shotTakes(project, library);
  const nodes = new Map(project.nodes.map((n) => [n.id, n]));
  /* Shots wired to a card on the canvas, by the shot's number. */
  const wiredTo = (nodeId: string | null): number[] => nodeId ? rows.filter((r) => nodes.get(r.nodeId)?.linked.includes(nodeId)).map((r) => r.index) : [];

  const inputs: RigInput[] = [];
  for (const card of cards) {
    if (card.kind === "cast") {
      const d = card.data as CastCardData;
      const wired = wiredTo(d.nodeId);
      const node = d.nodeId ? nodes.get(d.nodeId) : undefined;
      const shots = [...new Set([...d.shots, ...wired])].sort((a, b) => a - b);
      inputs.push({
        id: card.id, group: d.variant === "cast" ? "cast" : "elements", kind: d.variant === "cast" ? "Character" : d.variant === "environment" ? "Place" : "Prop",
        name: d.title.trim() || (d.variant === "cast" ? "Character" : d.variant === "environment" ? "Place" : "Prop"), nodeId: d.nodeId, shots, wired,
        thumb: d.still, locked: d.master || Boolean(node?.locked) || Boolean(node?.master), line: d.description.trim().slice(0, 60) || null,
      });
    } else if (card.kind === "look") {
      const d = card.data as LookData;
      if (!d.picked) continue;
      inputs.push({ id: card.id, group: "look", kind: "Look", name: d.name, nodeId: null, shots: rows.map((r) => r.index), wired: [], thumb: d.genId ? { url: `/api/media/${d.genId}`, kind: "image" } : null, locked: false, line: d.meta.slice(0, 60) || null });
    }
  }
  /* Wired cards the board's cast does not draw (a reference image dropped on a shot): inputs too. */
  const seen = new Set(inputs.map((i) => i.nodeId).filter(Boolean));
  for (const row of rows) {
    for (const id of nodes.get(row.nodeId)?.linked ?? []) {
      const n = nodes.get(id);
      if (!n || seen.has(id) || (n.type !== "media" && n.type !== "character" && n.type !== "element" && n.type !== "moodboard")) continue;
      seen.add(id);
      const asset = n.assetId ? [...project.assets, ...(project.sharedAssets ?? [])].find((a) => a.id === n.assetId) : undefined;
      const wired = wiredTo(id);
      inputs.push({ id: `node:${id}`, group: n.type === "moodboard" ? "look" : n.type === "character" ? "cast" : "elements", kind: n.type === "character" ? "Character" : n.type === "moodboard" ? "Look" : "Reference",
        name: n.title.trim() || "Reference", nodeId: id, shots: wired, wired, thumb: assetStill(asset), locked: Boolean(n.locked) || Boolean(n.master), line: null });
    }
  }

  const shots: RigShot[] = rows.map((row) => {
    const v = row.shown;
    const thumb: CastStill | null = v && v.url && (v.media === "image" || v.media === "video") && v.status !== "failed" ? { url: v.url, kind: v.media } : row.frame;
    return {
      nodeId: row.nodeId, index: row.index, label: row.title, line: row.line, thumb, state: stateOf(v), take: v, locked: Boolean(nodes.get(row.nodeId)?.locked),
      inputs: inputs.filter((i) => i.shots.includes(row.index)).map((i) => i.id), row,
    };
  });

  const made = rows.flatMap((r) => r.versions);
  const cut = cards.find((c) => c.id === CUT_CARD);
  const deliver = cards.find((c) => c.id === DELIVER_CARD);
  const outputs: RigOutput[] = [
    { id: "takes", name: "Takes", meta: `${plural(rows.length, "shot")} · ${plural(made.length, "take")}`, stage: "shots" },
    { id: "cut", name: "The cut", meta: cut?.summary ?? "Nothing yet", stage: "cut" },
    { id: "masters", name: "Masters", meta: [project.aspect, deliver?.summary].filter(Boolean).join(" · "), stage: "deliver" },
  ];
  return { inputs, shots, outputs, heading: `The work · ${plural(rows.length, "shot")}` };
}

/** The shots a change to an input would redraw: the ones it feeds that have a take and are not locked ("Locked frames stay"). */
export function redrawn(input: RigInput, model: RigModel): RigShot[] {
  return model.shots.filter((s) => input.shots.includes(s.index) && s.take && !s.locked);
}

/** "Shots 2, 3 and 5", "Shot 4". */
export function shotsList(shots: readonly number[]): string {
  const list = [...shots].sort((a, b) => a - b);
  if (list.length === 1) return `Shot ${list[0]}`;
  return `Shots ${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/** What a step of a shot's work is called: Still, Video, Upscale, Lip-sync, Sound. */
export function stepName(task: string, media: "image" | "video" | "audio" | null): string {
  const t = task.toLowerCase();
  if (t.includes("upscale")) return "Upscale";
  if (t.includes("lip")) return "Lip-sync";
  return media === "video" ? "Video" : media === "audio" ? "Sound" : "Still";
}

/** What the ledger charged for a settled take, in the workspace's own unit; null while it is still in flight. */
export function chargedOf(g: Partial<Pick<Generation, "costUsd" | "creditsBilled">> & Pick<Generation, "status">, dollars: boolean): RenderPrice | null {
  if (g.status !== "succeeded" && g.status !== "failed" && g.status !== "cancelled") return null;
  if (dollars) return typeof g.costUsd === "number" ? { amount: g.costUsd, unit: "usd" } : null;
  return typeof g.creditsBilled === "number" ? { amount: g.creditsBilled, unit: "cr" } : null;
}

/**
 * What a step of a shot's work cost, in words. A failed or cancelled take confirmed uncharged says "Nothing billed"
 * (CLAUDE.md rule 14), never a zero figure; one with a charge on record says what; one with neither shows a dash, because a
 * row's own figure of 0 is not a confirmation (tests/unit/takeCardContract.spec.ts); one in flight has not been billed yet.
 */
export function stepPriceText(v: Pick<ShotTakes["versions"][number], "status" | "nothingBilled" | "charge">, g: Partial<Pick<Generation, "costUsd" | "creditsBilled">> & Pick<Generation, "status"> | null, dollars: boolean): string {
  const charged = g ? chargedOf(g, dollars) : null;
  if (charged && charged.amount > 0) return fmtRenderPrice(charged);
  const ended = g ? g.status === "failed" || g.status === "cancelled" : v.status === "failed";
  /* "Nothing billed" rides on a receipt or its provider's word (`nothingBilled`, lib/workspace/takes.ts), never on a row's own zero. */
  if (ended) return v.nothingBilled ? "Nothing billed" : v.charge ?? "—";
  if (v.status === "rendering" || v.status === "held") return "not billed yet";
  return charged ? fmtRenderPrice(charged) : "—";
}

type QuoteRead = { credits?: number; approximate?: true; error?: string } | undefined;
/** The price of a change: every shot it redraws needs a request to quote; one without says "quoted"; a failed read says why. */
export type ImpactPrice =
  | { state: "quoted" }
  | { state: "loading" }
  | { state: "error"; message: string; ids: string[] }
  | { state: "ready"; total: number; approximate: boolean };
export function impactPrice(affected: readonly { nodeId: string }[], requests: Record<string, unknown>, quotes: Record<string, QuoteRead>): ImpactPrice {
  if (!affected.length || affected.some((s) => !requests[s.nodeId])) return { state: "quoted" };
  const reads = affected.map((s) => ({ id: s.nodeId, q: quotes[s.nodeId] }));
  const failed = reads.filter((r) => r.q?.error);
  if (failed.length) return { state: "error", message: failed[0].q!.error!, ids: failed.map((r) => r.id) };
  if (reads.some((r) => !r.q || r.q.credits == null)) return { state: "loading" };
  return { state: "ready", total: reads.reduce((n, r) => n + (r.q!.credits ?? 0), 0), approximate: reads.some((r) => r.q!.approximate) };
}

/** A shot's length, "4 s", when its script gives one. */
export const lengthOf = (line: string): string | null => /(?:^| · )(\d+(?:\.\d+)? s)(?: · |$)/.exec(line)?.[1] ?? null;
