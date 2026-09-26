/**
 * Three-way merge of a project draft: merge3(base, mine, theirs), over JSON values.
 * `base` is the draft as last read from or confirmed by the server, `mine` the
 * local draft built on it, `theirs` the newer version another save produced.
 *
 *  - A side that left a value as it was in base takes the other side's value.
 *  - Objects merge key by key; a key one side deleted stays deleted only if the
 *    other side left it unchanged.
 *  - Lists of records merge by identity: a string `id` (failing that the
 *    `genId`, `jobId` or `assetId` takes, pending renders and plates are keyed
 *    by), or a numbered `frame` or `page` (keyframes, script pages — kept in
 *    that number's order). Mine's order, then what theirs added in theirs'
 *    order — unless only theirs moved records (mine kept base's order), when
 *    theirs' order leads and what mine added follows. A record one side removed
 *    goes only if the other side left it unchanged. An identity never appears
 *    twice. A record both sides hold that base lacks merges from its ancestor
 *    when the caller knows one (a shot an undo put back: what it was when it
 *    was taken out), so the other side's edits since it came back stand.
 *  - Lists of distinct single-token strings (a node's links, an asset's refs, a
 *    place's references) merge as sets: both sides' additions are kept, both
 *    sides' removals hold.
 *  - Other lists of strings (hooks, steps) and lists of records without an
 *    identity merge as sequences (diff3): what each side changed in a different
 *    stretch is kept; where both inserted at one place, both insertions are
 *    kept, mine's first; where both rewrote one stretch, mine's rewrite stands
 *    (theirs' when mine only deleted it).
 *  - Text with several lines (a brief, a script, notes) merges the same way,
 *    line by line: two windows editing different scenes keep both.
 *  - Anything else both sides changed (a one-line string, a number, a vector):
 *    mine wins.
 *
 * Nothing either side added or changed is dropped, except where both changed
 * the same thing and mine's change stands.
 */

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => value !== null && typeof value === "object" && !Array.isArray(value);
/** A key holding `undefined` is absent, as it is once the draft is JSON. */
const has = (row: Row, key: string) => Object.prototype.hasOwnProperty.call(row, key) && row[key] !== undefined;
/** Sets a key as an own property: a key named "__proto__" is data here, never the prototype. */
function put(row: Row, key: string, value: unknown) {
  Object.defineProperty(row, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Deep equality of JSON values; key order does not matter, an undefined key is an absent one. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameJson(a[i] ?? null, b[i] ?? null)) return false;
    return true;
  }
  if (isRow(a)) {
    if (!isRow(b)) return false;
    let count = 0;
    for (const key of Object.keys(a)) {
      if (!has(a, key)) continue;
      if (!has(b, key) || !sameJson(a[key], b[key])) return false;
      count++;
    }
    return Object.keys(b).filter((key) => has(b, key)).length === count;
  }
  return false;
}

/** One JSON text per value, whatever the key order: equal values, equal texts. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item ?? null)).join(",")}]`;
  if (isRow(value)) {
    const keys = Object.keys(value).filter((key) => has(value, key)).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export type MergeOptions = {
  /**
   * What a record was before this side took it out and put it back (an undo),
   * by identity. When both sides hold such a record and base does not, it
   * merges from this ancestor rather than as two unrelated additions.
   */
  ancestors?: ReadonlyMap<string, unknown>;
  /** Set when a merged list or text came out longer than either side's: it may be past a limit neither side reached. */
  grew?: { value: boolean };
};

export function merge3<T>(base: T | undefined, mine: T, theirs: T, options: MergeOptions = {}): T {
  return mergeValue(base, mine, theirs, options) as T;
}

function mergeValue(base: unknown, mine: unknown, theirs: unknown, options: MergeOptions): unknown {
  if (sameJson(mine, base)) return theirs;
  if (sameJson(theirs, base)) return mine;
  if (sameJson(mine, theirs)) return mine;
  if (isRow(mine) && isRow(theirs)) return mergeRows(isRow(base) ? base : undefined, mine, theirs, options);
  if (Array.isArray(mine) && Array.isArray(theirs)) {
    const out = mergeList(Array.isArray(base) ? base : [], mine, theirs, options);
    if (options.grew && out.length > Math.max(mine.length, theirs.length)) options.grew.value = true;
    return out;
  }
  if (typeof base === "string" && typeof mine === "string" && typeof theirs === "string" && [base, mine, theirs].some((text) => text.includes("\n"))) {
    const out = mergeSequence(base.split("\n"), mine.split("\n"), theirs.split("\n"), false)?.join("\n") ?? mine;
    if (options.grew && out.length > Math.max(mine.length, theirs.length)) options.grew.value = true;
    return out;
  }
  return mine;
}

function mergeList(base: unknown[], mine: unknown[], theirs: unknown[], options: MergeOptions): unknown[] {
  if (tokenSet(base, mine, theirs)) return mergeStrings(base as string[], mine as string[], theirs as string[]);
  const key = identityKey(base, mine, theirs);
  if (key) return mergeById(key, base, mine, theirs, options);
  if (sequence(base, mine, theirs)) return mergeSequence(base, mine, theirs) ?? mine;
  return mine;
}

function mergeRows(base: Row | undefined, mine: Row, theirs: Row, options: MergeOptions): Row {
  const out: Row = {};
  for (const key of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
    const inMine = has(mine, key), inTheirs = has(theirs, key);
    if (!inMine && !inTheirs) continue;
    const before = base && has(base, key) ? base[key] : undefined;
    if (inMine && inTheirs) put(out, key, mergeValue(before, mine[key], theirs[key], options));
    else {
      const kept = inMine ? mine[key] : theirs[key];
      /* One side lacks it: added by the other (no base), or deleted by this one, which stands only over an unchanged value. */
      if (before === undefined || !sameJson(kept, before)) put(out, key, kept);
    }
  }
  return out;
}

/** Lists of strings, each list without repeats and every string one token (no spaces): a set of ids or names. */
function tokenSet(...lists: unknown[][]): boolean {
  return lists.every((list) => list.every((item) => typeof item === "string" && item.length <= 300 && !/\s/.test(item)) && new Set(list).size === list.length);
}

function mergeStrings(base: string[], mine: string[], theirs: string[]): string[] {
  const before = new Set(base);
  const [lead, follow] = theirsLead(base, mine, theirs) ? [theirs, mine] : [mine, theirs];
  const leading = new Set(lead), following = new Set(follow);
  /* The leading side's order, less what the other removed; then what the other added, in its order. */
  const out = lead.filter((item) => !before.has(item) || following.has(item));
  for (const item of follow) if (!before.has(item) && !leading.has(item)) out.push(item);
  return out;
}

/** Whether `list` orders the ids in `among` differently from `base`. */
function reorders(base: string[], list: string[], among: Set<string>): boolean {
  const moved = list.filter((id) => among.has(id)), was = base.filter((id) => among.has(id));
  return moved.some((id, i) => id !== was[i]);
}

/**
 * Whose order a merged list follows: mine's, unless mine kept base's order and
 * theirs moved what both sides still hold — a move is an edit like any other.
 * Measured this way, merging again with the result picks the same side, so the
 * merge stays idempotent.
 */
function theirsLead(base: string[], mine: string[], theirs: string[]): boolean {
  const before = new Set(base);
  const kept = new Set(mine.filter((id) => before.has(id)));
  if (reorders(base, mine, kept)) return false;
  return reorders(base, theirs, new Set(theirs.filter((id) => kept.has(id))));
}

const IDENTITIES = ["id", "genId", "jobId", "assetId"] as const;
/** Numbered identities: a list keyed by one is kept in that number's order (keyframes by frame, script pages by page). */
const ORDINALS = ["frame", "page"] as const;

/** The field a list of records is keyed by, or null for a list that is not one. */
function identityKey(...lists: unknown[][]): string | null {
  const items = lists.flat();
  if (!items.length || !items.every(isRow)) return null;
  const unique = (key: string) => lists.every((list) => new Set(list.map((item) => (item as Row)[key])).size === list.length);
  for (const key of IDENTITIES) {
    if (!items.every((item) => typeof (item as Row)[key] === "string" && (item as Row)[key] !== "")) continue;
    /* `id` is the identity: a repeated one collapses. The others key a list only where each value is unique. */
    if (key === "id" || unique(key)) return key;
  }
  for (const key of ORDINALS) if (items.every((item) => Number.isFinite((item as Row)[key])) && unique(key)) return key;
  return null;
}

function mergeById(key: string, base: unknown[], mine: unknown[], theirs: unknown[], options: MergeOptions): unknown[] {
  const identity = (item: unknown) => String((item as Row)[key]);
  const index = (list: unknown[]) => {
    const byId = new Map<string, Row>();
    for (const item of list) if (!byId.has(identity(item))) byId.set(identity(item), item as Row);
    return byId;
  };
  const before = index(base), ours = index(mine), others = index(theirs);
  const flip = theirsLead([...before.keys()], [...ours.keys()], [...others.keys()]);
  const [lead, follow] = flip ? [others, ours] : [ours, others];
  const out: unknown[] = [];
  for (const [id, item] of lead) {
    const other = follow.get(id), was = before.get(id);
    if (other) {
      /* Both hold it. With no base between them, a known ancestor (a record put back by an undo) is what each side changed. */
      const from = was ?? (key === "id" ? options.ancestors?.get(id) : undefined);
      out.push(flip ? mergeValue(from, other, item, options) : mergeValue(from, item, other, options));
    }
    /* The other side removed it: gone only if this side left it as it was. */
    else if (!was || !sameJson(item, was)) out.push(item);
  }
  for (const [id, item] of follow) {
    if (lead.has(id)) continue;
    const was = before.get(id);
    /* Added by the other side, or removed by the leading side but changed by the other: kept. */
    if (!was || !sameJson(item, was)) out.push(item);
  }
  if ((ORDINALS as readonly string[]).includes(key)) out.sort((a, b) => Number((a as Row)[key]) - Number((b as Row)[key]));
  return out;
}

/** Lists merged as sequences: strings that are not a token set, or records without an identity. */
function sequence(...lists: unknown[][]): boolean {
  const items = lists.flat();
  return items.length > 0 && (items.every((item) => typeof item === "string") || items.every(isRow));
}

/** Past this many edits between two versions, a sequence is not merged item by item: mine stands. */
const DIFF_LIMIT = 1000;

/**
 * diff3 over sequences (list items, or the lines of a text). Stretches only one
 * side changed take that side's; both inserting at one place keeps both
 * insertions (mine's first); a stretch one side only added to keeps those
 * additions beside the other side's rewrite; a stretch both rewrote keeps
 * mine's (theirs' when mine only deleted it). With `distinct` (no input repeats
 * an item), an item never appears twice in the result either. Null when the
 * versions differ too much to align.
 */
function mergeSequence<T>(base: T[], mine: T[], theirs: T[], distinct = true): T[] | null {
  const codes = new Map<string, number>();
  const encode = (list: T[]) => list.map((item) => {
    const text = typeof item === "string" ? item : canonical(item);
    let code = codes.get(text);
    if (code === undefined) codes.set(text, (code = codes.size));
    return code;
  });
  const b = encode(base), m = encode(mine), t = encode(theirs);
  const toMine = alignment(b, m), toTheirs = alignment(b, t);
  if (!toMine || !toTheirs) return null;
  const out: T[] = [];
  let bi = 0, mi = 0, ti = 0;
  const chunk = (bEnd: number, mEnd: number, tEnd: number) => {
    const picked = resolveChunk(b.slice(bi, bEnd), m.slice(mi, mEnd), t.slice(ti, tEnd));
    for (const [side, at] of picked) out.push(side === "mine" ? mine[mi + at] : theirs[ti + at]);
  };
  for (let i = 0; i < b.length; i++) {
    const jm = toMine[i], jt = toTheirs[i];
    if (jm < 0 || jt < 0) continue;
    /* An item every side kept in place: what lies before it merges as one stretch. */
    chunk(i, jm, jt);
    out.push(mine[jm]);
    bi = i + 1; mi = jm + 1; ti = jt + 1;
  }
  chunk(b.length, m.length, t.length);
  const unique = distinct && [b, m, t].every((list) => new Set(list).size === list.length);
  if (!unique) return out;
  const seen = new Set<string>();
  return out.filter((item) => {
    const text = typeof item === "string" ? item : canonical(item);
    if (seen.has(text)) return false;
    seen.add(text);
    return true;
  });
}

/** One stretch between items all three kept: which side's items stand, as [side, index within its stretch]. */
function resolveChunk(base: number[], mine: number[], theirs: number[]): ["mine" | "theirs", number][] {
  const same = (a: number[], b: number[]) => a.length === b.length && a.every((value, i) => value === b[i]);
  const all = (side: "mine" | "theirs", list: number[]) => list.map((_, i) => [side, i] as ["mine" | "theirs", number]);
  if (same(mine, base)) return all("theirs", theirs);
  if (same(theirs, base) || same(mine, theirs)) return all("mine", mine);
  /* Mine only deleted what theirs rewrote: the rewrite is kept. */
  if (!mine.length) return all("theirs", theirs);
  if (!theirs.length) return all("mine", mine);
  /* What a side put in besides base's items (all still there, in order), less what the other side has too. */
  const added = (list: number[], besides: number[]) => {
    const out: number[] = [];
    let at = 0;
    list.forEach((code, i) => {
      if (at < base.length && base[at] === code) at++;
      else if (!besides.includes(code)) out.push(i);
    });
    return out;
  };
  /* One side only added (base's items all still there, in order): its additions join the other side's version. */
  if (subsequence(base, theirs)) return [...all("mine", mine), ...added(theirs, mine).map((i) => ["theirs", i] as ["theirs", number])];
  if (subsequence(base, mine)) return [...all("theirs", theirs), ...added(mine, theirs).map((i) => ["mine", i] as ["mine", number])];
  /* Both rewrote this stretch: mine stands. */
  return all("mine", mine);
}

function subsequence(inner: number[], outer: number[]): boolean {
  let at = 0;
  for (const value of outer) if (at < inner.length && inner[at] === value) at++;
  return at === inner.length;
}

/** For each index of `a`, the index of `b` it is matched to in a longest common subsequence, or -1. Null past DIFF_LIMIT edits. */
function alignment(a: number[], b: number[]): Int32Array | null {
  const to = new Int32Array(a.length).fill(-1);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) { to[start] = start; start++; }
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; to[endA] = endB; }
  const middle = myers(a, b, start, endA, start, endB);
  if (!middle) return null;
  for (const [i, j] of middle) to[i] = j;
  return to;
}

/** Myers' O(ND) difference: the matched index pairs of a[a0..a1) and b[b0..b1), in order. */
function myers(a: number[], b: number[], a0: number, a1: number, b0: number, b1: number): [number, number][] | null {
  const n = a1 - a0, m = b1 - b0;
  if (!n || !m) return [];
  const max = Math.min(n + m, DIFF_LIMIT);
  /* trace[d][k + d]: the furthest x reached on diagonal k after d edits. */
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    const v = new Int32Array(2 * d + 1), prev = trace[d - 1];
    for (let k = -d; k <= d; k += 2) {
      let x = d === 0 ? 0 : k === -d || (k !== d && prev[k - 1 + d - 1] < prev[k + 1 + d - 1]) ? prev[k + 1 + d - 1] : prev[k - 1 + d - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[a0 + x] === b[b0 + y]) { x++; y++; }
      v[k + d] = x;
      if (x >= n && y >= m) {
        trace.push(v);
        return backtrack(trace, a0, b0, n, m);
      }
    }
    trace.push(v);
  }
  return null;
}

function backtrack(trace: Int32Array[], a0: number, b0: number, n: number, m: number): [number, number][] {
  const pairs: [number, number][] = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d - 1], k = x - y;
    const down = k === -d || (k !== d && prev[k - 1 + d - 1] < prev[k + 1 + d - 1]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = prev[prevK + d - 1], prevY = prevX - prevK;
    const midX = down ? prevX : prevX + 1;
    while (x > midX) { x--; y--; pairs.push([a0 + x, b0 + y]); }
    x = prevX; y = prevY;
  }
  while (x > 0 && y > 0) { x--; y--; pairs.push([a0 + x, b0 + y]); }
  return pairs.reverse();
}

/**
 * The local draft once the server holds `saved` for the draft `sent`: edits
 * made while the request was out (`local` moved on from `sent`) are laid over
 * `saved` rather than lost; with none, the draft is exactly `saved`.
 */
export function rebaseDraft<T>(sent: T, local: T, saved: T): T {
  return local === sent ? saved : merge3(sent, local, saved);
}
