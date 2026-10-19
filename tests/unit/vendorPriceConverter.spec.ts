import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { parseVendorPrices, VENDOR_PRICES_FORMAT } from "../../lib/vendorPriceFile";
import { MODELS, type ModelDef } from "../../lib/models";

/**
 * The owner's converter (scripts/vendor-prices/csv-to-json.mjs): his cost
 * sheet's CSV in, the vendor price file out, on his own machine.
 *
 * Every figure here is a SYNTHETIC PLACEHOLDER: repeated digits (111.11,
 * 777.77) that no vendor charges. The sample sheet in docs/ is held to the
 * same pattern below.
 */

type Convert = typeof import("../../scripts/vendor-prices/convert.mjs");
let lib: Convert;
test.beforeAll(async () => { lib = await import("../../scripts/vendor-prices/convert.mjs"); });

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, "scripts", "vendor-prices", "csv-to-json.mjs");
const SAMPLE = path.join(ROOT, "docs", "vendor-prices-sample.csv");
const PLACEHOLDER_COST = "111.11";
const PLACEHOLDER_BAD = "777.77";
const HEADER = "engine,unit,resolution,audio,length,upTo,costUsd";
const dir = mkdtempSync(path.join(tmpdir(), "particl-vendor-converter-"));
let n = 0;
const sheet = (text: string, ext = "csv") => {
  const file = path.join(dir, `sheet-${++n}.${ext}`);
  writeFileSync(file, text);
  return file;
};

const run = (text: string, scope: string[] | null = null, kind: "csv" | "json" = "csv") =>
  lib.convert(text, { kind, parse: parseVendorPrices, format: VENDOR_PRICES_FORMAT, models: MODELS, scope });

function cli(...args: string[]) {
  /* Under Node's permission model with read access only: a write, a child
     process or a worker would be refused, so a pass proves it does none. */
  const r = spawnSync(process.execPath, ["--permission", "--allow-fs-read=*", SCRIPT, ...args], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** The engines the registry expects in the sheet by default: offered, and not priced by a live estimate. */
const expected = (): ModelDef[] => (MODELS as ModelDef[]).filter((m) => !m.retired && !lib.liveEstimate(m));
/** A sheet that covers every one of them, one per-unit row per resolution, at a placeholder figure. */
function fullSheet(skip: (id: string, res: string) => boolean = () => false): string {
  const rows = expected().flatMap((m) => m.resolutions
    .filter((r) => !skip(m.id, r))
    .map((r) => `${m.id},${m.kind === "image" ? "image" : "second"},${r},,,,${PLACEHOLDER_COST}`));
  return [HEADER, ...rows].join("\n");
}

test.describe("converting the sheet", () => {
  test("the sample sheet converts, through the server's own parser, and the report names no figure", () => {
    const text = readFileSync(SAMPLE, "utf8");
    const engines = [...new Set(text.split("\n").filter((l) => l && !l.startsWith("#") && !l.startsWith("engine,")).map((l) => l.split(",")[0]))];
    expect(engines.length).toBeGreaterThan(3);
    const r = cli(SAMPLE, "--engines", engines.join(","));
    expect(r.code, r.stderr).toBe(0);
    const parsed = parseVendorPrices(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(JSON.parse(r.stdout).format).toBe(VENDOR_PRICES_FORMAT);
    expect(r.stdout).toBe(run(text, engines).json);
    for (const figure of text.match(/\d{3}\.\d{2}/g) ?? []) expect(r.stderr).not.toContain(figure);
    expect(r.stderr).toContain("coverage: complete.");
  });

  test("CSV details: quoted cells, CRLF, comments, blank lines and any column order", () => {
    const text = `# a comment line, with commas\r\n\r\ncostUsd,"engine",unit,resolution\r\n"${PLACEHOLDER_COST}",placeholder-engine,second,"1080p"\r\n`;
    const r = run(text, ["placeholder-engine"]);
    expect(r.ok, JSON.stringify(r.problems ?? r.coverage)).toBe(true);
    expect(JSON.parse(r.json!).engines["placeholder-engine"].second).toEqual([{ resolution: "1080p", costUsd: Number(PLACEHOLDER_COST) }]);
  });

  test("only plain dollars above zero: a sign, a currency, a separator, a minus, an exponent or a word is refused, and never repeated", () => {
    const bad = [
      `$${PLACEHOLDER_BAD}`, `"7,777.77"`, `${PLACEHOLDER_BAD} USD`, `€${PLACEHOLDER_BAD}`, `£${PLACEHOLDER_BAD}`, `-${PLACEHOLDER_BAD}`,
      "0", "0.00", "seven", "7.77e2", ".77", `${PLACEHOLDER_BAD}.7`, `"${PLACEHOLDER_BAD} "x`,
    ];
    for (const cell of bad) {
      const r = run(`${HEADER}\nplaceholder-engine,second,1080p,,,,${cell}`, ["placeholder-engine"]);
      expect(r.ok, cell).toBe(false);
      expect(["sheet", "shape"]).toContain(r.stage);
      const text = (r.problems ?? []).join("\n");
      expect(text, cell).toMatch(/costUsd|more cells than columns/);
      expect(text, cell).not.toMatch(/7{2,}|\d\.\d/);
    }
    /* An unquoted thousands separator splits the cell, and is refused as such. */
    const split = run(`${HEADER}\nplaceholder-engine,second,1080p,,,,7,777.77`, ["placeholder-engine"]);
    expect(split.problems?.join("\n")).toContain("more cells than columns");
  });

  test("margins, selling prices and unknown columns are refused; required columns must be there", () => {
    const refused = (header: string, re: RegExp) => {
      const r = run(`${header}\nplaceholder-engine,second,${PLACEHOLDER_COST},${PLACEHOLDER_BAD}`, ["placeholder-engine"]);
      expect(r.ok, header).toBe(false);
      expect(r.stage).toBe("sheet");
      const text = r.problems!.join("\n");
      expect(text, header).toMatch(re);
      expect(text).not.toContain(PLACEHOLDER_BAD);
    };
    refused("engine,unit,costUsd,margin", /margin or a selling price/);
    refused("engine,unit,costUsd,Markup %", /margin or a selling price/);
    refused("engine,unit,costUsd,price", /margin or a selling price/);
    refused("engine,unit,costUsd,costEur", /not a column this sheet uses/);
    refused(`engine,unit,costUsd,${PLACEHOLDER_BAD}`, /column 4 is not a column/);
    refused("engine,unit,costUsd,costUsd", /appears twice/);
    const noCost = run(`engine,unit,resolution\nplaceholder-engine,second,1080p`, ["placeholder-engine"]);
    expect(noCost.problems?.join("\n")).toContain('the header has no "costUsd" column');
    expect(run(`${HEADER}\n"placeholder-engine,second`, null).problems?.join("\n")).toContain("never closed");
  });

  test("the file's own rules come from the server's parser, pointed at the sheet's line", () => {
    const cases: [string, RegExp][] = [
      [`placeholder-engine,furlong,,,,,${PLACEHOLDER_COST}`, /a unit this format does not define/],
      [`__proto__,second,,,,,${PLACEHOLDER_COST}`, /this id is reserved/],
      [`placeholder-engine,second,1080p,,5,,${PLACEHOLDER_COST}`, /"length" is only for unit "job"/],
      [`placeholder-engine,job,1080p,,,10,${PLACEHOLDER_COST}`, /not for unit "job"/],
    ];
    for (const [row, re] of cases) {
      const r = run(`${HEADER}\n${row}`, ["placeholder-engine"]);
      expect(r.ok, row).toBe(false);
      expect(r.problems!.join("\n"), row).toMatch(re);
    }
    const dup = run(`${HEADER}\nplaceholder-engine,second,1080p,,,,${PLACEHOLDER_COST}\n# note\nplaceholder-engine,second,1080p,,,,${PLACEHOLDER_BAD}`, ["placeholder-engine"]);
    expect(dup.stage).toBe("shape");
    expect(dup.problems!.join("\n")).toContain("row 2 (CSV line 4): repeats another row's settings");
    expect(dup.problems!.join("\n")).not.toContain(PLACEHOLDER_BAD);
    expect(run(`${HEADER}\nplaceholder-engine,second,1080p,maybe,,,${PLACEHOLDER_COST}`).problems!.join("\n")).toContain('"audio" must be true, false or empty');
    expect(run(`${HEADER}\nplaceholder-engine,job,1080p,,5s,,${PLACEHOLDER_COST}`).problems!.join("\n")).toContain('"length" must be whole seconds');
  });
});

test.describe("coverage against the model registry", () => {
  test("by default every engine x resolution the registry offers needs a row; live-estimate and retired engines are not expected", () => {
    expect(expected().length).toBeGreaterThan(10);
    const full = run(fullSheet());
    expect(full.coverage?.missing, "a sheet covering the registry").toEqual([]);
    expect(full.ok).toBe(true);
    expect(full.coverage!.skipped.sort()).toEqual((MODELS as ModelDef[]).filter((m) => !m.retired && lib.liveEstimate(m)).map((m) => m.id).sort());

    const [first] = expected();
    const gap = run(fullSheet((id, res) => id === first.id && res === first.resolutions[0]));
    expect(gap.ok).toBe(false);
    expect(gap.stage).toBe("coverage");
    expect(gap.coverage!.missing).toEqual([`${first.id}: ${first.resolutions[0]}`]);
    expect(lib.report(gap)).toContain(`MISSING, no row for (1):\n  - ${first.id}: ${first.resolutions[0]}`);
    expect(lib.report(gap)).not.toContain(PLACEHOLDER_COST);

    const none = run(fullSheet((id) => id === first.id));
    expect(none.coverage!.missing).toEqual([`${first.id}: no rows`]);
  });

  test("fixed-length jobs need every length the engine offers; sound both ways where it is offered", () => {
    const m = expected().find((x) => x.durations.length > 1 && x.supportsAudio)!;
    expect(m, "a registry engine with lengths and sound").toBeTruthy();
    const res = m.resolutions[0];
    const lengths = m.durations;
    const rows = lengths.slice(1).map((l) => `${m.id},job,${res},,${l},,${PLACEHOLDER_COST}`);
    const jobs = run([HEADER, ...rows].join("\n"), [m.id]);
    expect(jobs.coverage!.missing).toContain(`${m.id}: ${res}, ${lengths[0]} s (unit "job")`);
    expect(jobs.coverage!.missing).not.toContain(`${m.id}: ${res}, ${lengths[1]} s (unit "job")`);

    const silent = run([HEADER, ...m.resolutions.map((r) => `${m.id},second,${r},false,,,${PLACEHOLDER_COST}`)].join("\n"), [m.id]);
    expect(silent.coverage!.missing).toContain(`${m.id}: ${res}, with sound (unit "second")`);
    const both = run([HEADER, ...m.resolutions.flatMap((r) => [`${m.id},second,${r},false,,,${PLACEHOLDER_COST}`, `${m.id},second,${r},true,,,${PLACEHOLDER_BAD}`])].join("\n"), [m.id]);
    expect(both.coverage!.missing).toEqual([]);
  });

  test("--engines scopes the check: only the named engines, live-estimate ones included when named, unknown ones need a row", () => {
    const live = (MODELS as ModelDef[]).find((m) => !m.retired && lib.liveEstimate(m))!;
    const r = run(`${HEADER}\nplaceholder-service,minute,,,,,${PLACEHOLDER_COST}`, [live.id, "placeholder-service", "placeholder-absent"]);
    expect(r.coverage!.missing).toEqual([`${live.id}: no rows`, "placeholder-absent: no rows (not in the model registry)"]);
    expect(r.coverage!.outside).toEqual(["placeholder-service"]);
  });
});

test.describe("the command", () => {
  test("exit 1 and nothing printed for a refused sheet; exit 2 and nothing printed for a gap; a JSON file is checked, never printed", () => {
    const refused = cli(sheet(`${HEADER}\nplaceholder-engine,second,1080p,,,,$${PLACEHOLDER_BAD}`), "--engines", "placeholder-engine");
    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).not.toContain(PLACEHOLDER_BAD);

    const gap = cli(sheet(`${HEADER}\nplaceholder-engine,second,1080p,,,,${PLACEHOLDER_COST}`));
    expect(gap.code).toBe(2);
    expect(gap.stdout).toBe("");
    expect(gap.stderr).toContain("MISSING");
    expect(gap.stderr).not.toContain(PLACEHOLDER_COST);

    const ok = cli(sheet(fullSheet()));
    expect(ok.code, ok.stderr).toBe(0);
    expect(parseVendorPrices(ok.stdout).ok).toBe(true);
    const checkOnly = cli(sheet(fullSheet()), "--check");
    expect(checkOnly.code).toBe(0);
    expect(checkOnly.stdout).toBe("");

    const json = cli(sheet(ok.stdout, "json"));
    expect(json.code, json.stderr).toBe(0);
    expect(json.stdout).toBe("");
    expect(json.stderr).toContain("coverage: complete.");

    expect(cli().code).toBe(1);
    expect(cli(path.join(dir, "no-such-sheet.csv")).stderr).toContain("cannot read that file");
  });

  test("it opens no connection and writes nothing: no network or write call in the script or anything it loads", () => {
    const FORBIDDEN = /\bfetch\s*\(|node:(https?|http2|net|tls|dgram|dns|child_process|worker_threads)\b|["'](https?|net|tls|dgram|dns|child_process)["']|\bwriteFile(Sync)?\b|\bappendFile(Sync)?\b|createWriteStream|\bXMLHttpRequest\b|\bWebSocket\b/;
    const seen = new Set<string>();
    const queue = [SCRIPT, path.join(ROOT, "scripts", "vendor-prices", "convert.mjs"), path.join(ROOT, "lib", "vendorPriceFile.ts"), path.join(ROOT, "lib", "models.ts")];
    const resolve = (from: string, spec: string): string | null => {
      const base = spec.startsWith("@/") ? path.join(ROOT, spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(from), spec) : null;
      if (!base) return null;
      for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
        if (/\.(ts|tsx|mjs|js)$/.test(c) && existsSync(c) && statSync(c).isFile()) return c;
      }
      return null;
    };
    const hits: string[] = [];
    while (queue.length) {
      const f = queue.shift()!;
      if (seen.has(f)) continue;
      seen.add(f);
      const text = readFileSync(f, "utf8");
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      const hit = code.match(FORBIDDEN);
      if (hit) hits.push(`${path.relative(ROOT, f)}: ${hit[0]}`);
      for (const spec of ts.preProcessFile(text, true, true).importedFiles.map((i) => i.fileName)) {
        const to = resolve(f, spec);
        if (to) queue.push(to);
      }
    }
    expect(seen.size).toBeGreaterThan(4);
    expect(hits).toEqual([]);
  });

  test("the sample sheet's figures are obviously fake, and it is no price file", () => {
    const text = readFileSync(SAMPLE, "utf8");
    expect(text).not.toContain(VENDOR_PRICES_FORMAT);
    const parsed = lib.parseCsv(text);
    expect(parsed.ok).toBe(true);
    const records = (parsed as { ok: true; records: { cells: string[] }[] }).records.filter((r) => !r.cells[0].startsWith("#"));
    const col = records[0].cells.indexOf("costUsd");
    expect(col).toBeGreaterThan(-1);
    const figures = records.slice(1).map((r) => r.cells[col]);
    expect(figures.length).toBeGreaterThan(5);
    /* 111.11 to 999.99: one digit repeated. Nothing a vendor charges looks like it. */
    for (const f of figures) expect(f, "a sample figure that is not an obvious fake").toMatch(/^([1-9])\1\1\.\1\1$/);
    /* And no other cell could be read as a cost (engine ids, such as a model version, aside). */
    const engineCol = records[0].cells.indexOf("engine");
    for (const r of records.slice(1)) for (const [i, c] of r.cells.entries()) if (i !== col && i !== engineCol) expect(c).not.toMatch(/\d\.\d/);
  });
});
