import { test, expect } from "@playwright/test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A failed render says what it was charged — billed, refunded, not charged or
 * unknown — from evidence: its receipt, or its provider's own word. The
 * public site used to promise that failed renders are never billed, in seven
 * places; that is not what a failed render shows (one the provider may have
 * taken keeps its reservation, and a connected account's refund is its own
 * ledger's to confirm). These checks keep the promise from coming back.
 */
const ROOTS = ["app/(marketing)", "components/marketing"];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(tsx?|mdx?)$/.test(name) ? [path] : [];
  });
}
const lines = () => ROOTS.flatMap(sources).flatMap((file) => readFileSync(file, "utf8").split("\n").map((text, i) => ({ where: `${file}:${i + 1}`, text })));

test("the public site never promises that a failed render is free", () => {
  const blanket = /never billed|(?:are|is) not billed|not charged for (?:a )?fail|fail(?:ed|ures?)[^\n]{0,60}\b(?:are|is) free\b/i;
  expect(lines().filter(({ text }) => blanket.test(text)).map(({ where, text }) => `${where} ${text.trim().slice(0, 120)}`)).toEqual([]);
  /* Nor as a figure: a failed render's line never carries "0 cr". */
  const zero = lines().filter(({ text }) => /failed (?:renders?|generations?|takes?)/i.test(text) && /\b0 cr\b/.test(text));
  expect(zero.map(({ where }) => where)).toEqual([]);
});

test("where the site speaks of failed renders, it points to what each one was charged", () => {
  const said = lines().filter(({ text }) => /failed (?:renders?|generations?)/i.test(text));
  expect(said.length).toBeGreaterThanOrEqual(5);
  for (const { where, text } of said) expect(text, where).toMatch(/what (?:it|they) (?:was|were) charged|receipt/i);
});
