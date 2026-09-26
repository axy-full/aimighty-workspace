/**
 * Credits said as takes: "400 cr ≈ 22 videos or 133 images".
 *
 * Browser-safe. The server prices one take at named settings with the same
 * quote the composer's button uses (lib/workbench/media-reach.ts →
 * quoteWorkbenchMedia) and sends only the credit figure; everything here is
 * the division and the wording, so no rate, margin or vendor dollar is needed
 * on this side of the wire.
 */

export type ReachKind = "video" | "image";

/** One take at named settings, priced in credits. */
export type PricedTake = {
  kind: ReachKind;
  engine: string;
  /** The engine's display name ("Seedance 2.5"). */
  label: string;
  resolution: string;
  ratio: string;
  /** Seconds, for a video; null for a still. */
  durationS: number | null;
  /** Whether the take was priced with sound (per-second engines charge more for it). */
  audio: boolean;
  credits: number;
};

/** Where a workspace's reference take came from: its own recent takes, or the defaults. */
export type ReachBasis = "usual" | "default";
export type WorkspaceTake = PricedTake & { basis: ReachBasis; left: number };
export type WorkspaceReach = { video: WorkspaceTake | null; image: WorkspaceTake | null };

/** What a plan's monthly credits come to at the reference settings. */
export type TakeReach = { videos: number | null; images: number | null };
export type ReferenceTakes = { video: PricedTake | null; image: PricedTake | null };

export type RateCell = { option: string; credits: number };
/** One engine's prices; `audio` marks the row priced with sound (only where sound moves the price). */
export type RateRow = { engine: string; label: string; audio: boolean; cells: RateCell[] };
/** What a group's columns are: a video's resolution, a still's pixel size, or a still's quality. */
export type RateAxis = "resolution" | "size" | "quality";
/** One kind's rows on one axis; `seconds` is the length every video cell is priced at. */
export type RateGroup = { kind: ReachKind; axis: RateAxis; seconds: number | null; rows: RateRow[] };

const QUALITIES = ["low", "medium", "high"];
/** A still engine whose options are qualities (Low · Medium · High) rather than sizes. */
export const byQuality = (options: readonly string[]) => options.length > 0 && options.every((o) => QUALITIES.includes(o.toLowerCase()));

/**
 * Whether a rate-card cell is exactly the take a figure was counted at: same
 * engine, size, sound and length, and the same price. A take whose aspect or
 * length prices differently from the card's cell is not outlined, so an
 * outline never claims a price the figure did not use.
 */
export function isTakeCell(take: PricedTake | null | undefined, group: Pick<RateGroup, "seconds">, row: Pick<RateRow, "engine" | "audio">, cell: RateCell): boolean {
  if (!take || take.engine !== row.engine || take.resolution !== cell.option || take.audio !== row.audio || take.credits !== cell.credits) return false;
  return take.kind === "image" || take.durationS === group.seconds;
}

/** Whole takes a number of credits buys; null when either side is unknown. */
export function takesWithin(credits: number | null | undefined, perTake: number | null | undefined): number | null {
  if (typeof credits !== "number" || !Number.isFinite(credits)) return null;
  if (typeof perTake !== "number" || !Number.isFinite(perTake) || perTake <= 0) return null;
  return Math.max(0, Math.floor(credits / perTake + 1e-9));
}

/**
 * Takes left from the balance the page is showing right now. The server's
 * `left` was counted from the balance when it answered; the page's balance
 * refreshes on its own (lib/workspace/data.ts), so the count follows it and
 * the two can never disagree on screen. The server's figure is the fallback.
 */
export function leftFrom(balance: number | null | undefined, take: Pick<WorkspaceTake, "credits" | "left">): number {
  return takesWithin(balance, take.credits) ?? take.left;
}

/** A plan's monthly credits as takes at the reference settings. */
export function reachFor(credits: number, reference: ReferenceTakes): TakeReach {
  return {
    videos: takesWithin(credits, reference.video?.credits),
    images: takesWithin(credits, reference.image?.credits),
  };
}

/** Western grouping regardless of the viewer's locale: "1,300". */
export const grouped = (n: number) => n.toLocaleString("en-US");

/** "4K", "2K", "720p", "1K", "Medium" — how a size option is printed. */
export function optionLabel(option: string): string {
  if (/^\d+k$/i.test(option)) return option.toUpperCase();
  if (/^\d+$/.test(option)) return `${option} px`;
  return option;
}

const OPTION_ORDER = ["480p", "512", "720p", "1k", "1080p", "2k", "4k", "low", "medium", "high"];
/** Size options smallest first, qualities low to high; anything unknown keeps its place at the end. */
export function sortOptions(options: readonly string[]): string[] {
  const rank = (o: string) => {
    const i = OPTION_ORDER.indexOf(o.toLowerCase());
    return i < 0 ? OPTION_ORDER.length : i;
  };
  return [...options].sort((a, b) => rank(a) - rank(b));
}

/** "Seedance 2.5 · 720p · 5 s" — the settings a figure was priced at. */
export function takeSettings(take: Pick<PricedTake, "label" | "resolution" | "durationS" | "audio">): string {
  return [take.label, optionLabel(take.resolution), take.durationS ? `${take.durationS}\u00a0s` : null, take.audio ? "sound" : null]
    .filter(Boolean)
    .join(" · ");
}

/** "18 cr each" — what one take at those settings is charged. */
export const eachLine = (take: Pick<PricedTake, "credits">) => `${grouped(take.credits)} cr each`;

/** The same settings as a screen reader should say them: "Seedance 2.5, 720p, 5 seconds, 18 credits each". */
export function spokenSettings(take: Pick<PricedTake, "label" | "resolution" | "durationS" | "audio" | "credits">): string {
  return [take.label, optionLabel(take.resolution), take.durationS ? `${take.durationS} seconds` : null, take.audio ? "with sound" : null, `${grouped(take.credits)} ${take.credits === 1 ? "credit" : "credits"} each`]
    .filter(Boolean)
    .join(", ");
}

/** "video" / "videos", "image" / "images". */
export const nounFor = (kind: ReachKind, n: number | null) => (kind === "video" ? (n === 1 ? "video" : "videos") : n === 1 ? "image" : "images");
