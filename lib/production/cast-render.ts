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
 * What a render that did not finish says, from its own record: the reason,
 * then what the ledger kept for it — never a blanket "not billed".
 */
export function renderOutcome(generation: { status: string; error?: string | null; creditsBilled?: number | null }): string {
  const reason = generation.error?.trim() || (generation.status === "cancelled" ? "The render was cancelled." : "The render did not finish.");
  const billed = generation.creditsBilled;
  return typeof billed !== "number" ? reason : billed > 0 ? `${reason} ${billed.toLocaleString("en-US")} cr billed.` : `${reason} Not billed.`;
}
