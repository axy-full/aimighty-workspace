#!/usr/bin/env node
/**
 * The owner's converter: his cost sheet (CSV) in, the vendor price file
 * (JSON, docs/vendor-prices.md) out, on his own machine.
 *
 *   node --permission --allow-fs-read="*" scripts/vendor-prices/csv-to-json.mjs ~/cost-sheet.csv | pbcopy
 *
 * Never redirect the output into a file inside this (public) repo's folder:
 * the JSON holds the real figures. Copy it (pbcopy) or keep it outside the
 * repo; .gitignore also ignores /vendor-prices*.json and *cost-sheet*.csv.
 *
 *   --check            validate only: print the report, not the JSON
 *   --engines a,b      check coverage for these engine ids only
 *   --skip a,b         leave these engines out of the coverage check (listed in the report)
 *   <file.json>        check a file already converted (implies --check)
 *
 * It reads the one file named and the repo's own code, prints the JSON to
 * stdout and a report to stderr, and nothing else: it writes no file, opens
 * no connection and logs no figure (the report names lines, columns and
 * engines only). The figures go from the printed JSON into Coolify by hand.
 *
 * The file's rules are lib/vendorPriceFile.ts's parseVendorPrices, the one the
 * server uses; coverage is checked against the model registry, lib/models.ts
 * MODELS (every engine x resolution x length the product offers), and against
 * the engines the server prices from the file (FILE_PRICED_UNITS there).
 *
 * Exit: 0 valid and covered (and --help, which prints usage to stderr);
 * 1 refused: a usage error, an unreadable file, a Node too old to load the
 * sources, a load failure, or the sheet or the file's shape; 2 valid but not
 * covered (a row missing for an engine, resolution or length).
 *
 * Needs the repo's Node (24; 22.18 or newer works): it loads the TypeScript
 * sources with Node's own type stripping, no build and no extra package.
 */
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

/* Node notes that lib/*.ts carry no module type; that note is not the owner's concern. */
process.removeAllListeners("warning");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fail = (message, code = 1) => { process.stderr.write(`${message}\n`); process.exit(code); };

const args = process.argv.slice(2);
let input = null, check = false, scope = null, skip = null;
const ids = (v) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--check") check = true;
  else if (a === "--engines") scope = ids(args[++i]);
  else if (a.startsWith("--engines=")) scope = ids(a.slice("--engines=".length));
  else if (a === "--skip") skip = ids(args[++i]);
  else if (a.startsWith("--skip=")) skip = ids(a.slice("--skip=".length));
  else if (a === "--help" || a === "-h") fail("usage: node scripts/vendor-prices/csv-to-json.mjs <sheet.csv | file.json> [--check] [--engines id,id] [--skip id,id]", 0);
  else if (a.startsWith("--")) fail(`unknown option ${a.split("=")[0]}`);
  else if (input) fail("give one file");
  else input = a;
}
if (!input) fail("usage: node scripts/vendor-prices/csv-to-json.mjs <sheet.csv | file.json> [--check] [--engines id,id] [--skip id,id]");
if (scope && !scope.length) fail("--engines needs at least one engine id");
if (skip && !skip.length) fail("--skip needs at least one engine id");
if (typeof registerHooks !== "function" || !process.features?.typescript) fail("This needs Node 22.18 or newer (the repo uses Node 24).");

const kind = /\.json$/i.test(input) ? "json" : "csv";
if (kind === "json") check = true;
let text;
try {
  text = readFileSync(input, "utf8");
} catch {
  fail("cannot read that file");
}

const isOurs = (url) => {
  if (!url?.startsWith("file:")) return false;
  const file = fileURLToPath(url);
  return file.startsWith(ROOT + path.sep) && !file.includes(`${path.sep}node_modules${path.sep}`);
};
/* The repo's sources import each other without extensions and through "@/": resolve those to .ts files. */
registerHooks({
  resolve(spec, context, next) {
    let base = null;
    if (spec.startsWith("@/")) base = path.join(ROOT, spec.slice(2));
    else if ((spec.startsWith("./") || spec.startsWith("../")) && isOurs(context.parentURL)) {
      base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), spec);
    }
    if (base && !/\.[cm]?[jt]sx?$/.test(base)) {
      for (const c of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) if (existsSync(c)) return next(pathToFileURL(c).href, context);
    }
    return next(spec, context);
  },
});

const lib = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
let loaded;
try {
  loaded = await Promise.all([lib("lib/vendorPriceFile.ts"), lib("lib/models.ts"), import("./convert.mjs")]);
} catch (error) {
  /* The error names a source file, never a figure from the sheet (the sheet is not parsed yet). */
  fail(`cannot load the repo's sources (run it from a full clone, with the repo's Node): ${error instanceof Error ? error.message.split("\n")[0] : "unknown error"}`);
}
const [{ parseVendorPrices, VENDOR_PRICES_FORMAT, FILE_PRICED_UNITS }, { MODELS }, { convert, report }] = loaded;

const result = convert(text, { kind, parse: parseVendorPrices, format: VENDOR_PRICES_FORMAT, models: MODELS, scope, skip, required: FILE_PRICED_UNITS });
process.stderr.write(`${report(result, { scope })}\n`);
if (result.stage === "sheet" || result.stage === "shape") process.exit(1);
if (!result.ok) process.exit(2);
if (!check) process.stdout.write(result.json);
