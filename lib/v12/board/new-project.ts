/**
 * What "New project" on Home makes (investor demo, 31 Oct 2026; docs/plans/demo-31oct-plan.md, PR 32 + D-1): a Film board
 * whose rail starts with the demo's steps. The built-in Film steps are PR 4's (lib/v12/board/stages.ts); this file is only
 * which of them a new project's rail shows, and in what order.
 *
 * Kept as the draft's own `boardStages` (an optional field of the draft JSON), so no database change and no new route.
 * Pure: no React.
 */
import type { SavedStage } from "./stages";

/**
 * Pitch, Brief, Script, Cast, Storyboard, Shots, then the Edit and Deliver the film ends in. Treatment and Locations are left
 * off (they hold no cards yet, so nothing is lost; a person adds them back from the rail). Elements stays, skipped: the cards
 * it holds (places and things) keep a stage that draws them, and a person can un-skip it. Ids are the built-in Film stages of
 * lib/v12/board/stages.ts (PR 4), so this file adds no stage of its own.
 */
export const NEW_PROJECT_STEPS: readonly SavedStage[] = [
  { id: "pitch" },
  { id: "brief" },
  { id: "script" },
  { id: "cast" },
  { id: "elements", skipped: true },
  { id: "storyboard" },
  { id: "shots" },
  { id: "edit" },
  { id: "deliver" },
];

/** The name of a project made with no words: the box's brief names it when there are some. */
export const NEW_PROJECT_NAME = "Untitled project";

/** The kind and rail a new project is made with (CreateSeed's `boardFlavor` and `boardStages`). */
export const newProjectBoard = () => ({ boardFlavor: "film" as const, boardStages: NEW_PROJECT_STEPS.map((s) => ({ ...s })) });
