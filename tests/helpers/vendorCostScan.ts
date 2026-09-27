import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import ts from "typescript";

/**
 * The customer-facing money scanner.
 *
 * A workspace on the platform's keys pays in credits, and nothing it can read
 * may carry what a vendor charged the platform: not a field that holds it,
 * not a sum of it, not a sentence that prints it. Beside the credits the
 * same screen shows, any one of those gives the margin away.
 *
 * Two checks, because a leak can hide from either one alone:
 *
 *   - by NAME: a key that says dollars, margin or multiplier (`costUsd`,
 *     `capUsd`, `estCostUsd`, `margin_pct` …) with any value at all. The one
 *     dollar key a customer may read is `creditUsd`, the price of a credit.
 *   - by VALUE: the test seeds vendor costs whose sixth decimal is 1, so
 *     every sum of up to nine of them ends in a non-zero sixth decimal and is
 *     recognisable wherever it turns up — under a neutral key like `spend`,
 *     or inside `params`. Credits, counts and credit rates never carry six
 *     decimals, so they never match.
 *
 * In text, any `$` followed by a digit is reported, and so is a number
 * beside a money word ("19.87 spent", "20.00 USD"): a credit workspace reads
 * no dollar figure but the price of a credit, which a caller allows by
 * passing `allowText`.
 */
export type Finding = { at: string; why: string };
export type ScanOptions = {
  /** Vendor dollar figures seeded for the test (see `vendorFigures`). */
  figures?: number[];
  /** Keys this route may carry although their names match (with a reason at the call site). */
  allowKeys?: string[];
  /** Strings this route may carry although they print a dollar figure. */
  allowText?: RegExp[];
};

const MONEY_KEY = /usd|margin|multiplier/i;
const MONEY_WORDS = /\d\.\d+\s*(usd|dollars?|spent|spend)\b|\b(usd|spent|spend|cost|costs|costing)\s*:?\s*\d+\.\d/i;
const ALWAYS_ALLOWED = new Set(["creditUsd"]);
const near = (a: number, b: number, eps: number) => Math.abs(a - b) < eps;

export function vendorCostFindings(body: unknown, options: ScanOptions = {}): Finding[] {
  const found: Finding[] = [];
  const figures = options.figures ?? [];
  const allowKeys = new Set([...ALWAYS_ALLOWED, ...(options.allowKeys ?? [])]);
  const allowText = options.allowText ?? [];
  const isFigure = (n: number) => figures.some((f) => near(f, n, 5e-8));
  const walk = (value: unknown, at: string) => {
    if (value == null) return;
    if (typeof value === "number") {
      if (isFigure(value)) found.push({ at, why: `vendor figure ${value}` });
      return;
    }
    if (typeof value === "string") {
      if (allowText.some((re) => re.test(value))) return;
      if (/\$\s?\d/.test(value)) found.push({ at, why: `dollar figure in ${JSON.stringify(value.slice(0, 120))}` });
      else if (MONEY_WORDS.test(value)) found.push({ at, why: `money figure in ${JSON.stringify(value.slice(0, 120))}` });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${at}[${i}]`));
      return;
    }
    if (typeof value === "object") {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (MONEY_KEY.test(key) && !allowKeys.has(key) && item != null) found.push({ at: `${at}.${key}`, why: "vendor money key" });
        walk(item, `${at}.${key}`);
      }
    }
  };
  walk(body, "$");
  return found;
}

/**
 * Every sum of a non-empty subset of the seeded vendor costs. A route may add
 * any of them up — by project, by person, by month — and each total is still
 * what vendors charged. Each cost must end in a sixth decimal of 1 (see
 * above); fewer than ten of them keep every sum's sixth decimal non-zero.
 */
export function vendorFigures(atoms: number[]): number[] {
  if (atoms.length > 9) throw new Error("At most nine seeded costs: ten would let a sum end in a round sixth decimal.");
  for (const a of atoms) if (Math.round(a * 1e6) % 10 !== 1) throw new Error(`Seed ${a} must end in a sixth decimal of 1.`);
  const out = new Set<number>();
  for (let mask = 1; mask < 1 << atoms.length; mask++) {
    let sum = 0;
    atoms.forEach((a, i) => { if (mask & (1 << i)) sum += a; });
    out.add(Math.round(sum * 1e6) / 1e6);
  }
  return [...out];
}

/**
 * An App Router route file, compiled as it ships, with every `@/` import
 * answered by the real module unless the test overrides it. Real modules
 * share the test's instances (Playwright resolves the tsconfig paths), so a
 * route reads the same tenant store and databases the test seeded.
 */
export function loadRouteModule<T>(file: string, overrides: Record<string, unknown> = {}): T {
  const real = createRequire(path.resolve("package.json"));
  const compiled = ts.transpileModule(readFileSync(path.resolve(file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} as T };
  new Function("require", "module", "exports", compiled)(
    (name: string) => (Object.hasOwn(overrides, name) ? overrides[name] : real(name)),
    mod, mod.exports,
  );
  return mod.exports;
}
