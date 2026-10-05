import { STUDIO_GROUP, nodesForSet } from "@/lib/board/regions";
import type { BoardCard, BoardSource, GroupData } from "@/lib/board/types";
import { boardShots } from "@/lib/production/boards";
import { castStillPrompt } from "@/lib/shell/connected-capability";
import { entryCategory, retiredModelOf, type CastEntry } from "@/lib/production/cast";
import { platePrompt, type EnvironmentEntry } from "@/lib/production/environment";
import { lockProblem } from "@/lib/workbench/master-lock";
import { resolveAsset } from "@/lib/workbench/node-graph";
import { refKindOf } from "@/lib/workbench/ref-kind";
import type { Asset, Project } from "@/lib/workbench/studio";
import type { SoulIdentity } from "@/lib/workbench/soul-identity";
import { isShotNode } from "@/lib/workspace/shots";

/*
 * The Cast region (README § 3.1 frame h), derived from today's data and nothing else. Pure: no React, no fetch.
 *
 * - A card is a character, a place or an element. Each comes from a reference card on the canvas (Cast, Environment
 *   or Element, `refKindOf`), or, when the production lists one that no card stands for, from the production's own
 *   cast and environment lists (Production › Cast & Elements and Environment). A name the canvas already draws is
 *   drawn once, from the canvas.
 * - What a card says is what is recorded: its picture, its words, the identity it renders with and that identity's
 *   state, the training consent that exists (who confirmed it and when), whether it is a locked master, and the
 *   shots it appears in from the beat sheet. Nothing is made up: a card with no identity says so.
 */

export type CastVariant = "cast" | "environment" | "element";
export const VARIANT_LABEL: Record<CastVariant, string> = { cast: "Cast", environment: "Environment", element: "Element" };

export type CastStill = { url: string; kind: "image" | "video" };

export type CastCardData = {
  variant: CastVariant;
  /** Drawn from a canvas reference card ("node") or from the production's own list ("entry"). */
  source: "node" | "entry";
  nodeId: string | null;
  entryId: string | null;
  title: string;
  description: string;
  still: CastStill | null;
  /** The shots (1-based, as the Shots region numbers them) this character, place or element appears in. */
  shots: number[];
  /** The identity a character renders with (a Soul ID of this workspace). */
  identityId: string | null;
  /** The card is a locked master. */
  master: boolean;
  /** Lock as master is possible right now (a stored picture on a Cast, Environment or Element card). */
  lockable: boolean;
  /** An environment's plates, and whether one is chosen. */
  plates: number;
  chosen: boolean;
  /** Renders on their way (the production list records them). */
  rendering: boolean;
  /** What a still or a plate is asked for: its prompt, else its words. */
  prompt: string;
  /** Built earlier on an account that is no longer used: shown, never changed. */
  retired: string | null;
};

const norm = (s: string) => s.trim().toLowerCase();
const allAssets = (p: Pick<Project, "assets"> & Partial<Pick<Project, "sharedAssets">>): Asset[] => [...p.assets, ...(p.sharedAssets ?? [])];

/** The picture an asset shows: a render by its stored take, an upload by its file. */
export function assetStill(asset: Asset | undefined): CastStill | null {
  if (!asset) return null;
  if (asset.generationId) return { url: `/api/media/${asset.generationId}`, kind: asset.kind === "video" ? "video" : "image" };
  if (asset.uploadId) return { url: `/api/uploads/${asset.uploadId}`, kind: asset.kind === "video" ? "video" : "image" };
  return asset.url && (asset.kind === "image" || asset.kind === "video") ? { url: asset.url, kind: asset.kind } : null;
}

/**
 * The shots (1-based) a name appears in: every beat-sheet shot of every scene that lists it as a character,
 * a location or a prop, numbered the way the Shots region numbers its cards (the Rig's shot cards in draft order).
 */
export function appearsIn(project: Pick<Project, "nodes" | "production">, variant: CastVariant, name: string): number[] {
  const sheet = project.production?.beats;
  const key = norm(name);
  if (!sheet || !key) return [];
  const field = variant === "cast" ? "characters" : variant === "environment" ? "locations" : "props";
  const ids = new Set(sheet.scenes.filter((scene) => scene[field].some((n) => norm(n) === key)).flatMap((scene) => scene.shots.map((s) => s.id)));
  if (!ids.size) return [];
  const numbers: number[] = [];
  project.nodes.filter(isShotNode).forEach((node, i) => { if (node.boardShotId && ids.has(node.boardShotId)) numbers.push(i + 1); });
  /* Shots the beat sheet has but the Rig has no card for yet still count, in the sheet's own order after the cards'. */
  if (!numbers.length) boardShots(sheet).forEach((s, i) => { if (ids.has(s.id)) numbers.push(i + 1); });
  return numbers;
}

/** "Shots 1 · 2 · 3", or null when it appears in none. */
export function shotsWords(shots: readonly number[]): string | null {
  return shots.length ? `${shots.length === 1 ? "Shot" : "Shots"} ${shots.join(" · ")}` : null;
}

/* ── What a card says about its state ───────────────────────────────────── */

export type CastTone = "done" | "working" | "waiting" | "idle";
export type CastStatus = { text: string; tone: CastTone };

/**
 * The status line. A character's is its identity's, read from the workspace's list (`identities` is null until that
 * answers: the card never claims readiness it has not read); a place's is its plates; an element's is its lock.
 */
export function castStatus(d: CastCardData, identities: readonly SoulIdentity[] | null): CastStatus {
  if (d.retired) return { text: "Built earlier · read-only", tone: "idle" };
  if (d.variant === "cast") {
    if (d.rendering) return { text: "Rendering a still", tone: "working" };
    if (!d.identityId) return { text: "No identity yet", tone: "idle" };
    const identity = identities?.find((i) => i.id === d.identityId);
    if (!identity) return { text: "Identity attached", tone: "idle" };
    if (identity.status === "ready") return { text: `Identity ready · ${identity.name}`, tone: "done" };
    if (identity.status === "failed" || identity.status === "uncertain") return { text: "Identity needs review", tone: "waiting" };
    return { text: "Identity training", tone: "working" };
  }
  if (d.variant === "environment") {
    if (d.rendering) return { text: "Rendering a plate", tone: "working" };
    if (d.chosen) return { text: `Plate chosen · ${d.plates} ${d.plates === 1 ? "plate" : "plates"}`, tone: "done" };
    return d.plates ? { text: `${d.plates} ${d.plates === 1 ? "plate" : "plates"} · none chosen`, tone: "waiting" } : { text: "No plate yet", tone: "idle" };
  }
  if (d.master) return { text: "Locked master", tone: "done" };
  if (d.rendering) return { text: "Rendering a still", tone: "working" };
  return d.still ? { text: "Not locked", tone: "idle" } : { text: "No still yet", tone: "idle" };
}

/** The identity of a character card, from the workspace's list. */
export const identityOf = (d: Pick<CastCardData, "identityId">, identities: readonly SoulIdentity[] | null): SoulIdentity | null =>
  d.identityId ? identities?.find((i) => i.id === d.identityId) ?? null : null;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "12 Sep 2026", in UTC, the same on every machine. */
const dateWords = (ms: number) => { const d = new Date(ms); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };

/**
 * The training consent that exists, in words: "Training consent confirmed 12 Sep 2025 by <name>". It is the record the
 * identity was built with (the box ticked to train on a face), nothing more: no scope, use or end date is stored, so
 * none is said. Never shown without a signed-in person, and never for an identity with no record.
 */
export function consentLine(identity: Pick<SoulIdentity, "consentAt" | "consentBy"> | null | undefined, signedIn: boolean): string | null {
  if (!signedIn || !identity || typeof identity.consentAt !== "number" || !Number.isFinite(identity.consentAt) || identity.consentAt <= 0) return null;
  const when = dateWords(identity.consentAt);
  return `Training consent confirmed ${when}${identity.consentBy ? ` by ${identity.consentBy}` : ""}`;
}

/** What the card's accessible name reads: its title and words, e.g. "Lead · ivory suit, short dark bob". */
export const castLabel = (d: Pick<CastCardData, "title" | "description">) => [d.title.trim(), d.description.trim()].filter(Boolean).join(" · ");

/** The Render a still / Render a plate words handed to Make, and the note it is filed under. */
export function renderPreset(d: CastCardData): { prompt: string; note: string } {
  const what = d.variant === "environment" ? "Plate" : "Reference still";
  return { prompt: d.prompt, note: `${what} · ${d.title.trim() || VARIANT_LABEL[d.variant]}` };
}

/* ── The region ──────────────────────────────────────────────────────── */

export const CAST_GROUP = STUDIO_GROUP.cast;
/** The card id of an entry the canvas does not draw. */
export const entryCardId = (kind: "cast" | "env", id: string) => `cast:${kind}:${id}`;

function nodeCards(src: Pick<BoardSource, "project" | "masters">): { card: BoardCard<CastCardData>; key: string }[] {
  const { project } = src;
  const assets = allAssets(project);
  const entries = project.production?.cast?.entries ?? [];
  return nodesForSet(project, "shots").flatMap(({ node, role }, order) => {
    if (role.kind !== "cast") return [];
    const ref = refKindOf(node, project);
    const variant: CastVariant = ref === "environment" ? "environment" : ref === "element" ? "element" : "cast";
    const asset = resolveAsset(node, project.nodes, assets);
    const master = Boolean(node.elementId && src.masters.has(node.elementId));
    const entry = entries.find((e) => norm(e.name) === norm(node.title));
    const data: CastCardData = {
      variant, source: "node", nodeId: node.id, entryId: entry?.id ?? null, title: node.title, description: (asset?.description ?? node.text ?? "").trim(),
      still: assetStill(asset), shots: appearsIn(project, variant, node.title), identityId: asset?.soulIdentityId ?? entry?.identityId ?? null,
      master, lockable: !master && lockProblem(node, project, false) === null, plates: 0, chosen: false,
      rendering: Boolean(entry?.pending?.length), prompt: (entry ? castStillPrompt(entry) : "") || asset?.prompt?.trim() || (asset?.description ?? "").trim() || node.title.trim(),
      retired: entry ? retiredModelOf(entry) : null,
    };
    return [{ key: `${variant}:${norm(node.title)}`, card: { id: node.id, kind: "cast", region: "cast" as const, order, group: CAST_GROUP, nodeId: node.id, state: cardState(data), data } }];
  });
}

function cardState(d: CastCardData): BoardCard["state"] {
  if (d.rendering) return "working";
  if (d.variant === "environment") return d.chosen ? "done" : "empty";
  if (d.variant === "element") return d.master ? "done" : "empty";
  return d.still ? "done" : "empty";
}

function entryCard(project: Project, entry: CastEntry, order: number): BoardCard<CastCardData> {
  const variant: CastVariant = entry.kind === "character" ? "cast" : entryCategory(entry) === "environment" ? "environment" : "element";
  const shown = entry.selected ?? entry.takes[0]?.genId;
  const reference = entry.referenceAssetId ? allAssets(project).find((a) => a.id === entry.referenceAssetId) : undefined;
  const data: CastCardData = {
    variant, source: "entry", nodeId: null, entryId: entry.id, title: entry.name, description: entry.description.trim(),
    still: shown ? { url: `/api/media/${shown}`, kind: "image" } : assetStill(reference), shots: appearsIn(project, variant, entry.name),
    identityId: entry.identityId ?? null, master: false, lockable: false, plates: 0, chosen: false, rendering: Boolean(entry.pending?.length),
    prompt: castStillPrompt(entry), retired: retiredModelOf(entry),
  };
  return { id: entryCardId("cast", entry.id), kind: "cast", region: "cast", order, group: CAST_GROUP, state: cardState(data), data };
}

function placeCard(project: Project, entry: EnvironmentEntry, world: string, order: number): BoardCard<CastCardData> {
  const assets = allAssets(project);
  const picked = entry.selected ? assets.find((a) => a.id === entry.selected) : undefined;
  const shown = picked ?? (entry.plates.length ? assets.find((a) => a.id === entry.plates[entry.plates.length - 1].assetId) : undefined);
  const data: CastCardData = {
    variant: "environment", source: "entry", nodeId: null, entryId: entry.id, title: entry.name, description: entry.notes.trim(),
    still: assetStill(shown), shots: appearsIn(project, "environment", entry.name), identityId: null, master: false, lockable: false,
    plates: entry.plates.length, chosen: Boolean(picked), rendering: Boolean(entry.pending?.length),
    prompt: entry.prompt.trim() || entry.name.trim() ? platePrompt(entry, world) : "", retired: null,
  };
  return { id: entryCardId("env", entry.id), kind: "cast", region: "cast", order, group: CAST_GROUP, state: cardState(data), data };
}

/** "1 character · 2 places · 1 element". */
export function castSummary(cards: readonly BoardCard<CastCardData>[]): string {
  const n = (v: CastVariant) => cards.filter((c) => c.data.variant === v).length;
  const words: [number, string, string][] = [[n("cast"), "character", "characters"], [n("environment"), "place", "places"], [n("element"), "element", "elements"]];
  return words.filter(([count]) => count > 0).map(([count, one, many]) => `${count} ${count === 1 ? one : many}`).join(" · ");
}

/**
 * The Cast region's cards in production order: characters, then places, then elements, the canvas's reference
 * cards before the production's own list. One group frame holds them.
 */
export function deriveCast(src: Pick<BoardSource, "kind" | "project" | "masters">): BoardCard[] {
  if (src.kind !== "studio") return [];
  const { project } = src;
  const fromNodes = nodeCards(src);
  const drawn = new Set(fromNodes.map((c) => c.key));
  const cards: BoardCard<CastCardData>[] = fromNodes.map((c) => c.card);
  (project.production?.cast?.entries ?? []).forEach((entry, i) => {
    const card = entryCard(project, entry, 1000 + i);
    if (!entry.name.trim() && !entry.description.trim() && !entry.prompt.trim() && !card.data.still) return;
    if (drawn.has(`${card.data.variant}:${norm(entry.name)}`)) return;
    cards.push(card);
  });
  const environment = project.production?.environment;
  (environment?.entries ?? []).forEach((entry, i) => {
    if (!entry.name.trim() && !entry.notes.trim()) return;
    const card = placeCard(project, entry, environment?.world ?? "", 2000 + i);
    if (drawn.has(`environment:${norm(entry.name)}`)) return;
    cards.push(card);
  });
  if (!cards.length) return [];
  const rank: Record<CastVariant, number> = { cast: 0, environment: 1, element: 2 };
  cards.sort((a, b) => rank[a.data.variant] - rank[b.data.variant] || a.order - b.order);
  cards.forEach((card, i) => { card.order = i; });
  const summary = castSummary(cards);
  const group: GroupData = { title: "Cast, environment and elements", meta: summary, columns: 3 };
  return [{ id: CAST_GROUP, kind: "group", region: "cast", order: -1, state: "empty", summary, data: group }, ...cards];
}

