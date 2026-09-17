import type { Asset, CanvasNode } from "./studio";

export const MAX_NODE_RENDER_PIXELS = 40_000_000;
export const MAX_NODE_RENDER_EDGE = 16_384;
export const MAX_NODE_RENDER_WORK_PIXELS = 120_000_000;
export type NodeRenderResolution = "preview" | "source";
/** Exports either keep every source pixel or fail; only monitor previews shrink. */
export function nodeRenderSize(
  width: number,
  height: number,
  resolution: NodeRenderResolution,
) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1
  )
    throw new Error("The source image has invalid pixel dimensions.");
  if (resolution === "source") {
    if (
      width * height > MAX_NODE_RENDER_PIXELS ||
      Math.max(width, height) > MAX_NODE_RENDER_EDGE
    )
      throw new Error(
        "Source-size rendering supports up to 40 megapixels and 16,384 pixels per edge. Use a smaller source image; no reduced-resolution export was created.",
      );
    return { width, height };
  }
  const scale = Math.min(1, 2048 / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
/** A rendered derivative has its own upload identity; trained/provider bindings belong to its source. */
export function renderedNodeAsset(
  source: Asset,
  upload: { id: string; url: string },
  node: CanvasNode,
  size: { width: number; height: number },
  references: string[],
  prompt: string,
): Asset {
  return {
    id: upload.id,
    url: upload.url,
    uploadId: upload.id,
    kind: "image",
    mime: "image/png",
    name: node.title + " / rendered take",
    version: source.version + 1,
    parentId: source.id,
    status: "Draft",
    locked: false,
    category: "Shot",
    refs: [...new Set([source.id, ...references])],
    description: "Node render · " + size.width + " × " + size.height,
    prompt,
  };
}
