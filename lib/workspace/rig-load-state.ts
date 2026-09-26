/**
 * What the Rig's list, graph and Inspector show before a project's shots are
 * in. The Rig provider reports "idle" both before a project's first load
 * starts and when no project is open at all, so the shell's project id is what
 * tells the two apart: with one, the shots are on their way; without one,
 * there is nothing to load and the person is asked to open or create a project.
 */
export type RigLoadState = "ready" | "loading" | "error" | "no-project";

export function rigLoadState(input: {
  status: "idle" | "loading" | "ready" | "error";
  /** The Rig has the open project's draft. */
  hasProject: boolean;
  /** The project the shell has open, if any. */
  projectId: string | null;
}): RigLoadState {
  if (input.hasProject) return "ready";
  if (input.status === "error") return "error";
  return input.projectId ? "loading" : "no-project";
}

export const RIG_NO_PROJECT = "Open or create a project to see its shots.";
