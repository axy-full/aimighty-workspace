import { test, expect } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import {
  FILE_PRICED_ENGINES, FILE_PRICED_UNITS, VENDOR_PRICES_ENV, VENDOR_PRICES_FORMAT, VendorPriceUnavailable,
  costFromTable, fileVendorCostUsd, fileVendorQuote, parseVendorPrices, reloadVendorPrices, vendorPricesStatus,
  type VendorPriceTable,
} from "../../lib/vendorPriceFile";
import { VENDOR_RATES } from "../../lib/vendorRates";

/**
 * The private vendor price file (lib/vendorPriceFile.ts, docs/vendor-prices.md).
 *
 * Every figure below is a SYNTHETIC PLACEHOLDER built in this test, not a
 * vendor's price: no vendor dollar is ever written into the repo (owner,
 * 19 Oct 2026). The engine ids are placeholders too.
 *
 * No network, no database, no engine call: the module only reads a file.
 */

const PLACEHOLDER_COST_A = 7.77;
const PLACEHOLDER_COST_B = 3.33;
const PLACEHOLDER_COST_C = 11.11;
const PLACEHOLDER_COST_D = 5.55;
const PLACEHOLDER_ENGINE_A = "placeholder-engine-a";
const PLACEHOLDER_ENGINE_B = "placeholder/engine-b";
const PLACEHOLDER_READER = "placeholder-reader";
const OPT_IN = [PLACEHOLDER_ENGINE_A, PLACEHOLDER_ENGINE_B, PLACEHOLDER_READER];
const ALL_PLACEHOLDER_COSTS = [PLACEHOLDER_COST_A, PLACEHOLDER_COST_B, PLACEHOLDER_COST_C, PLACEHOLDER_COST_D];

type Row = Record<string, unknown>;
/** A price file as plain JSON, loose enough for a test to break it. */
type Loose = Record<string, unknown> & { engines: Record<string, Record<string, Row[]>> };

/** A valid file: engine x resolution x sound per second; a fixed-length job; page bands for reading. */
function placeholderFile(): Loose {
  return {
    format: VENDOR_PRICES_FORMAT,
    engines: {
      [PLACEHOLDER_ENGINE_A]: {
        second: [
          { resolution: "720p", audio: false, costUsd: PLACEHOLDER_COST_B },
          { resolution: "720p", audio: true, costUsd: PLACEHOLDER_COST_A },
          { resolution: "1080p", audio: false, costUsd: PLACEHOLDER_COST_D },
          { resolution: "1080p", audio: true, costUsd: PLACEHOLDER_COST_C },
        ],
      },
      [PLACEHOLDER_ENGINE_B]: {
        job: [
          { resolution: "1080p", length: 5, costUsd: PLACEHOLDER_COST_A },
          { resolution: "1080p", length: 10, costUsd: PLACEHOLDER_COST_C },
        ],
      },
      [PLACEHOLDER_READER]: {
        page: [
          { upTo: 10, costUsd: PLACEHOLDER_COST_C },
          { upTo: 100, costUsd: PLACEHOLDER_COST_B },
        ],
        minute: [{ costUsd: PLACEHOLDER_COST_D }],
      },
    },
  };
}

const dir = mkdtempSync(path.join(tmpdir(), "particl-vendor-prices-"));
let n = 0;
function writeFile(content: unknown): string {
  const file = path.join(dir, `prices-${++n}.json`);
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}
function useFile(file: string | undefined): void {
  if (file === undefined) delete process.env[VENDOR_PRICES_ENV];
  else process.env[VENDOR_PRICES_ENV] = file;
  reloadVendorPrices();
}
const micro = (usd: number) => Math.ceil(usd * 1e6 - 1e-6) / 1e6;

function refusal(fn: () => unknown): VendorPriceUnavailable {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(VendorPriceUnavailable);
    const err = e as VendorPriceUnavailable;
    expect(err.status).toBe(503);
    expect(err.code).toBe("unpriced");
    expect(err.message).toBe("This engine has no confirmed price.");
    return err;
  }
  throw new Error("expected the quote to be refused, and it was priced");
}

/** No placeholder figure appears in a string meant for an admin or a log. */
function expectNoFigure(text: string): void {
  for (const c of ALL_PLACEHOLDER_COSTS) expect(text).not.toContain(String(c));
}

test.afterEach(() => useFile(undefined));

test.describe("the file's shape", () => {
  test("a valid file parses, and prices engine x resolution x sound, a fixed length, and bands", () => {
    const parsed = parseVendorPrices(JSON.stringify(placeholderFile()));
    expect(parsed.ok).toBe(true);
    const table = (parsed as { ok: true; table: VendorPriceTable }).table;
    expect(Object.keys(table.engines).sort()).toEqual([PLACEHOLDER_ENGINE_A, PLACEHOLDER_ENGINE_B, PLACEHOLDER_READER].sort());

    expect(costFromTable(table, PLACEHOLDER_ENGINE_A, { unit: "second", quantity: 5, resolution: "1080P", audio: true }))
      .toEqual({ ok: true, costUsd: micro(PLACEHOLDER_COST_C * 5) });
    expect(costFromTable(table, PLACEHOLDER_ENGINE_A, { unit: "second", quantity: 4, resolution: "720p", audio: false }))
      .toEqual({ ok: true, costUsd: micro(PLACEHOLDER_COST_B * 4) });
    expect(costFromTable(table, PLACEHOLDER_ENGINE_B, { unit: "job", resolution: "1080p", length: 10 }))
      .toEqual({ ok: true, costUsd: micro(PLACEHOLDER_COST_C) });
    expect(costFromTable(table, PLACEHOLDER_ENGINE_B, { unit: "job", quantity: 2, resolution: "1080p", length: 5 }))
      .toEqual({ ok: true, costUsd: micro(PLACEHOLDER_COST_A * 2) });
    /* Bands: the smallest band the quantity fits. */
    expect(costFromTable(table, PLACEHOLDER_READER, { unit: "page", quantity: 10 })).toEqual({ ok: true, costUsd: micro(PLACEHOLDER_COST_C * 10) });
    expect(costFromTable(table, PLACEHOLDER_READER, { unit: "page", quantity: 11 })).toEqual({ ok: true, costUsd: micro(PLACEHOLDER_COST_B * 11) });
    expect(costFromTable(table, PLACEHOLDER_READER, { unit: "minute", quantity: 3 })).toEqual({ ok: true, costUsd: micro(PLACEHOLDER_COST_D * 3) });
  });

  test("nothing is guessed: a setting with no row, a missing setting, or a quantity past the last band is unpriced", () => {
    const table = (parseVendorPrices(JSON.stringify(placeholderFile())) as { ok: true; table: VendorPriceTable }).table;
    const no = (r: ReturnType<typeof costFromTable>) => expect(r.ok).toBe(false);
    no(costFromTable(table, PLACEHOLDER_ENGINE_A, { unit: "second", quantity: 5, resolution: "4k", audio: false }));
    no(costFromTable(table, PLACEHOLDER_ENGINE_A, { unit: "second", quantity: 5, resolution: "1080p" }));
    no(costFromTable(table, PLACEHOLDER_ENGINE_A, { unit: "second", quantity: 5, audio: true }));
    no(costFromTable(table, PLACEHOLDER_ENGINE_A, { unit: "second", resolution: "1080p", audio: true }));
    no(costFromTable(table, PLACEHOLDER_ENGINE_A, { unit: "second", quantity: 0, resolution: "1080p", audio: true }));
    no(costFromTable(table, PLACEHOLDER_ENGINE_A, { unit: "job", resolution: "1080p", audio: true }));
    no(costFromTable(table, PLACEHOLDER_ENGINE_B, { unit: "job", resolution: "1080p", length: 7 }));
    no(costFromTable(table, PLACEHOLDER_ENGINE_B, { unit: "job", resolution: "1080p" }));
    no(costFromTable(table, PLACEHOLDER_READER, { unit: "page", quantity: 101 }));
    no(costFromTable(table, "placeholder-not-in-file", { unit: "second", quantity: 1 }));
  });

  test("an invalid file is rejected whole, and its problems never repeat a figure", () => {
    const bad = (mutate: (f: Loose) => void, expected: RegExp) => {
      const f = placeholderFile();
      mutate(f);
      const parsed = parseVendorPrices(JSON.stringify(f));
      expect(parsed.ok, expected.source).toBe(false);
      const problems = (parsed as { ok: false; problems: string[] }).problems;
      expect(problems.join("\n")).toMatch(expected);
      expectNoFigure(problems.join("\n"));
    };
    expect(parseVendorPrices("{ not json").ok).toBe(false);
    expect(parseVendorPrices("[]").ok).toBe(false);
    bad((f) => { f.format = "something-else"; }, /"format" must be/);
    bad((f) => { delete (f as Record<string, unknown>).engines; }, /"engines" must be an object/);
    bad((f) => { f.margins = { [PLACEHOLDER_ENGINE_A]: PLACEHOLDER_COST_D }; }, /margins do not belong/);
    bad((f) => { f.engines[PLACEHOLDER_ENGINE_A].margin = [{ costUsd: PLACEHOLDER_COST_D }]; }, /margins do not belong/);
    bad((f) => { f.engines[PLACEHOLDER_ENGINE_A].second[0].margin = PLACEHOLDER_COST_D; }, /margins do not belong/);
    bad((f) => { f.engines[PLACEHOLDER_ENGINE_A].furlong = [{ costUsd: PLACEHOLDER_COST_A }]; }, /a unit this format does not define/);
    bad((f) => { f.engines[PLACEHOLDER_ENGINE_A].second[0].costUsd = 0; }, /"costUsd" must be a number above zero/);
    bad((f) => { f.engines[PLACEHOLDER_ENGINE_A].second[0].costUsd = -PLACEHOLDER_COST_A; }, /"costUsd" must be a number above zero/);
    bad((f) => { f.engines[PLACEHOLDER_ENGINE_A].second[0].costUsd = String(PLACEHOLDER_COST_A); }, /"costUsd" must be a number above zero/);
    bad((f) => { delete f.engines[PLACEHOLDER_ENGINE_A].second[0].costUsd; }, /"costUsd" must be a number above zero/);
    bad((f) => { delete f.engines[PLACEHOLDER_ENGINE_A].second[1].audio; }, /must name the same keys/);
    bad((f) => { f.engines[PLACEHOLDER_ENGINE_A].second.push({ ...f.engines[PLACEHOLDER_ENGINE_A].second[0] }); }, /repeats another row/);
    bad((f) => { f.engines[PLACEHOLDER_ENGINE_A].second[0].length = 5; }, /"length" is only for unit "job"/);
    bad((f) => { f.engines[PLACEHOLDER_ENGINE_B].job[0].upTo = 5; }, /a band\) is not for unit "job"/);
    bad((f) => { f.engines[PLACEHOLDER_ENGINE_B].job[0].length = 2.5; }, /whole seconds/);
    bad((f) => { f.engines[PLACEHOLDER_ENGINE_A].second[0].audio = "yes"; }, /"audio" must be true or false/);
    bad((f) => { f.engines[PLACEHOLDER_ENGINE_A].second = []; }, /non-empty list/);
    bad((f) => { f.engines[String(PLACEHOLDER_COST_A)] = { second: [{ costUsd: PLACEHOLDER_COST_A }] }; }, /unusable id/);
    bad((f) => { f.engines[PLACEHOLDER_ENGINE_A].second[0][String(PLACEHOLDER_COST_D)] = 1; }, /a key this format does not define/);
  });
  test("an engine id an object already has (__proto__, constructor, prototype) is refused, and nothing inherited is ever a price", () => {
    for (const id of ["__proto__", "constructor", "prototype"]) {
      /* Written as text: a JSON key "__proto__" is an own key once parsed, which is how a sheet would carry it. */
      const text = JSON.stringify(placeholderFile()).replace(
        /"engines":\{/, `"engines":{${JSON.stringify(id)}:{"second":[{"costUsd":${PLACEHOLDER_COST_A}}]},`);
      expect(text).toContain(`"${id}":{"second"`);
      const parsed = parseVendorPrices(text);
      expect(parsed.ok, id).toBe(false);
      const problems = (parsed as { ok: false; problems: string[] }).problems.join("\n");
      expect(problems).toContain("this id is reserved");
      expectNoFigure(problems);
    }

    const table = (parseVendorPrices(JSON.stringify(placeholderFile())) as { ok: true; table: VendorPriceTable }).table;
    expect(Object.getPrototypeOf(table.engines)).toBeNull();
    expect(Object.keys(table.engines)).toHaveLength(3);
    for (const id of ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty", "valueOf"]) {
      expect(costFromTable(table, id, { unit: "job" }).ok, id).toBe(false);
      expect(costFromTable(table, id, { unit: "second", quantity: 5 }).ok, id).toBe(false);
    }
    /* A unit name an object has is no unit either. */
    expect(costFromTable(table, PLACEHOLDER_ENGINE_A, { unit: "constructor" as never, quantity: 1 }).ok).toBe(false);
    expect(costFromTable(table, PLACEHOLDER_ENGINE_A, { unit: "__proto__" as never, quantity: 1 }).ok).toBe(false);

    /* An opted-in engine the file does not name is refused, never priced from something inherited. */
    useFile(writeFile(placeholderFile()));
    for (const id of ["__proto__", "constructor", "toString"]) {
      refusal(() => fileVendorCostUsd(id, { unit: "job" }, [id]));
      refusal(() => fileVendorCostUsd(id, { unit: "second", quantity: 5 }, [id]));
    }
  });

  test("a number of jobs is a positive whole number, or the job is unpriced", () => {
    const table = (parseVendorPrices(JSON.stringify(placeholderFile())) as { ok: true; table: VendorPriceTable }).table;
    const job = (quantity: number | undefined) => costFromTable(table, PLACEHOLDER_ENGINE_B, { unit: "job", quantity, resolution: "1080p", length: 5 });
    expect(job(undefined)).toEqual({ ok: true, costUsd: micro(PLACEHOLDER_COST_A) });
    expect(job(3)).toEqual({ ok: true, costUsd: micro(PLACEHOLDER_COST_A * 3) });
    for (const q of [0.5, 1.5, 2.25, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(job(q).ok, String(q)).toBe(false);
    }
    expect(job(1.5)).toEqual({ ok: false, reason: "a number of jobs must be a whole number" });
    /* A per-unit quantity may still be fractional: seconds, minutes. */
    expect(costFromTable(table, PLACEHOLDER_READER, { unit: "minute", quantity: 2.5 })).toEqual({ ok: true, costUsd: micro(PLACEHOLDER_COST_D * 2.5) });

    useFile(writeFile(placeholderFile()));
    expect(refusal(() => fileVendorCostUsd(PLACEHOLDER_ENGINE_B, { unit: "job", quantity: 1.5, resolution: "1080p", length: 5 }, OPT_IN)).reason)
      .toBe("a number of jobs must be a whole number");
    expect(fileVendorCostUsd(PLACEHOLDER_ENGINE_B, { unit: "job", quantity: 2, resolution: "1080p", length: 5 }, OPT_IN)).toBe(micro(PLACEHOLDER_COST_A * 2));
  });
});

test.describe("loading the file from the variable", () => {
  test("no variable, a relative path, a missing file or a directory: the engine is unpriced, never a number from code", () => {
    useFile(undefined);
    expect(refusal(() => fileVendorCostUsd(PLACEHOLDER_ENGINE_A, { unit: "second", quantity: 5, resolution: "1080p", audio: true }, OPT_IN)).reason)
      .toContain("is not set");
    expect(vendorPricesStatus()).toEqual({ variable: VENDOR_PRICES_ENV, state: "unset", engines: 0 });

    useFile("relative/prices.json");
    refusal(() => fileVendorCostUsd(PLACEHOLDER_ENGINE_A, { unit: "second", quantity: 5, resolution: "1080p", audio: true }, OPT_IN));
    expect(vendorPricesStatus().state).toBe("missing");

    useFile(path.join(dir, "no-such-file.json"));
    refusal(() => fileVendorCostUsd(PLACEHOLDER_ENGINE_A, { unit: "second", quantity: 5, resolution: "1080p", audio: true }, OPT_IN));
    expect(vendorPricesStatus()).toEqual({ variable: VENDOR_PRICES_ENV, state: "missing", engines: 0 });

    const sub = path.join(dir, "a-directory");
    mkdirSync(sub, { recursive: true });
    useFile(sub);
    refusal(() => fileVendorCostUsd(PLACEHOLDER_ENGINE_A, { unit: "second", quantity: 5, resolution: "1080p", audio: true }, OPT_IN));
    expect(vendorPricesStatus().state).toBe("missing");
  });

  test("an invalid file is unpriced and reported by its problems, with no figure", () => {
    const f = placeholderFile();
    f.engines[PLACEHOLDER_ENGINE_A].second[0].costUsd = 0;
    useFile(writeFile(f));
    refusal(() => fileVendorCostUsd(PLACEHOLDER_ENGINE_A, { unit: "second", quantity: 5, resolution: "1080p", audio: true }, OPT_IN));
    const status = vendorPricesStatus();
    expect(status.state).toBe("invalid");
    expect(status.engines).toBe(0);
    expect(status.problems?.length).toBeGreaterThan(0);
    expectNoFigure(JSON.stringify(status));

    useFile(writeFile("this is not json"));
    expect(() => vendorPricesStatus()).not.toThrow();
    expect(vendorPricesStatus().state).toBe("invalid");
    refusal(() => fileVendorCostUsd(PLACEHOLDER_ENGINE_A, { unit: "second", quantity: 5, resolution: "1080p", audio: true }, OPT_IN));
  });

  test("a valid file prices an opted-in engine; the admin check says loaded and counts engines, nothing else", () => {
    const file = writeFile(placeholderFile());
    useFile(file);
    expect(fileVendorCostUsd(PLACEHOLDER_ENGINE_A, { unit: "second", quantity: 5, resolution: "1080p", audio: true }, OPT_IN))
      .toBe(micro(PLACEHOLDER_COST_C * 5));
    expect(fileVendorCostUsd(PLACEHOLDER_READER, { unit: "page", quantity: 20 }, OPT_IN)).toBe(micro(PLACEHOLDER_COST_B * 20));
    /* A setting the file has no row for is refused, not guessed. */
    expect(refusal(() => fileVendorCostUsd(PLACEHOLDER_ENGINE_B, { unit: "job", resolution: "1080p", length: 7 }, OPT_IN)).reason)
      .toBe("no price for these settings");

    const status = vendorPricesStatus();
    expect(status).toEqual({ variable: VENDOR_PRICES_ENV, state: "loaded", engines: 3 });
    expectNoFigure(JSON.stringify(status));
    expect(JSON.stringify(status)).not.toContain(file);
  });

  test("an engine is priced from the file only once it opts in; today lip-sync's three models do, per second, and Recraft's two raster models and background removal, per image", () => {
    useFile(writeFile(placeholderFile()));
    expect(refusal(() => fileVendorCostUsd(PLACEHOLDER_ENGINE_A, { unit: "second", quantity: 5, resolution: "1080p", audio: true })).reason)
      .toContain("not priced from the vendor price file");
    /* No engine is ever priced in both places: one already in lib/vendorRates.ts moves, it is not copied. */
    expect(FILE_PRICED_ENGINES.filter((id) => id in VENDOR_RATES)).toEqual([]);
    expect([...FILE_PRICED_ENGINES]).toEqual(Object.keys(FILE_PRICED_UNITS));
    expect({ ...FILE_PRICED_UNITS }).toEqual({ "lipsync-2": "second", "lipsync-2-pro": "second", "sync-3": "second", recraftv4_1: "image", recraftv4_1_pro: "image", recraft_remove_background: "image" });
    expect(Object.isFrozen(FILE_PRICED_UNITS) && Object.isFrozen(FILE_PRICED_ENGINES)).toBe(true);
    /* An opted-in engine the file has no row for is unpriced, like any other. */
    expect(refusal(() => fileVendorCostUsd("sync-3", { unit: "second", quantity: 5 })).reason).toBe('no "second" price for this engine');
  });

  test("an engine priced from the file takes no band: a hand-written file with upTo on its rows leaves it unpriced, and other engines keep their bands", () => {
    const file = placeholderFile();
    file.engines["lipsync-2-pro"] = { second: [{ upTo: 10, costUsd: PLACEHOLDER_COST_A }, { upTo: 100, costUsd: PLACEHOLDER_COST_B }] };
    file.engines["sync-3"] = { second: [{ costUsd: PLACEHOLDER_COST_D }] };
    useFile(writeFile(file));
    /* The file itself is valid (bands are a rule of the format)... */
    expect(vendorPricesStatus().state).toBe("loaded");
    /* ...but a file-priced engine with a band is refused, for any quantity, inside or past the bands. */
    for (const quantity of [1, 5, 50, 500]) {
      const r = refusal(() => fileVendorQuote("lipsync-2-pro", { unit: "second", quantity }));
      expect(r.reason, String(quantity)).toBe("this engine's rows must not name a band (upTo)");
      expect(refusal(() => fileVendorCostUsd("lipsync-2-pro", { unit: "second", quantity })).reason).toContain("band");
    }
    /* Another file-priced engine without a band, in the same file, is priced; a banded engine that is not file-priced keeps its bands. */
    expect(fileVendorCostUsd("sync-3", { unit: "second", quantity: 5 })).toBe(micro(PLACEHOLDER_COST_D * 5));
    expect(fileVendorCostUsd(PLACEHOLDER_READER, { unit: "page", quantity: 20 }, OPT_IN)).toBe(micro(PLACEHOLDER_COST_B * 20));
  });

  test("a quote can keep the rate it was priced at: the matched row's cost per unit, from the same read as the total", () => {
    useFile(writeFile(placeholderFile()));
    expect(fileVendorQuote(PLACEHOLDER_READER, { unit: "page", quantity: 20 }, OPT_IN)).toEqual({ costUsd: micro(PLACEHOLDER_COST_B * 20), rateUsd: PLACEHOLDER_COST_B });
    expect(fileVendorQuote(PLACEHOLDER_READER, { unit: "page", quantity: 7 }, OPT_IN)).toEqual({ costUsd: micro(PLACEHOLDER_COST_C * 7), rateUsd: PLACEHOLDER_COST_C });
    expect(fileVendorQuote(PLACEHOLDER_ENGINE_A, { unit: "second", quantity: 5, resolution: "720p", audio: false }, OPT_IN).costUsd)
      .toBe(fileVendorCostUsd(PLACEHOLDER_ENGINE_A, { unit: "second", quantity: 5, resolution: "720p", audio: false }, OPT_IN));
    refusal(() => fileVendorQuote(PLACEHOLDER_READER, { unit: "page", quantity: 101 }, OPT_IN));
    useFile(undefined);
    refusal(() => fileVendorQuote(PLACEHOLDER_READER, { unit: "page", quantity: 1 }, OPT_IN));
  });

  test("a changed file is read again, and a broken edit refuses rather than keep an old figure", () => {
    const file = path.join(dir, "edited.json");
    writeFileSync(file, JSON.stringify(placeholderFile()));
    useFile(file);
    expect(fileVendorCostUsd(PLACEHOLDER_READER, { unit: "minute", quantity: 1 }, OPT_IN)).toBe(micro(PLACEHOLDER_COST_D));

    const changed = placeholderFile();
    changed.engines[PLACEHOLDER_READER].minute[0].costUsd = PLACEHOLDER_COST_A;
    writeFileSync(file, JSON.stringify(changed));
    reloadVendorPrices();
    expect(fileVendorCostUsd(PLACEHOLDER_READER, { unit: "minute", quantity: 1 }, OPT_IN)).toBe(micro(PLACEHOLDER_COST_A));

    writeFileSync(file, "{ half a paste");
    reloadVendorPrices();
    refusal(() => fileVendorCostUsd(PLACEHOLDER_READER, { unit: "minute", quantity: 1 }, OPT_IN));
  });
});

/* ------------------------------------------------------------- the guards */

const ROOT = process.cwd();
const MODULE = path.join(ROOT, "lib", "vendorPriceFile.ts");
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "tests", "test-results", "playwright-report", "public", "docs", "design", "brand"]);

function walk(dirPath: string, out: string[] = []): string[] {
  for (const name of readdirSync(dirPath)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dirPath, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts|js|jsx|mjs)$/.test(name) && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const directive = (text: string, word: string) =>
  new RegExp(`^(?:\\s|//[^\\n]*\\n|/\\*[\\s\\S]*?\\*/)*["']${word}["']`).test(text);

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (!/\.(ts|tsx|js|mjs)$/.test(c)) continue;
    try { if (statSync(c).isFile()) return c; } catch { /* next */ }
  }
  return null;
}

/** Runtime imports only: `import type`, `export type` and all-type named imports are erased and bundle nothing. */
function runtimeImports(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const specs: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const c = node.importClause;
      const typeOnly = c?.isTypeOnly ||
        (c && !c.name && c.namedBindings && ts.isNamedImports(c.namedBindings) &&
          c.namedBindings.elements.length > 0 && c.namedBindings.elements.every((e) => e.isTypeOnly));
      if (!typeOnly) specs.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.isTypeOnly) specs.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.arguments.length && ts.isStringLiteral(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      specs.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return specs;
}

test.describe("the file stays on the server", () => {
  test("no module a client component can reach imports the vendor price file", () => {
    const files = walk(ROOT);
    const text = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
    const roots = files.filter((f) => directive(text.get(f)!, "use client"));
    /* A guard on the guard: it must see the client and walk into lib/. */
    expect(roots.length, "no client component found: the walker is looking in the wrong place").toBeGreaterThan(50);

    const seen = new Set<string>();
    const parent = new Map<string, string>();
    const queue = [...roots];
    roots.forEach((r) => seen.add(r));
    while (queue.length) {
      const f = queue.shift()!;
      const body = text.get(f) ?? (existsSync(f) ? readFileSync(f, "utf8") : "");
      /* A server action is sent as a reference, not bundled. */
      if (!roots.includes(f) && directive(body, "use server")) continue;
      for (const spec of runtimeImports(f, body)) {
        const to = resolveImport(f, spec);
        if (!to || seen.has(to)) continue;
        seen.add(to);
        parent.set(to, f);
        queue.push(to);
      }
    }
    expect([...seen].some((f) => f.startsWith(path.join(ROOT, "lib") + path.sep)), "the walk never reached lib/").toBe(true);

    const chain = (f: string): string[] => (parent.has(f) ? [...chain(parent.get(f)!), path.relative(ROOT, f)] : [path.relative(ROOT, f)]);
    expect(seen.has(MODULE), seen.has(MODULE) ? `client code reaches the vendor price file:\n${chain(MODULE).join("\n  -> ")}` : "").toBe(false);
  });

  test("no vendor price is in the repo: no price file is committed, and the doc names its figures as placeholders", () => {
    const jsonFiles: string[] = [];
    const walkJson = (d: string) => {
      for (const name of readdirSync(d)) {
        if (name === "node_modules" || name === ".next" || name === ".git") continue;
        const full = path.join(d, name);
        let st;
        try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) walkJson(full);
        else if (name.endsWith(".json")) jsonFiles.push(full);
      }
    };
    walkJson(ROOT);
    const committed = jsonFiles.filter((f) => readFileSync(f, "utf8").includes(VENDOR_PRICES_FORMAT));
    expect(committed.map((f) => path.relative(ROOT, f)), "a vendor price file is in the repo").toEqual([]);

    const doc = readFileSync(path.join(ROOT, "docs", "vendor-prices.md"), "utf8");
    expect(doc).toContain(VENDOR_PRICES_ENV);
    expect(doc, "the doc gives a figure where a placeholder name belongs").not.toMatch(/"costUsd"\s*:\s*-?\.?\d/);
    expect(doc, "the doc names a dollar figure").not.toMatch(/\$\s?\d/);

    /* The module holds no figure either: no `costUsd` literal, and no decimal number that could be a rate. */
    const source = readFileSync(MODULE, "utf8");
    expect(source).not.toMatch(/costUsd\s*:\s*-?\.?\d*[1-9]/);
    const decimals = [...source.matchAll(/(?<![\w.])\d*\.\d+(?![\w.])/g)].map((m) => m[0]);
    expect(decimals, "a decimal literal in the vendor price module").toEqual([]);
  });

  test("the admin check is the platform admin's alone, asked for by name, after the admin check passes", () => {
    const route = readFileSync(path.join(ROOT, "app", "api", "admin", "readiness", "route.ts"), "utf8");
    const gate = route.indexOf("await requireSuperAdmin()");
    const refusal = route.indexOf("if (auth.response) return auth.response;");
    const read = route.indexOf("vendorPricesStatus()");
    expect(gate, "the readiness route lost its platform-admin check").toBeGreaterThan(-1);
    expect(refusal).toBeGreaterThan(gate);
    expect(read, "the status is read before the admin check").toBeGreaterThan(refusal);
    expect(route).toMatch(/query\.get\("vendorPrices"\) === "1" \? vendorPricesStatus\(\) : null/);
  });

  test("no built client chunk names the variable or the file's format", () => {
    const chunks = ".next/static/chunks";
    test.skip(!existsSync(chunks), "no build in .next — run `next build` first");
    const files: string[] = [];
    const walkChunks = (d: string) => {
      for (const name of readdirSync(d)) {
        const full = path.join(d, name);
        if (statSync(full).isDirectory()) walkChunks(full);
        else if (name.endsWith(".js")) files.push(full);
      }
    };
    walkChunks(chunks);
    const found = files.filter((f) => {
      const t = readFileSync(f, "utf8");
      return t.includes(VENDOR_PRICES_ENV) || t.includes(VENDOR_PRICES_FORMAT);
    });
    expect(found, "the vendor price file's loader is in a client chunk").toEqual([]);
  });
});
