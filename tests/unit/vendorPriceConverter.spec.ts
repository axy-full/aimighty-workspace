import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { FILE_PRICED_UNITS, parseVendorPrices, VENDOR_PRICES_FORMAT } from "../../lib/vendorPriceFile";
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

const run = (text: string, scope: string[] | null = null, kind: "csv" | "json" = "csv", skip: string[] | null = null) =>
  lib.convert(text, { kind, parse: parseVendorPrices, format: VENDOR_PRICES_FORMAT, models: MODELS, scope, skip, required: FILE_PRICED_UNITS });

function cli(...args: string[]) {
  /* Under Node's permission model with read access only: a write, a child
     process or a worker would be refused, so a pass proves it does none. */
  const r = spawnSync(process.execPath, ["--permission", "--allow-fs-read=*", SCRIPT, ...args], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** The engines the registry expects in the sheet by default: every one not retired (owner: "every engine, resolution and length the registry knows"). */
const expected = (): ModelDef[] => (MODELS as ModelDef[]).filter((m) => !m.retired);
/** The engines the server prices from the file (lip-sync's models), which are not in the registry. */
const filePriced = (): string[] => Object.keys(FILE_PRICED_UNITS).filter((id) => !MODELS.some((m) => m.id === id));
/** A sheet that covers every one of them, one per-unit row per resolution, and a row in its unit for each file-priced engine, at a placeholder figure. */
function fullSheet(skip: (id: string, res: string) => boolean = () => false): string {
  const rows = expected().flatMap((m) => m.resolutions
    .filter((r) => !skip(m.id, r))
    .map((r) => `${m.id},${m.kind === "image" ? "image" : "second"},${r},,,,${PLACEHOLDER_COST}`));
  const priced = filePriced().filter((id) => !skip(id, "")).map((id) => `${id},${FILE_PRICED_UNITS[id]},,,,,${PLACEHOLDER_COST}`);
  return [HEADER, ...rows, ...priced].join("\n");
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
  test("by default every engine x resolution the registry offers needs a row, identity, marketing and transform engines included; nothing is skipped unless named", () => {
    expect(expected().length).toBeGreaterThan(10);
    const full = run(fullSheet());
    expect(full.coverage?.missing, "a sheet covering the registry").toEqual([]);
    expect(full.ok).toBe(true);
    expect(full.coverage!.skipped).toEqual([]);
    expect(full.coverage!.outOfScope).toEqual([]);
    expect(full.coverage!.checked.sort()).toEqual(expected().map((m) => m.id).sort());

    /* The engines once left out as "live estimate" are expected like any other. */
    const special = expected().filter((m) => m.soulIdentity || m.marketing || m.genjutsu);
    expect(special.length, "the registry still has identity, marketing or transform engines").toBeGreaterThan(0);
    const withoutSpecial = run(fullSheet((id) => special.some((m) => m.id === id)));
    expect(withoutSpecial.ok).toBe(false);
    expect(withoutSpecial.coverage!.missing.sort()).toEqual(special.map((m) => `${m.id}: no rows`).sort());

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

  test("--engines scopes the check: only the named engines, unknown ones need a row, and the rest are listed as not checked", () => {
    const [named, ...rest] = expected();
    const r = run(`${HEADER}\nplaceholder-service,minute,,,,,${PLACEHOLDER_COST}`, [named.id, "placeholder-service", "placeholder-absent"]);
    expect(r.coverage!.missing).toEqual([`${named.id}: no rows`, "placeholder-absent: no rows (not in the model registry)"]);
    expect(r.coverage!.outside).toEqual(["placeholder-service"]);
    const notChecked = [...rest.map((m) => m.id), ...filePriced()];
    expect(r.coverage!.outOfScope).toEqual(notChecked);
    const text = lib.report(r, { scope: [named.id] });
    expect(text).toContain(`NOT CHECKED, outside --engines (${notChecked.length}): ${notChecked.join(", ")}`);
  });

  test("the engines the server prices from the file need a row in their unit with no other setting, though the registry does not list them", () => {
    const ids = filePriced();
    expect(ids, "lip-sync's models are priced from the file").toEqual(["lipsync-2", "lipsync-2-pro", "sync-3"]);
    const full = run(fullSheet());
    expect(full.ok).toBe(true);
    expect(full.coverage!.filePriced).toEqual(ids);
    expect(full.coverage!.outside).toEqual([]);
    expect(lib.report(full)).toContain(`priced from this file, checked (${ids.length}): ${ids.join(", ")}`);
    /* One left out: refused, by name, with no figure. */
    const without = run(fullSheet((id) => id === "sync-3"));
    expect(without.ok).toBe(false);
    expect(without.coverage!.missing).toEqual(['sync-3: no "second" rows (priced from this file)']);
    expect(lib.report(without)).not.toContain(PLACEHOLDER_COST);
    /* In another unit, or with a setting the quote never names: not a price the server can use. */
    const minute = run(`${fullSheet((id) => id === "sync-3")}\nsync-3,minute,,,,,${PLACEHOLDER_COST}`);
    expect(minute.coverage!.missing).toEqual(['sync-3: no "second" rows (priced from this file)']);
    const withRes = run(`${fullSheet((id) => id === "sync-3")}\nsync-3,second,1080p,,,,${PLACEHOLDER_COST}`);
    expect(withRes.coverage!.missing).toEqual(['sync-3: its "second" rows must name no resolution, sound or length (priced from this file)']);
    /* No band either: a job settles at the rate it was quoted at, so a rate that depends on the quantity would not hold. Refused with exit 2. */
    const banded = `${fullSheet((id) => id === "sync-3")}\nsync-3,second,,,,10,${PLACEHOLDER_COST}\nsync-3,second,,,,100,${PLACEHOLDER_BAD}`;
    const bands = run(banded);
    expect(bands.ok).toBe(false);
    expect(bands.stage).toBe("coverage");
    expect(bands.coverage!.missing).toEqual(['sync-3: its "second" rows must not name a band (upTo): a job settles at the rate it was quoted at (priced from this file)']);
    expect(lib.report(bands)).not.toMatch(new RegExp(`${PLACEHOLDER_COST}|${PLACEHOLDER_BAD}`));
    const bandsCli = cli(sheet(banded));
    expect(bandsCli.code).toBe(2);
    expect(bandsCli.stdout).toBe("");
    expect(bandsCli.stderr).toContain("must not name a band (upTo)");
    /* A band on an engine the registry prices stays allowed (the shared rules); only file-priced engines settle at a kept rate. */
    expect(run(`${HEADER}\nplaceholder-reader,page,,,,10,${PLACEHOLDER_COST}`, ["placeholder-reader"]).ok).toBe(true);
    /* --skip and --engines treat them like any other engine. */
    const skipped = run(fullSheet((id) => id === "sync-3"), null, "csv", ["sync-3"]);
    expect(skipped.ok).toBe(true);
    expect(skipped.coverage!.skipped).toEqual(["sync-3"]);
    expect(skipped.coverage!.unknownSkips).toEqual([]);
    const scoped = run(`${HEADER}\nlipsync-2,second,,,,,${PLACEHOLDER_COST}`, ["lipsync-2"]);
    expect(scoped.ok).toBe(true);
    expect(scoped.coverage!.filePriced).toEqual(["lipsync-2"]);
    /* The command checks them by default. */
    expect(cli(sheet(fullSheet((id) => id === "lipsync-2"))).code).toBe(2);
  });

  test("--skip leaves only the named engines out, and the report lists every one of them", () => {
    const special = expected().filter((m) => m.soulIdentity || m.marketing || m.genjutsu).map((m) => m.id);
    const skip = [...special, "placeholder-typo"];
    const r = run(fullSheet((id) => special.includes(id)), null, "csv", skip);
    expect(r.coverage!.missing).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.coverage!.skipped).toEqual(skip);
    expect(r.coverage!.unknownSkips).toEqual(["placeholder-typo"]);
    const text = lib.report(r);
    expect(text).toContain(`NOT CHECKED, skipped with --skip (${skip.length}): ${skip.join(", ")}`);
    expect(text).toContain("(a typo?): placeholder-typo");
    expect(text).toContain("coverage: complete.");
    /* A skip names engines, nothing else: one missing resolution of an engine not skipped is still refused. */
    const [first] = expected().filter((m) => !special.includes(m.id));
    const gap = run(fullSheet((id, res) => special.includes(id) || (id === first.id && res === first.resolutions[0])), null, "csv", skip);
    expect(gap.coverage!.missing).toEqual([`${first.id}: ${first.resolutions[0]}`]);
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
    const help = cli("--help");
    expect(help.code).toBe(0);
    expect(help.stdout).toBe("");
    expect(help.stderr).toContain("--skip id,id");
    expect(cli(sheet(fullSheet()), "--skip").code).toBe(1);
    const special = expected().filter((m) => m.soulIdentity || m.marketing || m.genjutsu).map((m) => m.id);
    const skipped = cli(sheet(fullSheet((id) => special.includes(id))), "--skip", special.join(","));
    expect(skipped.code, skipped.stderr).toBe(0);
    expect(skipped.stderr).toContain(`NOT CHECKED, skipped with --skip (${special.length})`);
    expect(cli(sheet(fullSheet((id) => special.includes(id)))).code).toBe(2);
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

  test("the sample sheet's figures are obviously fake, and it is no price file; real sheets and files are ignored by git", () => {
    const ignore = readFileSync(path.join(ROOT, ".gitignore"), "utf8").split("\n").map((l) => l.trim());
    expect(ignore).toContain("/vendor-prices*.json");
    expect(ignore).toContain("*cost-sheet*.csv");
    const script = readFileSync(SCRIPT, "utf8");
    expect(script, "the usage must not tell the owner to write the JSON into the repo").not.toMatch(/>\s*vendor-prices[^\s]*\.json/);
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
