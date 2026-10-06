import { notFound, permanentRedirect, redirect } from "next/navigation";
import { currentContext, type Context } from "@/lib/auth";
import { getBoard } from "@/lib/boards";
import { getElement } from "@/lib/elements";
import { getGeneration } from "@/lib/jobs";
import { getShot } from "@/lib/shots";
import { db } from "@/lib/db";
import { runInTenant } from "@/lib/tenant";
import { workbenchReady } from "@/lib/workbench/records";
import { planOldRoute, type OldRoutePlan } from "./old-routes";
import { searchStringOf, type RawSearch } from "./raw-search";

export type { RawSearch };

/**
 * The Studio project (a workbench draft, what `?project=` names in the shell) that holds a production project's work: this
 * person's newest draft linked to it. Same read as GET /api/workbench/projects?production=. Null when there is none.
 */
async function studioProjectFor(ctx: Context, productionProjectId: string): Promise<string | null> {
  if (!ctx.workspace || !productionProjectId) return null;
  return runInTenant(ctx.workspace, async () => {
    await workbenchReady();
    const row = (await db().execute({
      sql: "SELECT project_id AS id FROM workbench_projects WHERE owner=? AND (CASE WHEN json_valid(body) THEN json_extract(body,'$.productionProjectId') END)=? ORDER BY updated_at DESC LIMIT 1",
      args: [ctx.user.id, productionProjectId],
    })).rows[0];
    return row ? String(row.id) : null;
  }, { user: ctx.user }).catch(() => null);
}

/** The Studio project an old address's lookup leads to, or null: a visitor, no workspace, nothing linked. */
async function resolve(found: OldRoutePlan): Promise<string | null> {
  if (!found.lookup) return null;
  const ctx = await currentContext();
  if (!ctx?.workspace) return null;
  if (found.lookup.kind === "production-project") return studioProjectFor(ctx, found.lookup.id);
  /* Everything else names a row whose production project is on it. */
  const { kind, id } = found.lookup;
  const owner = await runInTenant(ctx.workspace, async () => {
    if (kind === "board") return (await getBoard(id))?.projectId ?? null;
    if (kind === "take") return (await getGeneration(id))?.projectId ?? null;
    if (kind === "shot") return (await getShot(id))?.projectId ?? null;
    return (await getElement(id))?.projectId ?? null;
  }, { user: ctx.user }).catch(() => null);
  return owner ? studioProjectFor(ctx, owner) : null;
}

/**
 * Carries out the plan for an old address: one redirect to its final place in the Suites shell. A visitor goes the same
 * way, and /suites asks them to sign in and brings them back. 307 unless the plan says it is final.
 */
export async function followOldRoute(pathname: string, params: RawSearch = {}): Promise<never> {
  const found = planOldRoute(pathname, searchStringOf(params));
  if (!found) notFound();
  const to = found.to(await resolve(found));
  if (found.permanent) permanentRedirect(to);
  redirect(to);
}
