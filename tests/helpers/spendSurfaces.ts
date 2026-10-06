import { scanSpend, type SpendReport } from "./spendScan";

/**
 * The D0 surfaces where every spending control must carry a price (owner's D0 review, items 5 to 9, 13): the Make panel and quick
 * tools, the model sheet, Make › Recent, the right-click menu, and the board's paid actions. A file belongs to the first surface
 * that claims it, and to the dated ratchet when none does. The path patterns include the directories the new design adds, so new
 * files there are strict from the first commit whether or not the directory exists yet.
 */
export type SpendSurface = { id: string; name: string; claims: (path: string) => boolean };

const is = (path: string, names: string[]) => names.includes(path);

export const SPEND_SURFACES: SpendSurface[] = [
  { id: "recent", name: "Make › Recent (take cards: Again, Use as reference, Release)", claims: (p) => is(p, ["components/graphite/TakeTile.tsx", "components/graphite/TakeStrip.tsx", "components/graphite/DraftFinal.tsx", "components/graphite/ReleaseTake.tsx", "components/make/UnfiledWall.tsx"]) },
  { id: "model-sheet", name: "the model sheet", claims: (p) => p === "components/graphite/ModelSheet.tsx" },
  { id: "context-menu", name: "the right-click menu", claims: (p) => p === "components/graphite/ContextMenu.tsx" || p.startsWith("components/graphite/context/") },
  { id: "board", name: "the board's paid actions", claims: (p) => p.startsWith("components/graphite/board/") },
  {
    id: "make", name: "the Make panel and quick tools (Motion transfer, Object swap, Edit, upscale)",
    /* GenView is the Gen page that the Make panel (#512) replaces; the viral view hosts the quick tools until #514 moves them into Make. */
    claims: (p) => is(p, ["components/graphite/MakePanel.tsx", "components/graphite/GenView.tsx", "components/graphite/viral/ViralView.tsx"]) || p.startsWith("components/graphite/make/") || p.startsWith("components/make/"),
  },
];

export const spendSurfaceOf = (path: string): SpendSurface | null => SPEND_SURFACES.find((surface) => surface.claims(path)) ?? null;

/**
 * The gaps per file: 1 when the file reaches a paid route and carries no opt-in, plus one for each button labelled with a spend
 * verb that carries none.
 */
export function gapsByFile(report: SpendReport): Record<string, number> {
  const gaps: Record<string, number> = {};
  for (const site of report.sites) if (!site.optedIn) gaps[site.path] = (gaps[site.path] ?? 0) + 1;
  for (const label of report.labels) gaps[label.path] = (gaps[label.path] ?? 0) + 1;
  return gaps;
}

export const currentGaps = () => gapsByFile(scanSpend());
