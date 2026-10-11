import type { Generation } from "../jobs";
import { recreateBlock } from "../shell/recipe";

/**
 * The request a failed take's Retry would make, for its price only (POST /api/generate/quote: free, repeatable,
 * nothing reserved). Retry itself hands the take's recipe to Make (lib/shell/use-asset-actions.ts useRecreate), where
 * the same request is priced again and a person presses Make; this body only lets the take card say what that costs
 * ("Retry · 43 cr") before anyone opens Make. Pure. Null when the take can't be made again from Make (recreateBlock),
 * is not a failed image or video take, or has no project to file to: then Retry shows no figure.
 */
export function retryQuoteBody(g: Pick<Generation, "kind" | "model" | "params" | "prompt" | "projectId" | "shotId" | "status" | "task">): Record<string, unknown> | null {
  if (g.status !== "failed" || (g.kind !== "video" && g.kind !== "image")) return null;
  if (recreateBlock(g)) return null;
  if (!g.projectId || !g.model || !g.prompt) return null;
  const p = g.params ?? {};
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const ratio = text(p.ratio) ?? text(p.aspectRatio);
  const resolution = text(p.resolution);
  if (!ratio || !resolution) return null;
  const references = Array.isArray(p.references)
    ? p.references.flatMap((r): ({ genId: string; role: string } | { uploadId: string; role: string })[] => {
        if (!r || typeof r !== "object") return [];
        const ref = r as Record<string, unknown>;
        const role = text(ref.role) ?? "reference";
        if (typeof ref.genId === "string") return [{ genId: ref.genId, role }];
        if (typeof ref.uploadId === "string") return [{ uploadId: ref.uploadId, role }];
        return [];
      })
    : [];
  const duration = Number(p.duration);
  return {
    prompt: g.prompt,
    model: g.model,
    projectId: g.projectId,
    ...(g.shotId ? { shotId: g.shotId } : {}),
    ratio,
    resolution,
    ...(g.kind === "video" && Number.isFinite(duration) && duration > 0 ? { duration } : {}),
    refine: false,
    references,
    ...(g.kind === "video" ? { firstFrameAssetId: "" } : {}),
    ...(p.draft === true && g.kind === "video" ? { draft: true } : {}),
    ...(p.cinema && typeof p.cinema === "object" && Object.keys(p.cinema).length ? { cinema: p.cinema } : {}),
    ...(p.generateAudio === true ? { generateAudio: true } : {}),
    ...(p.shotSpec && typeof p.shotSpec === "object" && Object.keys(p.shotSpec).length ? { shotSpec: p.shotSpec } : {}),
  };
}
