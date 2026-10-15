import { test, expect } from "@playwright/test";
import { LABEL_DETECTED_MAX, LABEL_EXPECTED_MAX, STRICT_RULES, diffOps, labelDiff, normalise, readRules, rulesProblem, type LabelRules } from "../../lib/labelDiff";

/**
 * The exact text diff of the label check (lib/labelDiff.ts): pure, no model, no network. Every normalisation rule is named here and tested both ways, and the strict
 * default is pinned. Characters that need an escape are built with String.fromCodePoint so the file shows what is meant.
 */
const E_ACUTE = String.fromCodePoint(0x00e9);            // é as one code point
const E_PLUS_ACUTE = String.fromCodePoint(0x0065, 0x0301); // e then a combining acute: the same letter, written the other way
const CYRILLIC_A = String.fromCodePoint(0x0410);
const NBSP = String.fromCodePoint(0x00a0);
const rules = (over: Partial<LabelRules> = {}): LabelRules => ({ ...STRICT_RULES, ...over });
const removed = (d: { ops: { op: string; text: string }[] }) => d.ops.filter((o) => o.op === "remove").map((o) => o.text).join("");
const added = (d: { ops: { op: string; text: string }[] }) => d.ops.filter((o) => o.op === "add").map((o) => o.text).join("");

test("the default is strict: Unicode normal form C and nothing else; each rule is a named choice", () => {
  expect(STRICT_RULES).toEqual({ unicode: "nfc", case: "exact", whitespace: "exact" });
  expect(readRules(undefined)).toEqual(STRICT_RULES);
  expect(readRules({})).toEqual(STRICT_RULES);
  expect(readRules({ case: "fold", whitespace: "collapse", unicode: "none" })).toEqual({ unicode: "none", case: "fold", whitespace: "collapse" });
  /* Anything we do not know reads as strict, never as looser. */
  expect(readRules({ case: "ignore", whitespace: "trim", unicode: "nfkc" })).toEqual(STRICT_RULES);
  expect(readRules("loose")).toEqual(STRICT_RULES);
  /* A request that names a rule we do not have is refused in words instead. */
  expect(rulesProblem(undefined)).toBeNull();
  expect(rulesProblem({ case: "fold" })).toBeNull();
  expect(rulesProblem({ case: "ignore" })).toMatch(/case is exact/);
  expect(rulesProblem({ whitespace: "trim" })).toMatch(/whitespace is exact/);
  expect(rulesProblem({ unicode: "nfkc" })).toMatch(/unicode is nfc/);
  expect(rulesProblem({ accents: "strip" })).toMatch(/There is no rule called accents/);
  expect(rulesProblem("loose")).toMatch(/group/);
  expect(rulesProblem([])).toMatch(/group/);
});

test("an exact label matches; one wrong letter is caught and shown as the difference; missing text is missing", () => {
  const ok = labelDiff("ACME COLA 330 ml", "ACME COLA 330 ml\n", "whole");
  expect(ok).toMatchObject({ verdict: "match", distance: 0, expected: "ACME COLA 330 ml", detected: "ACME COLA 330 ml" });
  expect(ok.ops).toEqual([{ op: "equal", text: "ACME COLA 330 ml" }]);
  const wrong = labelDiff("ACME COLA", "ACME COIA", "whole");
  expect(wrong.verdict).toBe("mismatch");
  expect(wrong.distance).toBe(2);
  expect(removed(wrong)).toBe("L");
  expect(added(wrong)).toBe("I");
  expect(wrong.ops.filter((o) => o.op === "equal").map((o) => o.text).join("")).toBe("ACME COA");
  const missing = labelDiff("ACME COLA", "", "whole");
  expect(missing).toMatchObject({ verdict: "missing", detected: "", distance: 9, ops: [{ op: "remove", text: "ACME COLA" }] });
  expect(labelDiff("ACME COLA", " \n\t ", "whole").verdict).toBe("missing");
  /* Text read but not the required text is a mismatch, not missing. */
  expect(labelDiff("ACME COLA", "SALE", "whole").verdict).toBe("mismatch");
  /* Extra text in the picture is a difference in whole mode. */
  const extra = labelDiff("ACME COLA", "ACME COLA\nNEW", "whole");
  expect(extra.verdict).toBe("mismatch");
  expect(added(extra)).toBe("\nNEW");
  expect(() => labelDiff("  \n ", "ACME", "whole")).toThrow(RangeError);
});

test("rule: line endings are always read as LF, and the ends of the whole text are always dropped", () => {
  for (const r of [rules(), rules({ whitespace: "collapse" })]) {
    expect(labelDiff("ACME\nCOLA", "ACME\r\nCOLA", "whole", r).verdict).toBe("match");
    expect(labelDiff("ACME\nCOLA", "ACME\rCOLA", "whole", r).verdict).toBe("match");
    expect(labelDiff("  ACME COLA  ", "\nACME COLA\n\n", "whole", r).verdict).toBe("match");
  }
  expect(normalise("a\r\nb\rc", STRICT_RULES)).toBe("a\nb\nc");
});

test("rule whitespace: exact (default) keeps every space and line break inside the text; collapse reads a run of white space as one space", () => {
  expect(labelDiff("ACME COLA", "ACME  COLA", "whole").verdict).toBe("mismatch");
  expect(labelDiff("ACME COLA", "ACME\nCOLA", "whole").verdict).toBe("mismatch");
  expect(labelDiff("ACME COLA", `ACME${NBSP}COLA`, "whole").verdict).toBe("mismatch");
  expect(labelDiff("ACME COLA", "ACME\tCOLA", "whole").verdict).toBe("mismatch");
  const c = rules({ whitespace: "collapse" });
  expect(labelDiff("ACME COLA", "ACME  COLA", "whole", c).verdict).toBe("match");
  expect(labelDiff("ACME COLA", "ACME\nCOLA", "whole", c).verdict).toBe("match");
  expect(labelDiff("ACME COLA", `ACME${NBSP}COLA`, "whole", c).verdict).toBe("match");
  expect(labelDiff("ACME COLA", "ACME\t \nCOLA", "whole", c).verdict).toBe("match");
  /* Collapse never removes a space that is there to be missed: "ACMECOLA" is still wrong. */
  expect(labelDiff("ACME COLA", "ACMECOLA", "whole", c).verdict).toBe("mismatch");
});

test("rule case: exact (default) is case-sensitive; fold lower-cases both", () => {
  expect(labelDiff("Acme Cola", "ACME COLA", "whole").verdict).toBe("mismatch");
  expect(labelDiff("Acme Cola", "ACME COLA", "whole", rules({ case: "fold" })).verdict).toBe("match");
  expect(labelDiff("Acme Cola", "ACME COLB", "whole", rules({ case: "fold" })).verdict).toBe("mismatch");
});

test("rule unicode: nfc (default) makes canonically equal text equal; none compares code points as given", () => {
  expect(E_ACUTE).not.toBe(E_PLUS_ACUTE);
  expect(labelDiff(`caf${E_ACUTE}`, `caf${E_PLUS_ACUTE}`, "whole").verdict).toBe("match");
  expect(labelDiff(`caf${E_PLUS_ACUTE}`, `caf${E_ACUTE}`, "whole").verdict).toBe("match");
  const none = labelDiff(`caf${E_ACUTE}`, `caf${E_PLUS_ACUTE}`, "whole", rules({ unicode: "none" }));
  expect(none.verdict).toBe("mismatch");
  expect(none.distance).toBe(3);
});

test("nothing else is forgiven: no accent stripping, no look-alike letters, no digit, punctuation or spelling tolerance", () => {
  const loose = rules({ case: "fold", whitespace: "collapse" });
  for (const [a, b] of [
    ["cafe", `caf${E_ACUTE}`], ["ACME", `${CYRILLIC_A}CME`], ["COLA 0", "COLA O"], ["ACME 1L", "ACME lL"], ["ACME", "ACME."], ["ACME-COLA", "ACME COLA"], ["ACME", "ACMEE"], ["ACME's", "ACME’s"],
  ] as const) {
    for (const r of [STRICT_RULES, loose]) expect(labelDiff(a, b, "whole", r).verdict, `${a} / ${b}`).toBe("mismatch");
  }
});

test("mode contains: the required text found inside the picture's text is a match; a near miss shows the closest stretch; nothing like it shows all that was read", () => {
  const read = "NEW\nACME COLA 330 ml\nSHAKE WELL";
  expect(labelDiff("ACME COLA 330 ml", read, "contains")).toMatchObject({ verdict: "match", distance: 0, detected: "ACME COLA 330 ml" });
  expect(labelDiff("ACME COLA 330 ml", read, "whole").verdict).toBe("mismatch");
  const near = labelDiff("ACME COLA 330 ml", "NEW\nACME COIA 330 ml\nSHAKE WELL", "contains");
  expect(near.verdict).toBe("mismatch");
  expect(near.detected).toBe("ACME COIA 330 ml");
  expect(near.distance).toBe(2);
  expect(removed(near)).toBe("L");
  expect(added(near)).toBe("I");
  const none = labelDiff("ACME", "ZZZZ", "contains");
  expect(none.verdict).toBe("mismatch");
  expect(none.detected).toBe("ZZZZ");
  expect(labelDiff("ACME COLA", "", "contains").verdict).toBe("missing");
  /* The rules apply in this mode too. */
  expect(labelDiff("acme cola", "NEW ACME COLA OK", "contains").verdict).toBe("mismatch");
  expect(labelDiff("acme cola", "NEW ACME COLA OK", "contains", rules({ case: "fold" })).verdict).toBe("match");
});

test("the difference is a true edit script: it rebuilds both texts, and its size is the least possible", () => {
  let seed = 12345;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const word = (len: number) => Array.from({ length: len }, () => "ab c\n".charAt(rnd(5))).join("");
  const lcsLen = (a: string[], b: string[]) => { const t = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0)); for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) t[i][j] = a[i - 1] === b[j - 1] ? t[i - 1][j - 1] + 1 : Math.max(t[i - 1][j], t[i][j - 1]); return t[a.length][b.length]; };
  for (let k = 0; k < 200; k++) {
    const a = word(rnd(14)), b = word(rnd(14));
    const { ops, distance } = diffOps(a, b);
    expect(ops.filter((o) => o.op !== "add").map((o) => o.text).join(""), `${a}|${b}`).toBe(a);
    expect(ops.filter((o) => o.op !== "remove").map((o) => o.text).join(""), `${a}|${b}`).toBe(b);
    expect(distance, `${a}|${b}`).toBe(Array.from(a).length + Array.from(b).length - 2 * lcsLen(Array.from(a), Array.from(b)));
    expect(ops.every((o, i) => o.text.length > 0 && (i === 0 || ops[i - 1].op !== o.op))).toBe(true);
  }
  /* Whole characters, not halves of them. */
  const emoji = String.fromCodePoint(0x1f600);
  expect(diffOps(`a${emoji}b`, `ab`).ops).toEqual([{ op: "equal", text: "a" }, { op: "remove", text: emoji }, { op: "equal", text: "b" }]);
});

test("the work is bounded: the longest required text against the longest text read finishes at once", () => {
  const required = "ACME ".repeat(LABEL_EXPECTED_MAX / 5);
  const read = ("NOISE ".repeat(10) + required).slice(0, LABEL_DETECTED_MAX);
  const started = Date.now();
  expect(labelDiff(required, read, "contains").verdict).toBe("match");
  const big = "x".repeat(LABEL_DETECTED_MAX - 5) + required.slice(0, 5);
  expect(labelDiff(required, big, "contains").verdict).toBe("mismatch");
  expect(labelDiff(required, "ACME ".repeat(LABEL_EXPECTED_MAX / 5 - 1) + "ACMX", "whole").verdict).toBe("mismatch");
  expect(Date.now() - started).toBeLessThan(15_000);
});
