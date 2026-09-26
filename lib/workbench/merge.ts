import { isStableId } from "./stable-id";

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
 *    that number's order). Where a list repeats an identity, the n-th record
 *    under it in one version is the n-th in another, so what a side holds
 *    twice is never collapsed, and a merge never makes a repeat. A record one
 *    side removed goes only if the other side left it unchanged.
 *  - Order is merged like text (below): each side's moves and insertions stay
 *    where that side put them; where both moved the same stretch, mine's stands.
 *  - A record both sides hold that base lacks merges from its ancestor when
 *    one is known: a shot an undo put back (what it was when taken out), or a
 *    record this side made from a source both windows share (an agent run's
 *    places, a breakdown, a filed take, shots built from boards — what it was
 *    as made). So the other side's edits since stand. Such a record this side
 *    still holds as made stays out when the other side took it out since
 *    (Project.takenOut, noteTakenOut), and one this side took out stays out
 *    when the other side holds it as made — never on a guess.
 *  - Lists of distinct single-token strings (a node's links, an asset's refs, a
 *    place's references) merge as sets: both sides' additions are kept, both
 *    sides' removals hold.
 *  - Other lists of strings (hooks, steps) and lists of records without an
 *    identity merge as sequences (diff3): each side's changes to different
 *    items are kept, even side by side; where both inserted at one place, both
 *    insertions are kept, mine's first; where one side only took items out,
 *    they stay out of the other side's version; where both rewrote the same
 *    items, mine's stand — theirs' when theirs went on from mine's (it
 *    contains mine's edit).
 *  - Text with several lines (a brief, a script, notes) merges the same way,
 *    line by line: two windows editing different lines keep both.
 *  - A one-line string both sides changed: mine — theirs' when theirs went on
 *    from mine's edit (the same words, then more).
 *  - Anything else both sides changed (a number, a vector): mine wins.
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

/** What one editor's changes made, each record as made, by identity (`field:value`). */
export type MadeRecords = Map<string, unknown>;

export type MergeOptions = {
  /**
   * What a record was before this side took it out and put it back (an undo),
   * by identity. When both sides hold such a record and base does not, it
   * merges from this ancestor rather than as two unrelated additions.
   */
  ancestors?: ReadonlyMap<string, unknown>;
  /**
   * What this side made (recordMade), as made. A record both sides hold that
   * base lacks merges from it. One this side made and took out goes when the
   * other side holds it exactly as made (it made the same, untouched); one
   * this side holds exactly as made goes when the other side took it out
   * since base (`takenOut`).
   */
  made?: ReadonlyMap<string, unknown>;
  /** The records made from a shared source that the other side took out since base (Project.takenOut; mergeDraft fills it), by id. */
  takenOut?: ReadonlySet<string>;
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
  if (typeof mine === "string" && typeof theirs === "string" && (base === undefined || typeof base === "string")) {
    const before = base ?? "";
    if ([before, mine, theirs].some((text) => text.includes("\n"))) {
      const out = mergeSequence(before.split("\n"), mine.split("\n"), theirs.split("\n"), { distinct: false, text: true }).join("\n");
      if (options.grew && out.length > Math.max(mine.length, theirs.length)) options.grew.value = true;
      return out;
    }
    return continues(before, mine, theirs) ? theirs : mine;
  }
  return mine;
}

function mergeList(base: unknown[], mine: unknown[], theirs: unknown[], options: MergeOptions): unknown[] {
  if (tokenSet(base, mine, theirs)) return mergeStrings(base as string[], mine as string[], theirs as string[]);
  const key = identityKey(base, mine, theirs);
  if (key) return mergeById(key, base, mine, theirs, options);
  if (sequence(base, mine, theirs)) return mergeSequence(base, mine, theirs, { text: [...base, ...mine, ...theirs].every((item) => typeof item === "string") });
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

/** A set: what either side added stays, what either side took out stays out; the order merged as a sequence. */
function mergeStrings(base: string[], mine: string[], theirs: string[]): string[] {
  const before = new Set(base), ours = new Set(mine), others = new Set(theirs);
  const kept = new Map<string, string>();
  for (const item of [...mine, ...theirs]) if (!kept.has(item) && !(before.has(item) && (!ours.has(item) || !others.has(item)))) kept.set(item, item);
  return orderKeys(base, mine, theirs, kept);
}

const IDENTITIES = ["id", "genId", "jobId", "assetId"] as const;
/** Numbered identities: a list keyed by one is kept in that number's order (keyframes by frame, script pages by page). */
const ORDINALS = ["frame", "page"] as const;

/** The field a list of records is keyed by, or null for a list that is not one. */
export function identityKey(...lists: unknown[][]): string | null {
  const items = lists.flat();
  if (!items.length || !items.every(isRow)) return null;
  const unique = (key: string) => lists.every((list) => new Set(list.map((item) => (item as Row)[key])).size === list.length);
  for (const key of IDENTITIES) {
    if (!items.every((item) => typeof (item as Row)[key] === "string" && (item as Row)[key] !== "")) continue;
    /* `id` is the identity, repeated or not (repeats pair up by occurrence). The others key a list only where each value is unique. */
    if (key === "id" || unique(key)) return key;
  }
  for (const key of ORDINALS) if (items.every((item) => Number.isFinite((item as Row)[key])) && unique(key)) return key;
  return null;
}

function mergeById(key: string, base: unknown[], mine: unknown[], theirs: unknown[], options: MergeOptions): unknown[] {
  const identity = (item: unknown) => String((item as Row)[key]);
  /* A list that repeats an identity pairs its records by occurrence: the n-th under an id in one version is the n-th in another. */
  const repeats = [base, mine, theirs].some((list) => new Set(list.map(identity)).size !== list.length);
  const keysOf = (list: unknown[]) => {
    const seen = new Map<string, number>();
    return list.map((item) => {
      const id = identity(item);
      const n = seen.get(id) ?? 0;
      seen.set(id, n + 1);
      return repeats ? `${id}\u0000${n}` : id;
    });
  };
  const bk = keysOf(base), mk = keysOf(mine), tk = keysOf(theirs);
  const before = new Map(bk.map((k, i) => [k, base[i]])), ours = new Map(mk.map((k, i) => [k, mine[i]])), others = new Map(tk.map((k, i) => [k, theirs[i]]));
  const made = (k: string) => (repeats ? undefined : options.made?.get(`${key}:${k}`));
  const kept = new Map<string, unknown>();
  const decided = new Set<string>();
  for (const k of [...mk, ...tk]) {
    if (decided.has(k)) continue;
    decided.add(k);
    const m = ours.get(k), t = others.get(k), was = before.get(k);
    if (m !== undefined && t !== undefined) {
      /* Both hold it. With no base between them, a known ancestor (put back by an undo, or as this side made it) is what each side changed. */
      const from = was ?? (key === "id" && !repeats ? options.ancestors?.get(k) : undefined) ?? made(k);
      kept.set(k, mergeValue(from, m, t, options));
      continue;
    }
    const inMine = m !== undefined, item = inMine ? m : t;
    /* The other side removed it: gone only if this side left it as it was. */
    if (was !== undefined) {
      if (!sameJson(item, was)) kept.set(k, item);
      continue;
    }
    /* Added by one side — unless both sides made it from one source and one of them has taken it out since, untouched. */
    const as = made(k);
    if (as !== undefined && sameJson(item, as)) {
      /* Mine made it and took it out; theirs holds it exactly as made (it made the same). */
      if (!inMine) continue;
      /* Mine holds it as made; theirs made the same and took it out since base (it says so: Project.takenOut). */
      if (!repeats && options.takenOut?.has(identity(item))) continue;
    }
    kept.set(k, item);
  }
  const order = orderKeys(bk, mk, tk, kept);
  const out = order.map((k) => kept.get(k));
  if ((ORDINALS as readonly string[]).includes(key)) out.sort((a, b) => Number((a as Row)[key]) - Number((b as Row)[key]));
  return out;
}

/**
 * The order of the records a merge keeps. Which of two goes first is as the
 * side that changed their order has it — mine, when both did — else as base
 * has it. Mine's order is the spine; the records theirs reordered against
 * others that mine left as they were come out of it, and they and what only
 * theirs holds go back in after the last record that goes before each (and
 * after what mine put in at the same place), never past one mine has after it.
 * So each side's moves and insertions stay where that side put them, and
 * merging again with the result gives the result.
 */
function orderKeys(base: string[], mine: string[], theirs: string[], kept: ReadonlyMap<string, unknown>): string[] {
  const indexOf = (list: string[]) => new Map(list.map((k, i) => [k, i]));
  const inBase = indexOf(base), inMine = indexOf(mine), inTheirs = indexOf(theirs);
  const others = theirs.filter((k) => kept.has(k) && !inMine.has(k));
  /* What theirs moved: its records from base outside the longest run it kept in base's order. */
  const inOrder = theirs.filter((k) => inBase.has(k));
  const stayed = new Set(longestRun(inOrder.map((k) => inBase.get(k)!)).map((i) => base[i]));
  const movers = inOrder.filter((k) => !stayed.has(k) && inMine.has(k));
  const shared = mine.filter((k) => inBase.has(k) && inTheirs.has(k));
  if (!movers.length && !others.length) return mine.filter((k) => kept.has(k));
  if ((movers.length + others.length) * mine.length > 4_000_000) {
    /* Too many to weigh one by one: mine's order, and what only theirs holds after its nearest record there. */
    const out = mine.filter((k) => kept.has(k));
    for (const k of others) {
      let at = 0;
      for (let i = inTheirs.get(k)! - 1; i >= 0; i--) {
        const j = out.indexOf(theirs[i]);
        if (j >= 0) { at = j + 1; break; }
      }
      out.splice(at, 0, k);
    }
    return out;
  }
  /* Records in a pair theirs reordered and mine did not. */
  const loose = new Set<string>();
  for (const x of movers)
    for (const y of shared) {
      if (y === x) continue;
      const was = inBase.get(x)! < inBase.get(y)!;
      if ((inTheirs.get(x)! < inTheirs.get(y)!) !== was && (inMine.get(x)! < inMine.get(y)!) === was) { loose.add(x); loose.add(y); }
    }
  /* Whether `x` goes before `y`, and whether that is mine's word; unknown when no version holds both. */
  const decide = (x: string, y: string): { first: boolean; mine: boolean } | undefined => {
    const say = (at: Map<string, number>) => (at.has(x) && at.has(y) ? at.get(x)! < at.get(y)! : undefined);
    const was = say(inBase), own = say(inMine), other = say(inTheirs);
    if (own !== undefined && own !== was) return { first: own, mine: true };
    if (other !== undefined && other !== was) return { first: other, mine: false };
    const first = was ?? own ?? other;
    return first === undefined ? undefined : { first, mine: false };
  };
  const out = mine.filter((k) => kept.has(k) && !loose.has(k));
  for (const k of [...mine.filter((k) => kept.has(k) && loose.has(k)), ...others]) {
    let anchor = -1, cap = out.length;
    for (let j = 0; j < out.length; j++) {
      const says = decide(out[j], k);
      if (!says) continue;
      if (says.first) anchor = j;
      else if (says.mine && cap === out.length) cap = j;
    }
    /* Mine's word stands: nothing mine has after it goes before it. */
    if (anchor >= cap) anchor = cap - 1;
    /* What mine put in at the same place comes first. */
    while (anchor + 1 < cap && decide(out[anchor + 1], k) === undefined) anchor++;
    out.splice(anchor + 1, 0, k);
  }
  return out;
}

/** The longest strictly increasing run in `values` (its values, in order): patience sorting. */
function longestRun(values: number[]): number[] {
  const tails: number[] = [], prev = new Int32Array(values.length).fill(-1);
  for (let k = 0; k < values.length; k++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[tails[mid]] < values[k]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[k] = tails[lo - 1];
    tails[lo] = k;
  }
  const out: number[] = [];
  for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) out.push(values[k]);
  return out.reverse();
}

/** Lists merged as sequences: strings that are not a token set, or records without an identity. */
function sequence(...lists: unknown[][]): boolean {
  const items = lists.flat();
  return items.length > 0 && (items.every((item) => typeof item === "string") || items.every(isRow));
}

/** A stretch of one version: its items, and each item's code (equal items, equal codes). */
type Stretch<T> = { codes: number[]; items: T[] };
/** What one side did to base: base[start, end) became side[from, to). */
type Hunk = { side: 0 | 1; start: number; end: number; from: number; to: number };

/**
 * diff3 over sequences (list items, or the lines of a text). Each side's
 * changes are hunks over base; hunks that touch different items apply side by
 * side, and only hunks over the same items (or insertions at one place) are
 * resolved together (resolveStretch). With `distinct` (no input repeats an
 * item), an item never appears twice in the result either.
 */
function mergeSequence<T>(base: T[], mine: T[], theirs: T[], { distinct = true, text = false }: { distinct?: boolean; text?: boolean } = {}): T[] {
  const codes = new Map<string, number>();
  const encode = (list: T[]) => list.map((item) => {
    const key = typeof item === "string" ? item : canonical(item);
    let code = codes.get(key);
    if (code === undefined) codes.set(key, (code = codes.size));
    return code;
  });
  const b = encode(base), m = encode(mine), t = encode(theirs);
  const hunks = [...hunksOf(align(b, m), m.length, 0), ...hunksOf(align(b, t), t.length, 1)]
    .sort((x, y) => x.start - y.start || x.end - y.end || x.side - y.side);
  const sides = [{ codes: m, items: mine }, { codes: t, items: theirs }];
  /* Each item out, and whether mine put it there (a repeat keeps mine's place: where both moved one item, mine's move stands). */
  const out: T[] = [], own: boolean[] = [];
  const emit = (item: T, fromMine: boolean) => { out.push(item); own.push(fromMine); };
  let pos = 0;
  for (let h = 0; h < hunks.length;) {
    const cluster = [hunks[h++]];
    while (h < hunks.length && cluster.some((c) => overlaps(c, hunks[h]))) cluster.push(hunks[h++]);
    const start = Math.min(...cluster.map((c) => c.start)), end = Math.max(...cluster.map((c) => c.end));
    for (; pos < start; pos++) emit(base[pos], true);
    if (cluster.every((c) => c.side === cluster[0].side)) {
      /* One side changed these items: its version. */
      for (const c of cluster) for (const item of sides[c.side].items.slice(c.from, c.to)) emit(item, c.side === 0);
    } else {
      /* Both changed them: each side's version of the stretch, resolved. */
      const version = (side: 0 | 1): Stretch<T> => {
        const own = cluster.filter((c) => c.side === side);
        const stretch: Stretch<T> = { codes: [], items: [] };
        let at = start;
        for (const c of own) {
          for (; at < c.start; at++) { stretch.codes.push(b[at]); stretch.items.push(base[at]); }
          for (let j = c.from; j < c.to; j++) { stretch.codes.push(sides[side].codes[j]); stretch.items.push(sides[side].items[j]); }
          at = Math.max(at, c.end);
        }
        for (; at < end; at++) { stretch.codes.push(b[at]); stretch.items.push(base[at]); }
        return stretch;
      };
      for (const [item, fromMine] of resolveStretch({ codes: b.slice(start, end), items: base.slice(start, end) }, version(0), version(1), text)) emit(item, fromMine);
    }
    pos = Math.max(pos, end);
  }
  for (; pos < base.length; pos++) emit(base[pos], true);
  const unique = distinct && [b, m, t].every((list) => new Set(list).size === list.length);
  if (!unique) return out;
  const keyOf = (item: T) => (typeof item === "string" ? item : canonical(item));
  const chosen = new Map<string, number>();
  out.forEach((item, i) => {
    const key = keyOf(item), at = chosen.get(key);
    if (at === undefined || (!own[at] && own[i])) chosen.set(key, i);
  });
  return out.filter((item, i) => chosen.get(keyOf(item)) === i);
}

/** Whether two hunks change the same items: overlapping stretches, an insertion inside a stretch, or two insertions at one place. */
function overlaps(a: Hunk, b: Hunk): boolean {
  const aAt = a.start === a.end, bAt = b.start === b.end;
  if (aAt && bAt) return a.start === b.start;
  if (aAt) return b.start < a.start && a.start < b.end;
  if (bAt) return a.start < b.start && b.start < a.end;
  return a.start < b.end && b.start < a.end;
}

/** A side's hunks, from its alignment to base (base index → side index, or -1). */
function hunksOf(to: Int32Array, length: number, side: 0 | 1): Hunk[] {
  const out: Hunk[] = [];
  let pb = -1, ps = -1;
  for (let i = 0; i <= to.length; i++) {
    const j = i < to.length ? to[i] : length;
    if (i < to.length && j < 0) continue;
    if (i - pb > 1 || j - ps > 1) out.push({ side, start: pb + 1, end: i, from: ps + 1, to: j });
    pb = i;
    ps = j;
  }
  return out;
}

/** One stretch both sides changed: which items stand, each with whether it is mine's. */
function resolveStretch<T>(base: Stretch<T>, mine: Stretch<T>, theirs: Stretch<T>, text: boolean): [T, boolean][] {
  const same = (a: Stretch<T>, b: Stretch<T>) => a.codes.length === b.codes.length && a.codes.every((value, i) => value === b.codes[i]);
  const all = (items: T[], fromMine: boolean) => items.map((item) => [item, fromMine] as [T, boolean]);
  if (same(mine, base)) return all(theirs.items, false);
  if (same(theirs, base) || same(mine, theirs)) return all(mine.items, true);
  /* One side only took items out: they stay out of the other side's version, and what that side put in stays. */
  if (subsequence(mine.codes, base.codes)) return all(without(theirs, base, mine), false);
  if (subsequence(theirs.codes, base.codes)) return all(without(mine, base, theirs), true);
  /* One side only put items in (base's all still there, in order): its additions join the other side's version. */
  if (subsequence(base.codes, theirs.codes)) return [...all(mine.items, true), ...all(beyond(theirs, base, mine), false)];
  if (subsequence(base.codes, mine.codes)) return [...all(theirs.items, false), ...all(beyond(mine, base, theirs), true)];
  /* Both rewrote it: mine stands — theirs when it went on from mine's edit. */
  if (text && continues((base.items as string[]).join("\n"), (mine.items as string[]).join("\n"), (theirs.items as string[]).join("\n"))) return all(theirs.items, false);
  return all(mine.items, true);
}

/** `other`'s version without the base items `taker` took out. */
function without<T>(other: Stretch<T>, base: Stretch<T>, taker: Stretch<T>): T[] {
  const keptByTaker = align(base.codes, taker.codes), inOther = align(base.codes, other.codes);
  const out = new Set<number>();
  for (let i = 0; i < base.codes.length; i++) if (keptByTaker[i] < 0 && inOther[i] >= 0) out.add(inOther[i]);
  return other.items.filter((_, j) => !out.has(j));
}

/** The indices of `side`'s items that are not base's (what it put in). */
function fresh<T>(side: Stretch<T>, base: Stretch<T>): number[] {
  const matched = new Set<number>();
  for (const j of align(base.codes, side.codes)) if (j >= 0) matched.add(j);
  return side.codes.map((_, j) => j).filter((j) => !matched.has(j));
}

/**
 * What `side` put in, less `other`'s own insertion where `side` holds it
 * whole, in one run (it went on from the other's insertion, or both typed the
 * same): each insertion once. A line that merely equals one the other side
 * has — a blank line, a repeated character cue — is its own, and stays.
 */
function beyond<T>(side: Stretch<T>, base: Stretch<T>, other: Stretch<T>): T[] {
  const added = fresh(side, base), theirs = fresh(other, base).map((j) => other.codes[j]);
  let at = -1;
  for (let s = 0; theirs.length && s + theirs.length <= added.length && at < 0; s++)
    if (theirs.every((code, j) => side.codes[added[s + j]] === code)) at = s;
  return added.filter((_, n) => at < 0 || n < at || n >= at + theirs.length).map((i) => side.items[i]);
}

function subsequence(inner: number[], outer: number[]): boolean {
  let at = 0;
  for (const value of outer) if (at < inner.length && inner[at] === value) at++;
  return at === inner.length;
}

/** The stretch of `base` that `next` rewrote (common start and end trimmed), and what it is in `next`. */
function span(base: string, next: string) {
  let p = 0;
  const max = Math.min(base.length, next.length);
  while (p < max && base.charCodeAt(p) === next.charCodeAt(p)) p++;
  let s = 0;
  while (s < base.length - p && s < next.length - p && base.charCodeAt(base.length - 1 - s) === next.charCodeAt(next.length - 1 - s)) s++;
  return { from: p, to: base.length - s, text: next.slice(p, next.length - s) };
}

/**
 * Whether `theirs` went on from `mine`'s edit of `base`: the stretch mine
 * rewrote lies inside the one theirs rewrote, and theirs' text there contains
 * mine's — the same edit, then more (a world the agent wrote, then extended).
 */
function continues(base: string, mine: string, theirs: string): boolean {
  const m = span(base, mine), t = span(base, theirs);
  if (t.from > m.from || m.to > t.to) return false;
  return t.text.includes(base.slice(t.from, m.from) + m.text + base.slice(m.to, t.to));
}

/** Past this many edits between two stretches with nothing unique to anchor on, they are not aligned item by item. */
const DIFF_LIMIT = 1000;

/**
 * For each index of `a`, the index of `b` it is matched to, or -1: common
 * start and end, then items that occur once in each (patience anchors), then
 * Myers' difference between anchors. A stretch too different to align within
 * DIFF_LIMIT is left unmatched (one side rewrote it), never the whole list.
 */
function align(a: number[], b: number[]): Int32Array {
  const to = new Int32Array(a.length).fill(-1);
  const stack: [number, number, number, number][] = [[0, a.length, 0, b.length]];
  while (stack.length) {
    let [a0, a1, b0, b1] = stack.pop()!;
    while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) { to[a0] = b0; a0++; b0++; }
    while (a1 > a0 && b1 > b0 && a[a1 - 1] === b[b1 - 1]) { a1--; b1--; to[a1] = b1; }
    if (a0 === a1 || b0 === b1) continue;
    const anchors = uniqueAnchors(a, b, a0, a1, b0, b1);
    if (anchors.length) {
      let pa = a0, pb = b0;
      for (const [i, j] of anchors) {
        to[i] = j;
        stack.push([pa, i, pb, j]);
        pa = i + 1;
        pb = j + 1;
      }
      stack.push([pa, a1, pb, b1]);
      continue;
    }
    const pairs = myers(a, b, a0, a1, b0, b1);
    if (pairs) for (const [i, j] of pairs) to[i] = j;
  }
  return to;
}

/** Items that occur exactly once in a[a0..a1) and once in b[b0..b1), the longest run of them in the same order. */
function uniqueAnchors(a: number[], b: number[], a0: number, a1: number, b0: number, b1: number): [number, number][] {
  const seen = new Map<number, { na: number; ia: number; nb: number; ib: number }>();
  for (let i = a0; i < a1; i++) {
    const entry = seen.get(a[i]);
    if (entry) entry.na++;
    else seen.set(a[i], { na: 1, ia: i, nb: 0, ib: -1 });
  }
  for (let j = b0; j < b1; j++) {
    const entry = seen.get(b[j]);
    if (entry) { entry.nb++; entry.ib = j; }
  }
  const pairs: [number, number][] = [];
  for (const entry of seen.values()) if (entry.na === 1 && entry.nb === 1) pairs.push([entry.ia, entry.ib]);
  if (!pairs.length) return pairs;
  /* Patience: the longest run of them in the same order on both sides. */
  const run = new Set(longestRun(pairs.map(([, j]) => j)));
  return pairs.filter(([, j]) => run.has(j));
}

/** Myers' O(ND) difference: the matched index pairs of a[a0..a1) and b[b0..b1), in order. Null past DIFF_LIMIT edits. */
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
 * Notes what one change made: every record `next` holds (at any depth, in a
 * list keyed as the merge keys it) that `previous` did not, as made. An editor
 * keeps these for the records that come from a source both windows share (an
 * agent run, a breakdown, a job, a storyboard), so a merge can tell the other
 * window's later edits of the same record from two unrelated additions
 * (MergeOptions.made).
 */
export function recordMade(made: MadeRecords, previous: unknown, next: unknown): void {
  const walk = (before: unknown, after: unknown) => {
    if (before === after) return;
    if (Array.isArray(after)) {
      const prior = Array.isArray(before) ? before : [];
      const key = identityKey(prior, after);
      if (!key) return;
      const known = new Map(prior.map((item) => [String((item as Row)[key]), item]));
      if (new Set(after.map((item) => String((item as Row)[key]))).size !== after.length) return;
      for (const item of after) {
        const id = String((item as Row)[key]);
        const was = known.get(id);
        if (was === undefined) made.set(`${key}:${id}`, item);
        walk(was, item);
      }
      return;
    }
    if (isRow(after)) {
      const prior = isRow(before) ? before : undefined;
      for (const key of Object.keys(after)) walk(prior && has(prior, key) ? prior[key] : undefined, after[key]);
    }
  };
  walk(previous, next);
}

/** How many ids a draft keeps in `takenOut`, newest last: past it the oldest go (a stale window may then bring one back — kept, never lost). */
export const TAKEN_OUT_KEEP = 1000;

/**
 * `next` with what the change from `previous` took out noted in its
 * `takenOut`: every record made from a source windows share (a stableId: the
 * places and cast an agent run built, a breakdown's scenes, shots built from
 * boards, prepared variants) that `previous` held and `next` does not, at any
 * depth, in a list keyed as the merge keys it. A window that made the same
 * records from a stale copy then leaves them out when it merges, as this
 * one did (MergeOptions.takenOut) — and one that never took them out keeps
 * them. `next` itself when the change took nothing of the kind out.
 */
export function noteTakenOut<T extends object>(previous: T, next: T): T {
  if (previous === next) return next;
  const found = new Set<string>();
  const walk = (before: unknown, after: unknown) => {
    if (before === after) return;
    if (Array.isArray(before)) {
      const later = Array.isArray(after) ? after : [];
      const key = identityKey(before, later);
      if (!key) return;
      const id = (item: unknown) => String((item as Row)[key]);
      if (new Set(before.map(id)).size !== before.length) return;
      const now = new Map(later.map((item) => [id(item), item]));
      for (const item of before) {
        const still = now.get(id(item));
        if (still !== undefined) walk(item, still);
        else if (isStableId(id(item))) found.add(id(item));
      }
      return;
    }
    if (isRow(before)) {
      const later = isRow(after) ? after : undefined;
      for (const key of Object.keys(before)) if (key !== "takenOut") walk(before[key], later && has(later, key) ? later[key] : undefined);
    }
  };
  walk(previous, next);
  if (!found.size) return next;
  const noted = (next as { takenOut?: string[] }).takenOut ?? [];
  return { ...next, takenOut: [...noted.filter((id) => !found.has(id)), ...found].slice(-TAKEN_OUT_KEEP) };
}

/**
 * The local draft once the server holds `saved` for the draft `sent`: edits
 * made while the request was out (`local` moved on from `sent`) are laid over
 * `saved` rather than lost; with none, the draft is exactly `saved`.
 */
export function rebaseDraft<T>(sent: T, local: T, saved: T): T {
  return local === sent ? saved : merge3(sent, local, saved);
}
