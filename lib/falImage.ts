import type { ModelDef } from "./models";
import type { Reference } from "./ark";
import { estimateImageCostUsd } from "./vendorPricing";
import { falRun, falSubmit } from "./fal";
import { mediaUrl } from "./falVideo";
import { engineMock } from "./mock";
import { fixtureBytes, fetchBytes } from "./mockFs";
import { topazImageInput, type TopazImageSettings } from "./topaz";
import { inspectTopazImage } from "./topazImage.server";
import { stillToolFor, falImageInput } from "./stillTools";

/**
 * The still post tools on fal, server side: one still of ours through a
 * Bria tool, bytes back at the catalogue's flat price. What a tool IS —
 * and the vendor's input for it — lives in lib/stillTools.ts, which the
 * browser reads too; this file is the only one that calls the vendor.
 */
export {
  STILL_TOOLS,
  stillToolFor,
  stillToolModel,
  canvasFor,
  falImageInput,
  type StillTool,
} from "./stillTools";

export async function renderFalStill(opts: {
  model: ModelDef;
  size?: string;
  topaz?: TopazImageSettings;
  ratio: string;
  prompt: string;
  references: Reference[];
}): Promise<{ bytes: Buffer; mime: string; costUsd: number | null }> {
  const tool = stillToolFor(opts.model.id);
  if (!tool) throw new Error(`${opts.model.label} is not a still tool.`);
  const source = opts.references.find((r) => r.kind === "image");
  if (!source) throw new Error("Pick the still to work on.");
  if (tool === "upscale")
    throw new Error("Topaz must use the durable image queue.");
  const costUsd =
    estimateImageCostUsd(opts.model.id, "adaptive", 0)?.net ?? null;
  if (engineMock())
    return {
      bytes: await fixtureBytes("still.png"),
      mime: "image/png",
      costUsd,
    };
  const { endpoint, input } = falImageInput(
    tool,
    await mediaUrl(source),
    opts.ratio,
    opts.prompt,
  );
  const out = await falRun<{ image?: { url?: string; content_type?: string } }>(
    endpoint,
    input,
    { timeoutMs: 180_000 },
  );
  const url = out?.image?.url;
  if (!url) throw new Error("The render service finished but returned no image.");
  return {
    bytes: await fetchBytes(url),
    mime: out.image?.content_type ?? "image/png",
    costUsd,
  };
}

/** The caller persists this handle before any polling or output processing. */
export async function submitTopazImage(opts: {
  size: string;
  topaz?: TopazImageSettings;
  references: Reference[];
}) {
  const source = opts.references[0];
  if (!source || opts.references.length !== 1 || !opts.topaz)
    throw new Error("Review an original image and Topaz settings first.");
  const output = await inspectTopazImage(source, opts.topaz);
  if (output.resolution !== opts.size)
    throw new Error("The Topaz output size changed. Review the upscale again.");
  let url: string;
  if (!source.fromGeneration && /^https?:\/\//.test(source.storedUrl)) {
    // Legacy browser-direct originals can have a random Blob suffix. Read the
    // exact persisted object instead of presigning a different deterministic path.
    const { readUploadBytes } = await import("./storage");
    const bytes = await readUploadBytes(
      source.id,
      source.ext,
      source.storedUrl,
    );
    url = `data:${source.mime};base64,${bytes.toString("base64")}`;
  } else url = await mediaUrl({ ...source, deliveryUrl: null });
  return falSubmit(
    "fal-ai/topaz/upscale/image",
    topazImageInput(url, opts.topaz),
  );
}
