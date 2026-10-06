import { priceSum, priceWords, type PriceValue } from "@/lib/shell/price-words";

/**
 * The approvals queue: everything that waits for a person, across every
 * project, as one list. It is the only queue model: the control room's
 * Approvals, Home's "Waiting for you", ⌘K's "approve everything under N cr"
 * and the phone's "Needs you" all read it, so every screen shows the same
 * items at the same prices.
 *
 * Pure. The server builds the items from the durable records that wait today
 * (lib/control-room/approvals.server.ts, read through GET
 * /api/control-room/approvals); screens read them, choose from them and press
 * through each item's own existing path (lib/control-room/approve.ts). Nothing
 * here formats money by hand: a price is a number and a kind, worded by
 * lib/shell/price-words.ts.
 *
 * Three things wait for a person today, each with its own approval:
 *  - a take held at zero credits (lib/held.ts), released at the price it was
 *    approved at;
 *  - Atomik's work on a board (lib/workbench/rig-agent*.ts): a proposed build,
 *    or one priced render, approved only by the person who asked;
 *  - a step of an Atomik plan (lib/atomik.ts), approved one at a time with
 *    the plan's own Continue, at its live price.
 * A plan is not approved in one tap: its next step is the item.
 */

export type QueueSource = "held" | "board-plan" | "board-render" | "thread";

/**
 * What an item costs: the server's figure and its kind, exactly as
 * lib/shell/price-words.ts words it ("43 cr", "up to 69 cr", "free"), passed
 * to Price as is. `exact`: the charge is this figure. `up-to`: the charge
 * can't go above it. `free`: nothing is charged. Null when there is no figure
 * to show: nothing has priced it yet, or the workspace is not billed in
 * credits (the reply says which: ApprovalsReply.inCredits).
 */
export type QueuePrice = PriceValue | null;

/** The project an item belongs to: its production, this viewer's own draft of it (for Home's cards), and its name. */
export type QueueProject = { productionId: string | null; draftId: string | null; name: string | null };

/** How an item is approved: its own existing person-only path, with its own price or fingerprint. */
export type ApproveRef =
  | { kind: "release"; genId: string; credits: number }
  /* A proposed build (free), or with `plan` the plan's one approval at the server's total (its quote fingerprint). */
  | { kind: "board-approve"; productionId: string; runId: string; fingerprint: string; plan?: boolean }
  | { kind: "board-render"; productionId: string; runId: string; seq: number; fingerprint: string }
  /* A plan's step: approved by the plan's own Continue, at its live price (ThreadCheckpoint). */
  | { kind: "thread"; chatId: string; stepId: string; productionId: string | null };

/** "Not now": the item's own existing path. Nothing is charged by any of them. */
export type DeclineRef =
  | { kind: "discard"; genId: string }
  | { kind: "board-decline"; productionId: string; runId: string }
  | { kind: "board-skip"; productionId: string; runId: string; seq: number }
  | { kind: "thread-stop"; stepId: string };

/** Where Open goes. */
export type OpenRef =
  | { kind: "take"; genId: string; draftId: string | null }
  | { kind: "board"; productionId: string; draftId: string | null }
  | { kind: "thread"; chatId: string; productionId: string | null };

export type QueueItem = {
  /** Stable across reads: `<source>:<record id>`. */
  id: string;
  source: QueueSource;
  title: string;
  /** Where it was made, in the product's words: "Board", "Make" or "Atomik". */
  where: string;
  /** When it started waiting. */
  at: number;
  project: QueueProject;
  price: QueuePrice;
  /** Over the workspace's per-shot rule: an admin presses it, and Approve in one go leaves it out. */
  needsAdmin: boolean;
  /** This viewer may press Approve now. */
  canApprove: boolean;
  /** Why not, in the product's words, when they may not. */
  why: string | null;
  /** How many credits the balance is short by, when it is. */
  shortBy: number | null;
  /** One more line: a plan's step, the reason a render paused, what a held take waits for. */
  note: string | null;
  /** For a plan's step: which step and how many. */
  step: { n: number; of: number } | null;
  /** The sample production: nothing in it spends credits. */
  sample: boolean;
  approve: ApproveRef | null;
  decline: DeclineRef | null;
  open: OpenRef;
};

/**
 * What the ledger shows for something sent: settled at a figure, not settled
 * yet, or nothing charged (only where the ledger confirms it, or nothing was
 * ever sent). `unbilled`: the workspace is not billed in credits. `unknown`:
 * the ledger holds no row for it, so no figure is shown.
 */
export type Outcome = { kind: "settled"; credits: number } | { kind: "settling" } | { kind: "nothing" } | { kind: "unbilled" } | { kind: "unknown" };

/** A decision taken in the last days, as the Decided list shows it. */
export type DecidedItem = {
  id: string;
  title: string;
  project: QueueProject;
  /** "approved", "released", "skipped", "set aside", "turned down", or Auto's "spent without asking". */
  what: string;
  /** Who decided, under the usage ledger's naming rule; null when the record does not say. */
  by: string | null;
  byYou: boolean;
  at: number;
  outcome: Outcome;
};

export type ApprovalsReply = {
  items: QueueItem[];
  decided: DecidedItem[];
  /** The workspace pays in credits. */
  inCredits: boolean;
};

/* ── Prices ────────────────────────────────────────────────────────────── */

/** The credits behind a price, or null when it has none to count. */
export function priceCredits(price: QueuePrice): number | null {
  if (!price) return null;
  return price.kind === "free" ? 0 : price.credits;
}

/** The price as every screen says it ("43 cr", "up to 69 cr", "free"), or "" when there is none to say. */
export function priceLabel(price: QueuePrice): string {
  return priceWords(price) ?? "";
}

/** Said in place of a figure where a workspace is not billed in credits. */
export const UNBILLED = "not billed in credits";

/* ── The list ──────────────────────────────────────────────────────────── */

/** Oldest first: the order held takes are released in, so the balance is never spent out of turn. */
export function sortQueue(items: readonly QueueItem[]): QueueItem[] {
  return [...items].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

/** "4 items across 2 projects". */
export function countLine(items: readonly QueueItem[]): string {
  const projects = new Set(items.map((i) => i.project.productionId ?? i.project.name ?? "")).size;
  return `${items.length} ${items.length === 1 ? "item" : "items"} across ${projects} ${projects === 1 ? "project" : "projects"}`;
}

/** How many items wait in each of this viewer's projects (by draft id), for Home's project cards. */
export function countsByDraft(items: readonly QueueItem[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of items) {
    const draft = item.project.draftId;
    if (draft) out.set(draft, (out.get(draft) ?? 0) + 1);
  }
  return out;
}

/**
 * An item a person can press here. A plan's step opens its Continue, which
 * prices it live before anything is sent; every other item needs a price the
 * screen can show.
 */
export function pressable(item: QueueItem): boolean {
  if (!item.canApprove || item.sample || item.approve === null) return false;
  return item.approve.kind === "thread" || item.price !== null;
}

/**
 * May this item go in "Approve in one go"? Only an item with a one-call path
 * (a held take's release, a board render), a credit price, this viewer's to
 * press, within the per-shot rule, with the balance to cover it, and not in
 * the sample. A plan's step keeps its own Continue; a proposed build is
 * approved on its own.
 */
export function batchable(item: QueueItem): boolean {
  if (!pressable(item) || item.needsAdmin || (item.shortBy ?? 0) > 0) return false;
  if (item.approve?.kind !== "release" && item.approve?.kind !== "board-render") return false;
  return item.price !== null && item.price.kind !== "free";
}

export type Batch = {
  /** What one tap approves, in the order it is sent. */
  items: QueueItem[];
  /** Under the figure but over the per-shot rule: listed, and left out. */
  adminOut: QueueItem[];
  /** Under the figure but a plan's step: approved in its own plan. */
  inPlan: QueueItem[];
  /** What the batch approves, as one price ("up to" if any part is); null when it is empty. */
  total: QueuePrice;
};

/** Priced, not free, and under the figure: what "everything under N cr" can cover. */
const below = (item: QueueItem, under: number) => {
  const credits = priceCredits(item.price);
  return credits !== null && item.price?.kind !== "free" && credits < under;
};

/** "Approve everything under N cr": the items it covers, what it leaves out, and its total. */
export function selectBatch(items: readonly QueueItem[], under: number): Batch {
  const sorted = sortQueue(items);
  const batch = sorted.filter((item) => batchable(item) && below(item, under));
  return {
    items: batch,
    adminOut: sorted.filter((item) => item.needsAdmin && below(item, under) && !item.sample),
    inPlan: sorted.filter((item) => item.source === "thread" && below(item, under) && !item.needsAdmin && !item.sample),
    total: batch.length ? priceSum(batch.map((item) => item.price)) : null,
  };
}

/** The figure typed in "Everything under · credits": a whole number from 1, else the default. */
export const BATCH_UNDER_DEFAULT = 10;
export function cleanUnder(value: unknown): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 1_000_000) : BATCH_UNDER_DEFAULT;
}
