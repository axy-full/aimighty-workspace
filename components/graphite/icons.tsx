/**
 * The prototype's glyphs (Particl Suites.dc.html › ic), as React. Stroke
 * icons at 1.8, 24-unit box; the suite glyphs carry their suite's colour.
 */
export type GlyphName = "clap" | "tag" | "bolt" | "atom" | "crew" | "spark" | "search" | "panel" | "wrench" | "stack" | "chev" | "home" | "grid";

export function Glyph({ name, size = 16, color, className }: { name: GlyphName; size?: number; color?: string; className?: string }) {
  const p = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: color ?? "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, className, "aria-hidden": true, style: { display: "block" as const } };
  switch (name) {
    case "spark": return <svg {...p}><path d="M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z" /></svg>;
    case "search": return <svg {...p}><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></svg>;
    case "panel": return <svg {...p}><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M15 4v16" /></svg>;
    case "clap": return <svg {...p}><rect x="3" y="9" width="18" height="11" rx="2" /><path d="M3 9l2-4h14l2 4M8 5l2 4M13 5l2 4" /></svg>;
    case "tag": return <svg {...p}><path d="M3 12l9-9h9v9l-9 9z" /><circle cx="16" cy="8" r="1.4" fill={color ?? "currentColor"} stroke="none" /></svg>;
    case "bolt": return <svg {...p}><path d="M13 2L5 14h6l-1 8 9-13h-6z" /></svg>;
    case "atom": return <svg {...p}><circle cx="12" cy="12" r="1.6" fill={color ?? "currentColor"} stroke="none" /><ellipse cx="12" cy="12" rx="9" ry="3.6" /><ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(60 12 12)" /><ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(120 12 12)" /></svg>;
    /* Three agents around a chair (FINAL_SPEC §6 › Crew). */
    case "crew": return <svg {...p}><rect x="9" y="9" width="6" height="6" rx="1.5" /><circle cx="12" cy="3.5" r="1.8" /><circle cx="4.5" cy="17.5" r="1.8" /><circle cx="19.5" cy="17.5" r="1.8" /><path d="M12 5.5v3M6 16l3-2.2M18 16l-3-2.2" /></svg>;
    case "wrench": return <svg {...p}><path d="M14.5 6.5a4 4 0 0 0 4.9 4.9L21 13l-8 8-3-3 8-8-1.6-1.6z" /><path d="M3 5l4 4M4 4l3 1" /></svg>;
    case "stack": return <svg {...p}><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 13l9 5 9-5M3 17l9 5 9-5" /></svg>;
    case "chev": return <svg {...p}><path d="M9 6l6 6-6 6" /></svg>;
    /* The phone's Home and Suites tabs (Particl Mobile iOS 27.dc.html › tab bar). */
    case "home": return <svg {...p}><path d="M3 11l9-7 9 7" /><path d="M5 10v10h14V10" /><path d="M10 20v-6h4v6" /></svg>;
    case "grid": return <svg {...p}><rect x="3" y="3" width="7" height="7" rx="1.8" /><rect x="14" y="3" width="7" height="7" rx="1.8" /><rect x="3" y="14" width="7" height="7" rx="1.8" /><rect x="14" y="14" width="7" height="7" rx="1.8" /></svg>;
  }
}

/** Suite colours and glyphs (FINAL_SPEC §6 › Suite picker). Gen takes the violet of its aurora. */
export const SUITE_LOOK: Record<string, { color: string; glyph: GlyphName }> = {
  studio: { color: "#0A84FF", glyph: "clap" },
  gen: { color: "#BF5AF2", glyph: "spark" },
  business: { color: "#FF9F0A", glyph: "tag" },
  viral: { color: "#FF453A", glyph: "bolt" },
  atomik: { color: "#30D158", glyph: "atom" },
  crew: { color: "#BF5AF2", glyph: "crew" },
};
/** Library › Tools department colours cycle in this order. */
export const DEPT_COLORS = ["#0A84FF", "#BF5AF2", "#FF9F0A", "#30D158", "#64D2FF", "#FF453A"];
/** Kind dots on the asset filter chips; All is the three-stop gradient. */
export const KIND_DOT: Record<string, string> = { Images: "#0A84FF", Video: "#30D158", Audio: "#BF5AF2", Uploads: "#FF9F0A" };
/** A project's poster tint: the sample palette for the sample names, a stable pick otherwise. */
export function posterOf(name: string): { from: string; to: string; glow: string } {
  const sample: Record<string, [string, string, string]> = { "dune studies": ["#7A5A34", "#1A120B", "#F0B23E"], northline: ["#2E4A6A", "#0B1420", "#0A84FF"] };
  const known = sample[name.trim().toLowerCase()];
  if (known) return { from: known[0], to: known[1], glow: known[2] };
  if (!name.trim()) return { from: "#3A3A40", to: "#141416", glow: "#8E8E93" };
  const hue = [...name].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 360, 7);
  return { from: `hsl(${hue} 38% 34%)`, to: `hsl(${hue} 30% 9%)`, glow: `hsl(${hue} 80% 62%)` };
}
