import { generationBrief } from "../workbench/node-graph";
import type { Asset, CanvasNode, Project } from "../workbench/studio";

/**
 * Production › Rig (owner's brief, 23 September): each shot's own prompt holds
 * up to 20,000 characters. What the engine receives is the shot's prompt, its
 * notes and a line per connected reference. Engines take 10,000 characters: a
 * longer render prompt is condensed by the agent (priced) and the condensed
 * text is pinned to the exact prompt it came from, so an edit asks again.
 */
export const RIG_PROMPT_LIMIT = 20_000;
export const ENGINE_PROMPT_LIMIT = 10_000;
export const CONDENSE_TARGET = 9_000;

/** FNV-1a (64-bit) of a text, hex: the same key in the browser and on the server, without async crypto. */
export function textKey(text: string): string {
  let hash = BigInt("0xcbf29ce484222325");
  const prime = BigInt("0x100000001b3"), mask = (BigInt(1) << BigInt(64)) - BigInt(1);
  for (let i = 0; i < text.length; i++) { hash ^= BigInt(text.charCodeAt(i)); hash = (hash * prime) & mask; }
  return hash.toString(16).padStart(16, "0");
}

const direction = (node: CanvasNode) => String(node.operations?.find((op) => op.kind === "direction")?.values.note ?? "").trim();

/** One line per connected input: what it is, and whether it is the first frame. */
function referenceLines(node: CanvasNode, project: Project): string[] {
  const assets = new Map([...project.assets, ...(project.sharedAssets ?? [])].map((a) => [a.id, a]));
  return node.linked.flatMap((id, i) => {
    const input = project.nodes.find((n) => n.id === id);
    if (!input) return [];
    const asset: Asset | undefined = input.assetId ? assets.get(input.assetId) : undefined;
    const what = [input.title, asset?.category && asset.category !== "Reference" ? `(${asset.category.toLowerCase()})` : ""].filter(Boolean).join(" ");
    const role = asset && node.firstFrameId === asset.id ? "first frame — the shot starts on this image" : asset?.kind === "video" ? "reference video" : asset ? "reference image" : "note";
    return [`Input ${i + 1} — ${what}: ${role}${!asset && input.text ? `. ${input.text.slice(0, 600)}` : ""}`];
  });
}

/** The prompt a shot renders with. A shot without its own prompt keeps the Rig's earlier composition (brief, direction, references). */
export function shotRenderPrompt(node: CanvasNode, project: Project): string {
  const own = node.text?.trim();
  if (!own) return generationBrief(node, project);
  const notes = direction(node);
  const refs = referenceLines(node, project);
  return [own, notes ? `Director's notes: ${notes}` : "", refs.length ? `Inputs:\n${refs.join("\n")}` : ""].filter(Boolean).join("\n\n");
}

export type RenderPrompt = { prompt: string; condensed: boolean } | { prompt: null; length: number };
/** What goes to the engine: the render prompt when it fits, the agent's condensed text when it is pinned to this exact prompt, else nothing. */
export function renderPromptFor(node: CanvasNode, project: Project): RenderPrompt {
  const full = shotRenderPrompt(node, project);
  if (full.trim().length <= ENGINE_PROMPT_LIMIT) return { prompt: full, condensed: false };
  if (node.condensed && node.condensed.key === textKey(full)) return { prompt: node.condensed.text, condensed: true };
  return { prompt: null, length: full.trim().length };
}
