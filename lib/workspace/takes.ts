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
      status, ...(unbilled ? { failedUnbilled: true as const } : {}),
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
 * it says more, for the tooltip. Nothing here claims a refund: the card's chip
 * says "not billed" only when the ledger shows nothing charged.
 */
export function failureReason(g: Row): { reason: string; detail?: string } {
  const raw = (g.error ?? "").trim();
  const detail = raw ? firstLine(raw) : "";
  const same = (a: string, b: string) => a.replace(/[.!?\s]+$/, "").toLowerCase() === b.replace(/[.!?\s]+$/, "").toLowerCase();
  const withDetail = (reason: string) => (detail && !same(detail, reason) ? { reason, detail } : { reason });
  if (g.status === "cancelled") return withDetail("Cancelled before it rendered");
  switch (failureKind(raw, g.params)) {
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
 * The card's status chip (Queued / Rendering / Held / Failed · not billed /
 * Picked / Approved / Changes). A take waiting for review and an upload carry
 * none. `compact` shortens the one long label for a 2-up sidebar tile; the
 * billing note then rides on the reason line instead.
 */
export function takeChip(take: Pick<Take, "status" | "stage" | "failedUnbilled">, compact = false): TakeChip | null {
  switch (take.status) {
    case "rendering": return take.stage === "held" ? { label: "Held", tone: "waiting" } : take.stage === "queued" ? { label: "Queued", tone: "idle" } : { label: "Rendering", tone: "live" };
    case "failed": return { label: take.failedUnbilled && !compact ? "Failed · not billed" : "Failed", tone: "failed" };
    case "picked": return { label: "Picked", tone: "picked" };
    case "approved": return { label: "Approved", tone: "done" };
    case "changes": return { label: "Changes", tone: "waiting" };
    default: return null;
  }
}

/** The status in words, where there is room for all of them (the Inspector's facts). */
export function takeStatusWord(take: Pick<Take, "status" | "stage" | "failedUnbilled">): string {
  return takeChip(take)?.label ?? (take.status === "uploaded" ? "Uploaded" : "In review");
}

/** The line under a card's name: the failure or hold reason, with the billing note when the chip had no room for it. */
export function takeReasonLine(take: Pick<Take, "status" | "reason" | "failedUnbilled">, compact = false): string | null {
  if (!take.reason) return null;
  return compact && take.status === "failed" && take.failedUnbilled ? `Not billed · ${take.reason}` : take.reason;
}

/** "12 assets · 84 cr settled" — summed from billed credits only; failed renders count 0. */
export function takesSubtitle(takes: readonly Pick<Take, "credits">[]): string {
  const settled = takes.reduce((sum, t) => sum + (t.credits ?? 0), 0);
  return `${takes.length.toLocaleString("en-US")} ${takes.length === 1 ? "asset" : "assets"} · ${settled.toLocaleString("en-US")} cr settled`;
}
