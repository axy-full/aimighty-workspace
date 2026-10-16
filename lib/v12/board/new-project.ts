/**
 * What "New project" on Home makes (investor demo, 31 Oct 2026; docs/plans/demo-31oct-plan.md, PR 32 + D-1): a Film board
 * whose rail starts with the demo's steps. THE ONE PLACE the list lives: PR 4 (board data for v25) owns the built-in Film
 * steps, and when it adds a real Pitch step this list is the only thing to edit (an id that has become built-in is read as
 * built-in whatever `custom` says: `stagesOf` in lib/v12/board/stages.ts).
 *
 * Kept as the draft's own `boardStages` (an optional field of the draft JSON), so no database change and no new route.
 * Pure: no React.
 */
import type { SavedStage } from "./stages";

/**
 * Pitch, Brief, Script, Cast, Storyboard, Shots, then the Cut and Deliver the film ends in. Elements stays on the rail,
 * skipped: the cards it holds (places and things) keep a stage that draws them, and a person can un-skip it.
 * Pitch is a stage of its own until PR 4 gives it contents, so it is saved as a custom stage under its final id.
 */
export const NEW_PROJECT_STEPS: readonly SavedStage[] = [
  { id: "pitch", label: "Pitch", custom: true },
  { id: "brief" },
  { id: "script" },
  { id: "cast" },
  { id: "elements", skipped: true },
  { id: "storyboard" },
  { id: "shots" },
  { id: "cut" },
  { id: "deliver" },
];

/** The name of a project made with no words: the box's brief names it when there are some. */
export const NEW_PROJECT_NAME = "Untitled project";

/** The kind and rail a new project is made with (CreateSeed's `boardFlavor` and `boardStages`). */
export const newProjectBoard = () => ({ boardFlavor: "film" as const, boardStages: NEW_PROJECT_STEPS.map((s) => ({ ...s })) });
