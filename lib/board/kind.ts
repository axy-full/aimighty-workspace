import type { Project } from "@/lib/workbench/studio";
import type { BoardKind } from "./types";

/*
 * Which board a project opens on (README § 1: Studio, Ads and Social are templates picked on Home; a project's board
 * looks the same whichever started it). Kept as `boardKind` in the project draft (lead decision 26), written when a
 * template makes the project (stream 2). A project from before it is read from its data: an Ads project carries the
 * marketing brief; anything else opens as Studio.
 */
export function boardKindOf(project: Pick<Project, "boardKind" | "marketingBrief" | "moleculr"> | null | undefined): BoardKind {
  if (!project) return "studio";
  if (project.boardKind) return project.boardKind;
  return project.marketingBrief || project.moleculr ? "ads" : "studio";
}

export type BoardTemplate = { id: "film" | "ad" | "social" | "script"; name: string; kind: BoardKind; icon: string };
/** The four templates (README § 3.1 frame a; Home's, stream 2): Film and Start from a script open a Studio board. */
export const BOARD_TEMPLATES: readonly BoardTemplate[] = [
  { id: "film", name: "Film", kind: "studio", icon: "M2 4h12v8H2zM2 7h12M5 4v8" },
  { id: "ad", name: "Ad campaign", kind: "ads", icon: "M2 8.5V2.5h6L14 8.5 8.5 14zM5.2 5.2h.01" },
  { id: "social", name: "Social clips", kind: "social", icon: "M2 4h8v8H2zM10 7l4-2v6l-4-2" },
  { id: "script", name: "Start from a script", kind: "studio", icon: "M4 2h6l3 3v9H4zM10 2v3h3M6 8h4M6 11h4" },
];
