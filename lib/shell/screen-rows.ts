/**
 * Address rows for the screen registry (lib/shell/screens.ts): pure, with no imports, so every stream's routing
 * module and the unit specs can use it.
 *
 * A row is a pair of searches. `from` matches as a SUBSET of the address (every param it names must be there with
 * that value); `to` replaces those params; every other param rides along. Where several rows match, the most
 * specific (the most params in `from`) wins, and the first declared wins a tie.
 */
export type Row = { from: string; to: string };

/** The shell's old position in a suite: the page's sub-params go with it when the page does. */
const SUBPAGE = ["sp", "rig", "beats"] as const;

const keysOf = (search: string): string[] => [...new URLSearchParams(search).keys()];

/** The most specific row `search` matches, or null. */
export function matchRow(search: string, rows: readonly Row[]): Row | null {
  const q = new URLSearchParams(search);
  let best: { row: Row; weight: number } | null = null;
  for (const row of rows) {
    const from = new URLSearchParams(row.from);
    let hit = true;
    for (const [key, value] of from) if (q.get(key) !== value) { hit = false; break; }
    if (!hit) continue;
    const weight = keysOf(row.from).length;
    if (!best || weight > best.weight) best = { row, weight };
  }
  return best?.row ?? null;
}

/**
 * `search` with the most specific matching row applied, or null when none matches. `drop` names params that belong
 * to the address being left (a fallback row leaves a new screen: its own params go with it); each is removed unless
 * the row's `to` sets it. When a row leaves a suite page (`page` is in `from`), the page's sub-params (`sp`, `rig`,
 * `beats`) leave with it, so an old `…&sp=brief` does not ride into a screen that has no such thing.
 */
export function applyRows(search: string, rows: readonly Row[], drop: readonly string[] = []): string | null {
  const row = matchRow(search, rows);
  if (!row) return null;
  const q = new URLSearchParams(search);
  const to = new URLSearchParams(row.to);
  const from = new URLSearchParams(row.from);
  for (const key of from.keys()) q.delete(key);
  if (from.has("page")) for (const key of SUBPAGE) if (!to.has(key)) q.delete(key);
  for (const key of drop) if (!to.has(key)) q.delete(key);
  for (const [key, value] of to) q.set(key, value);
  const text = q.toString();
  return text ? `?${text}` : "";
}
