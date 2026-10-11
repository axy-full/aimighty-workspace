import { EMPTY_MOLECULR, type MoleculrBrief } from "@/lib/workbench/moleculr";
import { createPoster, type PosterDocument, type PosterLayer } from "@/lib/workbench/moleculr-poster";
import { PROJECT_LIMITS } from "@/lib/workbench/project-limits";
import type { Asset, Project } from "@/lib/workbench/studio";

/*
 * The poster Designer's pure steps (the poster model is lib/workbench/moleculr-poster.ts; one poster per project, saved in
 * `brief.poster`). Free: nothing here calls an engine.
 */

/** The asset the project already holds for this one (same id, render or upload), else null. */
export function knownAsset(project: Pick<Project, "assets">, asset: Pick<Asset, "id" | "generationId" | "uploadId">): Asset | null {
  return project.assets.find((a) => a.id === asset.id || (!!asset.generationId && a.generationId === asset.generationId) || (!!asset.uploadId && a.uploadId === asset.uploadId)) ?? null;
}

/** A take adopted into the draft (kept with its render or upload identity), filed under `category`; null when the draft is full. */
export function withAsset(project: Project, asset: Asset, category: string): { project: Project; asset: Asset } | null {
  const known = knownAsset(project, asset);
  if (known) return { project, asset: known };
  if (project.assets.length >= PROJECT_LIMITS.assets) return null;
  const added: Asset = { ...asset, category };
  return { project: { ...project, assets: [...project.assets, added] }, asset: added };
}

const LINES = [(b: MoleculrBrief) => b.hooks.find((h) => h.trim())?.trim(), (b: MoleculrBrief) => b.brandKit?.tagline?.trim(), (b: MoleculrBrief) => b.productName.trim()];
/** The headline a new poster starts with: the first hook, else the brand's tagline, else the product's name, else the project's. */
export function posterHeadline(brief: MoleculrBrief | undefined, projectName: string): string {
  for (const pick of LINES) { const line = brief ? pick(brief) : undefined; if (line) return line.slice(0, 120); }
  return projectName.slice(0, 120) || "Your headline";
}

/**
 * The poster the Designer opens on: the one the project has, else a new one with a headline and a call to action and the
 * brand's first colour behind it (createPoster), with `image` as a layer when it came from a result.
 */
export function posterFor(project: Project, makeId: (prefix: string) => string, image?: Asset): { project: Project; poster: PosterDocument } {
  const brief = project.moleculr;
  if (brief?.poster && !image) return { project, poster: brief.poster };
  let next = project;
  let poster = brief?.poster ?? createPoster(posterHeadline(brief, project.name), () => makeId("poster"), brief?.brandKit?.colors[0] ?? "#141414");
  if (image) {
    const adopted = withAsset(project, image, "Campaign design");
    if (adopted) {
      next = adopted.project;
      const layer: PosterLayer = { id: makeId("layer"), kind: "image", name: adopted.asset.name.slice(0, 120) || "Image", assetId: adopted.asset.id, fit: "cover", x: 0, y: 0, width: 100, height: 100, opacity: 1, visible: true, locked: false };
      /* The image sits under the type: first in the stack, the layers drawn after it on top. */
      if (poster.layers.length < 40 && !poster.layers.some((l) => l.kind === "image" && l.assetId === adopted.asset.id)) poster = { ...poster, layers: [layer, ...poster.layers] };
    }
  }
  const base: MoleculrBrief = next.moleculr ?? EMPTY_MOLECULR;
  return { project: { ...next, moleculr: { ...base, poster } }, poster };
}
