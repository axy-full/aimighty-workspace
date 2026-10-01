import { test, expect } from "@playwright/test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The public site makes no claim about what a failed render is charged. It
 * used to promise that failed renders are never billed, in seven places; a
 * failed take's charge is shown in the app, from its receipt or its
 * provider's own word, and is not a selling point. These checks keep any
 * such claim — "never billed", "not charged", "refunded", "0 cr", or any word
 * about money beside a failure — off the marketing sources.
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
const said = (found: { where: string; text: string }[]) => found.map(({ where, text }) => `${where} ${text.trim().slice(0, 120)}`);

test("the public site claims nothing about what a failed render is charged", () => {
  const claim = /never billed|not billed|not charged|refund|what (?:it|they) (?:was|were) charged|when that is known/i;
  expect(said(lines().filter(({ text }) => claim.test(text)))).toEqual([]);
  /* Where the site speaks of a failure at all, nothing about money rides with it. */
  const failure = /fail(?:ed|ures?)? (?:renders?|generations?|takes?|jobs?|runs?|finals?)|renders? that fail/i;
  const money = /charg|bill|refund|receipt|\bfree\b|\bcredits?\b|\b\d[\d,]* cr\b|\bcost/i;
  expect(said(lines().filter(({ text }) => failure.test(text) && money.test(text)))).toEqual([]);
});

test("the seven places that promised it say only what they are about", () => {
  const read = (file: string) => readFileSync(file, "utf8");
  expect(read("app/(marketing)/site/_pages/pricing/index.tsx")).not.toMatch(/Failed renders/);
  expect(read("app/(marketing)/site/_pages/gen/index.tsx")).not.toMatch(/Failed renders|failed render/);
  expect(read("app/(marketing)/site/_pages/workspace/index.tsx")).not.toMatch(/Failed renders/);
  expect(read("app/(marketing)/site/_pages/atomik/index.tsx")).not.toMatch(/Failed generations|failed generation/);
  /* The shell's credits tile is gone with the rest of the site's charging copy; nothing there speaks of a failure. */
  expect(read("components/marketing/SharedBottom.tsx")).not.toMatch(/failed renders?|never billed/i);
  expect(read("components/marketing/SiteChrome.tsx")).toContain('<span className="mk-tag">Every take has an owner</span>');
});
