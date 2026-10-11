/**
 * What Studio's first run and Home share: the four steps of a first production, and the saved-time reading of a project list.
 * Pure. (The Studio overview's stage cards, suite tiles and Running list went with the overview and the phone's old Home.)
 */
import type { ProjectSummary } from "@/lib/workspace/data";

/**
 * Studio's first run (components/graphite/FirstRun): the four stages a
 * production moves through, in order, each a tap into its page.
 */
export const FIRST_RUN_STEPS: { id: "brief" | "beats" | "boards" | "takes"; label: string; line: string }[] = [
  { id: "brief", label: "Brief", line: "Write the idea and the script" },
  { id: "beats", label: "Beats", line: "Split it into scenes and shots" },
  { id: "boards", label: "Boards", line: "Frame every shot" },
  { id: "takes", label: "Takes", line: "Generate, then approve" },
];

/** When a project was last saved, as a time: the list route sends a number; older rows and fixtures an ISO date. */
export function savedAt(project: Pick<ProjectSummary, "updatedAt">): number | null {
  const value = project.updatedAt as unknown;
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== "string" || !value) return null;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/** The projects to offer beside the open one: most recently saved first, never the open one, at most `limit`. */
export function recentProjects(projects: readonly ProjectSummary[], openId: string | null, limit = 4): ProjectSummary[] {
  return projects
    .filter((p) => p.id !== openId)
    .map((p, i) => ({ p, i, at: savedAt(p) ?? 0 }))
    .sort((a, b) => b.at - a.at || a.i - b.i)
    .slice(0, Math.max(0, limit))
    .map(({ p }) => p);
}
