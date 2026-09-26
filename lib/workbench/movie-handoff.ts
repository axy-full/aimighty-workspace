import { projectSchema } from "./studio-schema";
import type { Project } from "./studio";
import { accountScopeFor, workbenchScopeFor } from "./request-scope";

const limit = 3_500_000;
const lifetime = 10 * 60 * 1000;
const visitor = "particl-visitor";
/**
 * The scope a handoff is written and read under: the one /workbench renders
 * with (a workspace, an account without one, or a signed-out visitor), so a
 * snapshot made there opens here.
 */
export function movieScopeFor(account: { id: string; workspaceId?: string | null } | null): string {
  if (!account) return visitor;
  return account.workspaceId ? workbenchScopeFor(account.workspaceId, account.id) : accountScopeFor(account.id);
}
/**
 * Whether this browser is still who the renderer was opened for. /api/me
 * answers only inside a workspace ("Pick a workspace first." is a 401 too), so
 * anyone else is asked through GET /api/workspaces, which holds the captured
 * account scope against the session (lib/accountRequestScope.ts) and answers
 * 401 once signed out.
 */
export async function movieScopeIsCurrent(
  scope: string,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<boolean> {
  const unverified = () => new Error("Your account could not be verified. Try again.");
  const me = await request("/api/me", { signal, cache: "no-store" });
  if (me.ok) {
    const account = await me.json();
    return movieScopeFor({ id: String(account.id), workspaceId: account.workspace?.id }) === scope;
  }
  if (me.status !== 401) throw unverified();
  const session = await request("/api/workspaces", {
    signal,
    cache: "no-store",
    headers: scope === visitor ? {} : { "X-Workbench-Scope": scope },
  });
  if (session.status === 401) return scope === visitor;
  if (session.status === 409) return false;
  if (!session.ok) throw unverified();
  /* Signed in without a workspace: the header matched, unless the page was a visitor's. */
  return scope !== visitor;
}
export function movieHandoffKey(token: string, scope: string) {
  if (!/^[a-f0-9-]{36}$/.test(token))
    throw new Error("Open the movie renderer from Delivery.");
  return `particl-movie-${scope === visitor ? "visitor" : "private"}:${token}`;
}
/**
 * The renderer reads the cut, its sound and grade, and only the assets those
 * use; the rest of a feature film's project (script, beats, boards, the Rig)
 * would overflow the browser's session storage, so it stays behind.
 */
export function movieSnapshot(project: Project): Project {
  const used = new Set<string>([
    ...project.shots.map((shot) => shot.assetId),
    ...(project.audioClips ?? []).map((clip) => clip.assetId),
    ...(project.audioAssetId ? [project.audioAssetId] : []),
    ...(project.colorGrade?.lutAssetId ? [project.colorGrade.lutAssetId] : []),
  ]);
  return {
    ...project, script: "", nodes: [], plans: [], assets: project.assets.filter((asset) => used.has(asset.id)),
    bins: undefined, production: undefined, astraNative: undefined, astraBlender: undefined, moleculr: undefined,
    sharedAssets: undefined, sharedNodes: undefined, sharedAssetIds: [], sharedNodeIds: [], scriptReviews: undefined,
  };
}
export function createMovieHandoff(project: Project, scope: string) {
  const token = crypto.randomUUID();
  const raw = JSON.stringify({ project: movieSnapshot(project), scope, createdAt: Date.now() });
  if (raw.length > limit)
    throw new Error("The cut exceeds the 3.5 MB export snapshot limit.");
  for (let i = sessionStorage.length - 1; i >= 0; i--) {
    const key = sessionStorage.key(i);
    if (key?.startsWith("particl-movie-")) sessionStorage.removeItem(key);
  }
  sessionStorage.setItem(movieHandoffKey(token, scope), raw);
  return `/workbench/movie?snapshot=${encodeURIComponent(token)}`;
}
export function readMovieHandoff(raw: string | null, scope: string): Project {
  if (!raw || raw.length > limit)
    throw new Error(
      "This export snapshot is unavailable. Return to Delivery and open the movie renderer again.",
    );
  const value = JSON.parse(raw);
  if (value.scope !== scope)
    throw new Error(
      "This export belongs to another account or workspace. Return to your current workbench.",
    );
  if (
    !Number.isFinite(value.createdAt) ||
    value.createdAt > Date.now() ||
    Date.now() - value.createdAt > lifetime
  )
    throw new Error(
      "This export snapshot expired. Return to Delivery to export the latest edit.",
    );
  return projectSchema.parse(value.project) as Project;
}
