import type { Asset, CanvasNode, Project } from "./studio";

export const MOLECULR_FORMATS = [
  {
    id: "ugc-review",
    label: "UGC review",
    description: "A first-person product story.",
  },
  {
    id: "tutorial",
    label: "Tutorial",
    description: "Show how it works, step by step.",
  },
  {
    id: "unboxing",
    label: "Unboxing",
    description: "Reveal the product and its details.",
  },
  {
    id: "try-on",
    label: "Try-on",
    description: "Cast, styling and product in context.",
  },
  {
    id: "cgi",
    label: "CGI product",
    description: "Build a considered product world.",
  },
  {
    id: "cinematic-demo",
    label: "Cinematic demo",
    description: "A product film with a strong visual idea.",
  },
  {
    id: "poster",
    label: "Poster",
    description: "One frame, one clear message.",
  },
  {
    id: "marketplace",
    label: "Marketplace image",
    description: "Clear, accurate product imagery.",
  },
  {
    id: "motion",
    label: "Motion graphic",
    description: "Rhythm, graphic language and movement.",
  },
] as const;
export type MoleculrFormat = (typeof MOLECULR_FORMATS)[number]["id"];
export type MoleculrMarketing = {
  quality: "low" | "medium" | "high";
  enhancePrompt: boolean;
  presetId?: string;
  presetName?: string;
};
export type MoleculrGenerationOptions = {
  modelId?: string;
  marketing?: Omit<MoleculrMarketing, "presetName">;
  referenceAssetIds?: string[];
};
export type MoleculrBrief = {
  marketing?: MoleculrMarketing;
  productName: string;
  productUrl: string;
  productAssetIds: string[];
  castAssetIds: string[];
  format: MoleculrFormat;
  hooks: string[];
  notes: string;
  variants: {
    id: string;
    nodeId: string;
    hook: string;
    castAssetId?: string;
  }[];
};
export const EMPTY_MOLECULR: MoleculrBrief = {
  productName: "",
  productUrl: "",
  productAssetIds: [],
  castAssetIds: [],
  format: "cinematic-demo",
  hooks: [],
  notes: "",
  variants: [],
};
export function moleculrReferences(
  project: Project,
  brief: MoleculrBrief,
  castId?: string,
): Asset[] {
  const ids = [
    ...new Set([
      ...brief.productAssetIds,
      ...(castId ? [castId] : brief.castAssetIds),
    ]),
  ];
  const assets = new Map(
    project.assets
      .filter((asset) => asset.kind === "image")
      .map((asset) => [asset.id, asset]),
  );
  return ids
    .map((id) => assets.get(id))
    .filter((asset): asset is Asset => !!asset);
}
/** Provider enhancement assigns meaning by position: product, then optional cast. */
export function marketingReferenceIds(
  project: Project,
  brief: MoleculrBrief,
  productId?: string,
  castId?: string,
): string[] {
  const images = new Set(
    project.assets
      .filter((asset) => asset.kind === "image")
      .map((asset) => asset.id),
  );
  const product =
    productId ?? brief.productAssetIds.find((id) => images.has(id));
  if (
    !product ||
    !brief.productAssetIds.includes(product) ||
    !images.has(product)
  )
    return [];
  return [
    ...new Set([
      product,
      ...(castId && brief.castAssetIds.includes(castId) && images.has(castId)
        ? [castId]
        : []),
    ]),
  ];
}
export function moleculrPrompt(
  project: Project,
  brief: MoleculrBrief,
  hook: string,
  castId?: string,
) {
  const format = MOLECULR_FORMATS.find((item) => item.id === brief.format)!;
  const cast = project.assets.find(
    (asset) => asset.id === castId && asset.kind === "image",
  );
  return [
    `Create a ${format.label.toLowerCase()} for ${(brief.productName || project.name).slice(0, 200)}.`,
    `Campaign hook: ${hook.trim() || "Introduce the product clearly."}`,
    brief.productUrl &&
      `Product reference URL (context only, not a fetched product description): ${brief.productUrl.slice(0, 500)}`,
    project.marketingBrief?.offer &&
      `Verified product / offer information: ${project.marketingBrief.offer.slice(0, 1600)}`,
    project.marketingBrief?.audience &&
      `Audience: ${project.marketingBrief.audience.slice(0, 600)}`,
    cast &&
      `Match the selected cast reference: ${cast.name}. ${cast.description.slice(0, 600)}`,
    brief.notes && `Direction: ${brief.notes.slice(0, 1500)}`,
    project.direction &&
      `Project visual language: ${project.direction.slice(0, 2000)}`,
    project.marketingBrief?.constraints &&
      `Constraints: ${project.marketingBrief.constraints.slice(0, 1500)}`,
    "Preserve the product geometry, packaging, labels and identity in the supplied references. Do not invent product claims or testimonials. Make a clean production plate; add final typography in post.",
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 12000);
}
export function moleculrNode(
  id: string,
  prompt: string,
  title: string,
  index: number,
  kind: "image" | "video",
): CanvasNode {
  return {
    id,
    title: title.slice(0, 300),
    type: "generate",
    text: prompt,
    x: 80 + (index % 3) * 340,
    y: 80 + Math.floor((index % 150) / 3) * 360,
    width: 300,
    linked: [],
    mode: kind === "video" ? "Video" : "Image",
    role: "Art director",
  };
}
export function variantAssets(project: Project, brief: MoleculrBrief) {
  const nodes = new Set(brief.variants.map((item) => item.nodeId));
  return project.assets.filter(
    (asset) => asset.nodeId && nodes.has(asset.nodeId),
  );
}
