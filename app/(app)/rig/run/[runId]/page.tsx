import { redirect } from "next/navigation";

/**
 * Rig · Run. A Rig run had no runner: nothing advances stage_runs
 * (lib/runs.ts), so every stage stayed queued under a "Running" ring while
 * Continue and Stop changed nothing. Runs execute in Pipelines, so an old run
 * link opens the project's pipelines there instead of a view that cannot move.
 */
export default async function RunPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const project = (await searchParams).project;
  redirect(typeof project === "string" && project ? `/pipelines?projectId=${encodeURIComponent(project)}` : "/pipelines");
}
