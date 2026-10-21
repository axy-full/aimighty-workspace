import type { Stage } from "@/lib/v12/board/stages";
import type { RailStep } from "./StepRail";
import { railIcon } from "./rail-icons";

/**
 * The rail's steps, read from a board's stages (lib/v12/board/stages.ts, `stagesOf`): the saved rail with its renames and its order, a skipped step
 * muted, and a step the person REMOVED already absent (stagesOf drops a built-in stage flagged `removed`, so it never comes back). Pure
 * (tests/unit/v25-rail-stages.spec.ts). `status` and `done` are the board's own reads; the Treatment and Pitch steps may be skipped, so they say "Optional".
 */
/** A step the prototype draws no icon for takes the nearest one it does (Treatment is a written document, like the Script). */
const ICON_FOR: Readonly<Record<string, string>> = { treatment: "script" };
export const iconOf = (id: string): string => railIcon(ICON_FOR[id] ?? id);

export const OPTIONAL_STEPS: ReadonlySet<string> = new Set(["treatment", "pitch"]);

export function railStepsOf(stages: readonly Stage[], read: { status: (id: string) => string; done?: (id: string) => boolean; optional?: ReadonlySet<string> }): RailStep[] {
  const optional = read.optional ?? OPTIONAL_STEPS;
  return stages.map((stage) => ({
    id: stage.id,
    label: stage.label,
    icon: iconOf(stage.id),
    done: !stage.skipped && (read.done?.(stage.id) ?? false),
    status: stage.skipped ? "Skipped" : read.status(stage.id),
    optional: optional.has(stage.id),
    skipped: stage.skipped,
  }));
}
