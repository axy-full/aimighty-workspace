import type { BillingSource, ComposerModel, ComposerType } from "./composer";

/**
 * Gen's model sheet, as pure data: the spec chips on every row, the price
 * beside it, the search, and the Recent group.
 *
 * Where a price comes from, one line per catalogue:
 *  - Studio engines carry `rate`, computed on the server from the engine's
 *    own rates at the composer's untouched settings (GET /api/workbench/engines);
 *  - connected models are never priced from here — a quote on the connected
 *    account is a job row there — so a row shows the last figure this browser
 *    was actually quoted for it, and nothing when there is none.
 *
 * What this browser remembers (recent picks, last quotes) is kept per
 * workspace scope, and cleared with the rest of the private keys at sign-out
 * (lib/session.tsx).
 */

export type SpecChip = { key: "resolution" | "length" | "refs" | "audio" | "enhance"; text: string; title: string };

/** A size label's rank inside one engine's list; null when the label names no size ("adaptive", "High"). */
export function resolutionRank(label: string): number | null {
  const s = label.trim().toLowerCase();
  const p = /^(\d+)p$/.exec(s);
  if (p) return Number(p[1]);
  const k = /^(\d+(?:\.\d+)?)k$/.exec(s);
  if (k) return Number(k[1]) * 1000;
  const px = /^(\d+)$/.exec(s);
  if (px) return Number(px[1]);
  const mp = /^(\d+)mp$/.exec(s);
  if (mp) return Number(mp[1]) * 1e6;
  return null;
}

/** The largest size an engine renders ("4K", "1080p"), or null when its sizes are not sizes. */
export function maxResolution(list?: readonly string[]): string | null {
  let best: string | null = null;
  let rank = -1;
  for (const label of list ?? []) {
    const r = resolutionRank(label);
    if (r != null && r > rank) { rank = r; best = label.trim(); }
  }
  return best == null ? null : best.replace(/k$/, "K");
}

/** "4–30 s" for a run of seconds, "5/10 s" for a short closed list, "5–30 s" for a long one. */
export function lengthSpan(durations?: readonly number[]): string | null {
  const d = [...new Set(durations ?? [])].filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (!d.length) return null;
  if (d.length === 1) return `${d[0]} s`;
  const run = d.every((v, i) => i === 0 || v - d[i - 1] === 1);
  return run || d.length > 4 ? `${d[0]}–${d[d.length - 1]} s` : `${d.join("/")} s`;
}

function refsChip(m: ComposerModel): SpecChip | null {
  if (m.type === "audio") return null;
  const none: SpecChip = { key: "refs", text: "Prompt only", title: "Takes no reference media" };
  if (m.connected) {
    if (m.promptOnly) return none;
    const roles = m.referenceRoles ?? [];
    if (!roles.length) return null;
    const video = roles.some((r) => /video/i.test(r));
    const image = roles.some((r) => !/video|audio/i.test(r));
    const text = image && video ? "Image + video refs"
      : video ? "Video refs"
      : m.mediaMax ? `${m.mediaMax} image ref${m.mediaMax === 1 ? "" : "s"}`
      : "Image refs";
    return { key: "refs", text, title: `Reference roles: ${roles.join(", ")}` };
  }
  if (m.maxImages === undefined && m.maxVideos === undefined) return null;
  const images = m.maxImages ?? 0;
  const videos = m.maxVideos ?? 0;
  if (!images && !videos) return none;
  const text = images && videos ? `${images} image + ${videos} video refs` : images ? `${images} image refs` : `${videos} video refs`;
  return { key: "refs", text, title: `Up to ${[images ? `${images} reference images` : null, videos ? `${videos} reference videos` : null].filter(Boolean).join(" and ")}` };
}

/** The row's chips, in one order everywhere: size, length, references, sound, enhance. */
export function modelChips(m: ComposerModel): SpecChip[] {
  const out: SpecChip[] = [];
  const size = maxResolution(m.resolutions);
  if (size) out.push({ key: "resolution", text: size, title: `Up to ${size} · ${(m.resolutions ?? []).join(", ")}` });
  const length = m.type === "video" ? lengthSpan(m.durations) : null;
  if (length) out.push({ key: "length", text: length, title: `Length ${length}` });
  const refs = refsChip(m);
  if (refs) out.push(refs);
  if (m.audio) out.push({ key: "audio", text: "Audio", title: "Can render sound with the picture" });
  if (m.enhanceable) out.push({ key: "enhance", text: "Enhance", title: "Can enhance the prompt on the account" });
  return out;
}

/* ── The price beside a row ───────────────────────────────────────────── */

export type Quoted = { credits: number; at: number; detail?: string };
export type RowPrice = { credits: number | null; detail: string; title: string; kind: "rate" | "last" | "none" };

/** The settings a Studio rate prices, written as the composer's chips write them. */
function rateDetail(rate: NonNullable<ComposerModel["rate"]>): string {
  return [rate.duration != null ? `${rate.duration} s` : null, rate.resolution !== "adaptive" ? rate.resolution : null].filter(Boolean).join(" · ");
}

/**
 * The figure beside a row: a Studio engine's rate at its untouched settings,
 * a connected model's last quote in this browser, or nothing — never a guess.
 */
export function rowPrice(m: ComposerModel, quoted: Readonly<Record<string, Quoted>>): RowPrice {
  if (!m.connected && m.rate) {
    const detail = rateDetail(m.rate);
    const at = [detail, m.rate.ratio !== "adaptive" ? m.rate.ratio : null].filter(Boolean).join(" · ");
    return { credits: m.rate.credits, detail, kind: "rate", title: `${m.rate.credits.toLocaleString("en-US")} cr${at ? ` at ${at}` : ""}, no references` };
  }
  const last = m.connected ? quoted[m.id] : undefined;
  if (last) {
    return { credits: last.credits, detail: "last quote", kind: "last",
      title: `Last quoted in this browser: ${last.credits.toLocaleString("en-US")} connected cr${last.detail ? ` at ${last.detail}` : ""}` };
  }
  return { credits: null, detail: "priced on Generate", kind: "none", title: "The live price shows on Generate once there is a prompt" };
}

/* ── Search and Recent ────────────────────────────────────────────────── */

/** Every word must appear in the name, the id, the one-liner or a chip ("seedance 1080p audio"). */
export function searchModels(models: readonly ComposerModel[], query: string): ComposerModel[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [...models];
  return models.filter((m) => {
    const hay = [m.label, m.id, m.description ?? "", ...(m.resolutions ?? []), ...modelChips(m).map((c) => c.text)].join(" ").toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

export const RECENT_SHOWN = 3;
const RECENT_KEPT = 12;
/** Below this many models the whole list is already short: no Recent group. */
export const RECENT_FROM = RECENT_SHOWN + 2;

export const recentKey = (billing: BillingSource, type: ComposerType, id: string) => `${billing}:${type}:${id}`;

/** Most recent first, no repeats, a short tail kept for the other types. */
export function pushRecent(list: readonly string[], key: string): string[] {
  return [key, ...list.filter((k) => k !== key)].slice(0, RECENT_KEPT);
}

/** The last models used for this catalogue and type that the list still offers. */
export function recentModels(list: readonly string[], billing: BillingSource, type: ComposerType, offered: readonly ComposerModel[]): ComposerModel[] {
  const out: ComposerModel[] = [];
  const prefix = `${billing}:${type}:`;
  for (const key of list) {
    if (!key.startsWith(prefix)) continue;
    const model = offered.find((m) => m.id === key.slice(prefix.length));
    if (model && !out.includes(model)) out.push(model);
    if (out.length >= RECENT_SHOWN) break;
  }
  return out;
}

/**
 * The sheet's groups. A query searches the whole list and drops Recent; with
 * no query, Recent leads and the rest follow once, without repeats.
 */
export function pickerSections(offered: readonly ComposerModel[], recent: readonly ComposerModel[], query: string): { recent: ComposerModel[]; rest: ComposerModel[] } {
  if (query.trim()) return { recent: [], rest: searchModels(offered, query) };
  if (offered.length < RECENT_FROM || !recent.length) return { recent: [], rest: [...offered] };
  const ids = new Set(recent.map((m) => m.id));
  return { recent: [...recent], rest: offered.filter((m) => !ids.has(m.id)) };
}

/* ── What this browser remembers ──────────────────────────────────────── */

export type PickerMemory = { recent: string[]; quoted: Record<string, Quoted> };
export const EMPTY_MEMORY: PickerMemory = { recent: [], quoted: {} };
/** Cleared with the private keys at sign-out (lib/session.tsx › PRIVATE_PREFIXES). */
export const PICKER_PREFIX = "particl-picker:";
const QUOTED_KEPT = 40;
type Store = Pick<Storage, "getItem" | "setItem">;

const pickerKey = (scope: string) => `${PICKER_PREFIX}${scope}`;

/** Parsed defensively: anything malformed is dropped, never trusted. */
export function parsePickerMemory(raw: string | null): PickerMemory {
  if (!raw) return EMPTY_MEMORY;
  try {
    const value = JSON.parse(raw) as { recent?: unknown; quoted?: unknown };
    const recent = Array.isArray(value.recent) ? value.recent.filter((k): k is string => typeof k === "string" && k.length <= 240).slice(0, RECENT_KEPT) : [];
    const quoted: Record<string, Quoted> = {};
    if (value.quoted && typeof value.quoted === "object") {
      for (const [id, q] of Object.entries(value.quoted as Record<string, unknown>).slice(0, QUOTED_KEPT)) {
        const v = q as Partial<Quoted> | null;
        if (!v || typeof v.credits !== "number" || !Number.isFinite(v.credits) || v.credits < 0 || typeof v.at !== "number") continue;
        quoted[id] = { credits: v.credits, at: v.at, ...(typeof v.detail === "string" ? { detail: v.detail.slice(0, 80) } : {}) };
      }
    }
    return { recent, quoted };
  } catch {
    return EMPTY_MEMORY;
  }
}

export function readPickerMemory(scope: string, store?: Store): PickerMemory {
  try { return parsePickerMemory((store ?? window.localStorage).getItem(pickerKey(scope))); }
  catch { return EMPTY_MEMORY; }
}

export function writePickerMemory(scope: string, memory: PickerMemory, store?: Store): void {
  try { (store ?? window.localStorage).setItem(pickerKey(scope), JSON.stringify(memory)); }
  catch { /* Private mode or full storage: the sheet still works, it only forgets. */ }
}

/** A connected quote the composer was actually given, kept as that model's last figure. */
export function rememberQuote(memory: PickerMemory, id: string, quote: Quoted): PickerMemory {
  const same = memory.quoted[id];
  if (same && same.credits === quote.credits && same.detail === quote.detail) return memory;
  const entries = Object.entries({ ...memory.quoted, [id]: quote }).sort((a, b) => b[1].at - a[1].at).slice(0, QUOTED_KEPT);
  return { ...memory, quoted: Object.fromEntries(entries) };
}

export function rememberRecent(memory: PickerMemory, key: string): PickerMemory {
  if (memory.recent[0] === key) return memory;
  return { ...memory, recent: pushRecent(memory.recent, key) };
}
