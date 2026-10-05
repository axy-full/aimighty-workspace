import type { ComponentType } from "react";
import type { RigContext } from "@/components/workspace/rig/RigProvider";
import type { ContainerSpec } from "@/lib/board/layout";
import type { RailEntry } from "@/lib/board/regions";
import type { BoardCard, BoardKind, BoardSource, CardSize, RegionId } from "@/lib/board/types";
import type { ComposerType } from "@/lib/workspace/composer";
import type { Project } from "@/lib/workbench/studio";

/*
 * The card interface's React side (stream 3's plan § 0; lead decision 26).
 * Streams 4, 5 and 11 build their cards against these types and register
 * them in components/graphite/board/cards/index.ts through their set files.
 * Cards never import React Flow and never position themselves.
 */

/** Something dropped on a card: a Library asset (by its Library id) or another card. */
export type BoardDrop = { type: "asset"; assetId: string; media: "image" | "video" | "audio" | null } | { type: "card"; cardId: string };
/** What a drop does. The canvas runs it through the existing Rig path; `reference` is rig-build's addInput. */
export type DropAction = { type: "reference"; shotId: string; assetId: string };

export type BoardSelection = { primary: string | null; ids: ReadonlySet<string> };

export type BoardCtx = {
  kind: BoardKind;
  scope: string;
  project: Project;
  /** The production's id on the team canvas, once the project has one. */
  productionId: string | null;
  /** The board is read-only: no drags; a spending button reads "Needs a connection". */
  offline: boolean;
  selection: BoardSelection;
  select(id: string | null, opts?: { add?: boolean }): void;
  /** Glides the board to a region, or to a card (.35 s, the design's easing). */
  glide(to: RegionId | { card: string }): void;
  /** Selects the card; stream 5's Inspector opens over the board's right edge. */
  openInspector(id: string): void;
  /** Review mode (stream 5 provides it). A no-op until then. */
  openReview(takeId?: string): void;
  /** The docked Atomik panel with these words, never sent (stream 7 provides it). A no-op until then. */
  askAtomik(words: string): void;
  /** Make's panel, on a type (stream 6, through the shell). */
  openMake(type?: ComposerType): void;
  /** The shell's toast; `undo` puts the step on the shell's ⌘Z stack. */
  toast(text: string, undo?: { label: string; run: () => void }): void;
  /** The existing Rig seam: apply, patchShot, select, generate, quote, team, masters… */
  rig: RigContext;
};

export type CardProps<D> = { card: BoardCard<D>; data: D; selected: boolean; ctx: BoardCtx };

export type CardDef<D = unknown> = {
  kind: string;
  /** The card's exact box. The layout needs it before anything renders; longer content scrolls inside or is clamped. */
  size: (data: D, at: { aspect: string }) => CardSize;
  /** A group: its children are laid out inside it and its size comes from them (size() is its size while empty). */
  container?: ContainerSpec | ((data: D) => ContainerSpec);
  Card: ComponentType<CardProps<D>>;
  /** Its body in stream 5's Inspector; absent: the Inspector's nearest-frame default. */
  Inspector?: ComponentType<CardProps<D>>;
  /** What a drop on this card does; null refuses it. */
  accepts?: (drop: BoardDrop, card: BoardCard<D>) => DropAction | null;
  /** Double-click or Enter on the card. */
  onOpen?: (card: BoardCard<D>, ctx: BoardCtx) => void;
};

declare const erased: unique symbol;
/** A definition with its data type erased, as a set holds it. Make one with defineCard(). */
export type AnyCardDef = { readonly [erased]: true; kind: string };

/** Registers a typed definition: `defineCard<TakeData>({ kind: "take", … })`. */
export function defineCard<D>(def: CardDef<D>): AnyCardDef {
  return def as unknown as AnyCardDef;
}
/** The registry's view of a definition (its data is whatever the card set derived). */
export const cardDef = (def: AnyCardDef) => def as unknown as CardDef<unknown>;

/** One stream's cards: their definitions, and which cards it puts on the board. */
export type CardSet = {
  id: string;
  defs: readonly AnyCardDef[];
  /** Pure and cheap: called on every change. Lays nothing out. */
  derive: (src: BoardSource) => BoardCard[];
  /** The board's List view (stream 4 owns the drawn table, lead decision 28); a later set's replaces an earlier one's. */
  List?: ComponentType<{ ctx: BoardCtx; cards: readonly BoardCard[] }>;
};

/** A board kind: Studio (stream 3), Ads and Social (stream 11). */
export type BoardKindModule = {
  kind: BoardKind;
  rail: readonly RailEntry[];
  /** The layout's bands, top to bottom; regions in a band sit side by side. */
  bands: readonly (readonly RegionId[])[];
  /** Its card sets; the canvas adds stream 3's board set (free cards, fallbacks) first. */
  sets: readonly CardSet[];
  /** The empty board; absent: the canvas shows its dots and the rail. */
  Empty?: ComponentType<{ ctx: BoardCtx }>;
};
