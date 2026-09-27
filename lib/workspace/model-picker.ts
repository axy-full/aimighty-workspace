import { composerSettings, type BillingSource, type ComposerModel, type ComposerPicks, type ComposerReference, type ComposerSettings, type ComposerType, type EngineRate } from "./composer";
import { mediaQuoteReferences } from "../workbench/media-reference-input";
import type { Asset } from "../workbench/studio";

/**
 * Gen's model sheet, as pure data: the spec chips on every row, the price
 * beside it, the search, and the Recent group.
 *
 * Where a price comes from, one line per catalogue:
 *  - Studio engines are priced on the server (GET /api/workbench/engines) at
 *    the settings the composer would render each one with — its picks, the
 *    project's aspect, its references — so the ticked row is the figure
 *    Generate shows for one take. A figure is only shown when the settings it
 *    names are that engine's composerSettings; otherwise the row waits;
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
  /* The headline size is one that has been rendered here; a listed, untested tier is named in the title only. */
  const untested = new Set((m.untested ?? []).map((r) => r.toLowerCase()));
  const size = maxResolution((m.resolutions ?? []).filter((r) => !untested.has(r.toLowerCase())));
  const listed = (m.resolutions ?? []).map((r) => (untested.has(r.toLowerCase()) ? `${r} (listed, untested)` : r)).join(", ");
  if (size) out.push({ key: "resolution", text: size, title: `Up to ${size} · ${listed}` });
  const length = m.type === "video" ? lengthSpan(m.durations) : null;
  if (length) out.push({ key: "length", text: length, title: `Length ${length}` });
  const refs = refsChip(m);
  if (refs) out.push(refs);
  if (m.audio) out.push({ key: "audio", text: "Audio", title: m.connected ? "Renders sound on the account" : "Takes carry sound" });
  if (m.enhanceable) out.push({ key: "enhance", text: "Enhance", title: "Can enhance the prompt on the account" });
  return out;
}

/* ── The price beside a row ───────────────────────────────────────────── */

export type Quoted = { credits: number; at: number; detail?: string };
export type RowPrice = {
  credits: number | null;
  /** The figure's unit, as Generate writes it: connected credits are the account's, not this workspace's. */
  unit: "cr" | "connected cr";
  detail: string;
  /** Takes per Generate is above one: the row is one take, the button multiplies. */
  perTake: boolean;
  title: string;
  kind: "rate" | "last" | "loading" | "none";
};

/** Where Gen's composer stands: every Studio row is priced here, one take at a time. */
export type PriceAt = { aspect?: string; picks: ComposerPicks; references: readonly ComposerReference[]; seconds: number; takes: number };
export const UNTOUCHED: PriceAt = { picks: {}, references: [], seconds: 10, takes: 1 };
/** A sound engine's price (lib/workbench/media-quote.ts › workbenchAudioRates). */
export type AudioRate = { credits: number; seconds: number | null };
/** The sheet's own priced read of the engines route, for the PriceAt its key names. */
export type SheetRates = { key: string; models: Readonly<Record<string, EngineRate | null>>; audio: { sound?: AudioRate; music?: AudioRate } | null; failed?: boolean };

/** A reference as the quote helpers read it: an Asset citing its saved id (as the composer's own quote does). */
const quoteAsset = (r: ComposerReference): Asset =>
  ({ id: r.key, name: r.name, url: r.url, kind: r.kind, ...(r.origin === "upload" ? { uploadId: r.id } : { generationId: r.id }) }) as unknown as Asset;

/** The engines-route query that prices the list where the composer stands (the route's list read, never a quote). */
export function rateQuery(at: PriceAt): string {
  const q = new URLSearchParams();
  if (at.picks.ratio) q.set("pickRatio", at.picks.ratio);
  if (at.picks.resolution) q.set("pickResolution", at.picks.resolution);
  if (at.picks.duration != null) q.set("pickDuration", String(at.picks.duration));
  if (at.aspect) q.set("aspect", at.aspect);
  q.set("seconds", String(at.seconds));
  const refs = at.references.length ? mediaQuoteReferences(at.references.map(quoteAsset)) : "";
  return [q.toString(), refs].filter(Boolean).join("&");
}

/** A rate prices this row only when it names the settings the composer would render the engine with. */
function fits(rate: EngineRate, m: ComposerModel, want: ComposerSettings): boolean {
  return rate.resolution === want.resolution && rate.ratio === want.ratio && (m.type !== "video" || rate.duration === want.duration);
}

/**
 * Whether the rates the composer's own list read carries (untouched settings,
 * no references) leave any Studio row unpriced where the composer stands — the
 * sheet then asks the engines route for the list priced there.
 */
export function needsPricedRead(offered: readonly ComposerModel[], at: PriceAt): boolean {
  return offered.some((m) => !m.connected && (
    m.audioTask === "sound" || m.audioTask === "music"
    || (m.type !== "audio" && (at.references.length > 0 || !m.rate || !fits(m.rate, m, composerSettings(m, at.aspect, at.picks))))
  ));
}

/** The priced read's reply, kept by the key it was asked for. */
export function sheetRatesFrom(key: string, reply: { models?: { id: string; rate?: EngineRate | null }[]; audio?: { sound?: AudioRate; music?: AudioRate } | null }): SheetRates {
  return { key, models: Object.fromEntries((reply.models ?? []).map((row) => [row.id, row.rate ?? null])), audio: reply.audio ?? null };
}

/** The settings a figure is at, as Gen's chips write them; the aspect only where it is not the usual 16:9. */
function settingsDetail(rate: EngineRate): string {
  return [rate.duration != null ? `${rate.duration} s` : null, rate.resolution !== "adaptive" ? rate.resolution : null, rate.ratio !== "16:9" ? rate.ratio : null].filter(Boolean).join(" · ");
}

const NONE: Omit<RowPrice, "perTake"> = { credits: null, unit: "cr", detail: "priced on Generate", kind: "none", title: "The live price shows on Generate once there is a prompt" };
const LOADING: Omit<RowPrice, "perTake"> = { credits: null, unit: "cr", detail: "", kind: "loading", title: "Pricing at these settings…" };

/**
 * The figure beside a row, never a guess: a Studio engine priced where the
 * composer stands (the sheet's priced read, or the list's own rate when that
 * is already at those settings), a sound engine's rate, a connected model's
 * last quote in this browser, or nothing.
 */
export function rowPrice(m: ComposerModel, quoted: Readonly<Record<string, Quoted>>, at: PriceAt = UNTOUCHED, sheet: SheetRates | null = null, reading = false): RowPrice {
  const perTake = at.takes > 1;
  if (m.connected) {
    const last = quoted[m.id];
    if (!last) return { ...NONE, perTake: false };
    return { credits: last.credits, unit: "connected cr", detail: "last quote", kind: "last", perTake,
      title: `Last quoted in this browser: ${last.credits.toLocaleString("en-US")} connected cr${last.detail ? ` at ${last.detail}` : ""}` };
  }
  if (m.type === "audio") {
    const rate = m.audioTask === "sound" ? sheet?.audio?.sound : m.audioTask === "music" ? sheet?.audio?.music : undefined;
    if (rate) {
      const detail = rate.seconds != null ? `${rate.seconds} s` : "any length";
      return { credits: rate.credits, unit: "cr", detail, kind: "rate", perTake, title: `${rate.credits.toLocaleString("en-US")} cr per take, ${rate.seconds != null ? `at ${rate.seconds} s` : "whatever its length"}` };
    }
    if (reading && (m.audioTask === "sound" || m.audioTask === "music")) return { ...LOADING, perTake: false };
    return m.audioTask === "speech"
      ? { ...NONE, perTake: false, title: "Speech is priced by its words: the live price shows on Generate once there is a prompt" }
      : { ...NONE, perTake: false };
  }
  const want = composerSettings(m, at.aspect, at.picks);
  const fromSheet = sheet?.models[m.id];
  const rate = fromSheet !== undefined
    ? (fromSheet && fits(fromSheet, m, want) ? fromSheet : null)
    : !at.references.length && m.rate && fits(m.rate, m, want) ? m.rate : null;
  if (rate) {
    const detail = settingsDetail(rate);
    const refs = at.references.length ? `with the ${at.references.length === 1 ? "reference" : `${at.references.length} references`} attached` : "no references";
    return { credits: rate.credits, unit: "cr", detail, kind: "rate", perTake,
      title: `${rate.credits.toLocaleString("en-US")} cr per take at ${[detail, rate.ratio === "16:9" ? "16:9" : null].filter(Boolean).join(" · ")}, ${refs}` };
  }
  if (reading && fromSheet === undefined) return { ...LOADING, perTake: false };
  return { ...NONE, perTake: false };
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
