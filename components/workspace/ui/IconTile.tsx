import type { LucideIcon } from "lucide-react";

/** Tile tints from the prototype, cycled by group or card index. */
export const TILE = [
  { bg: "rgba(10,132,255,.1)", border: "rgba(10,132,255,.26)", glyph: "#4DA3FF" },
  { bg: "rgba(52,199,89,.09)", border: "rgba(52,199,89,.24)", glyph: "#34C759" },
  { bg: "rgba(240,178,62,.09)", border: "rgba(240,178,62,.24)", glyph: "#E0B95E" },
  { bg: "rgba(212,140,245,.08)", border: "rgba(212,140,245,.22)", glyph: "#C89AE8" },
] as const;

/** 30px on cards, 32px in the Library; radius 9, 1px tinted border, 15px glyph. */
export function IconTile({ icon: Icon, size = 32, tint = 0 }: { icon: LucideIcon; size?: 30 | 32; tint?: number }) {
  const t = TILE[((tint % TILE.length) + TILE.length) % TILE.length];
  return (
    <span className="pxw-tile" aria-hidden="true" style={{ width: size, height: size, background: t.bg, borderColor: t.border, color: t.glyph }}>
      <Icon size={15} strokeWidth={1.6} />
    </span>
  );
}
