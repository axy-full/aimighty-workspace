/**
 * What the Rig's list, graph and Inspector show before a project's shots are
 * in. The Rig provider reports "idle" both before a project's first load
 * starts and when no project is open at all, so the shell's project id is what
 * tells those two apart.
 *
 * A finished load ("ready") with no draft is not loading: the project named by
 * the shell (a shared link, say) has no draft this person can open, and the
 * person is asked to open or create one instead of watching "Loading…" for
 * good. Switching projects passes through that state for a moment (the
 * provider is still "ready" for the project being left), which shows the same
 * line the Rig showed there before.
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
  if (!input.projectId || input.status === "ready") return "no-project";
  return "loading";
}

export const RIG_NO_PROJECT = "Open or create a project to see its shots.";
