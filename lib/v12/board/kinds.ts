/**
 * The new interface's board kinds (docs/redesign/inventory.md § 6.1, § 6.3; docs/redesign-plan.md P2-a).
 *
 * A kind is what a person picks: Film, Pre-vis, Campaign, Social (narrated) or Social (clips). Today's board has three
 * kinds of data (lib/board/kind.ts: studio, ads, social), so each kind sits over one of them, and the rail is the kind's
 * own list of stages (lib/v12/board/stages.ts) over that data's regions. A Pre-vis board is a Studio board with the
 * Pre-vis rail; a Social board is a Social board whose rail is narrated or clips.
 *
 * The kind is kept in the project's draft as `boardFlavor` (lib/workbench/studio-schema.ts): an optional field of the
 * draft JSON, saved and merged like the rest of the draft. No database change. Absent, it is read from the board's kind.
 *
 * Pure: no React.
 */
import type { BoardKind } from "@/lib/board/types";

export type Flavor = "film" | "previs" | "campaign" | "narrated" | "clips";
export const FLAVORS: readonly Flavor[] = ["film", "previs", "campaign", "narrated", "clips"];
export const isFlavor = (value: unknown): value is Flavor => FLAVORS.includes(value as Flavor);

/** The rail's kind label (§ 6.2), shown in capitals. */
export const FLAVOR_LABEL: Record<Flavor, string> = { film: "Film", previs: "Pre-vis", campaign: "Campaign", narrated: "Social · narrated", clips: "Social · clips" };

/** The data each kind sits over: today's board kind. */
export const FLAVOR_BOARD: Record<Flavor, BoardKind> = { film: "studio", previs: "studio", campaign: "ads", narrated: "social", clips: "social" };

/** What a board of a given data kind is when nothing says otherwise. */
export const DEFAULT_FLAVOR: Record<BoardKind, Flavor> = { studio: "film", ads: "campaign", social: "clips" };

/** The kind of a board: the draft's own when it sits over this data kind, else the data kind's default. */
export function flavorOf(kind: BoardKind, saved: unknown): Flavor {
  return isFlavor(saved) && FLAVOR_BOARD[saved] === kind ? saved : DEFAULT_FLAVOR[kind];
}

/** The kind after this one, as the rail's label cycles (§ 6.2). */
export const nextFlavor = (flavor: Flavor): Flavor => FLAVORS[(FLAVORS.indexOf(flavor) + 1) % FLAVORS.length];

/** The four kind cards of the new-board flow (§ 6.3). Social stands for narrated or clips: the words decide. */
export type KindCard = "film" | "previs" | "campaign" | "social";
export const KIND_CARDS: readonly { id: KindCard; name: string; line: string }[] = [
  { id: "film", name: "Film", line: "An AI film or ad, ending in masters." },
  { id: "previs", name: "Pre-vis", line: "Boards and an animatic for a live-action shoot." },
  { id: "campaign", name: "Campaign", line: "A product’s ads and content." },
  { id: "social", name: "Social", line: "Narrated, faceless or clip-based videos." },
];

/** Narrated or clips, from what was typed: a link or a video with no "topic" is clips. */
export function socialFlavor(text: string): Flavor {
  return /http|video|clip|youtube|reel/i.test(text) && !/topic/i.test(text) ? "clips" : "narrated";
}

/** The kind a card means for these words. */
export function flavorForCard(card: KindCard, text: string): Flavor {
  return card === "social" ? socialFlavor(text) : card;
}

/** The kind card the words suggest when none is picked (prototype L638), and Film when they say nothing. */
export function detectCard(text: string): KindCard {
  if (/product page|\.com\/|campaign|ads? for|packshot/i.test(text)) return "campaign";
  if (/topic|reel|short|youtube|clip|long video|faceless|narrat/i.test(text)) return "social";
  if (/agency|script attached|shoot|live[- ]action|ppm|pre-?vis|boards/i.test(text)) return "previs";
  return "film";
}

/** The new-board composer's words, by the picked kind (§ 6.3). `null`: no kind picked yet. */
export type Composer = {
  title: string;
  placeholder: string;
  attach: string;
  /** Chips row 1 and row 2: a label and its choices. */
  chips: readonly { id: "length" | "aspect" | "platform"; label: string; options: readonly string[] }[];
};
const LENGTHS = ["15 s", "30 s", "60 s"] as const;
/** The length the composer opens on (the prototype's). */
export const COMPOSER_LENGTH = "30 s";
const ASPECTS = ["16:9", "9:16", "1:1"] as const;
export const COMPOSER: Record<KindCard | "none", Composer> = {
  none: { title: "What are we making?", placeholder: "A film, an ad, a product, or a topic. Pick a kind above, or just describe it.", attach: "Attach a script or boards", chips: [] },
  film: { title: "Describe the film", placeholder: "Describe the film. Who it’s for, what it must show, the feeling.", attach: "Attach a script or references",
    chips: [{ id: "length", label: "Length", options: LENGTHS }, { id: "aspect", label: "Aspect", options: ASPECTS }] },
  previs: { title: "Paste or attach the agency script", placeholder: "Paste or attach the agency script.", attach: "Attach the script, the boards PDF or references",
    chips: [{ id: "length", label: "Length", options: LENGTHS }] },
  campaign: { title: "Paste the product page link", placeholder: "Paste the product page link.", attach: "Attach packshots", chips: [] },
  social: { title: "A topic, or a long video link", placeholder: "A topic, or a long video link.", attach: "Attach a long video",
    chips: [{ id: "platform", label: "Platform", options: ["Reels", "Shorts", "YouTube"] }, { id: "length", label: "Length", options: LENGTHS }] },
};

/** What Atomik says it will do first, by kind (prototype L638), before the price of its thinking. */
export const FIRST_LINE: Record<Flavor, string> = {
  film: "I’ll write the brief and a first script, then cast and boards. Approvals come before anything is spent.",
  previs: "I read the script: shots, cast and locations come next, then boards, an animatic and the PPM deck for the client.",
  campaign: "I’ll read the product page and show the brand kit, product facts and a reference ad for your review before anything is made.",
  narrated: "Three opening hooks first, then the script, scenes, a voice and captions.",
  clips: "I’ll find the moments worth clipping, with reasons, then cut 9:16 clips with captions.",
};

/** A new board's name: the first four words of what was typed (links dropped), then the kind. */
export function boardName(text: string, flavor: Flavor): string {
  const words = text.replace(/https?:\S+/g, "").trim().split(/\s+/).filter(Boolean).slice(0, 4).join(" ").replace(/[.,;:]+$/, "");
  const head = words ? words.charAt(0).toUpperCase() + words.slice(1) : "New board";
  return `${head} · ${flavor === "previs" ? "pre-vis" : flavor === "narrated" || flavor === "clips" ? "social" : flavor}`;
}
