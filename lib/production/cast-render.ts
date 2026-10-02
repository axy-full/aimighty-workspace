import { failureLine } from "../errors";
import type { TakeFailure } from "../providerOutcome";
import type { GenerationBodyInput } from "../workbench/generation-request";
import type { SoulIdentity } from "../workbench/soul-identity";
import type { Project } from "../workbench/studio";
import { SOUL_RENDER_STRENGTHS, isSoulRenderModel } from "../soulRenderTypes";
import { CAST_RENDER_RATIO, type CastEntry } from "./cast";

/**
 * A character of Production › Cast rendered with its Soul ID on the platform's
 * key. Pure: the page, its quotes and its tests read the same request.
 */

/** A Soul ID a character can render with: trained, and trained for a family this platform renders. */
export const renderableIdentity = (identity: Pick<SoulIdentity, "status" | "renderModel">): boolean =>
  identity.status === "ready" && typeof identity.renderModel === "string" && isSoulRenderModel(identity.renderModel);

/**
 * The request one character's render sends (POST /api/generate/quote, then
 * /api/generate): its prompt as a 3:4 character sheet, the workspace's own id
 * for its Soul ID — the server resolves the provider's — the model of the
 * family that identity was trained for, and 1 or 4 stills. Null until there is
 * a saved production, a prompt and a ready identity it can render with.
 */
export function castRenderInput(project: Pick<Project, "id" | "productionProjectId">, entry: CastEntry, identity: SoulIdentity | null | undefined): GenerationBodyInput | null {
  if (entry.kind !== "character" || !project.productionProjectId || !entry.prompt.trim() || !identity || identity.id !== entry.identityId || !renderableIdentity(identity))
    return null;
  const strength = (SOUL_RENDER_STRENGTHS as readonly number[]).includes(entry.soulStrength ?? 1) ? entry.soulStrength ?? 1 : 1;
  return {
    prompt: entry.prompt.trim(), kind: "image", model: { id: identity.renderModel!, soulIdentity: true },
    mapping: { shotId: "", productionProjectId: project.productionProjectId },
    ratio: CAST_RENDER_RATIO, resolution: entry.soulResolution ?? "720p", duration: 5, references: [],
    soul: { soulIdentityId: identity.id, soulStrength: strength, workbenchProjectId: project.id, soulBatch: entry.soulBatch ?? 1 },
  };
}

/** A finished render's stills, in order: the request's own take, then the rest of its batch. */
export function renderedStills(generation: { id: string; params?: unknown }): string[] {
  const ids = (generation.params as { soulBatchIds?: unknown } | undefined)?.soulBatchIds;
  const batch = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(id)) : [];
  return batch[0] === generation.id ? batch : [generation.id];
}

/**
 * What a render that did not finish says: the failure line every other take
 * prints (lib/errors.ts failureLine) — what happened, what Particl's ledger
 * holds for it or what the provider did with the charge ("12 cr held" while
 * its reservation is open, "12 cr charged", "Not billed" only once settled at
 * nothing; nothing when neither has said), then the next step. A record with
 * no failure on it (an older row) gives its reason alone — never a blanket
 * "not billed".
 */
export function renderOutcome(generation: { status: string; error?: string | null; failure?: TakeFailure | null }): string {
  const cancelled = generation.status === "cancelled";
  if (generation.failure) return failureLine(generation.failure, { cancelled }).text;
  return generation.error?.trim() || (cancelled ? "The render was cancelled." : "The render did not finish.");
}
