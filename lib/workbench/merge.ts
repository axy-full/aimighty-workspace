/**
 * Three-way merge of a project draft: merge3(base, mine, theirs), over JSON values.
 * `base` is the draft as last read from or confirmed by the server, `mine` the
 * local draft built on it, `theirs` the newer version another save produced.
 *
 *  - A side that left a value as it was in base takes the other side's value.
 *  - Objects merge key by key; a key one side deleted stays deleted only if the
 *    other side left it unchanged.
 *  - Lists of records merge by id (a string `id`; failing that the `genId`,
 *    `jobId` or `assetId` takes, pending renders and plates are keyed by):
 *    mine's order, then what theirs added in theirs' order — unless only theirs
 *    moved records (mine kept base's order), when theirs' order leads and what
 *    mine added follows. A record one side removed goes only if the other side
 *    left it unchanged. An id never appears twice.
 *  - Lists of distinct strings (a node's links, an asset's refs) merge the same
 *    way, as sets: both sides' additions are kept, both sides' removals hold.
 *  - Anything else both sides changed (a scalar, a list of numbers): mine wins.
 *
 * Nothing either side added or changed is dropped, and merging again with the
 * result — merge3(base, mine, merge3(base, mine, theirs)) — changes nothing,
 * which is what makes a save whose reply was lost safe to reconcile.
 */

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => value !== null && typeof value === "object" && !Array.isArray(value);
/** A key holding `undefined` is absent, as it is once the draft is JSON. */
const has = (row: Row, key: string) => row[key] !== undefined;

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

export function merge3<T>(base: T | undefined, mine: T, theirs: T): T {
  return mergeValue(base, mine, theirs) as T;
}

function mergeValue(base: unknown, mine: unknown, theirs: unknown): unknown {
  if (sameJson(mine, base)) return theirs;
  if (sameJson(theirs, base)) return mine;
  if (sameJson(mine, theirs)) return mine;
  if (isRow(mine) && isRow(theirs)) return mergeRows(isRow(base) ? base : undefined, mine, theirs);
  if (Array.isArray(mine) && Array.isArray(theirs)) {
    const list = Array.isArray(base) ? base : [];
    if (distinctStrings(list, mine, theirs)) return mergeStrings(list as string[], mine as string[], theirs as string[]);
    const key = identityKey(list, mine, theirs);
    if (key) return mergeById(key, list, mine, theirs);
  }
  return mine;
}

function mergeRows(base: Row | undefined, mine: Row, theirs: Row): Row {
  const out: Row = {};
  for (const key of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
    const inMine = has(mine, key), inTheirs = has(theirs, key);
    if (!inMine && !inTheirs) continue;
    const before = base && has(base, key) ? base[key] : undefined;
    if (inMine && inTheirs) out[key] = mergeValue(before, mine[key], theirs[key]);
    else {
      const kept = inMine ? mine[key] : theirs[key];
      /* One side lacks it: added by the other (no base), or deleted by this one, which stands only over an unchanged value. */
      if (before === undefined || !sameJson(kept, before)) out[key] = kept;
    }
  }
  return out;
}

/** Lists of strings, each list without repeats: a set of ids or names. */
function distinctStrings(...lists: unknown[][]): boolean {
  return lists.every((list) => list.every((item) => typeof item === "string") && new Set(list).size === list.length);
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

/** The field a list of records is keyed by, or null for a list that is not one. */
function identityKey(...lists: unknown[][]): string | null {
  const items = lists.flat();
  if (!items.length || !items.every(isRow)) return null;
  for (const key of IDENTITIES) {
    if (!items.every((item) => typeof (item as Row)[key] === "string" && (item as Row)[key] !== "")) continue;
    /* `id` is the identity: a repeated one collapses. The others key a list only where each value is unique. */
    if (key === "id" || lists.every((list) => new Set(list.map((item) => (item as Row)[key])).size === list.length)) return key;
  }
  return null;
}

function mergeById(key: string, base: unknown[], mine: unknown[], theirs: unknown[]): unknown[] {
  const index = (list: unknown[]) => {
    const byId = new Map<string, Row>();
    for (const item of list) {
      const id = (item as Row)[key] as string;
      if (!byId.has(id)) byId.set(id, item as Row);
    }
    return byId;
  };
  const before = index(base), ours = index(mine), others = index(theirs);
  const flip = theirsLead([...before.keys()], [...ours.keys()], [...others.keys()]);
  const [lead, follow] = flip ? [others, ours] : [ours, others];
  const out: unknown[] = [];
  for (const [id, item] of lead) {
    const other = follow.get(id), was = before.get(id);
    if (other) out.push(flip ? mergeValue(was, other, item) : mergeValue(was, item, other));
    /* The other side removed it: gone only if this side left it as it was. */
    else if (!was || !sameJson(item, was)) out.push(item);
  }
  for (const [id, item] of follow) {
    if (lead.has(id)) continue;
    const was = before.get(id);
    /* Added by the other side, or removed by the leading side but changed by the other: kept. */
    if (!was || !sameJson(item, was)) out.push(item);
  }
  return out;
}

/**
 * The local draft once the server holds `saved` for the draft `sent`: edits
 * made while the request was out (`local` moved on from `sent`) are laid over
 * `saved` rather than lost; with none, the draft is exactly `saved`.
 */
export function rebaseDraft<T>(sent: T, local: T, saved: T): T {
  return local === sent ? saved : merge3(sent, local, saved);
}
