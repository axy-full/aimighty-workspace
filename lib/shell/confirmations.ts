import { restorePage, shellPage, type ShellPage, type ShellSuiteId } from "./ia";

/**
 * Confirmations that say what was done and where it is (idea 18). Pure: the
 * words of each toast, and the one place it opens — a page of the shell, Gen
 * or the Library. A toast names its destination by the label that place goes
 * by on screen, so "Added to Rig" opens Rig and nothing else.
 */
export type Destination =
  | { to: "page"; suite: ShellSuiteId; page: string; /** What to select once there: a Rig shot or a take. */ select?: { kind: "shot" | "take"; id: string } }
  | { to: "gen" }
  | { to: "library" };

export type Confirmation = { text: string; open?: Destination };

/** The name a destination goes by on screen: the stage strip's label, Gen, or Library. */
export function destinationName(d: Destination): string {
  if (d.to === "gen") return "Gen";
  if (d.to === "library") return "Library";
  const page = shellPage(d.suite, d.page);
  if (!page || page.phoneOnly) throw new Error(`No stage ${d.suite}:${d.page}`);
  return page.label;
}
export const openLabel = (d: Destination) => `Open ${destinationName(d)}`;

/** The stage an Open actually shows: the page `goSuite` restores for it (a page id it does not know falls back to the suite's first). */
export function landingPage(d: Extract<Destination, { to: "page" }>): ShellPage {
  return restorePage(d.suite, d.page);
}

/** Where the person is: the shell view, its suite and page, and whether the Library's assets are already on screen. */
export type Here = { view: "suite" | "gen" | "workspace" | "crew"; suite: ShellSuiteId; page: string; library: boolean };

/** A toast shown where its result already is carries no Open. */
export function isHere(d: Destination, here: Here): boolean {
  if (d.to === "gen") return here.view === "gen";
  if (d.to === "library") return here.library;
  return here.view === "suite" && here.suite === d.suite && here.page === d.page && !d.select;
}

const page = (suite: ShellSuiteId, id: string, select?: { kind: "shot" | "take"; id: string }): Destination => ({ to: "page", suite, page: id, ...(select ? { select } : {}) });
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What the agent's cast list actually changed: the entries added, names already listed, and those past the list's limit. */
export type CastTaken = { added: number; known: number; overLimit: number };

export const CONFIRM = {
  /** Crew › → Brief appends the solution to the saved Brief. */
  crewBrief: (): Confirmation => ({ text: "Added to the Brief", open: page("studio", "brief") }),
  /** Crew › → Rig writes a draft scene node on the Rig (not a Storyboards frame, which comes from the beat sheet). */
  crewRig: (title: string, nodeId?: string): Confirmation => ({ text: `Added to Rig · ${title}`, open: page("studio", "rig", nodeId ? { kind: "shot", id: nodeId } : undefined) }),
  /** Crew › Open in Gen puts the solution in Gen's prompt; nothing is copied or written. */
  crewGen: (): Confirmation => ({ text: "The solution is Gen’s prompt", open: { to: "gen" } }),
  /** Open in Gen or Retry when the browser would not hold what was being carried (storage blocked): Gen opens empty, and says so. */
  notCarried: (what: string): Confirmation => ({ text: `${what} could not be carried to Gen`, open: { to: "gen" } }),
  /** Crew › File minutes: the markdown is stored in this project's Library. */
  minutesFiled: (): Confirmation => ({ text: "Minutes filed in the Library", open: { to: "library" } }),
  /** Cast › the agent's list, counted from what was added rather than what was proposed. */
  castTaken: ({ added, known, overLimit }: CastTaken): Confirmation => ({
    text: [
      added ? `The agent added ${plural(added, "entry", "entries")} to Cast` : "The agent added nothing new to Cast",
      known ? `${known} already listed` : "",
      overLimit ? `${overLimit} left out · the list is full` : "",
    ].filter(Boolean).join(" · "),
    open: page("studio", "cast"),
  }),
  /** Cast › a build that landed is stored in the Library. */
  castBuilt: (name: string, kind: "character" | "element"): Confirmation => ({ text: `${name || "The build"} is in the Library as ${kind === "character" ? "Cast" : "Elements"}`, open: { to: "library" } }),
  /** Environment › a plate that landed is stored in the Library. */
  plateBuilt: (name: string): Confirmation => ({ text: `${name || "The plate"} is in the Library as Environment`, open: { to: "library" } }),
  /** Brief › a breakdown's scenes became Rig nodes. */
  breakdownToRig: (nodes?: number): Confirmation => ({ text: nodes == null ? "Scene breakdown added to Rig" : `${plural(nodes, "scene node", "scene nodes")} added to Rig`, open: page("studio", "rig") }),
  /** Retry generation loads the render's prompt and model in Gen (Gen's note says which; its Generate button carries the price). */
  retry: (name: string): Confirmation => ({ text: `Retry · ${name} loaded in Gen`, open: { to: "gen" } }),
  /** Business › a finished take opens in Takes, selected. */
  take: (generationId: string): Destination => page("studio", "takes", { kind: "take", id: `generation:${generationId}` }),
};

/** A Crew solution's line once it has gone somewhere — where it went, in the destination's own name. */
export function solutionStatusLabel(status: "open" | "sent_to_brief" | "boarded" | "generated"): string | null {
  if (status === "sent_to_brief") return `Added to the ${destinationName(page("studio", "brief"))}`;
  if (status === "boarded") return `Added to ${destinationName(page("studio", "rig"))}`;
  if (status === "generated") return `Opened in ${destinationName({ to: "gen" })}`;
  return null;
}
