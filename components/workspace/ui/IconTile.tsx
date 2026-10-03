import type { LucideIcon } from "lucide-react";

/** Tile tints (accent, done, waiting, purple), cycled by group or card index. */
export const TILE = [
  { bg: "var(--gx-tint-10)", border: "var(--gx-tint-border)", glyph: "var(--gx-accent-text)" },
  { bg: "var(--gx-done-tint)", border: "color-mix(in srgb, var(--gx-done) 35%, transparent)", glyph: "var(--gx-done-text)" },
  { bg: "color-mix(in srgb, var(--gx-waiting) 14%, transparent)", border: "color-mix(in srgb, var(--gx-waiting) 35%, transparent)", glyph: "var(--gx-waiting-text)" },
  { bg: "color-mix(in srgb, var(--gx-purple) 14%, transparent)", border: "color-mix(in srgb, var(--gx-purple) 35%, transparent)", glyph: "var(--gx-purple)" },
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
