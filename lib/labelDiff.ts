/**
 * The exact text diff of the label check: what a label must say against what was read in the picture, character by character. Pure; no model decides anything here
 * (the owner, 14 Oct 2026: "an AI model alone never decides pass/fail"). The words of a verdict are:
 *
 *   match      the text read equals the required text under the rules below (whole), or the required text is found in what was read (contains)
 *   mismatch   text was read, and it differs: the difference is shown as removed (required, not read) and added (read, not required)
 *   missing    no text at all was read
 *
 * A mismatch or a missing label FLAGS the take for a person. It never blocks, hides or deletes it: this module decides nothing about a take.
 *
 * THE RULES (explicit, recorded with every result, strict by default). Applied to both texts before they are compared:
 *   - line endings: CRLF and CR are read as LF, always.
 *   - the ends: whitespace at the start and end of the whole text is dropped, always (the reader ends its text with a line break).
 *   - `unicode`: "nfc" (default) writes both in Unicode normal form C, so one letter written two canonically equal ways is one letter; "none" compares code points as given.
 *   - `case`: "exact" (default) is case-sensitive; "fold" lower-cases both.
 *   - `whitespace`: "exact" (default) compares every space, tab and line break inside the text as it is; "collapse" reads any run of white space (including the no-break space) as one space.
 * Nothing else is ever done: no accent stripping, no look-alike letters, no punctuation or digit tolerance. A caller wanting more asks for a rule here, in code, with a test.
 *
 * Text is compared by Unicode code point. Limits keep the work bounded: the required text is at most LABEL_EXPECTED_MAX characters, the text read at most LABEL_DETECTED_MAX.
 */
export const LABEL_EXPECTED_MAX = 1000;
export const LABEL_DETECTED_MAX = 20000;

export type LabelRules = { unicode: "nfc" | "none"; case: "exact" | "fold"; whitespace: "exact" | "collapse" };
export const STRICT_RULES: LabelRules = { unicode: "nfc", case: "exact", whitespace: "exact" };
export type LabelMode = "whole" | "contains";
export type LabelVerdict = "match" | "mismatch" | "missing";

export type DiffOp = { op: "equal" | "remove" | "add"; text: string };
export type LabelDiff = {
  verdict: LabelVerdict;
  /** The required text as compared (after the rules). */
  expected: string;
  /** The text read as compared; for `contains`, the stretch of it that is closest to the required text. */
  detected: string;
  /** Characters removed plus characters added: 0 only for a match. */
  distance: number;
  ops: DiffOp[];
};

/** Reads a caller's rules: any field left out or not one of the known words is the strict value. Never throws. */
export function readRules(input: unknown): LabelRules {
  const r = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return {
    unicode: r.unicode === "none" ? "none" : "nfc",
    case: r.case === "fold" ? "fold" : "exact",
    whitespace: r.whitespace === "collapse" ? "collapse" : "exact",
  };
}
/** Are all the fields given by the caller words we know? For a request to be refused rather than silently read as strict. */
export function rulesProblem(input: unknown): string | null {
  if (input == null) return null;
  if (typeof input !== "object" || Array.isArray(input)) return "Rules are a group: unicode, case and whitespace.";
  const r = input as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!["unicode", "case", "whitespace"].includes(k)) return `There is no rule called ${k.slice(0, 40)}: the rules are unicode, case and whitespace.`;
  if (r.unicode != null && r.unicode !== "nfc" && r.unicode !== "none") return "unicode is nfc (default) or none.";
  if (r.case != null && r.case !== "exact" && r.case !== "fold") return "case is exact (default) or fold.";
  if (r.whitespace != null && r.whitespace !== "exact" && r.whitespace !== "collapse") return "whitespace is exact (default) or collapse.";
  return null;
}

const SPACE = /[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/gu;
export function normalise(text: string, rules: LabelRules): string {
  let t = text.replace(/\r\n?/g, "\n");
  if (rules.unicode === "nfc") t = t.normalize("NFC");
  if (rules.case === "fold") t = t.toLowerCase();
  if (rules.whitespace === "collapse") t = t.replace(SPACE, " ");
  return t.replace(/^[\s\u00a0\ufeff]+|[\s\u00a0\ufeff]+$/gu, "");
}

const points = (s: string): string[] => Array.from(s);

/** The difference between two texts as runs of equal, removed (in `a` only) and added (in `b` only) characters: a longest-common-subsequence edit script. */
export function diffOps(a: string, b: string): { ops: DiffOp[]; distance: number } {
  const x = points(a), y = points(b);
  const n = x.length, m = y.length;
  /* lcs[i][j]: length of the longest common subsequence of x[i..] and y[j..]. */
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const ops: DiffOp[] = [];
  const push = (op: DiffOp["op"], ch: string) => { const last = ops[ops.length - 1]; if (last && last.op === op) last.text += ch; else ops.push({ op, text: ch }); };
  let i = 0, j = 0, distance = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) { push("equal", x[i]); i++; j++; }
    else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) { push("add", y[j]); j++; distance++; }
    else { push("remove", x[i]); i++; distance++; }
  }
  return { ops, distance };
}

/**
 * The stretch of `hay` closest to `needle` (smallest Levenshtein distance; the earliest, then the shortest, on a tie), by Sellers' approximate substring match with rolling rows.
 * An exact occurrence is distance 0.
 */
function closestWindow(needle: string[], hay: string[]): { start: number; end: number } {
  const m = needle.length, n = hay.length;
  let prev = Array.from({ length: m + 1 }, (_, i) => i);
  let prevStart = new Array<number>(m + 1).fill(0);
  let best = { dist: prev[m], start: 0, end: 0 };
  for (let j = 1; j <= n; j++) {
    const cur = new Array<number>(m + 1).fill(0), curStart = new Array<number>(m + 1).fill(j);
    for (let i = 1; i <= m; i++) {
      const sub = prev[i - 1] + (needle[i - 1] === hay[j - 1] ? 0 : 1), del = cur[i - 1] + 1, ins = prev[i] + 1;
      if (sub <= del && sub <= ins) { cur[i] = sub; curStart[i] = prevStart[i - 1]; }
      else if (ins <= del) { cur[i] = ins; curStart[i] = prevStart[i]; }
      else { cur[i] = del; curStart[i] = curStart[i - 1]; }
    }
    if (cur[m] < best.dist) best = { dist: cur[m], start: curStart[m], end: j };
    prev = cur; prevStart = curStart;
  }
  return { start: best.start, end: best.end };
}

/** Compares what a label must say with what was read. */
export function labelDiff(required: string, read: string, mode: LabelMode, rules: LabelRules = STRICT_RULES): LabelDiff {
  const expected = normalise(required, rules);
  const detectedAll = normalise(read, rules);
  if (!expected) throw new RangeError("The required text is empty.");
  if (!detectedAll) return { verdict: "missing", expected, detected: "", distance: points(expected).length, ops: [{ op: "remove", text: expected }] };
  let detected = detectedAll;
  if (mode === "contains") {
    if (detectedAll.includes(expected)) return { verdict: "match", expected, detected: expected, distance: 0, ops: [{ op: "equal", text: expected }] };
    const hay = points(detectedAll), needle = points(expected);
    const w = closestWindow(needle, hay);
    /* Nothing in what was read lines up with the required text better than nothing does: show all of it. */
    detected = w.end > w.start ? hay.slice(w.start, w.end).join("") : detectedAll;
  }
  const { ops, distance } = diffOps(expected, detected);
  return { verdict: distance === 0 ? "match" : "mismatch", expected, detected, distance, ops };
}
