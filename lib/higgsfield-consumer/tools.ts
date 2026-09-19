/**
 * Media tools on the connected account: thin presets over the catalogue-driven
 * generation request. A tool fixes the output workflow, the candidate models,
 * and the source it works on (one image or one video, plus one audio track for
 * lip-sync); everything else — settings, media roles, pricing, submission,
 * collection — is the generic generation pipeline. Nothing here is sent to the
 * provider: the tool name only labels the job and constrains the request.
 *
 * Pure (no database, no network) so the browser form and the server share it.
 */
import {
  CatalogueError,
  isStandaloneModel,
  mediaKindForRole,
  validateGenerationRequest,
  type ConnectedCatalogue,
  type ConnectedMediaKind,
  type ConnectedModel,
  type ConnectedOutputType,
  type GenerationRequest,
} from "./catalogue";

export const CONNECTED_TOOL_NAMES = [
  "upscale_image",
  "upscale_video",
  "remove_background_image",
  "remove_background_video",
  "extend_canvas",
  "deflicker",
  "lip_sync",
] as const;
export type ConnectedToolName = (typeof CONNECTED_TOOL_NAMES)[number];
export type ConnectedTool = {
  name: ConnectedToolName;
  label: string;
  description: string;
  outputType: ConnectedOutputType;
  /** The one source file the tool transforms. */
  sourceKind: "image" | "video";
  /** Additional single files by kind (lip-sync: one audio track). */
  extraKinds: readonly ConnectedMediaKind[];
  /** Catalogue model ids that implement the tool, in preferred order. */
  models: readonly string[];
  /** Appended to the source name when the result is filed: "<source> · <suffix>". */
  suffix: string;
};
export const CONNECTED_TOOLS: readonly ConnectedTool[] = Object.freeze([
  { name: "upscale_image", label: "Upscale image", description: "Enhance and enlarge a project image.", outputType: "image", sourceKind: "image", extraKinds: [], models: ["bytedance_image_upscale", "topaz_image"], suffix: "upscaled" },
  { name: "upscale_video", label: "Upscale video", description: "Enhance and enlarge a project video.", outputType: "video", sourceKind: "video", extraKinds: [], models: ["video_upscale", "topaz_video", "bytedance_video_upscale"], suffix: "upscaled" },
  { name: "remove_background_image", label: "Remove background (image)", description: "Cut the subject out of a project image.", outputType: "image", sourceKind: "image", extraKinds: [], models: ["image_background_remover"], suffix: "background removed" },
  { name: "remove_background_video", label: "Remove background (video)", description: "Cut the subject out of a project video.", outputType: "video", sourceKind: "video", extraKinds: [], models: ["video_background_remover"], suffix: "background removed" },
  { name: "extend_canvas", label: "Extend canvas", description: "Outpaint a project image beyond its edges.", outputType: "image", sourceKind: "image", extraKinds: [], models: ["outpaint", "flux_2_pro_outpaint"], suffix: "extended" },
  { name: "deflicker", label: "Deflicker", description: "Smooth flicker in a project video.", outputType: "video", sourceKind: "video", extraKinds: [], models: ["video_deflicker"], suffix: "deflickered" },
  { name: "lip_sync", label: "Lip-sync", description: "Match a project video's mouth movement to an audio track.", outputType: "video", sourceKind: "video", extraKinds: ["audio"], models: ["sync_so"], suffix: "lip-synced" },
]);
export function findConnectedTool(name: string): ConnectedTool | null {
  return CONNECTED_TOOLS.find((tool) => tool.name === name) ?? null;
}
function reject(code: "tool_unknown" | "tool_model" | "tool_source", message: string): never {
  throw new CatalogueError(code, message);
}
export function requireConnectedTool(name: string): ConnectedTool {
  return findConnectedTool(name) ?? reject("tool_unknown", "Choose a tool from the list.");
}
/** The tool's candidate models that the connected catalogue actually lists,
 * with matching output type and a declared role for every file the tool needs. */
export function connectedToolModels(tool: ConnectedTool, catalogue: Pick<ConnectedCatalogue, "models">): ConnectedModel[] {
  return tool.models.flatMap((id) => {
    const model = catalogue.models.find((entry) => entry.id === id);
    if (!model || !isStandaloneModel(model) || model.outputType !== tool.outputType) return [];
    try {
      connectedToolRoles(tool, model);
      return [model];
    } catch {
      return [];
    }
  });
}
export type ConnectedToolRoles = { source: string; extras: { kind: ConnectedMediaKind; role: string }[] };
/** Which declared media role carries each file the tool needs, per model. */
export function connectedToolRoles(tool: ConnectedTool, model: ConnectedModel): ConnectedToolRoles {
  if (!tool.models.includes(model.id) || model.outputType !== tool.outputType)
    reject("tool_model", `${tool.label} does not run on ${model.name}.`);
  const roles = [...new Set(model.medias.flatMap((slot) => slot.roles))];
  const roleFor = (kind: ConnectedMediaKind) => {
    const role = roles.find((candidate) => mediaKindForRole(candidate) === kind);
    if (!role) reject("tool_source", `${model.name} does not declare a ${kind} input for ${tool.label}.`);
    return role!;
  };
  return { source: roleFor(tool.sourceKind), extras: tool.extraKinds.map((kind) => ({ kind, role: roleFor(kind) })) };
}
/**
 * Validates a tool request: the model must implement the tool, the medias
 * must be exactly one source (plus exactly one file per extra kind), and the
 * remainder is the generic catalogue validation. Returns the provider settings.
 */
export function validateToolRequest(tool: ConnectedTool, model: ConnectedModel, request: GenerationRequest) {
  const roles = connectedToolRoles(tool, model);
  const expected = [{ kind: tool.sourceKind as ConnectedMediaKind, role: roles.source }, ...roles.extras];
  if (!Array.isArray(request.medias)) reject("tool_source", `${tool.label} needs a source file.`);
  for (const { kind, role } of expected) {
    const count = request.medias.filter((media) => media.role === role && media.kind === kind).length;
    if (count === 0)
      reject("tool_source", kind === tool.sourceKind ? `${tool.label} needs one ${kind} from this project.` : `${tool.label} needs one ${kind} file from this project.`);
    if (count > 1) reject("tool_source", `${tool.label} takes exactly one ${kind} file.`);
  }
  if (request.medias.length !== expected.length)
    reject("tool_source", `${tool.label} accepts only ${expected.map((e) => `one ${e.kind}`).join(" and ")}.`);
  return validateGenerationRequest(model, request);
}
/** "<source name without extension> · <suffix>", bounded for the project library. */
export function connectedToolResultName(tool: ConnectedTool, sourceName: string) {
  const base = sourceName.replace(/\.[A-Za-z0-9]{1,5}$/, "").trim().slice(0, 100) || "Source";
  return `${base} · ${tool.suffix}`;
}
