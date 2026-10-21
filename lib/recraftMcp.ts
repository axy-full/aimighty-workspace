import type { ToolDef } from "./mcp";
import { recraftTools } from "./recraftImage";
import { RECRAFT_DEFAULT_MODEL, RECRAFT_RASTER_MODELS } from "./recraft";

/**
 * Recraft as an outside agent over MCP sees it (rule 11), in the shape lib/directEngineMcp.ts registers its engines in: a definition, whether the tool is present for this workspace, the route and
 * body a call sends (the quote; the registry then prepares the job for a person), and the sentence the agent reads. THIS FILE DECLARES; the registry lists these and runs them. Nothing here
 * approves anything: a caller's `maxCredits` is refused by the registry. **None of these is started inside a token's ceiling** (no `startsInsideCeiling`: every call is priced and prepared for a
 * person, whatever the token and the workspace's settings; there is no Auto since 20 Oct 2026): a still from words is a paid render and background removal is a finishing step on a take that exists. The SVG tools (vector models, vectorize) are NOT in this list at all: they are declared in the
 * handler's registry as `unavailable` until an SVG sanitiser exists (lib/recraftImage.ts header), so an outside agent is never offered one.
 */
type Args = Record<string, string | number | boolean | undefined>;
export type RecraftDirectTool = {
  def: ToolDef;
  present: () => Promise<boolean>;
  request: (args: Args) => { path: string; body: Record<string, unknown> };
  describe: (out: Record<string, unknown>, quote: { estimatedCredits: number; price: number; unit: string }) => string;
  prepared: (body: Record<string, unknown>) => string;
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const COMMON = { project_id: { type: "string", description: "Optional: the production it is filed under." }, request_id: { type: "string", description: "Optional: unique to this job; a retried call with it gets back the job it started." } };
const price = (quote: { estimatedCredits: number; price: number; unit: string }) => (quote.unit === "usd" ? `$${Number(quote.price).toFixed(2)}` : `${quote.estimatedCredits} cr`);
const present = (id: string) => async () => (await recraftTools()).some((t) => t.id === id && !t.unavailable);

export const RECRAFT_IMAGE_TOOL: RecraftDirectTool = {
  def: {
    name: "recraft_image",
    description: "Make a still from words (Recraft). Priced first; a person approves it in Particl. Returns an image take id; collect it with get_render. Raster only: vector (SVG) output is not switched on.",
    inputSchema: { type: "object", properties: { prompt: { type: "string", description: "What to make, up to 1,000 characters." }, model: { type: "string", description: `${RECRAFT_RASTER_MODELS.join(" or ")} (default ${RECRAFT_DEFAULT_MODEL}).` }, size: { type: "string", description: "A size such as 1024x1024." }, style: { type: "string", description: "Optional: a Recraft style name." }, ...COMMON }, required: ["prompt"] },
  },
  present: present("recraft_image"),
  prepared: (b) => `prepared: ${String(b.model ?? RECRAFT_DEFAULT_MODEL)} still, ${String(b.size ?? "1024x1024")}`,
  request: (a) => ({ path: "/api/recraft", body: { tool: "image", prompt: str(a.prompt), model: str(a.model), size: str(a.size), style: str(a.style), projectId: str(a.project_id) } }),
  describe: (out, quote) => `Image started.\n\nid: ${String(out.id)}\nprice: ${price(quote)}\n\nCall get_render with this id to collect it.`,
};
export const RECRAFT_REMOVE_BACKGROUND_TOOL: RecraftDirectTool = {
  def: {
    name: "recraft_remove_background",
    description:
      "Cut the background out of a still of this workspace (Recraft); a transparent PNG take is added beside the original. Priced first; always asks a person. Returns an image take id; collect it with get_render.",
    inputSchema: { type: "object", properties: { source_upload_id: { type: "string", description: "An upload of this workspace (or source_take_id: one of its takes)." }, source_take_id: { type: "string" }, ...COMMON }, required: [] },
  },
  present: present("recraft_remove_background"),
  prepared: (b) => `prepared: background removal of ${String(b.sourceUploadId ?? b.sourceGenId ?? "a still")}`,
  request: (a) => ({ path: "/api/recraft", body: { tool: "remove_background", sourceUploadId: str(a.source_upload_id), sourceGenId: str(a.source_take_id), projectId: str(a.project_id) } }),
  describe: (out, quote) => `Background removal started.\n\nid: ${String(out.id)}\nprice: ${price(quote)}\n\nCall get_render with this id to collect it.`,
};
export const RECRAFT_DIRECT_TOOLS: RecraftDirectTool[] = [RECRAFT_IMAGE_TOOL, RECRAFT_REMOVE_BACKGROUND_TOOL];
