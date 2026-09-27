import { libraryId, libraryName, type LibraryAsset } from "../genLibrary";
import { failureKind } from "../jobState";
import { engineLabel } from "./engines";

/**
 * The Takes page: the project library (GET /api/workbench/library →
 * listProjectLibrary) as cards. Uploads and generations together.
 *
 * Money: `credits` is the ledger's billed figure (Generation.creditsBilled),
 * never an estimate. A failed or cancelled render is not billed and says so.
 * A render still in flight has not settled and carries no figure. Uploads
 * cost nothing and show none. A workspace on its own keys is billed in
 * dollars (Generation.costUsd); that figure is carried as `usd` and the
 * credits stay null — the subtitle counts credits only.
 *
 * Integrity: uploads always carry their stored sha256. A generation carries
 * one only when its original was stored byte-for-byte and hashed
 * (params.originalSha256, the connected-account path through
 * storeOriginalBytes); other renders have no persisted digest, so null.
 */

export type TakeStatus = "approved" | "picked" | "changes" | "review" | "rendering" | "failed" | "uploaded";

export type Take = {
  /** Library id, `generation:<id>` or `upload:<id>` (lib/genLibrary.ts libraryId). */
  id: string;
  /** The generation or upload id. */
  sourceId: string;
  kind: "GEN" | "UPLOAD";
  name: string;
  /** "v2". */
  version: string;
  /** "2.5 · 5s" or "4032×3024 · JPEG" / "1920×1080 · MP4 · 12s". */
  meta: string;
  /** Billed credits once settled (failed → 0); null for uploads, renders in flight and non-credit billing. */
  credits: number | null;
  /** Billed dollars, only for a workspace billed in dollars. */
  usd: number | null;
  status: TakeStatus;
  failedUnbilled?: true;
  /** A take stopped before it rendered (a held take discarded): filed under `failed`, but nothing went wrong. */
  cancelled?: true;
  /** Where a render that has not settled is: waiting its turn, on the engine, or parked for credits. */
  stage?: TakeStage;
  /** One line on why a take failed or is held ("Refused by the content filter", "Needs 12 cr"). */
  reason?: string;
  /** The row's own words behind `reason`, for a tooltip; only when they say more. */
  detail?: string;
  sha256: string | null;
  createdAt: number;
};

/** A render in flight: queued (or waiting for a slot), on the engine, or held until credits arrive. */
export type TakeStage = "queued" | "rendering" | "held";

const SHA = /^[a-f0-9]{64}$/;
const seconds = (n: number) => `${Number.isInteger(n) ? n : Math.round(n * 10) / 10}s`;

function extension(filename: string, mime: string): string {
  const ext = /\.([a-z0-9]{1,8})$/i.exec(filename)?.[1] ?? mime.split("/")[1] ?? "";
  const upper = ext.toUpperCase();
  return upper === "JPG" ? "JPEG" : upper === "QUICKTIME" ? "MOV" : upper;
}

export function projectTakes(assets: readonly LibraryAsset[]): Take[] {
  return assets.map((asset): Take => {
    if (asset.origin === "upload") {
      const u = asset.value;
      const parts = [u.width && u.height ? `${u.width}×${u.height}` : "", extension(u.filename, u.mime),
        u.durationS != null && u.durationS > 0 ? seconds(u.durationS) : ""].filter(Boolean);
      return { id: libraryId(asset), sourceId: u.id, kind: "UPLOAD", name: libraryName(asset), version: "v1", meta: parts.join(" · "),
        credits: null, usd: null, status: "uploaded", sha256: SHA.test(u.sha256) ? u.sha256 : null, createdAt: u.createdAt };
    }
    const g = asset.value;
    const label = engineLabel(g.model).short;
    const length = g.durationS ?? (typeof g.params.duration === "number" ? g.params.duration : null);
    const detail = g.kind === "image" ? (typeof g.params.resolution === "string" ? g.params.resolution : typeof g.params.ratio === "string" ? g.params.ratio : "")
      : length != null && length > 0 ? seconds(length) : "";
    const failed = g.status === "failed" || g.status === "cancelled";
    const settled = failed || g.status === "succeeded";
    const billedCredits = g.providerCreditQuote ? null : g.creditsBilled;
    const status: TakeStatus = failed ? "failed" : g.status !== "succeeded" ? "rendering"
      : g.reviewState === "approved" ? "approved" : g.reviewState === "picked" ? "picked" : g.reviewState === "changes" ? "changes" : "review";
    const unbilled = failed && !((billedCredits ?? 0) > 0) && !((g.costUsd ?? 0) > 0);
    const sha = typeof g.params.originalSha256 === "string" && SHA.test(g.params.originalSha256) ? g.params.originalSha256 : null;
    const stage = status === "rendering" ? takeStage(g) : null;
    const why = failed ? failureReason(g) : stage === "held" || (stage === "queued" && g.status === "held") ? heldReason(g.params) : null;
    return {
      id: libraryId(asset), sourceId: g.id, kind: "GEN", name: libraryName(asset), version: `v${g.version}`,
      meta: [label, detail].filter(Boolean).join(" · "),
      credits: !settled ? null : unbilled ? 0 : billedCredits ?? null,
      usd: !settled ? null : unbilled ? (g.costUsd == null ? null : 0) : g.costUsd ?? null,
      status, ...(unbilled ? { failedUnbilled: true as const } : {}), ...(g.status === "cancelled" ? { cancelled: true as const } : {}),
      ...(stage ? { stage } : {}), ...(why ? { reason: why.reason, ...(why.detail ? { detail: why.detail } : {}) } : {}),
      sha256: sha, createdAt: g.createdAt,
    };
  });
}

type Row = { status: string; error?: string | null; params?: Record<string, unknown> | null };
type HeldParams = { held?: { needs?: unknown; why?: unknown } };

/** Held for slots is a place in the line (Queued); held for credits waits on a top-up (Held). */
export function takeStage(g: Pick<Row, "status" | "params">): TakeStage {
  if (g.status === "running") return "rendering";
  if (g.status === "held") return (g.params as HeldParams | null | undefined)?.held?.why === "slots" ? "queued" : "held";
  return g.status === "queued" ? "queued" : "rendering";
}

/** "Needs 12 cr" for a take parked at zero (lib/held.ts heldInfo), or the slot it waits for. */
export function heldReason(params: Row["params"]): { reason: string; detail?: string } {
  const held = (params as HeldParams | null | undefined)?.held;
  if (held?.why === "slots") return { reason: "Waiting for a free slot" };
  const needs = typeof held?.needs === "number" && Number.isFinite(held.needs) && held.needs > 0 ? Math.ceil(held.needs) : null;
  return needs == null ? { reason: "Waiting for credits" } : { reason: `Needs ${needs.toLocaleString("en-US")} cr`, detail: "Starts on its own when credits arrive." };
}

/** First sentence of an engine message, without URLs, ids or JSON, capped for one line. */
function firstLine(message: string): string {
  const plain = message.replace(/https?:\/\/\S+/g, "").replace(/[{[][\s\S]*$/, "").replace(/\s+/g, " ").trim();
  const sentence = /^(.{8,}?[.!?])(\s|$)/.exec(plain)?.[1] ?? plain;
  return sentence.length > 120 ? `${sentence.slice(0, 117).trimEnd()}…` : sentence;
}

/**
 * Why a take failed, in one line a card can carry (lib/jobState.ts failureKind
 * reads the row's own words). The row's message rides along as `detail` when
 * it says more, for the tooltip. Failure state alone does not establish the
 * provider's billing outcome.
 */
export function failureReason(g: Row): { reason: string; detail?: string } {
  const raw = (g.error ?? "").trim();
  const detail = raw ? firstLine(raw) : "";
  const same = (a: string, b: string) => a.replace(/[.!?\s]+$/, "").toLowerCase() === b.replace(/[.!?\s]+$/, "").toLowerCase();
  const withDetail = (reason: string) => (detail && !same(detail, reason) ? { reason, detail } : { reason });
  /* Stopped on purpose (a held take discarded): its own words say so ("Discarded before it started."). */
  if (g.status === "cancelled") return { reason: detail || "Stopped before it rendered" };
  /* The row's own words first; why a take was parked only when they say nothing. */
  const said = raw ? failureKind(raw) : "unknown";
  switch (said !== "unknown" ? said : failureKind(raw, g.params)) {
    case "refused": return withDetail("Refused by the content filter");
    case "cap": return withDetail("The production is at its cap");
    case "balance": return withDetail("Out of credits");
    case "slots": return withDetail("Every render slot was busy");
    case "vendor": return withDetail(/timed out|timeout|never came back/i.test(raw) ? "The engine timed out" : "The engine hit an error");
    default: return detail ? { reason: detail } : { reason: "Did not render" };
  }
}

export type ChipTone = "idle" | "live" | "waiting" | "failed" | "picked" | "done";
export type TakeChip = { label: string; tone: ChipTone };

/**
 * The card's status chip (Queued / Rendering / Held / Failed /
 * Cancelled / Picked / Approved / Changes). A take waiting for review and an
 * upload carry none. Billing outcomes must be confirmed separately.
 */
export function takeChip(take: Pick<Take, "status" | "stage" | "cancelled">): TakeChip | null {
  switch (take.status) {
    case "rendering": return take.stage === "held" ? { label: "Held", tone: "waiting" } : take.stage === "queued" ? { label: "Queued", tone: "idle" } : { label: "Rendering", tone: "live" };
    case "failed": {
      const word = take.cancelled ? "Cancelled" : "Failed";
      return { label: word, tone: take.cancelled ? "idle" : "failed" };
    }
    case "picked": return { label: "Picked", tone: "picked" };
    case "approved": return { label: "Approved", tone: "done" };
    case "changes": return { label: "Changes", tone: "waiting" };
    default: return null;
  }
}

/** The status in words, where there is room for all of them (the Inspector's facts). */
export function takeStatusWord(take: Pick<Take, "status" | "stage" | "cancelled">): string {
  return takeChip(take)?.label ?? (take.status === "uploaded" ? "Uploaded" : "In review");
}

/** The failure or hold reason, independent of the billing outcome. */
export function takeReasonLine(take: Pick<Take, "reason">): string | null {
  return take.reason || null;
}

/* ── The Takes desk (Studio › Takes): review filters and review words ──── */

/**
 * The desk's status filters. They read the same fields as the chips above
 * (`status` and `stage`), so a filter and a card never disagree: Held is the
 * card that says Held, Failed is everything filed under failed (a take
 * stopped before it rendered wears Cancelled, and is here too).
 */
export const DESK_FILTERS = [
  { id: "all", label: "All" },
  { id: "review", label: "Needs review" },
  { id: "picked", label: "Picked" },
  { id: "approved", label: "Approved" },
  { id: "changes", label: "Changes" },
  { id: "held", label: "Held" },
  { id: "failed", label: "Failed" },
] as const;
export type DeskFilter = (typeof DESK_FILTERS)[number]["id"];

export function inDeskFilter(take: Pick<Take, "status" | "stage">, filter: DeskFilter): boolean {
  switch (filter) {
    case "all": return true;
    case "held": return take.status === "rendering" && take.stage === "held";
    default: return take.status === filter;
  }
}

/** What PATCH /api/jobs/:id takes as `reviewState`: picked, approved, changes, or "" for back to review. */
export type ReviewState = "" | "picked" | "approved" | "changes";

/** A review button pressed on a take already in that state clears it (back to Needs review), as the wall's buttons always did. */
export function nextReview(current: TakeStatus, pressed: Exclude<ReviewState, "">): ReviewState {
  return current === pressed ? "" : pressed;
}

/** What a review did, and where the take now waits. */
export function reviewSaid(name: string, state: ReviewState): string {
  switch (state) {
    case "picked": return `${name} is picked. It waits under Picked for approval.`;
    case "approved": return `${name} is approved.`;
    case "changes": return `Changes requested on ${name}. It waits under Changes.`;
    default: return `${name} is back in Needs review.`;
  }
}

/** "12 assets · 84 cr settled" — summed from billed credits only; failed renders count 0. */
export function takesSubtitle(takes: readonly Pick<Take, "credits">[]): string {
  const settled = takes.reduce((sum, t) => sum + (t.credits ?? 0), 0);
  return `${takes.length.toLocaleString("en-US")} ${takes.length === 1 ? "asset" : "assets"} · ${settled.toLocaleString("en-US")} cr settled`;
}
