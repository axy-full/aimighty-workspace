import { readFileSync, statSync } from "node:fs";

/**
 * What the vendors charge, read from a private file on the server.
 *
 * Owner, 17 Oct 2026: "vendor prices in a server-only file set on Coolify;
 * today's rate file and its tests untouched until sign-off. Margins are per service and arrive later as config, never in
 * code." So this module holds NO price: it reads a JSON file whose path is
 * the one environment variable named below, checks its shape strictly, and
 * prices a job from it. docs/vendor-prices.md describes the file.
 *
 * Nothing is priced from here today. lib/vendorRates.ts still prices every
 * engine it priced before; an engine is priced from this file only once it is
 * listed in FILE_PRICED_ENGINES, and the list is empty.
 *
 * Failure is always a refusal, never a number from code: no variable, no
 * file, a file that does not parse or does not match the shape, or no row for
 * the settings asked for, and the engine is UNPRICED. Its quote is refused
 * with VendorPriceUnavailable. A bad file is logged and refused; it never
 * throws out of this module.
 *
 * Server only. Like lib/vendorRates.ts it does not `import "server-only"`
 * (the package is not installed and that import throws in plain Node, where
 * the unit tests run). The enforcement is tests/unit/vendorPriceFile.spec.ts:
 * no module a client component can reach imports this one, and no built
 * client chunk carries its variable name or format marker.
 */

/** The one environment variable: an absolute path to the price file. Read by name only. */
export const VENDOR_PRICES_ENV = "VENDOR_PRICES_PATH";
/** The file's first key must be this; anything else is not a price file. */
export const VENDOR_PRICES_FORMAT = "particl-vendor-prices/1";

/**
 * What a cost is per. Generations bill per second, per job (a fixed length)
 * or per image; reading, research, analysis and writing bill per page,
 * source or minute; layers per layer; text per character or token.
 */
export const VENDOR_PRICE_UNITS = ["second", "minute", "job", "image", "page", "source", "layer", "character", "token"] as const;
export type VendorPriceUnit = (typeof VENDOR_PRICE_UNITS)[number];

/** The dimensions a row may name. Every row of one engine's unit names the same ones. */
const SELECTORS = ["resolution", "length", "audio", "upTo"] as const;

export type VendorPriceRow = {
  /** For example "720p", "1080p", "4k", "1K"; matched without regard to case. */
  resolution?: string;
  /** Whole seconds of a fixed-length job (unit "job" only). */
  length?: number;
  /** With sound, or without. */
  audio?: boolean;
  /** A band: this row's cost per unit applies up to this many units (not on unit "job"). */
  upTo?: number;
  /** US dollars per one unit. Always above zero: a free engine is not priced from this file. */
  costUsd: number;
};

export type VendorPriceTable = {
  format: typeof VENDOR_PRICES_FORMAT;
  engines: Record<string, Partial<Record<VendorPriceUnit, VendorPriceRow[]>>>;
};

/**
 * Engines priced from the file instead of lib/vendorRates.ts. Empty until the
 * owner signs off; an engine is added here in the PR that ports it (the first
 * is planned to be sync.so lip-sync, PR #776).
 */
export const FILE_PRICED_ENGINES: readonly string[] = [];

/** The largest file read. A price table is a few kilobytes; anything near this is a wrong paste. */
const MAX_BYTES = 1024 * 1024;
const ENGINE_ID = /^(?=.*[A-Za-z])[A-Za-z0-9._/:@-]{1,200}$/;
/** Names an object already has: as an engine id they would reach the prototype instead of a row. */
const RESERVED_IDS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_ROWS = 500;

export type ParseResult = { ok: true; table: VendorPriceTable } | { ok: false; problems: string[] };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/* Problems name where, never what: no value from the file is ever repeated,
   so a problem list can be shown to an admin without showing a price. A key
   is named only when it is one this format defines. */
const engineLabel = (id: string) => (ENGINE_ID.test(id) ? `"${id}"` : "an engine with an unusable id");

/** Checks a price file's text. Strict: an unknown key, a missing field or one bad row rejects the whole file. */
export function parseVendorPrices(text: string): ParseResult {
  const problems: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, problems: ["the file is not valid JSON"] };
  }
  if (!isObject(raw)) return { ok: false, problems: ["the file must be one JSON object"] };
  if (raw.format !== VENDOR_PRICES_FORMAT) problems.push(`"format" must be "${VENDOR_PRICES_FORMAT}"`);
  for (const k of Object.keys(raw)) {
    if (k === "format" || k === "engines") continue;
    problems.push(/margin|markup|multiplier/i.test(k)
      ? "margins do not belong in this file (they are a separate per-service setting)"
      : "the file has a top-level key this format does not define");
  }
  if (!isObject(raw.engines)) {
    problems.push(`"engines" must be an object keyed by engine id`);
    return { ok: false, problems };
  }
  /* No prototype: an id can never resolve to an inherited key. */
  const engines: VendorPriceTable["engines"] = Object.create(null);
  let rowCount = 0;
  for (const [id, entry] of Object.entries(raw.engines)) {
    const at = `engine ${engineLabel(id)}`;
    if (!ENGINE_ID.test(id)) { problems.push(`${at}: the id must be 1-200 letters, digits or . _ / : @ - and contain a letter`); continue; }
    if (RESERVED_IDS.has(id)) { problems.push(`${at}: this id is reserved (__proto__, constructor and prototype cannot be engine ids)`); continue; }
    if (!isObject(entry) || Object.keys(entry).length === 0) { problems.push(`${at}: must be an object of units, with at least one`); continue; }
    const units: Partial<Record<VendorPriceUnit, VendorPriceRow[]>> = Object.create(null);
    for (const [unit, rows] of Object.entries(entry)) {
      if (!(VENDOR_PRICE_UNITS as readonly string[]).includes(unit)) {
        problems.push(/margin|markup|multiplier/i.test(unit)
          ? `${at}: margins do not belong in this file`
          : `${at}: a unit this format does not define (units: ${VENDOR_PRICE_UNITS.join(", ")})`);
        continue;
      }
      const u = unit as VendorPriceUnit;
      const where = `${at}, unit "${u}"`;
      if (!Array.isArray(rows) || rows.length === 0) { problems.push(`${where}: must be a non-empty list of rows`); continue; }
      rowCount += rows.length;
      const clean: VendorPriceRow[] = [];
      let shape: string | null = null;
      const seen = new Set<string>();
      rows.forEach((row, i) => {
        const r = `${where}, row ${i + 1}`;
        if (!isObject(row)) { problems.push(`${r}: must be an object`); return; }
        const out: VendorPriceRow = { costUsd: 0 };
        let bad = false;
        for (const k of Object.keys(row)) {
          if (k === "costUsd" || (SELECTORS as readonly string[]).includes(k)) continue;
          problems.push(/margin|markup|multiplier/i.test(k) ? `${r}: margins do not belong in this file` : `${r}: a key this format does not define`);
          bad = true;
        }
        const cost = row.costUsd;
        if (typeof cost !== "number" || !Number.isFinite(cost) || cost <= 0) { problems.push(`${r}: "costUsd" must be a number above zero`); bad = true; }
        else out.costUsd = cost;
        if ("resolution" in row) {
          if (typeof row.resolution !== "string" || !/^[A-Za-z0-9._-]{1,32}$/.test(row.resolution)) { problems.push(`${r}: "resolution" must be a short name such as 1080p`); bad = true; }
          else out.resolution = row.resolution.toLowerCase();
        }
        if ("length" in row) {
          if (u !== "job") { problems.push(`${r}: "length" is only for unit "job" (a per-${u} cost is multiplied by the quantity)`); bad = true; }
          else if (!Number.isInteger(row.length) || (row.length as number) <= 0) { problems.push(`${r}: "length" must be whole seconds above zero`); bad = true; }
          else out.length = row.length as number;
        }
        if ("audio" in row) {
          if (typeof row.audio !== "boolean") { problems.push(`${r}: "audio" must be true or false`); bad = true; }
          else out.audio = row.audio;
        }
        if ("upTo" in row) {
          if (u === "job") { problems.push(`${r}: "upTo" (a band) is not for unit "job"`); bad = true; }
          else if (typeof row.upTo !== "number" || !Number.isFinite(row.upTo) || row.upTo <= 0) { problems.push(`${r}: "upTo" must be a number above zero`); bad = true; }
          else out.upTo = row.upTo;
        }
        if (bad) return;
        const named = SELECTORS.filter((s) => s in out).join(",");
        if (shape === null) shape = named;
        else if (shape !== named) { problems.push(`${r}: every row of one unit must name the same keys (resolution, length, audio, upTo)`); return; }
        const key = SELECTORS.map((s) => String(out[s] ?? "")).join("|");
        if (seen.has(key)) { problems.push(`${r}: repeats another row's settings`); return; }
        seen.add(key);
        clean.push(out);
      });
      units[u] = clean;
    }
    engines[id] = units;
  }
  if (rowCount > MAX_ROWS) problems.push(`the file has more than ${MAX_ROWS} rows`);
  if (problems.length) return { ok: false, problems };
  return { ok: true, table: { format: VENDOR_PRICES_FORMAT, engines } };
}

/* ------------------------------------------------------------------ load */

export type VendorPricesState = "unset" | "missing" | "invalid" | "loaded";
/** What an admin may see: a state and counts, never a figure, a path or a row. */
export type VendorPricesStatus = { variable: typeof VENDOR_PRICES_ENV; state: VendorPricesState; engines: number; problems?: string[] };

type Loaded =
  | { state: "unset" | "missing"; reason: string }
  | { state: "invalid"; problems: string[] }
  | { state: "loaded"; table: VendorPriceTable };

let cache: { path: string; stamp: string; checkedAt: number; value: Loaded } | null = null;
let lastLogged = "";
/** How long a read is trusted before the file is looked at again (a stat, re-read only when it changed). */
const RECHECK_MS = 30_000;

function log(value: Loaded): void {
  const line = value.state === "loaded"
    ? `vendor prices: loaded, ${Object.keys(value.table.engines).length} engines`
    : value.state === "invalid"
      ? `vendor prices: invalid file (${value.problems.length} problem${value.problems.length === 1 ? "" : "s"}); every file-priced engine is unpriced`
      : `vendor prices: ${value.state} (${value.reason}); every file-priced engine is unpriced`;
  if (line === lastLogged) return;
  lastLogged = line;
  if (value.state === "loaded") console.info(line);
  else console.warn(line);
}

function read(path: string): Loaded {
  try {
    const st = statSync(path);
    if (!st.isFile()) return { state: "missing", reason: `${VENDOR_PRICES_ENV} does not name a file` };
    if (st.size > MAX_BYTES) return { state: "invalid", problems: ["the file is larger than 1 MB"] };
    const parsed = parseVendorPrices(readFileSync(path, "utf8"));
    return parsed.ok ? { state: "loaded", table: parsed.table } : { state: "invalid", problems: parsed.problems };
  } catch {
    return { state: "missing", reason: `no readable file at ${VENDOR_PRICES_ENV}` };
  }
}

function stampOf(path: string): string {
  try {
    const st = statSync(path);
    return `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch {
    return "absent";
  }
}

function load(now = Date.now()): Loaded {
  const path = (process.env[VENDOR_PRICES_ENV] ?? "").trim();
  let value: Loaded;
  if (!path) {
    cache = null;
    value = { state: "unset", reason: `${VENDOR_PRICES_ENV} is not set` };
  } else if (!path.startsWith("/")) {
    cache = null;
    value = { state: "missing", reason: `${VENDOR_PRICES_ENV} must be an absolute path` };
  } else if (cache && cache.path === path && now - cache.checkedAt < RECHECK_MS) {
    value = cache.value;
  } else {
    const stamp = stampOf(path);
    if (cache && cache.path === path && cache.stamp === stamp) {
      cache.checkedAt = now;
      value = cache.value;
    } else {
      value = read(path);
      cache = { path, stamp, checkedAt: now, value };
    }
  }
  log(value);
  return value;
}

/** Forget the cached file, so the next read looks again. For tests, and for an admin's "check now". */
export function reloadVendorPrices(): void {
  cache = null;
}

/** The admin check: "loaded, N engines", or why not. Counts only; never a price, row or path. */
export function vendorPricesStatus(): VendorPricesStatus {
  const v = load();
  if (v.state === "loaded") return { variable: VENDOR_PRICES_ENV, state: "loaded", engines: Object.keys(v.table.engines).length };
  if (v.state === "invalid") return { variable: VENDOR_PRICES_ENV, state: "invalid", engines: 0, problems: v.problems.slice(0, 10) };
  return { variable: VENDOR_PRICES_ENV, state: v.state, engines: 0 };
}

/* ----------------------------------------------------------------- price */

/** A refused quote: the engine has no price on this server. Its message is the one the product already uses. */
export class VendorPriceUnavailable extends Error {
  readonly code = "unpriced";
  readonly status = 503;
  readonly engine: string;
  readonly reason: string;
  /* Plain fields, not constructor parameter properties: the owner's converter
     (scripts/vendor-prices/csv-to-json.mjs) loads this file with Node's own
     type stripping, which accepts only erasable syntax. */
  constructor(engine: string, reason: string) {
    super("This engine has no confirmed price.");
    this.name = "VendorPriceUnavailable";
    this.engine = engine;
    this.reason = reason;
  }
}

export type VendorPriceRequest = {
  unit: VendorPriceUnit;
  /** How many units: seconds, minutes, pages, sources, images, layers, characters, tokens; for "job", how many jobs (default 1). */
  quantity?: number;
  resolution?: string;
  /** Whole seconds, for a fixed-length job. */
  length?: number;
  audio?: boolean;
};

/** Dollars to the micro-dollar, rounded up, so a quote is never under the cost. */
const microCeil = (usd: number): number => Math.ceil(usd * 1e6 - 1e-6) / 1e6;

/**
 * The cost of one request against a parsed table, or why there is none. Pure:
 * every row the request does not match exactly is passed over, and nothing is
 * guessed. A band applies when the quantity is at or under its upTo; the
 * smallest such band wins, and a quantity past the largest band is unpriced.
 */
export function costFromTable(table: VendorPriceTable, engine: string, req: VendorPriceRequest): { ok: true; costUsd: number } | { ok: false; reason: string } {
  /* Own keys only: an engine or unit the file does not name is unpriced, whatever an object inherits. */
  const entry = Object.hasOwn(table.engines, engine) ? table.engines[engine] : undefined;
  const rows = entry && Object.hasOwn(entry, req.unit) ? entry[req.unit] : undefined;
  if (!Array.isArray(rows) || !rows.length) return { ok: false, reason: `no "${req.unit}" price for this engine` };
  const quantity = req.quantity ?? (req.unit === "job" ? 1 : NaN);
  if (!Number.isFinite(quantity) || quantity <= 0) return { ok: false, reason: "the quantity must be above zero" };
  if (req.unit === "job" && !Number.isInteger(quantity)) return { ok: false, reason: "a number of jobs must be a whole number" };
  const named = rows[0];
  if ("resolution" in named && !req.resolution) return { ok: false, reason: "this price needs a resolution" };
  if ("length" in named && !req.length) return { ok: false, reason: "this price needs a length" };
  if ("audio" in named && typeof req.audio !== "boolean") return { ok: false, reason: "this price needs with or without sound" };
  const res = req.resolution?.toLowerCase();
  const matches = rows.filter((r) =>
    (r.resolution === undefined || r.resolution === res) &&
    (r.length === undefined || r.length === req.length) &&
    (r.audio === undefined || r.audio === req.audio) &&
    (r.upTo === undefined || quantity <= r.upTo));
  if (!matches.length) return { ok: false, reason: "no price for these settings" };
  const row = matches.reduce((a, b) => ((b.upTo ?? Infinity) < (a.upTo ?? Infinity) ? b : a));
  return { ok: true, costUsd: microCeil(row.costUsd * quantity) };
}

/**
 * What one job costs the platform, in vendor dollars, from the private file.
 * Throws VendorPriceUnavailable for an engine not opted in, or when the file
 * is unset, missing or invalid, or has no row for these settings. The caller
 * turns dollars into credits exactly as it does for every other engine.
 * `engines` is the opt-in list; only a test passes its own.
 */
export function fileVendorCostUsd(engine: string, req: VendorPriceRequest, engines: readonly string[] = FILE_PRICED_ENGINES): number {
  if (!engines.includes(engine)) throw new VendorPriceUnavailable(engine, "this engine is not priced from the vendor price file");
  const v = load();
  if (v.state !== "loaded") throw new VendorPriceUnavailable(engine, v.state === "invalid" ? "the vendor price file is invalid" : v.reason);
  const got = costFromTable(v.table, engine, req);
  if (!got.ok) throw new VendorPriceUnavailable(engine, got.reason);
  return got.costUsd;
}
