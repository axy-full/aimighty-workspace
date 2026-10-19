/**
 * The cost sheet's CSV into the vendor price file (docs/vendor-prices.md), and
 * the check that it covers the model registry. Pure: no file, network or
 * console here. The command is scripts/vendor-prices/csv-to-json.mjs.
 *
 * Every rule about the file itself lives in lib/vendorPriceFile.ts
 * (parseVendorPrices), passed in as `parse`, so the converter and the server
 * can never disagree. This file adds only what a CSV needs: columns, plain
 * dollars, and line numbers.
 *
 * No message here ever carries a figure: problems name a line, a column or
 * an engine id, never a cell's value.
 */

/** The sheet's columns, in this order. Only engine, unit and costUsd are required; an empty cell means "not set". */
export const CSV_COLUMNS = ["engine", "unit", "resolution", "audio", "length", "upTo", "costUsd"];
const REQUIRED = ["engine", "unit", "costUsd"];
/** Plain US dollars: digits, at most one dot. No sign, currency, code, separator or exponent. */
const PLAIN_DOLLARS = /^\d+(\.\d+)?$/;
const PLAIN_NUMBER = /^\d+(\.\d+)?$/;
const WHOLE = /^\d+$/;
const MARGINISH = /margin|markup|multiplier|mark-up|uplift|resale|sell|price/i;
const SAFE_NAME = /^[A-Za-z][A-Za-z _-]{0,39}$/;

/** RFC 4180 records: quoted fields, doubled quotes, CRLF or LF. Returns each record with the line it starts on. */
export function parseCsv(text) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records = [];
  let field = "", record = [], line = 1, startLine = 1, quoted = false, i = 0, sawQuote = false;
  const endField = () => { record.push(sawQuote ? field : field.trim()); field = ""; sawQuote = false; };
  const endRecord = () => { endField(); records.push({ line: startLine, cells: record }); record = []; startLine = line; };
  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      if (c === "\n") line++;
      field += c; i++; continue;
    }
    if (c === '"' && field.trim() === "") { quoted = true; sawQuote = true; field = ""; i++; continue; }
    if (c === ",") { endField(); i++; continue; }
    if (c === "\r" && src[i + 1] === "\n") { i++; continue; }
    if (c === "\n") { line++; endRecord(); i++; continue; }
    field += c; i++;
  }
  if (quoted) return { ok: false, problems: [`line ${startLine}: a quoted cell is never closed`] };
  if (field !== "" || record.length) endRecord();
  return { ok: true, records: records.filter((r) => !(r.cells.length === 1 && r.cells[0] === "")) };
}

const columnLabel = (name, index) => (SAFE_NAME.test(name) ? `"${name}"` : `column ${index + 1}`);

/**
 * CSV text to the price table object, before the shared rules run. Problems
 * are by line and column; a cell's value is never repeated.
 */
export function csvToTable(text, format) {
  const parsed = parseCsv(text);
  if (!parsed.ok) return parsed;
  const rows = parsed.records.filter((r) => !String(r.cells[0] ?? "").startsWith("#"));
  if (!rows.length) return { ok: false, problems: ["the file has no header row"] };
  const problems = [];
  const header = rows[0];
  const index = new Map();
  header.cells.forEach((raw, i) => {
    const name = raw.trim();
    const known = CSV_COLUMNS.find((c) => c.toLowerCase() === name.toLowerCase());
    if (known) {
      if (index.has(known)) problems.push(`line ${header.line}: column "${known}" appears twice`);
      else index.set(known, i);
    } else if (MARGINISH.test(name)) {
      problems.push(`line ${header.line}: ${columnLabel(name, i)} looks like a margin or a selling price; the sheet holds vendor costs only (margins are a separate setting)`);
    } else {
      problems.push(`line ${header.line}: ${columnLabel(name, i)} is not a column this sheet uses (columns: ${CSV_COLUMNS.join(", ")}; costs go in "costUsd", in US dollars only)`);
    }
  });
  for (const c of REQUIRED) if (!index.has(c)) problems.push(`line ${header.line}: the header has no "${c}" column`);
  if (problems.length) return { ok: false, problems };

  const engines = Object.create(null);
  /** engine|unit -> the CSV line of each row, in order, to point the shared parser's "row N" at a line. */
  const lines = new Map();
  for (const r of rows.slice(1)) {
    const at = `line ${r.line}`;
    if (r.cells.length > header.cells.length) {
      problems.push(`${at}: more cells than columns (a number written with a thousands separator, such as a comma, splits a cell)`);
      continue;
    }
    const cell = (c) => (index.has(c) ? String(r.cells[index.get(c)] ?? "").trim() : "");
    const engine = cell("engine"), unit = cell("unit"), cost = cell("costUsd");
    if (!engine) { problems.push(`${at}: "engine" is empty`); continue; }
    if (!unit) { problems.push(`${at}: "unit" is empty`); continue; }
    const row = {};
    let bad = false;
    const res = cell("resolution");
    if (res) row.resolution = res;
    const audio = cell("audio");
    if (audio) {
      if (/^true$/i.test(audio)) row.audio = true;
      else if (/^false$/i.test(audio)) row.audio = false;
      else { problems.push(`${at}: "audio" must be true, false or empty`); bad = true; }
    }
    const length = cell("length");
    if (length) {
      if (WHOLE.test(length)) row.length = Number(length);
      else { problems.push(`${at}: "length" must be whole seconds`); bad = true; }
    }
    const upTo = cell("upTo");
    if (upTo) {
      if (PLAIN_NUMBER.test(upTo)) row.upTo = Number(upTo);
      else { problems.push(`${at}: "upTo" must be a plain number`); bad = true; }
    }
    if (!cost) { problems.push(`${at}: "costUsd" is empty`); bad = true; }
    else if (!PLAIN_DOLLARS.test(cost)) {
      problems.push(`${at}: "costUsd" must be plain US dollars: digits and at most one dot, with no currency sign or code, no thousands separator, no minus and no exponent`);
      bad = true;
    } else if (!(Number(cost) > 0)) { problems.push(`${at}: "costUsd" must be above zero`); bad = true; }
    else row.costUsd = Number(cost);
    if (bad) continue;
    const units = Object.hasOwn(engines, engine) ? engines[engine] : (engines[engine] = Object.create(null));
    (Object.hasOwn(units, unit) ? units[unit] : (units[unit] = [])).push(row);
    const key = `${engine}|${unit}`;
    if (!lines.has(key)) lines.set(key, []);
    lines.get(key).push(r.line);
  }
  if (problems.length) return { ok: false, problems };
  if (!Object.keys(engines).length) return { ok: false, problems: ["the sheet has no cost rows"] };
  return { ok: true, table: { format, engines }, lines };
}

/** The shared parser numbers rows within an engine's unit; point each at its CSV line. */
function withLines(problems, lines) {
  return problems.map((p) => p.replace(/engine "([^"]+)", unit "([^"]+)", row (\d+)/, (all, engine, unit, n) => {
    const line = lines?.get(`${engine}|${unit}`)?.[Number(n) - 1];
    return line ? `${all} (CSV line ${line})` : all;
  }));
}

/**
 * Every engine x resolution x length the registry (lib/models.ts MODELS) offers
 * must have a row. A per-unit row (second, token, image, ...) covers every
 * length at its resolution; "job" rows must name each length the engine
 * offers. If an engine's rows name sound, both with and without are needed
 * where the engine offers sound. Names only, never a figure.
 *
 * Every engine the registry offers is checked (owner, 19 Oct: "every engine,
 * resolution and length the registry knows has a row"); only a retired one is
 * not expected. Leaving an engine out is explicit: `skip` (--skip), and the
 * report lists every engine not checked and why.
 *
 * The engines the server prices from the file (`required`, lib/vendorPriceFile.ts
 * FILE_PRICED_UNITS, such as lip-sync's models, which are not in the registry)
 * are checked the same way: each needs a row in its unit that names no
 * resolution, sound or length, since its quote asks for none, and no band
 * (upTo), since its job settles at the rate it was quoted at. Without such a
 * row the server refuses every quote of that engine.
 */
/**
 * @param {{ engines: Record<string, Record<string, Array<Record<string, unknown>>>> }} table
 * @param {Array<{ id: string; resolutions: string[]; durations?: number[]; supportsAudio?: boolean; retired?: boolean }>} models
 * @param {string[] | null} [scope] check only these (--engines)
 * @param {string[] | null} [skip] never check these (--skip)
 * @param {Record<string, string> | null} [required] engine id -> unit, for the engines priced from the file
 */
export function coverage(table, models, scope = null, skip = null, required = null) {
  const missing = [], checked = [], skipped = [], outOfScope = [], retired = [], filePriced = [];
  const ownUnits = (id) => (Object.hasOwn(table.engines, id) ? table.engines[id] : null);
  const inScope = (id) => !scope || scope.includes(id);
  const known = new Set(models.map((m) => m.id));
  const filePricedIds = Object.keys(required ?? {}).filter((id) => !known.has(id));
  for (const m of models) {
    if (skip?.includes(m.id)) { skipped.push(m.id); continue; }
    if (m.retired) { retired.push(m.id); continue; }
    if (!inScope(m.id)) { outOfScope.push(m.id); continue; }
    checked.push(m.id);
    const units = ownUnits(m.id);
    if (!units || !Object.keys(units).length) { missing.push(`${m.id}: no rows`); continue; }
    for (const resolution of m.resolutions) {
      const res = String(resolution).toLowerCase();
      const gaps = [];
      let covered = false;
      for (const [unit, rows] of Object.entries(units)) {
        const namesAudio = rows.some((r) => "audio" in r);
        const audios = namesAudio ? (m.supportsAudio ? [false, true] : [false]) : [undefined];
        const lengths = unit === "job" && rows.some((r) => "length" in r) && m.durations?.length ? m.durations : [undefined];
        const needs = [];
        for (const audio of audios) for (const length of lengths) {
          const hit = rows.some((r) =>
            (r.resolution === undefined || r.resolution === res) &&
            (audio === undefined || r.audio === audio) &&
            (length === undefined || r.length === length));
          if (!hit) needs.push([audio, length]);
        }
        if (!needs.length) { covered = true; break; }
        if (rows.some((r) => r.resolution === undefined || r.resolution === res)) gaps.push(...needs.map(([audio, length]) =>
          `${m.id}: ${resolution}${length === undefined ? "" : `, ${length} s`}${audio === undefined ? "" : audio ? ", with sound" : ", without sound"} (unit "${unit}")`));
      }
      if (!covered) missing.push(...(gaps.length ? gaps : [`${m.id}: ${resolution}`]));
    }
  }
  for (const id of filePricedIds) {
    if (skip?.includes(id)) continue;
    if (!inScope(id)) { outOfScope.push(id); continue; }
    filePriced.push(id);
    const unit = required[id];
    const units = ownUnits(id);
    const rows = units && Object.hasOwn(units, unit) ? units[unit] : null;
    if (!rows || !rows.length) missing.push(`${id}: no "${unit}" rows (priced from this file)`);
    else if (rows.some((r) => "resolution" in r || "audio" in r || "length" in r)) missing.push(`${id}: its "${unit}" rows must name no resolution, sound or length (priced from this file)`);
    /* A job of these engines keeps the rate it was quoted at and settles at it, so a band (a rate that depends on the quantity) would not hold at settlement. */
    if (rows?.some((r) => "upTo" in r)) missing.push(`${id}: its "${unit}" rows must not name a band (upTo): a job settles at the rate it was quoted at (priced from this file)`);
  }
  if (scope) for (const id of scope) if (!known.has(id) && !filePricedIds.includes(id) && !skip?.includes(id)) {
    checked.push(id);
    const units = ownUnits(id);
    if (!units || !Object.keys(units).length) missing.push(`${id}: no rows (not in the model registry)`);
  }
  for (const id of skip ?? []) if (!known.has(id)) skipped.push(id);
  const unknownSkips = (skip ?? []).filter((id) => !known.has(id) && !filePricedIds.includes(id) && !Object.hasOwn(table.engines, id));
  const outside = Object.keys(table.engines).filter((id) => !known.has(id) && !filePricedIds.includes(id));
  return { missing, checked, skipped, outOfScope, retired, unknownSkips, outside, filePriced };
}

/**
 * The whole run. `kind` is "csv" or "json" (a file already converted, checked
 * again before it is pasted). Returns the JSON text to print, or problems.
 */
/**
 * @param {string} text
 * @param {{ kind: "csv" | "json"; parse: (text: string) => { ok: boolean; table?: any; problems?: string[] }; format: string; models: any[]; scope?: string[] | null; skip?: string[] | null; required?: Record<string, string> | null }} options
 */
export function convert(text, { kind, parse, format, models, scope = null, skip = null, required = null }) {
  let lines = null;
  let json;
  if (kind === "csv") {
    const got = csvToTable(text, format);
    if (!got.ok) return { ok: false, stage: "sheet", problems: got.problems };
    lines = got.lines;
    json = JSON.stringify(got.table, null, 2) + "\n";
  } else {
    json = text;
  }
  const checked = parse(json);
  if (!checked.ok) return { ok: false, stage: "shape", problems: withLines(checked.problems, lines) };
  const engines = Object.keys(checked.table.engines).length;
  const rows = Object.values(checked.table.engines).reduce((n, units) => n + Object.values(units).reduce((k, r) => k + r.length, 0), 0);
  const cover = coverage(checked.table, models, scope, skip, required);
  return { ok: cover.missing.length === 0, stage: cover.missing.length ? "coverage" : "done", json, engines, rows, coverage: cover };
}

/** What the person running it reads (stderr). Names and counts only. */
/**
 * @param {any} result
 * @param {{ scope?: string[] | null }} [options]
 */
export function report(result, { scope = null } = {}) {
  const out = [];
  if (result.stage === "sheet" || result.stage === "shape") {
    out.push(`vendor prices: refused (${result.stage === "sheet" ? "the sheet" : "the file's shape"}), ${result.problems.length} problem${result.problems.length === 1 ? "" : "s"}:`);
    for (const p of result.problems) out.push(`  - ${p}`);
    return out.join("\n");
  }
  const c = result.coverage;
  out.push(`vendor prices: ${result.engines} engine${result.engines === 1 ? "" : "s"}, ${result.rows} row${result.rows === 1 ? "" : "s"}; the shape is valid.`);
  out.push(scope
    ? `coverage: checked only the engines named (${c.checked.length}).`
    : `coverage: ${c.checked.length} registry engines checked.`);
  if (c.filePriced?.length) out.push(`priced from this file, checked (${c.filePriced.length}): ${c.filePriced.join(", ")}`);
  if (c.skipped.length) out.push(`NOT CHECKED, skipped with --skip (${c.skipped.length}): ${c.skipped.join(", ")}`);
  if (c.unknownSkips.length) out.push(`--skip names engines neither the registry nor the sheet has (a typo?): ${c.unknownSkips.join(", ")}`);
  if (c.outOfScope.length) out.push(`NOT CHECKED, outside --engines (${c.outOfScope.length}): ${c.outOfScope.join(", ")}`);
  if (c.retired.length) out.push(`not expected, retired (${c.retired.length}): ${c.retired.join(", ")}`);
  if (c.outside.length) out.push(`in the sheet but not in the model registry (${c.outside.length}; fine for a service such as lip-sync): ${c.outside.join(", ")}`);
  if (c.missing.length) {
    out.push(`MISSING, no row for (${c.missing.length}):`);
    for (const m of c.missing) out.push(`  - ${m}`);
    out.push("Refused: add the rows above, check only some engines with --engines <id,id>, or leave engines out with --skip <id,id>.");
  } else {
    out.push("coverage: complete.");
  }
  return out.join("\n");
}
