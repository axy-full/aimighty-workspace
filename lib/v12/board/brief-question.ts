/**
 * The Brief's one question for Agent mode (owner, 16 Oct 2026, 15:50, section D): "Deliver at 1080p or 4K?". It only RECORDS the choice, in the
 * board's own Agent setup for the Brief step (`boardSetup.agent.brief.resolution`, lib/v12/board/board-data.ts), so the Agent plan can read it later
 * and lane I's resolution work can use it. It prices nothing and sends nothing. In Director the per-shot Resolution control covers it, so the
 * question is not asked there. Pure: no React (tests/unit/v12-brief-question.spec.ts).
 */
import { modeOf, stepSetup, withStepSetting, type BoardSetup, type BoardModes } from "./board-data";
import type { Project } from "@/lib/workbench/studio";

export const DELIVERY_QUESTION = "Deliver at 1080p or 4K?";
/** The setup key, and the two answers as the draft keeps them. */
export const RESOLUTION_KEY = "resolution";
export const RESOLUTIONS = [{ id: "1080p", label: "1080p" }, { id: "4k", label: "4K" }] as const;
export type DeliveryResolution = (typeof RESOLUTIONS)[number]["id"];

const isResolution = (value: unknown): value is DeliveryResolution => RESOLUTIONS.some((r) => r.id === value);

/** The question is Agent's: asked of a person working the board in Agent mode, and of nobody else. */
export const asksResolution = (project: Pick<Project, "boardMode">, person: string | null | undefined): boolean => modeOf(project.boardMode as BoardModes | undefined, person) === "agent";

/** What was answered, or null while nothing has been (the question has no default: the answer is the person's). */
export function resolutionOf(project: Pick<Project, "boardSetup">): DeliveryResolution | null {
  const value = stepSetup(project.boardSetup as BoardSetup | undefined, "agent", "brief")[RESOLUTION_KEY];
  return isResolution(value) ? value : null;
}

/** The draft with the answer kept in Agent's setup for the Brief. Any other value changes nothing. */
export function withResolution(project: Project, answer: DeliveryResolution): Project {
  if (!isResolution(answer)) return project;
  return { ...project, boardSetup: withStepSetting(project.boardSetup as BoardSetup | undefined, "agent", "brief", RESOLUTION_KEY, answer) };
}
