import type { BoardBox, BoardPoint, CardSize, RegionId } from "./types";

/*
 * Where every card sits on the board (design/particl-graphite/README.md
 * § 3.1, the master's board): regions are bands, top to bottom in production
 * order; a band's cards and groups sit side by side, wrapping; a group's
 * cards are laid out inside it in columns, and its size comes from them. A
 * free card (a note, a label, an upload) stays where it was saved.
 *
 * Pure and deterministic: the same cards give the same places in every
 * window, and on the server, where S1's Tidy may call it later. Opening a
 * board writes nothing: arranged places are computed, never saved.
 *
 * The band area sits left of x = 0, so content an old Rig board placed (at
 * x ≥ 0) never lies under it.
 */

/** The dot grid's pitch (README § 2: 24 px). Free cards snap to it. */
export const BOARD_DOTS = 24;
/** The band area: as wide as the master's board (its groups are 996 wide inside a 1044 board). */
export const BAND_WIDTH = 1008;
export const BAND_LEFT = -1080;
export const BAND_TOP = 48;
/** Between two bands: room for the next group's label, which sits on its top border. */
export const BAND_GAP = 56;
/** Between two items side by side in a band, or two rows of them. */
export const ITEM_GAP = 24;
/** How far up the region an empty section's glide target reaches. */
const EMPTY_SLOT_H = 240;

export type ContainerSpec = {
  columns: number;
  gap?: number;
  pad?: { top: number; right: number; bottom: number; left: number };
  /** Stretch to the rest of the band when it is the band's last item (the master's full-width frames). */
  fill?: boolean;
};

/** The group frame's default padding: room for the label on its top border, and the master's 24 px insets. */
export const GROUP_PAD = { top: 24, right: 24, bottom: 24, left: 24 } as const;
export const GROUP_GAP = 14;

export type LayoutItem = {
  id: string;
  region: RegionId | null;
  order: number;
  group?: string;
  /** A free card's saved place. */
  at?: BoardPoint;
  size: CardSize;
  container?: ContainerSpec;
};

export type BoardLayout = {
  /** Every card's box, children included, in board units. */
  boxes: Map<string, BoardBox>;
  /** Each region's box: the union of its cards' boxes. */
  regions: Map<RegionId, BoardBox>;
  /** Where a region with no cards would start: what its rail entry glides to. */
  slots: Map<RegionId, BoardBox>;
  /** Everything on the board. */
  bounds: BoardBox | null;
  /** The arranged cards only (the first view fits these). */
  arranged: BoardBox | null;
};

const byOrder = (a: LayoutItem, b: LayoutItem) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function union(a: BoardBox | null, b: BoardBox): BoardBox {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** A group's children placed inside it (relative to its top-left), and its own size. */
function packGroup(group: LayoutItem, children: LayoutItem[]): { size: CardSize; places: Map<string, BoardPoint> } {
  const spec = group.container!;
  const pad = spec.pad ?? GROUP_PAD, gap = spec.gap ?? GROUP_GAP;
  const columns = Math.max(1, Math.floor(spec.columns));
  const places = new Map<string, BoardPoint>();
  if (!children.length) return { size: { w: Math.max(group.size.w, pad.left + pad.right), h: Math.max(group.size.h, pad.top + pad.bottom) }, places };
  const colW = Math.max(...children.map((c) => c.size.w));
  const used = Math.min(columns, children.length);
  let y = pad.top;
  for (let start = 0; start < children.length; start += columns) {
    const row = children.slice(start, start + columns);
    row.forEach((child, i) => places.set(child.id, { x: pad.left + i * (colW + gap), y }));
    y += Math.max(...row.map((c) => c.size.h)) + gap;
  }
  return { size: { w: pad.left + used * colW + (used - 1) * gap + pad.right, h: y - gap + pad.bottom }, places };
}

export function layoutBoard(items: readonly LayoutItem[], bands: readonly (readonly RegionId[])[]): BoardLayout {
  const boxes = new Map<string, BoardBox>();
  const regions = new Map<RegionId, BoardBox>();
  const slots = new Map<RegionId, BoardBox>();
  let bounds: BoardBox | null = null, arranged: BoardBox | null = null;
  const regionOf = new Map<string, RegionId | null>(items.map((item) => [item.id, item.region]));
  const place = (id: string, box: BoardBox, isArranged: boolean) => {
    boxes.set(id, box);
    bounds = union(bounds, box);
    if (isArranged) arranged = union(arranged, box);
    const region = regionOf.get(id);
    if (region) regions.set(region, union(regions.get(region) ?? null, box));
  };

  /* Groups first: their children, and so their sizes. A card naming a group that is not on the board stands alone. */
  const groups = new Map(items.filter((item) => item.container && item.region).map((item) => [item.id, item]));
  const children = new Map<string, LayoutItem[]>();
  for (const item of items) {
    if (!item.group || item.group === item.id || !groups.has(item.group) || !item.region) continue;
    children.set(item.group, [...(children.get(item.group) ?? []), item]);
  }
  const packed = new Map([...groups.values()].map((group) => [group.id, packGroup(group, (children.get(group.id) ?? []).sort(byOrder))]));
  const nested = new Set([...children.values()].flat().map((child) => child.id));

  /* Bands, top to bottom: the arranged cards and groups that are not inside a group. */
  const bandOf = new Map<RegionId, number>();
  bands.forEach((band, i) => band.forEach((region) => bandOf.set(region, i)));
  const top = items.filter((item) => item.region && !nested.has(item.id) && bandOf.has(item.region));
  let y = BAND_TOP;
  bands.forEach((band, bi) => {
    const rank = (r: RegionId | null) => (r ? band.indexOf(r) : -1);
    const here = top.filter((item) => bandOf.get(item.region!) === bi).sort((a, b) => rank(a.region) - rank(b.region) || byOrder(a, b));
    if (!here.length) {
      for (const region of band) slots.set(region, { x: BAND_LEFT, y, w: BAND_WIDTH, h: EMPTY_SLOT_H });
      return;
    }
    let x = BAND_LEFT, rowH = 0, rowTop = y;
    here.forEach((item, i) => {
      const own = packed.get(item.id);
      let size = own ? own.size : item.size;
      if (x > BAND_LEFT && x + size.w > BAND_LEFT + BAND_WIDTH) { x = BAND_LEFT; rowTop += rowH + ITEM_GAP; rowH = 0; }
      if (own && item.container?.fill && i === here.length - 1) size = { ...size, w: Math.max(size.w, BAND_LEFT + BAND_WIDTH - x) };
      place(item.id, { x, y: rowTop, w: size.w, h: size.h }, true);
      for (const child of own ? children.get(item.id) ?? [] : []) {
        const at = own!.places.get(child.id)!;
        place(child.id, { x: x + at.x, y: rowTop + at.y, w: child.size.w, h: child.size.h }, true);
      }
      x += size.w + ITEM_GAP;
      rowH = Math.max(rowH, size.h);
    });
    for (const region of band) if (!regions.has(region)) slots.set(region, { x: BAND_LEFT, y, w: BAND_WIDTH, h: EMPTY_SLOT_H });
    y = rowTop + rowH + BAND_GAP;
  });

  /* Free cards where they were saved; an arranged card whose region has no band, after the last band. */
  let spare = y;
  for (const item of items) {
    if (boxes.has(item.id)) continue;
    if (item.at && !item.region) { place(item.id, { x: item.at.x, y: item.at.y, ...item.size }, false); continue; }
    if (nested.has(item.id)) continue;
    place(item.id, { x: BAND_LEFT, y: spare, w: item.size.w, h: item.size.h }, true);
    spare += item.size.h + ITEM_GAP;
  }
  return { boxes, regions, slots, bounds, arranged };
}

/** The nearest dot to a value (never -0). */
export function snapToDots(value: number): number {
  const snapped = Math.round(value / BOARD_DOTS) * BOARD_DOTS;
  return snapped === 0 ? 0 : snapped;
}
