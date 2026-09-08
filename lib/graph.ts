/**
 * Laying a recipe out as a graph (brief 3, surface 1d).
 *
 * The handoff draws its example at fixed coordinates — Brief at 16,196 and
 * Motion at 560,196 — because it is one production drawn once. A real recipe
 * has whatever shape its author gave it, so the positions are computed and
 * the handoff's numbers become the grid they are computed on: nodes 126 wide,
 * 136 apart across, 176 apart down, the locked band at y 28 and the main row
 * at y 196.
 *
 * Two things decide where a stage sits.
 *
 *   ACROSS: how far it is from the start. A stage sits one column right of
 *   the furthest of the stages feeding it, so a wire never points backwards
 *   and the eye reads the recipe left to right the way the work happens.
 *
 *   DOWN: which branch it is on. Everything is on the main line until two
 *   stages want the same column, and the later one drops a row. That is how
 *   Audio ends up under Motion in the handoff's own drawing, and it falls out
 *   of the shape rather than being placed by hand.
 *
 * Pure: no database, no DOM, no clock.
 */

export const NODE_W = 126;
export const NODE_H = 68;
export const COL = 136;      /* 126 wide plus a 10px gutter */
export const ROW = 176;
export const BAND_Y = 28;    /* the locked elements */
export const MAIN_Y = 196;   /* the first row of stages */
export const PAD_X = 16;

export type StageIn = {
  id: string;
  num: number;
  name: string;
  /** Ids of the stages feeding this one. */
  inputs: string[];
  position: number;
};

export type Placed = StageIn & { x: number; y: number; col: number; row: number };

/**
 * How far each stage is from the start.
 *
 * A cycle would make this non-terminating, so the walk carries the path it
 * came by and refuses to re-enter it: a recipe that feeds itself lays out as
 * though the offending edge were not there, which draws something wrong-ish
 * rather than hanging the screen.
 */
export function depths(stages: StageIn[]): Map<string, number> {
  const byId = new Map(stages.map((s) => [s.id, s]));
  const out = new Map<string, number>();

  const walk = (id: string, seen: Set<string>): number => {
    const found = out.get(id);
    if (found !== undefined) return found;
    const stage = byId.get(id);
    if (!stage || seen.has(id)) return 0;
    const next = new Set(seen).add(id);
    const feeders = stage.inputs.filter((i) => byId.has(i) && !next.has(i));
    const d = feeders.length ? Math.max(...feeders.map((i) => walk(i, next))) + 1 : 0;
    out.set(id, d);
    return d;
  };

  for (const s of stages) walk(s.id, new Set());
  return out;
}

/**
 * Every stage placed on the grid.
 *
 * Within a column the order is the author's own `position`, so two stages
 * that could sit in either order sit in the order the recipe lists them
 * rather than in whatever order the rows came back.
 */
export function layout(stages: StageIn[]): Placed[] {
  const d = depths(stages);
  const byCol = new Map<number, StageIn[]>();
  for (const s of stages) {
    const col = d.get(s.id) ?? 0;
    const list = byCol.get(col);
    if (list) list.push(s); else byCol.set(col, [s]);
  }

  const out: Placed[] = [];
  for (const [col, list] of byCol) {
    list.sort((a, b) => a.position - b.position || a.num - b.num);
    list.forEach((s, row) => {
      out.push({ ...s, col, row, x: PAD_X + col * COL, y: MAIN_Y + row * ROW });
    });
  }
  return out.sort((a, b) => a.col - b.col || a.row - b.row);
}

/** The locked elements, spread along the band above the first row. */
export function bandLayout(count: number, startCol = 1): { x: number; y: number }[] {
  return Array.from({ length: count }, (_, i) => ({ x: PAD_X + (startCol + i) * COL, y: BAND_Y }));
}

/** How big the graph has to be to hold what was placed. */
export function extent(placed: Placed[], band: { x: number; y: number }[] = []): { w: number; h: number } {
  const xs = [...placed.map((p) => p.x), ...band.map((b) => b.x)];
  const ys = [...placed.map((p) => p.y), ...band.map((b) => b.y)];
  if (!xs.length) return { w: 860, h: 530 };
  return {
    w: Math.max(...xs) + NODE_W + PAD_X,
    h: Math.max(...ys) + NODE_H + PAD_X + 40,
  };
}

/* ── Wires ───────────────────────────────────────────────────────────────
   A wire leaves the right edge of what feeds it and lands on the left edge
   of what it feeds, and it is drawn as a curve rather than a corner so two
   wires crossing read as two wires rather than one shape. A wire from the
   locked band drops instead, so a pinned element reads as something coming
   down onto a stage rather than along into it. */

export type Wire = { from: string; to: string; d: string; dashed: boolean };

const rightEdge = (p: { x: number; y: number }) => ({ x: p.x + NODE_W, y: p.y + NODE_H / 2 });
const leftEdge = (p: { x: number; y: number }) => ({ x: p.x, y: p.y + NODE_H / 2 });

export function wirePath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const from = rightEdge(a);
  const to = leftEdge(b);
  const bend = Math.max(18, Math.min(60, (to.x - from.x) / 2));
  return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
}

/** A locked element drops onto the top edge of the stage that cites it. */
export function dropPath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const from = { x: a.x + NODE_W / 2, y: a.y + NODE_H };
  const to = { x: b.x + NODE_W / 2, y: b.y };
  const mid = from.y + (to.y - from.y) / 2;
  return `M ${from.x} ${from.y} C ${from.x} ${mid}, ${to.x} ${mid}, ${to.x} ${to.y}`;
}

export function wiresOf(placed: Placed[]): Wire[] {
  const at = new Map(placed.map((p) => [p.id, p]));
  const out: Wire[] = [];
  for (const p of placed) {
    for (const input of p.inputs) {
      const from = at.get(input);
      if (!from) continue;
      out.push({ from: input, to: p.id, d: wirePath(from, p), dashed: false });
    }
  }
  return out;
}

/** "8 stages · 3 locked · 1 branch" — the toolbar's own count. */
export function shapeLine(placed: Placed[], locked: number): string {
  const branches = Math.max(0, new Set(placed.filter((p) => p.row > 0).map((p) => p.col)).size);
  const parts = [`${placed.length} stage${placed.length === 1 ? "" : "s"}`];
  if (locked) parts.push(`${locked} locked`);
  parts.push(`${branches} branch${branches === 1 ? "" : "es"}`);
  return parts.join(" · ").toUpperCase();
}
