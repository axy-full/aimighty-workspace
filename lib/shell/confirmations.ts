import { shellPage, type ShellSuiteId } from "./ia";
import { isStageId, stageAddress, stagePlace } from "./stage-redirects";

/**
 * Confirmations that say what was done and where it is (idea 18). Pure: the
 * words of each toast, and the one place it opens — a page of the shell, a place on the board (the Studio stage ids
 * stand for the board's regions, lib/shell/stage-redirects.ts), Gen (Make's panel, over the page) or the Library. A toast
 * names its destination by the name that place goes by on screen, so "Added to the Board" opens the board and nothing else.
 */
export type Destination =
  | { to: "page"; suite: ShellSuiteId; page: string; /** What to select once there: a Rig shot or a take. */ select?: { kind: "shot" | "take"; id: string } }
  | { to: "gen" }
  | { to: "library" };

export type Confirmation = { text: string; open?: Destination };

/** The name a destination goes by on screen: the board's place for a Studio stage, the strip's label for another page, Gen, or Library. */
export function destinationName(d: Destination): string {
  if (d.to === "gen") return "Gen";
  if (d.to === "library") return "Library";
  if (d.suite === "studio" && isStageId(d.page)) return stagePlace(d.page);
  const page = shellPage(d.suite, d.page);
  if (!page || page.phoneOnly) throw new Error(`No stage ${d.suite}:${d.page}`);
  return page.label;
}
export const openLabel = (d: Destination) => `Open ${destinationName(d)}`;

/** The board address a Studio stage destination opens (null for a destination that is another suite's page). */
export function boardPlace(d: Extract<Destination, { to: "page" }>): string | null {
  return d.suite === "studio" && isStageId(d.page) ? stageAddress(d.page) : null;
}

/**
 * Where the person is: the shell view, its suite and page, whether Make's panel is open over it, and whether the Library's assets are
 * already on screen. On the Studio board, `board` is the address the board is at (`?view=board&region=cast`), so a toast whose Open is
 * the place the person is looking at carries none.
 */
export type Here = { view: "suite" | "gen" | "workspace" | "crew"; suite: ShellSuiteId; page: string; make?: boolean; library: boolean; board?: string | null };

/** A toast shown where its result already is carries no Open. */
export function isHere(d: Destination, here: Here): boolean {
  if (d.to === "gen") return Boolean(here.make);
  if (d.to === "library") return here.library;
  if (d.select) return false;
  const board = boardPlace(d);
  if (board) return here.board === board;
  return here.view === "suite" && here.suite === d.suite && here.page === d.page;
}

const page = (suite: ShellSuiteId, id: string, select?: { kind: "shot" | "take"; id: string }): Destination => ({ to: "page", suite, page: id, ...(select ? { select } : {}) });

export const CONFIRM = {
  /** Crew › → Brief appends the solution to the saved Brief. */
  crewBrief: (): Confirmation => ({ text: "Added to the Brief", open: page("studio", "brief") }),
  /** Crew › → Board writes a draft scene node on the board (not a Storyboard frame, which comes from the beat sheet). */
  crewRig: (title: string, nodeId?: string): Confirmation => ({ text: `Added to the Board · ${title}`, open: page("studio", "rig", nodeId ? { kind: "shot", id: nodeId } : undefined) }),
  /** Crew › Open in Gen puts the solution in Gen's prompt; nothing is copied or written. */
  crewGen: (): Confirmation => ({ text: "The solution is Gen’s prompt", open: { to: "gen" } }),
  /** Crew › File minutes: the markdown is stored in this project's Library. */
  minutesFiled: (): Confirmation => ({ text: "Minutes filed in the Library", open: { to: "library" } }),
  /** Business › a finished take opens in Shots, selected. */
  take: (generationId: string): Destination => page("studio", "takes", { kind: "take", id: `generation:${generationId}` }),
};

/** A Crew solution's line once it has gone somewhere — where it went, in the destination's own name. */
export function solutionStatusLabel(status: "open" | "sent_to_brief" | "boarded" | "generated"): string | null {
  if (status === "sent_to_brief") return `Added to the ${destinationName(page("studio", "brief"))}`;
  if (status === "boarded") return `Added to the ${destinationName(page("studio", "rig"))}`;
  if (status === "generated") return `Opened in ${destinationName({ to: "gen" })}`;
  return null;
}
