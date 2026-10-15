import type { ToolDef } from "./mcp";
import { topazTools } from "./topazUpscale";
import { DEFAULT_ASTRA } from "./astra";
import { DEFAULT_TOPAZ_IMAGE, TOPAZ_IMAGE_PRESETS } from "./topaz";

/**
 * Topaz upscale as an outside agent over MCP sees it (rule 11), in the shape lib/directEngineMcp.ts registers its engines in: a definition, whether the tool is present for this workspace, the
 * route and body a call sends (the quote first, then, only where the workspace's spending setting lets a call start it, the job), and the sentence the agent reads. THIS FILE DECLARES; the
 * registry (lib/directEngineMcp.ts, lane B's file) lists these and runs them. Nothing here approves anything: a caller's `maxCredits` is refused by the registry, and an upscale is a finishing
 * step on a take that already exists, so it is declared HERO: it always asks a person, in Ask and in Auto alike.
 */
type Args = Record<string, string | number | boolean | undefined>;
export type TopazDirectTool = {
  def: ToolDef;
  present: () => Promise<boolean>;
  /** A finishing step: priced and prepared for a person, never started by a caller on its own. */
  tier: "hero";
  request: (args: Args) => { path: string; body: Record<string, unknown> };
  describe: (out: Record<string, unknown>, quote: { estimatedCredits: number; price: number; unit: string }) => string;
  prepared: (body: Record<string, unknown>) => string;
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const SOURCE = { source_upload_id: { type: "string", description: "An upload of this workspace (or source_take_id: one of its takes)." }, source_take_id: { type: "string" } };
const COMMON = { project_id: { type: "string", description: "Optional: the production it is filed under." }, request_id: { type: "string", description: "Optional: unique to this job; a retried call with it gets back the job it started." } };
const price = (quote: { estimatedCredits: number; price: number; unit: string }) => (quote.unit === "usd" ? `$${Number(quote.price).toFixed(2)}` : `${quote.estimatedCredits} cr`);

export const TOPAZ_UPSCALE_IMAGE: TopazDirectTool = {
  def: {
    name: "topaz_upscale_image",
    description: "Upscale a still of this workspace with Topaz (a Gigapixel preset). Priced first; a person approves it in Particl. Returns an image take id; collect it with get_render.",
    inputSchema: { type: "object", properties: { ...SOURCE, model: { type: "string", description: `A preset: ${TOPAZ_IMAGE_PRESETS.join(", ")} (default ${DEFAULT_TOPAZ_IMAGE.model}).` }, factor: { type: "number", description: "1, 2 (default) or 4." }, face_enhancement: { type: "boolean", description: "Off by default." }, face_strength: { type: "number", description: "0 to 1, default 0.5." }, ...COMMON }, required: [] },
  },
  present: async () => (await topazTools()).some((t) => t.id === "topaz_upscale_image"),
  tier: "hero",
  prepared: (b) => `prepared: Topaz upscale of ${String(b.sourceUploadId ?? b.sourceGenId ?? "a still")} (${String((b.topaz as { model?: string } | undefined)?.model ?? DEFAULT_TOPAZ_IMAGE.model)}, ${String((b.topaz as { factor?: number } | undefined)?.factor ?? DEFAULT_TOPAZ_IMAGE.factor)}x)`,
  request: (a) => ({
    path: "/api/topaz",
    body: {
      tool: "image", sourceUploadId: str(a.source_upload_id), sourceGenId: str(a.source_take_id), projectId: str(a.project_id),
      topaz: { model: str(a.model) ?? DEFAULT_TOPAZ_IMAGE.model, factor: num(a.factor) ?? DEFAULT_TOPAZ_IMAGE.factor, faceEnhancement: a.face_enhancement === true, faceStrength: num(a.face_strength) ?? DEFAULT_TOPAZ_IMAGE.faceStrength },
    },
  }),
  describe: (out, quote) => `Upscale started.\n\nid: ${String(out.id)}\nprice: ${price(quote)}\n\nCall get_render with this id to collect it.`,
};

export const TOPAZ_UPSCALE_VIDEO: TopazDirectTool = {
  def: {
    name: "topaz_upscale_video",
    description: "Upscale a clip of this workspace to 4K with Topaz Astra 2. Priced first; a person approves it in Particl. Returns a video take id; collect it with get_render.",
    inputSchema: { type: "object", properties: { ...SOURCE, creativity: { type: "number", description: "0 to 1, default 0.5." }, realism: { type: "number", description: "0 to 1, default 0.5." }, sharpness: { type: "number", description: "0 to 1, default 0.5." }, fps: { type: "number", description: "30 (default) or 60." }, ...COMMON }, required: [] },
  },
  present: async () => (await topazTools()).some((t) => t.id === "topaz_upscale_video"),
  tier: "hero",
  prepared: (b) => `prepared: Topaz Astra 2 upscale of ${String(b.sourceUploadId ?? b.sourceGenId ?? "a clip")} at ${String((b.astra as { fps?: number } | undefined)?.fps ?? DEFAULT_ASTRA.fps)} fps`,
  request: (a) => ({
    path: "/api/topaz",
    body: {
      tool: "video", sourceUploadId: str(a.source_upload_id), sourceGenId: str(a.source_take_id), projectId: str(a.project_id),
      astra: { creativity: num(a.creativity) ?? DEFAULT_ASTRA.creativity, realism: num(a.realism) ?? DEFAULT_ASTRA.realism, sharpness: num(a.sharpness) ?? DEFAULT_ASTRA.sharpness, fps: num(a.fps) ?? DEFAULT_ASTRA.fps },
    },
  }),
  describe: (out, quote) => `Upscale started.\n\nid: ${String(out.id)}\nprice: ${price(quote)}\n\nCall get_render with this id to collect it.`,
};

/** For the registry (lib/directEngineMcp.ts) to list. */
export const TOPAZ_DIRECT_TOOLS: TopazDirectTool[] = [TOPAZ_UPSCALE_IMAGE, TOPAZ_UPSCALE_VIDEO];
