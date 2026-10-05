"use client";
import type { LibraryEntry, ProjectLibrary } from "@/lib/workspace/library";
import type { Project } from "@/lib/workbench/studio";
import type { BoardKindId } from "@/lib/shell/screens";

/**
 * The board's entry (stream 3): `?view=board`, for Studio, Ads and Social alike. STUB seeded by the shell (stream 1);
 * stream 3 replaces this file with BoardView and flips `landed` in lib/board/routes.ts. Never mounted while `landed` is
 * false: the address opens today's page for it instead.
 */
export type BoardViewProps = {
  scope: string;
  project: Project | null;
  items: readonly LibraryEntry[];
  library: ProjectLibrary;
  /** `kind=` from the address; null when it names none, and the project's own kind is used. */
  kind: BoardKindId | null;
  /** A design frame letter from a design or old link, or null. */
  frame: string | null;
  /** `region=` from an old Studio stage link, or null. */
  region?: string | null;
};

export function BoardView(props: BoardViewProps) {
  void props;
  return null;
}
