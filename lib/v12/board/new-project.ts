/**
 * What "New project" on Home makes (investor demo, 31 Oct 2026; docs/plans/demo-31oct-plan.md, PR 32 + D-1): a Film board whose rail
 * starts with the demo's steps. The built-in Film steps are PR 4's (lib/v12/board/stages.ts); this file is only which of them a new
 * project's rail shows. The rail is made by `startingRail`, never by hand, so a step left out is flagged removed and a later read never
 * adds it back.
 *
 * Kept as the draft's own `boardStages` (an optional field of the draft JSON), so no database change and no new route.
 * Pure: no React.
 */
import { startingRail, type SavedStage } from "./stages";

/**
 * Pitch, Brief, Script, Cast, Storyboard, Shots, then the Edit and Deliver the film ends in. Treatment and Locations are left off (they
 * hold no cards yet, so nothing is lost; a person adds them back from the rail). Elements stays, skipped: the cards it holds (places and
 * things) keep a stage that draws them, and a person can un-skip it.
 */
export const NEW_PROJECT_PLAN = { without: ["treatment", "locations"], skipped: ["elements"] } as const;

/** The name of a project made with no words: the box's brief names it when there are some. */
export const NEW_PROJECT_NAME = "Untitled project";

/** The rail a new project starts with, as the draft saves it. A new list each time: no two boards share one. */
export const newProjectRail = (): SavedStage[] => startingRail("film", NEW_PROJECT_PLAN);

/** The kind and rail a new project is made with (CreateSeed's `boardFlavor` and `boardStages`). */
export const newProjectBoard = () => ({ boardFlavor: "film" as const, boardStages: newProjectRail() });
