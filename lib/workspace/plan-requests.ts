/**
 * Where a paid plan's request bodies come from.
 *
 * A paid plan sends exactly the bodies the page's existing UI would send
 * (GenerationDialog, SubatomikWorkspace, SoundGenerate, AstraStudio...). The
 * plan never invents them. Two kinds of provider fill `PlanContext.request`:
 *
 *  - project providers: pure reads of the saved draft that need no page UI
 *    (today: Astra's saved-scene digest), computed by the shell;
 *  - page providers: a page body publishes what its own form holds with
 *    `usePlanRequest(key, value)` (lib/workspace/atomik-host.tsx).
 *
 * Until something provides a plan's key, the plan is not runnable and says
 * "Needs <page> data" — it never guesses a body.
 */

import { astraSceneDigest } from "../astra-blender/proposal";
import type { Project } from "../workbench/studio";
import { pageDef } from "./pages";
import type { Plan, PlanContext, PlanRequest, Runnable, WorkspacePageId } from "./plan-types";
import type { PageId } from "./types";

export type RequestKey = keyof PlanRequest;

/**
 * Paid plans whose bodies come from a page, and which page owns that data.
 *
 * `boards` has no provider and cannot have one yet. A board frame is a `Shot`
 * (lib/workbench/studio.ts: id, name, assetId, duration, sourceIn, note) — it
 * cites an existing asset and carries no prompt, engine, ratio, resolution or
 * production mapping, and no surface in the product generates a board image.
 * Building an /api/generate body for one would mean inventing all five, so the
 * Boards plan stays "Needs Boards data" until a Boards generate UI makes those
 * choices; the seam is here, ready for it.
 */
export const PLAN_REQUEST_NEEDS: Partial<Record<WorkspacePageId, { key: RequestKey; page: PageId }>> = {
  boards: { key: "boards", page: "boards" },
  astra: { key: "astra", page: "astra" },
  rig: { key: "shots", page: "rig" },
  edit: { key: "stems", page: "edit" },
  generate: { key: "generation", page: "generate" },
  models: { key: "shots", page: "rig" },
  marketing: { key: "variants", page: "marketing" },
  motion: { key: "motion", page: "motion" },
  swap: { key: "swap", page: "swap" },
};

/** "Needs Rig data" when nothing provides the plan's request yet, else null. */
export function missingRequest(page: string, provided: ReadonlySet<RequestKey>): string | null {
  const need = PLAN_REQUEST_NEEDS[page as WorkspacePageId];
  if (!need || provided.has(need.key)) return null;
  return `Needs ${pageDef(need.page).title} data`;
}

/**
 * The registry's plans with one more runnable check in front: a plan whose
 * request nobody provides is not runnable. The engine calls `runnable` on
 * every start, so a plan can never start on a guessed body.
 */
export function withRequestGate(
  plans: Record<string, Plan>,
  provided: () => ReadonlySet<RequestKey>,
): Record<string, Plan> {
  return Object.fromEntries(
    Object.entries(plans).map(([page, plan]) => [
      page,
      {
        ...plan,
        runnable: (ctx: PlanContext): Runnable => {
          const own = plan.runnable(ctx);
          /* "Open a project first" outranks a missing page request. */
          if (!ctx.projectId) return own;
          const missing = missingRequest(plan.page, provided());
          return missing ? { ok: false, reason: missing } : own;
        },
      },
    ]),
  );
}

/**
 * Requests derivable from the saved draft alone. Astra: the saved scene's
 * digest, computed exactly as the Astra render panel computes it
 * (astraSceneDigest over the saved scene); no saved scene → no request, and
 * the plan's own reason ("save the scene in Astra first") shows.
 */
export async function projectRequests(project: Project | null): Promise<{ request: PlanRequest; provided: RequestKey[] }> {
  if (!project) return { request: {}, provided: [] };
  const request: PlanRequest = {};
  if (project.astraBlender) {
    try {
      request.astra = { sourceDigest: await astraSceneDigest(project.astraBlender), source: "scene" };
    } catch {
      /* An unreadable scene gives no digest; the plan stays not runnable with its own reason. */
    }
  }
  /* Astra is provided (possibly empty) whenever a project is open: its plan's own check explains what is missing. */
  return { request, provided: ["astra"] };
}

/** Merge page-published values over project-derived ones. */
export function mergeRequests(base: PlanRequest, published: Partial<Record<RequestKey, unknown>>): PlanRequest {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(published)) if (value !== undefined) out[key] = value;
  return out as PlanRequest;
}
