import type { ModelDef } from "./models";
import type { Reference } from "./ark";
import { estimateImageCostUsd } from "./vendorPricing";
import { falRun } from "./fal";
import { mediaUrl } from "./falVideo";
import { engineMock } from "./mock";
import { fixtureBytes, fetchBytes } from "./mockFs";
import { stillToolFor, falImageInput } from "./stillTools";
import { falEditInput } from "./falEdit";

/**
 * The still post tools on fal, server side: one still of ours through a
 * Bria tool, bytes back at the catalogue's flat price. What a tool IS —
 * and the vendor's input for it — lives in lib/stillTools.ts, which the
 * browser reads too; this file is the only one that calls the vendor.
 */
export { STILL_TOOLS, stillToolFor, stillToolModel, canvasFor, falImageInput, type StillTool } from "./stillTools";

export async function renderFalStill(opts: { model: ModelDef; ratio: string; size?: string; prompt: string; references: Reference[] }): Promise<{ bytes: Buffer; mime: string; costUsd: number | null }> {
  const tool = stillToolFor(opts.model.id);
  if (!tool) {
    /* CR1 §3: an edit engine on fal (Nano Banana 2 Edit, Flux Kontext) — the stills and the words go as they are, one image back. */
    if (opts.model.provider !== "fal" || opts.model.kind !== "image") throw new Error(`${opts.model.label} is not a still tool.`);
    const stills = opts.references.filter((r) => r.kind === "image");
    if (opts.model.needsStartImage && !stills.length) throw new Error(`${opts.model.label} needs a still to work from.`);
    const size = opts.size && opts.model.resolutions.includes(opts.size) ? opts.size : opts.model.resolutions[0];
    const costUsd = estimateImageCostUsd(opts.model.id, size, stills.length)?.net ?? null;
    if (engineMock()) return { bytes: await fixtureBytes("still.png"), mime: "image/png", costUsd };
    const { endpoint, input } = falEditInput(opts.model, opts.prompt, await Promise.all(stills.map(mediaUrl)), opts.ratio, size);
    const out = await falRun<{ images?: { url?: string; content_type?: string }[]; image?: { url?: string; content_type?: string }; has_nsfw_concepts?: boolean[] }>(endpoint, input, { timeoutMs: 180_000 });
    if (out?.has_nsfw_concepts?.[0]) throw new Error("The safety checker flagged this render. Reword the prompt.");
    const picked = out?.images?.[0] ?? out?.image;
    if (!picked?.url) throw new Error("fal.ai finished but returned no image.");
    return { bytes: await fetchBytes(picked.url), mime: picked.content_type ?? "image/png", costUsd };
  }
  const source = opts.references.find((r) => r.kind === "image");
  if (!source) throw new Error("Pick the still to work on.");
  const costUsd = estimateImageCostUsd(opts.model.id, "adaptive", 0)?.net ?? null;
  if (engineMock()) return { bytes: await fixtureBytes("still.png"), mime: "image/png", costUsd };
  const { endpoint, input } = falImageInput(tool, await mediaUrl(source), opts.ratio, opts.prompt);
  const out = await falRun<{ image?: { url?: string; content_type?: string } }>(endpoint, input, { timeoutMs: 180_000 });
  const url = out?.image?.url;
  if (!url) throw new Error("fal.ai finished but returned no image.");
  return { bytes: await fetchBytes(url), mime: out.image?.content_type ?? "image/png", costUsd };
}
