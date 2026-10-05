import type { ShotVersion } from "../cards/take/take-model";

/*
 * The Inspector (README § 3.1 frame k), pure: what it says about a take beyond the card. Every figure is the
 * take's own record; nothing is estimated here, and no vendor cost or internal id is shown.
 */

/** What the take was charged, once settled: the ledger's billed credits. Null while in flight, for uploads, or unknown. */
export function paidCredits(v: Pick<ShotVersion, "entry" | "status">): number | null {
  if (v.status === "rendering" || v.status === "held") return null;
  const credits = v.entry.take.credits;
  return typeof credits === "number" && Number.isFinite(credits) ? credits : null;
}

/** The Advanced rows (folded): the settings the request carried, where it carried them. */
export function advancedRows(v: Pick<ShotVersion, "entry">): { k: string; v: string }[] {
  if (v.entry.asset.origin !== "generation") return [];
  const g = v.entry.asset.value;
  const p = (g.params ?? {}) as Record<string, unknown>;
  const text = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim() : typeof x === "number" && Number.isFinite(x) ? String(x) : null);
  const rows: [string, string | null][] = [
    ["Seed", text(p.seed)],
    ["Resolution", text(p.resolution)],
    ["Ratio", text(p.ratio) ?? text(p.aspect)],
    ["Length", typeof g.durationS === "number" && g.durationS > 0 ? `${Math.round(g.durationS * 10) / 10} s` : typeof p.duration === "number" ? `${p.duration} s` : null],
    ["Audio", p.generateAudio === true || p.audio === true ? "on" : p.generateAudio === false || p.audio === false ? "off" : null],
    ["Made by", g.authorName ?? null],
  ];
  return rows.flatMap(([k, val]) => (val ? [{ k, v: val }] : []));
}

/** The original's download link (the media route's own `download=1`). */
export const downloadHref = (genId: string) => `/api/media/${encodeURIComponent(genId)}?download=1`;
