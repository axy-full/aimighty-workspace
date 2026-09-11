/**
 * The four items (design/particl-v2/README.md §1): Make · Productions · Rig
 * · Library. Usage and Settings live in the account menu, and nowhere else.
 *
 * Each item's destination is its v2 route once that step has landed (§0);
 * until then it goes to the old route it replaces, and this table is the
 * one place that changes when a route is deleted. `match` decides which
 * item is lit for a path — the old routes are listed under the item that
 * replaces them, so the nav is right on every screen, old or new.
 */
export type NavItem = {
  label: "Make" | "Productions" | "Rig" | "Library";
  /** Where the item goes. `production` is the current production's id, if there is one. */
  href: (ctx: { production: string | null }) => string;
  match: (path: string) => boolean;
};

const starts = (path: string, ...prefixes: string[]) => prefixes.some((p) => path === p || path.startsWith(`${p}/`));

export const NAV: readonly NavItem[] = [
  {
    label: "Make",
    href: () => "/make/video",
    match: (p) => p === "/" || starts(p, "/generate", "/images", "/audio", "/make"),
  },
  {
    label: "Productions",
    href: () => "/productions",
    match: (p) => starts(p, "/projects", "/productions", "/shots", "/takes", "/canvas", "/dashboard") && !p.includes("/rig"),
  },
  {
    label: "Rig",
    href: ({ production }) => (production ? `/rig/canvas/new?project=${encodeURIComponent(production)}` : "/productions"),
    match: (p) => starts(p, "/rig", "/elements") || p.includes("/rig"),
  },
  {
    label: "Library",
    href: () => "/library",
    match: (p) => starts(p, "/library", "/studio", "/all"),
  },
];

/** The phone's dock (design/particl-v2-mobile/README.md, board M1): `Make · PRODS · Rig · Library` — the four nav items, Productions written short. */
export const DOCK: readonly { label: NavItem["label"]; short: string; href: NavItem["href"]; match: (path: string) => boolean }[] = NAV.map((n) => ({
  label: n.label, short: n.label === "Productions" ? "Prods" : n.label, href: n.href, match: n.match,
}));
