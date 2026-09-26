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
