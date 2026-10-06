import type { MediaJob } from "@/lib/workbench/job-recovery";
import type { RigAgentRunView } from "@/lib/workbench/rig-agent-plan";
import type { Project } from "@/lib/workbench/studio";
import type { LibraryEntry } from "@/lib/workspace/library";
import type { RigShot } from "@/lib/workspace/shots";
import type { SampleBoard } from "@/lib/demo/board";

/*
 * The board's card interface (design/particl-graphite/README.md § 1.1, § 3.1):
 * what a card is, as plain data. Pure and server-safe: no React here. The
 * React side (how a card renders and registers) is
 * components/graphite/board/cards/types.ts.
 *
 * A card set derives its cards from the production as it is now; the canvas
 * lays every card out (lib/board/layout.ts) and draws its selection. Cards
 * never position themselves.
 */

export type BoardKind = "studio" | "ads" | "social";
export const BOARD_KINDS: readonly BoardKind[] = ["studio", "ads", "social"];
export const isBoardKind = (value: unknown): value is BoardKind => BOARD_KINDS.includes(value as BoardKind);

export type StudioRegion = "brief" | "looks" | "storyboard" | "shots" | "cast" | "cut" | "deliver";
export type AdsRegion = "brand" | "product" | "hooks" | "formats" | "ads" | "adapt" | "deliver";
export type SocialRegion = "source" | "clips" | "hooks" | "effects" | "posts";
/** `next` is the "Where to next?" band and `made` the "Made in Make" band: laid out, never on the rail. */
export type RegionId = StudioRegion | AdsRegion | SocialRegion | "next" | "made";

/** The rail's four statuses (README § 1.1): needs > working > done > empty when a region rolls its cards up. */
export type CardState = "empty" | "working" | "needs" | "done";

/** A card's box in board units (CSS px at 100 %). */
export type CardSize = { w: number; h: number };
export type BoardPoint = { x: number; y: number };
export type BoardBox = { x: number; y: number; w: number; h: number };

export type BoardCard<D = unknown> = {
  /** Unique on the board. A card that draws a canvas node uses the node id; any other is `${kind}:${key}`, stable across renders. */
  id: string;
  /** The registry key of its definition ("take", "doc", "group", …). */
  kind: string;
  /** The rail section it counts towards and the band it is laid out in. Null: a free card, drawn where `at` says. */
  region: RegionId | null;
  /** Production order inside its region, or inside its group (ties: id). */
  order: number;
  /** The id of the group card it sits in. */
  group?: string;
  /** Set when the card draws a team-canvas node (a shot, a reference, a look board, a note): that node's id. */
  nodeId?: string;
  /** A free card's saved place (its node's x and y). Required when `region` is null. */
  at?: BoardPoint;
  /** Rolled up into the rail. */
  state: CardState;
  /** What waits for a person on this card (the rail's count); 1 when the state is "needs" and this is absent. */
  needs?: number;
  /** The rail's one-line hover summary, e.g. "3 frames · approve to make shots". */
  summary?: string;
  /** Whatever the card's component reads: plain data, no functions. */
  data: D;
};

/** The shared group frame's data. Stream 5 owns the `group` kind; stream 4's Looks and Storyboard groups use it too. */
export type GroupData = { title: string; meta?: string; tone?: "warning" } & Record<string, unknown>;

/** Atomik's run on this production, as today's team-canvas GET `agent=1` answers it. Stream 7 supplies it. */
export type BoardAgentView = RigAgentRunView;

/** What every card set's derive() receives. All of it exists on today's backend. */
export type BoardSource = {
  kind: BoardKind;
  /** The Rig draft (useRig().project): nodes, assets, brief, aspect, fps, production (beats, boards, cast, environment), shots (the sequence). */
  project: Project;
  /** useRig().shots: status, engine, estimate key, issues. */
  shots: readonly RigShot[];
  /** useRig().jobs: the production's jobs, renders and their progress. */
  jobs: readonly MediaJob[];
  /** The project's Library entries (lib/workspace/library useProjectLibrary). */
  library: readonly LibraryEntry[];
  /** Locked element ids (useRig().masters). */
  masters: ReadonlySet<string>;
  /** A board kind's own session data for its cards (stream 11: Ads' pending reads and agent runs), or null. Plain data. */
  extra?: unknown;
  /** Atomik's run on this production; null until stream 7 provides it. */
  agent: BoardAgentView | null;
  /** The explore-only sample production's recorded prices, cast and cut (stream 12, lib/demo); null on any other production. */
  sample?: SampleBoard | null;
  now: number;
};
