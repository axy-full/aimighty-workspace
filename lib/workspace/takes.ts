import { libraryId, libraryName, type LibraryAsset } from "../genLibrary";
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
  sha256: string | null;
  createdAt: number;
};

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
    return {
      id: libraryId(asset), sourceId: g.id, kind: "GEN", name: libraryName(asset), version: `v${g.version}`,
      meta: [label, detail].filter(Boolean).join(" · "),
      credits: !settled ? null : unbilled ? 0 : billedCredits ?? null,
      usd: !settled ? null : unbilled ? (g.costUsd == null ? null : 0) : g.costUsd ?? null,
      status, ...(unbilled ? { failedUnbilled: true as const } : {}), sha256: sha, createdAt: g.createdAt,
    };
  });
}

/** "12 assets · 84 cr settled" — summed from billed credits only; failed renders count 0. */
export function takesSubtitle(takes: readonly Pick<Take, "credits">[]): string {
  const settled = takes.reduce((sum, t) => sum + (t.credits ?? 0), 0);
  return `${takes.length.toLocaleString("en-US")} ${takes.length === 1 ? "asset" : "assets"} · ${settled.toLocaleString("en-US")} cr settled`;
}
