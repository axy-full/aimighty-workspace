/**
 * Make in the new interface (redesign plan C3; docs/redesign/inventory.md § 5.12), the parts with no React and no
 * fetch: the results' tiles, the justified rows they sit in, the day dividers, the composer's modes and their words,
 * and the Remix and Edit ops as far as Make offers them today. Every result is the workspace's own; every price is
 * passed in from the quote layer.
 */
import type { Generation } from "@/lib/jobs";
import type { ComposerType } from "@/lib/workspace/composer";
import { displayModelName } from "@/lib/models";
import { recipePrompt, recreateBlock } from "@/lib/shell/recipe";

/* ── Results ──────────────────────────────────────────────────────────── */

/** How many takes the page reads. */
export const RESULTS_READ = 60;

export type ResultTile = {
  id: string;
  /** Particl's own media route, once stored; null while it renders or when it failed. */
  url: string | null;
  kind: "image" | "video" | "audio";
  /** width / height. */
  aspect: number;
  /** The words as typed. */
  prompt: string;
  /** "Image · 16:9", "Video · 5 s", "Audio". */
  type: string;
  model: string;
  createdAt: number;
  /** Load into the composer (Recreate), or why not. */
  reuseBlock: string | null;
  source: Generation;
};

const clean = (text: unknown) => (typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "");

/** "16:9" → 1.777…; a pixel size wins when the take carries one. */
export function aspectOf(g: Pick<Generation, "kind" | "params">): number {
  if (g.kind === "audio") return 2;
  const p = (g.params ?? {}) as Record<string, unknown>;
  const w = Number(p.width), h = Number(p.height);
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return clampAspect(w / h);
  const m = /^(\d+(?:\.\d+)?)\s*[:x]\s*(\d+(?:\.\d+)?)$/.exec(clean(p.ratio));
  if (m && Number(m[2]) > 0) return clampAspect(Number(m[1]) / Number(m[2]));
  return 16 / 9;
}
const clampAspect = (a: number) => Math.min(3, Math.max(0.4, a));

/** A take as a result tile; null for kinds Make does not make (3D) or a take that is gone. */
export function resultTile(g: Generation): ResultTile | null {
  if (g.kind !== "image" && g.kind !== "video" && g.kind !== "audio") return null;
  const p = (g.params ?? {}) as Record<string, unknown>;
  const stored = g.status === "succeeded" && g.storedUrl ? (g.storedUrl.startsWith("/api/media/") ? g.storedUrl : `/api/media/${encodeURIComponent(g.id)}`) : null;
  const seconds = Number(g.durationS ?? p.duration);
  const type = g.kind === "image" ? ["Image", clean(p.ratio) || null].filter(Boolean).join(" · ")
    : g.kind === "video" ? ["Video", Number.isFinite(seconds) && seconds > 0 ? `${Math.round(seconds)} s` : null].filter(Boolean).join(" · ")
      : "Audio";
  return {
    id: g.id, url: stored, kind: g.kind, aspect: aspectOf(g), prompt: clean(recipePrompt(g)) || clean(g.title) || displayModelName(g.model),
    type, model: g.model, createdAt: g.createdAt, reuseBlock: recreateBlock(g), source: g,
  };
}

export function resultTiles(list: readonly Generation[]): ResultTile[] {
  const seen = new Set<string>();
  const out: ResultTile[] = [];
  for (const g of [...list].sort((a, b) => b.createdAt - a.createdAt)) {
    if (seen.has(g.id)) continue;
    seen.add(g.id);
    const tile = resultTile(g);
    if (tile) out.push(tile);
  }
  return out;
}

/** "3 results". */
export const resultsCount = (n: number): string => `${n.toLocaleString("en-US")} ${n === 1 ? "result" : "results"}`;

/* ── Justified rows ──────────────────────────────────────────────────── */

export type Placed<T> = { item: T; width: number };
export type JustifiedRow<T> = { height: number; items: Placed<T>[] };
export const ROW_TARGET = 200;
export const ROW_MIN = 120;
export const ROW_GAP = 8;

/**
 * Rows of tiles that keep their true aspect and fill the width (the prototype's justified rows): each row is scaled to
 * span the width exactly, breaking where its height comes closest to the target, never under the minimum. A short last row keeps the target
 * height rather than stretching. Widths are whole pixels; the last tile of a full row takes the rounding.
 */
export function justify<T>(items: readonly T[], ratio: (item: T) => number, width: number,
  { target = ROW_TARGET, min = ROW_MIN, gap = ROW_GAP }: { target?: number; min?: number; gap?: number } = {}): JustifiedRow<T>[] {
  if (!(width > 0) || !items.length) return [];
  const rows: JustifiedRow<T>[] = [];
  let row: T[] = [];
  let sum = 0;
  const flush = (full: boolean) => {
    if (!row.length) return;
    const room = width - gap * (row.length - 1);
    const height = full ? Math.max(min, room / sum) : Math.min(target, Math.max(min, room / sum));
    let used = 0;
    const placed = row.map((item, i) => {
      const w = i === row.length - 1 && full ? Math.max(1, Math.round(room - used)) : Math.max(1, Math.round(ratio(item) * height));
      used += w;
      return { item, width: w };
    });
    rows.push({ height: Math.round(height), items: placed });
    row = [];
    sum = 0;
  };
  for (const item of items) {
    const before = row.length ? (width - gap * (row.length - 1)) / sum : Infinity;
    row.push(item);
    sum += ratio(item);
    const room = width - gap * (row.length - 1);
    const height = room / sum;
    if (height > target) continue;
    /* The row breaks where its height comes closest to the target: before this tile (a little taller) or after it (shorter). */
    if (row.length > 1 && before - target < target - height) {
      row.pop();
      sum -= ratio(item);
      flush(true);
      row.push(item);
      sum = ratio(item);
      if ((width) / sum <= target) flush(true);
    } else flush(true);
  }
  flush(false);
  return rows;
}

/* ── Day dividers ────────────────────────────────────────────────────── */

/** "Today", "Yesterday", else "4 Oct" (with the year when it is not this one). Grouped by the take's own date. */
export function dayLabel(at: number, now: number): string {
  const day = (t: number) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  const diff = Math.round((day(now) - day(at)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  const d = new Date(at);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(d.getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" } : {}) });
}

/** Results grouped by day, newest first, each group then justified on its own (a divider never sits mid-row). */
export function byDay<T extends { createdAt: number }>(items: readonly T[], now: number): { label: string; items: T[] }[] {
  const out: { label: string; items: T[] }[] = [];
  for (const item of items) {
    const label = dayLabel(item.createdAt, now);
    const last = out[out.length - 1];
    if (last?.label === label) last.items.push(item);
    else out.push({ label, items: [item] });
  }
  return out;
}

/* ── The composer's modes ────────────────────────────────────────────── */

export type MakeMode = "auto" | "image" | "video" | "audio" | "remix" | "edit";
export const MAKE_MODES: readonly { id: MakeMode; label: string }[] = [
  { id: "auto", label: "Auto" }, { id: "image", label: "Image" }, { id: "video", label: "Video" },
  { id: "audio", label: "Audio" }, { id: "remix", label: "Remix" }, { id: "edit", label: "Edit" },
];

/** The prototype's `mk=` (Auto · Image · Video · Audio · Remix · Edit), case-insensitive; null for anything else. */
export function modeFromParam(value: string | null | undefined): MakeMode | null {
  const v = (value ?? "").trim().toLowerCase();
  return MAKE_MODES.some((m) => m.id === v) ? (v as MakeMode) : null;
}

export const modeType = (mode: MakeMode): ComposerType | null => (mode === "image" || mode === "video" || mode === "audio" ? mode : null);

/** The words box's placeholder per mode (inventory § 5.12). Video names the engine and length it would use. */
export function placeholderFor(mode: MakeMode, video?: { engine: string | null; seconds: number | null }): string {
  switch (mode) {
    case "auto": return "Describe anything · Atomik picks the model and settings";
    case "image": return "Describe a still · @ to pull from the library";
    case "video": return video?.engine ? `Describe a clip · ${video.seconds ? `${video.seconds} s on ` : ""}${video.engine}` : "Describe a clip";
    case "audio": return "A line, a cue or a sound";
    case "edit": return "What to change in the last result (optional)";
    case "remix": return "Paste a video link, or drop a file here";
  }
}

/**
 * The ops Remix and Edit show (inventory § 5.12, § 10.3), and what each does in Make today: a quick tool that prices
 * itself (Motion transfer, Object swap, Upscale), or not yet here (no engine, or only from a card on a board) with why.
 */
export type MakeOp = { id: string; label: string; tool: "motion" | "swap" | "upscale" | null; why: string | null };
export const REMIX_OPS: readonly MakeOp[] = [
  { id: "cut", label: "Cut into clips", tool: null, why: "Cutting a video into clips is not in Particl yet." },
  { id: "motion", label: "Transfer motion", tool: "motion", why: null },
  { id: "swap", label: "Swap an object", tool: "swap", why: null },
  { id: "effect", label: "Add an effect", tool: null, why: "Saved looks come with Remix on the boards." },
];
export const EDIT_OPS: readonly MakeOp[] = [
  { id: "upscale", label: "Upscale", tool: "upscale", why: null },
  { id: "reframe", label: "Reframe / outpaint", tool: null, why: "Reframe a still from its card on a board." },
  { id: "cutout", label: "Remove background", tool: null, why: "Remove a background from its card on a board." },
  { id: "relight", label: "Relight", tool: null, why: "Relight is not in Particl yet." },
  { id: "lipsync", label: "Lip-sync", tool: null, why: "Lip-sync has no engine yet." },
  { id: "motion", label: "Motion transfer", tool: "motion", why: null },
];
