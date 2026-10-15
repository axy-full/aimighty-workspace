import type { ToolDef } from "./mcp";
import { lipSyncTools } from "./lipSync";
import { sarvamTools } from "./sarvamTools";
import { bflTools } from "./bflImage";

/**
 * The direct engines' tools (sync.so, and in the stack above it Sarvam and BFL) as an outside agent over MCP sees them (rule 11: the button, Make, a board
 * card, Atomik, a saved skill and an outside agent call the same tool, at the same price, through the same approval).
 *
 * - **Behind the same engine gate as the route.** A tool is listed, and callable, only where its own `*Tools()` says it is present for this workspace
 *   (its switch is on and the workspace is the house or on the engine list, and for lip-sync where its face gate can run). Anywhere else it is not in the list
 *   and a call says there is no such tool.
 * - **The same door and the same price.** A call goes to the engine's own route as the caller (lib/mcp.ts makeCaller: the workspace's own token, its scope and its
 *   monthly ceiling), asks the route for the quote (`quoteOnly`), and sends the job with that quote as its ceiling. **The caller never writes the approval**: a
 *   `maxCredits` in the arguments is refused. A token that may not spend (read, prepare) is refused by the route (requireRender); a job above the approval line is
 *   refused to a machine by the route's guardrail 4; consent is only ever read, never recorded, by these tools. The spend a render token allows is the cap the person
 *   gave it, as for render_shot.
 * - Declared once beside each engine's handler (`LIP_SYNC_TOOL`, ...); this file only maps them to MCP's shape. Names are the registry's tool ids.
 */
type Args = Record<string, string | number | boolean | undefined>;
type Call = (path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) => Promise<Record<string, unknown>>;

type DirectTool = {
  def: ToolDef;
  present: () => Promise<boolean>;
  /** The route and the body to send, from the tool's arguments; throws a sentence for an argument that is wrong. */
  request: (args: Args) => { path: string; body: Record<string, unknown> };
  /** A sentence for the agent from the route's answer to the job. */
  describe: (out: Record<string, unknown>, quote: { estimatedCredits: number; price: number; unit: string }) => string;
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

const LIP_SYNC: DirectTool = {
  def: {
    name: "lip_sync",
    description:
      "Match a clip's mouth to a voice track (sync.so). Priced first; the job is sent at that price as its ceiling, and spends from the workspace's credit with a token " +
      "made to render. Every face passes the consent gate first: it needs the cast member's live consent, a still of the face, the production and what it is for. " +
      "Returns an id; collect it with get_render.",
    inputSchema: {
      type: "object",
      properties: {
        clip_upload_id: { type: "string", description: "A video of this workspace (or clip_take_id: one of its takes)." },
        clip_take_id: { type: "string" },
        audio_upload_id: { type: "string", description: "The voice track (or audio_take_id: a speech take)." },
        audio_take_id: { type: "string" },
        model: { type: "string", description: "lipsync-2, lipsync-2-pro (default) or sync-3." },
        sync_mode: { type: "string", description: "How a length mismatch is handled: bounce (default), loop, cut_off, silence or remap." },
        cast_member_id: { type: "string", description: "Who is in the clip." },
        face_frame_upload_id: { type: "string", description: "A still of their face (an image of this workspace)." },
        project_id: { type: "string", description: "The production." },
        use: { type: "string", description: "production, ads or social." },
        request_id: { type: "string", description: "Optional: unique to this job; a retried call with it gets back the job it started." },
      },
      required: ["cast_member_id", "face_frame_upload_id", "project_id", "use"],
    },
  },
  present: async () => (await lipSyncTools()).length > 0,
  request: (a) => ({
    path: "/api/lipsync",
    body: {
      clipUploadId: str(a.clip_upload_id), clipGenId: str(a.clip_take_id), audioUploadId: str(a.audio_upload_id), audioGenId: str(a.audio_take_id),
      model: str(a.model), syncMode: str(a.sync_mode), castMemberId: str(a.cast_member_id), faceFrameUploadId: str(a.face_frame_upload_id), projectId: str(a.project_id), use: str(a.use),
    },
  }),
  describe: (out, quote) => `Lip-sync started.\n\nid: ${String(out.id)}\nprice: ${quote.unit === "usd" ? `$${Number(quote.price).toFixed(2)}` : `${quote.estimatedCredits} cr`}\n\nCall get_render with this id to collect it.`,
};

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
/** A Sarvam tool is present when the engine is on here AND it can be priced (a tool that cannot be priced cannot run). */
const sarvamPresent = (id: string) => async () => (await sarvamTools()).some((t) => t.id === id && !("unavailable" in t && t.unavailable));
const SARVAM_PROJECT = { project_id: { type: "string", description: "Optional: the production it is filed under." } };

const SARVAM_SPEECH: DirectTool = {
  def: {
    name: "sarvam_speech",
    description: "Speak a line in an Indian language or English (Sarvam Bulbul, a stock voice: no cloning). Priced first; the job is sent at that price as its ceiling. Returns an audio take id; collect it with get_render.",
    inputSchema: { type: "object", properties: { text: { type: "string", description: "Up to 2,500 characters." }, language: { type: "string", description: "A code such as hi-IN or en-IN." }, model: { type: "string", description: "bulbul:v3 (default) or bulbul:v4-flash." }, voice: { type: "string", description: "A stock voice's name. Optional." }, pace: { type: "number", description: "0.5 to 2. Optional." }, ...SARVAM_PROJECT, request_id: { type: "string", description: "Optional: unique to this job; a retried call with it gets back the job it started." } }, required: ["text", "language"] },
  },
  present: sarvamPresent("sarvam_speech"),
  request: (a) => ({ path: "/api/sarvam", body: { tool: "speech", text: str(a.text), language: str(a.language), model: str(a.model), voice: str(a.voice), pace: num(a.pace), projectId: str(a.project_id) } }),
  describe: (out, quote) => `Speech made.\n\nid: ${String(out.id)}\nprice: ${quote.unit === "usd" ? `$${Number(quote.price).toFixed(2)}` : `${quote.estimatedCredits} cr`}\n\nCall get_render with this id to collect it.`,
};
const SARVAM_TRANSCRIBE: DirectTool = {
  def: {
    name: "sarvam_transcribe",
    description: "Transcribe a short audio clip of this workspace (under about 30 seconds; Sarvam Saaras). Priced first. The transcript is returned to you and kept nowhere.",
    inputSchema: { type: "object", properties: { source_upload_id: { type: "string", description: "An audio upload of this workspace (or source_take_id)." }, source_take_id: { type: "string" }, language: { type: "string", description: "A code such as hi-IN, or leave it to be detected." }, request_id: { type: "string" } }, required: [] },
  },
  present: sarvamPresent("sarvam_transcribe"),
  request: (a) => ({ path: "/api/sarvam", body: { tool: "transcribe", sourceUploadId: str(a.source_upload_id), sourceGenId: str(a.source_take_id), language: str(a.language) } }),
  describe: (out) => out.kept === false ? String(out.note) : `Transcript (${String(out.language ?? "language detected")}, ${String(out.seconds)} s):\n\n${String(out.transcript)}`,
};
const SARVAM_TRANSLATE: DirectTool = {
  def: {
    name: "sarvam_translate",
    description: "Translate text between English and Indian languages (Sarvam). Priced first. The translation is returned to you and kept nowhere.",
    inputSchema: { type: "object", properties: { text: { type: "string", description: "Up to 2,000 characters (1,000 on mayura:v1)." }, source: { type: "string", description: "A code such as en-IN." }, target: { type: "string", description: "A code such as ta-IN." }, model: { type: "string", description: "sarvam-translate:v1 (default) or mayura:v1." }, request_id: { type: "string" } }, required: ["text", "source", "target"] },
  },
  present: sarvamPresent("sarvam_translate"),
  request: (a) => ({ path: "/api/sarvam", body: { tool: "translate", text: str(a.text), source: str(a.source), target: str(a.target), model: str(a.model) } }),
  describe: (out) => (out.kept === false ? String(out.note) : String(out.text)),
};

const bflPresent = (id: string) => async () => (await bflTools()).some((t) => t.id === id);
const list = (v: unknown): string[] => (typeof v === "string" ? v.split(",").map((x) => x.trim()).filter(Boolean) : []);
const BFL_COMMON = { model: { type: "string", description: "flux-2-pro (default), flux-2-flex or flux-2-max." }, ...SARVAM_PROJECT, request_id: { type: "string", description: "Optional: unique to this job; a retried call with it gets back the job it started." } };
const SIZE = { width: { type: "number", description: "A multiple of 16, default 1024." }, height: { type: "number", description: "A multiple of 16, default 1024." } };

const FLUX2_IMAGE: DirectTool = {
  def: {
    name: "flux2_image",
    description: "Make a still from words (FLUX.2, Black Forest Labs). Priced first; the job is sent at that price as its ceiling. Returns an image take id; collect it with get_render.",
    inputSchema: { type: "object", properties: { prompt: { type: "string", description: "What to make." }, ...SIZE, seed: { type: "number" }, ...BFL_COMMON }, required: ["prompt"] },
  },
  present: bflPresent("flux2_image"),
  request: (a) => ({ path: "/api/bfl", body: { tool: "image", prompt: str(a.prompt), model: str(a.model), width: num(a.width), height: num(a.height), seed: num(a.seed), projectId: str(a.project_id) } }),
  describe: (out, quote) => `Image started.\n\nid: ${String(out.id)}\nprice: ${quote.unit === "usd" ? `$${Number(quote.price).toFixed(2)}` : `${quote.estimatedCredits} cr`}\n\nCall get_render with this id to collect it.`,
};
const FLUX2_EDIT: DirectTool = {
  def: {
    name: "flux2_edit",
    description:
      "Edit from one to eight reference images of this workspace (FLUX.2, Black Forest Labs). Priced first. Every reference passes the consent gate first: it needs the cast member each one shows, the production " +
      "and what it is for. Returns an image take id; collect it with get_render.",
    inputSchema: { type: "object", properties: { prompt: { type: "string", description: "What to change." }, reference_upload_ids: { type: "string", description: "Comma-separated upload ids, one to eight." }, cast_member_ids: { type: "string", description: "Comma-separated cast member ids, one per reference, in the same order." }, ...SIZE, use: { type: "string", description: "production, ads or social." }, seed: { type: "number" }, ...BFL_COMMON }, required: ["prompt", "reference_upload_ids", "cast_member_ids", "project_id", "use"] },
  },
  present: bflPresent("flux2_edit"),
  request: (a) => {
    const uploads = list(a.reference_upload_ids), cast = list(a.cast_member_ids);
    if (uploads.length !== cast.length) throw new Error("Give one cast member for each reference, in the same order.");
    return { path: "/api/bfl", body: { tool: "edit", prompt: str(a.prompt), model: str(a.model), width: num(a.width), height: num(a.height), seed: num(a.seed), projectId: str(a.project_id), use: str(a.use), references: uploads.map((uploadId, i) => ({ uploadId, castMemberId: cast[i] })) } };
  },
  describe: (out, quote) => `Edit started.\n\nid: ${String(out.id)}\nprice: ${quote.unit === "usd" ? `$${Number(quote.price).toFixed(2)}` : `${quote.estimatedCredits} cr`}\n\nCall get_render with this id to collect it.`,
};

const REGISTRY: DirectTool[] = [LIP_SYNC, SARVAM_SPEECH, SARVAM_TRANSCRIBE, SARVAM_TRANSLATE, FLUX2_IMAGE, FLUX2_EDIT];

/** The direct engines' tools present for this workspace, in MCP's shape. */
export async function directEngineMcpTools(): Promise<ToolDef[]> {
  const out: ToolDef[] = [];
  for (const tool of REGISTRY) if (await tool.present()) out.push(tool.def);
  return out;
}

/** Runs one of them, or returns null when the name is none of these (the caller then tries its own tools). */
export async function runDirectEngineTool(name: string, args: Args, call: Call): Promise<string | null> {
  const tool = REGISTRY.find((t) => t.def.name === name);
  if (!tool) return null;
  if (!(await tool.present())) throw new Error("There is no such tool here.");
  if ("maxCredits" in args || "max_credits" in args) throw new Error("The price is not yours to approve: it is asked of the server and sent as the job's ceiling, under your token's own cap.");
  const requestId = args.request_id;
  if (requestId !== undefined && (typeof requestId !== "string" || !/^[A-Za-z0-9._:-]{1,120}$/.test(requestId)))
    throw new Error("request_id must be 1–120 letters, digits, dots, colons, dashes or underscores.");
  const { path, body } = tool.request(args);
  const clean = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
  const quote = (await call(path, { method: "POST", body: { ...clean, quoteOnly: true } })) as { estimatedCredits?: unknown; price?: unknown; unit?: unknown };
  if (typeof quote.estimatedCredits !== "number" || !Number.isInteger(quote.estimatedCredits) || quote.estimatedCredits < 0 || typeof quote.price !== "number" || !Number.isFinite(quote.price))
    throw new Error("This could not be priced, so nothing was started.");
  const out = await call(path, { method: "POST", body: { ...clean, maxCredits: quote.estimatedCredits }, headers: requestId ? { "Idempotency-Key": `mcp-${name}:${requestId}` } : undefined });
  return tool.describe(out, { estimatedCredits: quote.estimatedCredits, price: quote.price, unit: String(quote.unit ?? "cr") });
}
