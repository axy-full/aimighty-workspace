import type { ToolDef } from "./mcp";
import { lipSyncTools } from "./lipSync";
import { sarvamTools } from "./sarvamTools";
import { bflTools } from "./bflImage";
import { allSettings } from "./settings";
import { rigJobCeiling } from "./workbench/rig-agent-limits";
import { jobApprovalLineCredits } from "./approvalRule";
import { creditUsd } from "./creditTerms";

/**
 * The direct engines' tools (sync.so, and in the stack above it Sarvam and BFL) as an outside agent over MCP sees them (rule 11: the button, Make, a board
 * card, Atomik, a saved skill and an outside agent call the same tool, at the same price, through the same approval).
 *
 * - **Behind the same engine gate as the route.** A tool is listed, and callable, only where its own `*Tools()` says it is present for this workspace
 *   (its switch is on and the workspace is the house or on the engine list, and for lip-sync where its face gate can run). Anywhere else it is not in the list
 *   and a call says there is no such tool.
 * - **The same door and the same price.** A call goes to the engine's own route as the caller (lib/mcp.ts makeCaller: the workspace's own token, its scope and its
 *   monthly ceiling) and asks the route for the quote (`quoteOnly`).
 * - **Only a person approves spending** (rule 14: "an approval written by agent:* or an MCP caller is refused"). The call NEVER sends the quote as `maxCredits` on the caller's
 *   behalf, and a `maxCredits` in the arguments is refused. What follows is the workspace's own spending setting, `spendWithoutAsking` (Ask by default; lib/workbench/
 *   rig-agent-limits.ts): in **Ask** the call returns the priced, prepared job and says it needs a person's approval, and nothing is started or spent; in **Auto** it may start the
 *   job only when its price is at or under the per-job line (the Rig's line, and never above guardrail 4, SOW 7A: 200 cr at $0.10 a credit), the approval then being the workspace
 *   admin's standing choice, not the caller's; above the line it is prepared and asks a person. Nothing in the app yet lets an admin switch the setting to Auto (that screen is
 *   U1's), so until it does every MCP call here is Ask. A token that may not spend is refused by the route (requireRender); consent is only ever read by these tools.
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
  /** One line saying what was prepared, for the "needs a person" answer. */
  prepared?: (body: Record<string, unknown>) => string;
  /**
   * Is this call a DRAFT (the engine's cheap, quick model, or a step that renders nothing)? Auto may start only a draft at or under the line (rule 14: "a draft priced at or under the
   * per-job line runs without a tap"); a hero or full-quality model always asks. Absent means never a draft: it always asks.
   */
  draft?: (body: Record<string, unknown>) => boolean;
  /** False when the call's own arguments must not be kept anywhere (Sarvam's translation text: "kept nowhere"): it is then answered in words only, never filed as a prepared job. */
  file?: false;
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** lipsync-2 is the engine's draft model; lipsync-2-pro (the default) and sync-3 are full quality and always ask. */
const LIP_SYNC: DirectTool = {
  def: {
    name: "lip_sync",
    description:
      "Match a clip's mouth to a voice track (sync.so). Priced first; the job is sent at that price as its ceiling, and spends from the workspace's credit with a token " +
      "made to render. No face or voice is checked by Particl; the provider's own filters apply. " +
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
        project_id: { type: "string", description: "The production (optional)." },
        request_id: { type: "string", description: "Optional: unique to this job; a retried call with it gets back the job it started." },
      },
      required: [],
    },
  },
  present: async () => (await lipSyncTools()).length > 0,
  request: (a) => ({
    path: "/api/lipsync",
    body: {
      clipUploadId: str(a.clip_upload_id), clipGenId: str(a.clip_take_id), audioUploadId: str(a.audio_upload_id), audioGenId: str(a.audio_take_id),
      model: str(a.model), syncMode: str(a.sync_mode), projectId: str(a.project_id),
    },
  }),
  draft: (b) => b.model === "lipsync-2",
  prepared: (b) => `prepared: lip-sync (${String(b.model ?? "lipsync-2-pro")}) of ${String(b.clipUploadId ?? b.clipGenId ?? "a clip")} with ${String(b.audioUploadId ?? b.audioGenId ?? "a voice track")}${b.projectId ? ` for production ${String(b.projectId)}` : ""}`,
  describe: (out, quote) => `Lip-sync started.\n\nid: ${String(out.id)}\nprice: ${quote.unit === "usd" ? `$${Number(quote.price).toFixed(2)}` : `${quote.estimatedCredits} cr`}\n\nCall get_render with this id to collect it.`,
};

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
/** A Sarvam tool is present when the engine is on here AND it can be priced (a tool that cannot be priced cannot run). */
const sarvamPresent = (id: string) => async () => (await sarvamTools()).some((t) => t.id === id && !("unavailable" in t && t.unavailable));
const SARVAM_PROJECT = { project_id: { type: "string", description: "Optional: the production it is filed under." } };

const SARVAM_SPEECH: DirectTool = {
  def: {
    name: "sarvam_speech",
    description: "Speak a line in an Indian language or English (Sarvam Bulbul, a stock voice: no cloning). Priced first; a person approves it in Particl (or the workspace lets small jobs run). Returns an audio take id; collect it with get_render.",
    inputSchema: { type: "object", properties: { text: { type: "string", description: "Up to 2,500 characters." }, language: { type: "string", description: "A code such as hi-IN or en-IN." }, model: { type: "string", description: "bulbul:v3 (default) or bulbul:v4-flash." }, voice: { type: "string", description: "A stock voice's name. Optional." }, pace: { type: "number", description: "0.5 to 2. Optional." }, ...SARVAM_PROJECT, request_id: { type: "string", description: "Optional: unique to this job; a retried call with it gets back the job it started." } }, required: ["text", "language"] },
  },
  present: sarvamPresent("sarvam_speech"),
  /* The flash model is the draft; bulbul:v3 (the default) is full quality and always asks. */
  draft: (b) => b.model === "bulbul:v4-flash",
  prepared: (b) => `prepared: speech (${String(b.model ?? "bulbul:v3")}, ${String(b.language)}), ${[...String(b.text ?? "")].length} characters`,
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
  /* Not a render: a short transcript is a working step, so it is a draft at any setting. */
  draft: () => true,
  prepared: (b) => `prepared: transcript of ${String(b.sourceUploadId ?? b.sourceGenId ?? "an audio clip")}`,
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
  /* Not a render (a draft at any setting), and its text is kept nowhere, so it is never filed as a prepared job. */
  draft: () => true,
  file: false,
  prepared: (b) => `prepared: translation ${String(b.source)} to ${String(b.target)}, ${[...String(b.text ?? "")].length} characters`,
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
    description: "Make a still from words (FLUX.2, Black Forest Labs). Priced first; a person approves it in Particl (or the workspace lets small jobs run). Returns an image take id; collect it with get_render.",
    inputSchema: { type: "object", properties: { prompt: { type: "string", description: "What to make." }, ...SIZE, seed: { type: "number" }, ...BFL_COMMON }, required: ["prompt"] },
  },
  present: bflPresent("flux2_image"),
  /* flux-2-pro (the default, the cheapest) is the draft; flux-2-flex and flux-2-max are full quality and always ask. */
  draft: (b) => (b.model ?? "flux-2-pro") === "flux-2-pro",
  prepared: (b) => `prepared: ${String(b.model ?? "flux-2-pro")} still, ${String(b.width ?? 1024)} by ${String(b.height ?? 1024)}`,
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
  draft: (b) => (b.model ?? "flux-2-pro") === "flux-2-pro",
  prepared: (b) => `prepared: ${String(b.model ?? "flux-2-pro")} edit of ${Array.isArray(b.references) ? b.references.length : 0} reference(s) for production ${String(b.projectId)}`,
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

/** The most a call may start without a person: the Rig's per-job line, and never above the approval line (guardrail 4). */
async function autoLineCredits(): Promise<number> {
  return Math.min(await rigJobCeiling(), jobApprovalLineCredits(creditUsd()));
}
/** The workspace's spending setting: only an exact "auto" lets a call start; anything else, or none, is Ask. */
async function spendsWithoutAsking(): Promise<boolean> {
  try { return (await allSettings()).spendWithoutAsking === "auto"; } catch { return false; }
}

/**
 * Files the prepared job for a person through the existing prepared-jobs door (POST /api/prepared-jobs), as an outside agent's prepared render is filed. It prices, holds and sends nothing.
 * Only a token made to prepare may file one (a render token is refused there by design), and the door refuses an approval, a price, text or file bytes inside a list.
 * Returns `{ id }` when it was filed, or `{ refused }` with the door's plain reason when it was not: a job is never said to be filed unless it was.
 */
async function fileForPerson(name: string, clean: Record<string, unknown>, line: string, call: Call): Promise<{ id: string } | { refused: string }> {
  try {
    const { quoteOnly: _q, ...args } = clean;
    void _q;
    const out = (await call("/api/prepared-jobs", { method: "POST", body: { engine: name, args, prompt: line, project: typeof clean.projectId === "string" ? clean.projectId : undefined } })) as { job?: { id?: unknown } };
    return typeof out.job?.id === "string" ? { id: out.job.id } : { refused: "Particl did not take it." };
  } catch (error) { return { refused: error instanceof Error && error.message ? error.message.slice(0, 160) : "Particl did not take it." }; }
}
/** A tool whose own text is kept nowhere is never filed; it is answered in words, plainly. */
const NOT_KEPT = { refused: "this tool's text is kept nowhere, so it cannot be kept for a person." } as const;
/** What the agent reads about the job it asked for: the filed id, or plainly that nothing was filed and what the person does instead. */
const filedWords = (filed: { id: string } | { refused: string } | null, why?: string) =>
  filed && "id" in filed
    ? `prepared job: ${filed.id}\n\nThis needs a person's approval: nothing was started or spent. It waits in Particl › Settings › Connections for a person.`
    : `Nothing was filed: ${filed ? filed.refused : why ?? "this tool's arguments are not kept"}\n\nThis needs a person's approval: nothing was started or spent. A person can make this themselves in Particl, where its price is shown before they approve it.`;

/** Runs one of them, or returns null when the name is none of these (the caller then tries its own tools). */
export async function runDirectEngineTool(name: string, args: Args, call: Call): Promise<string | null> {
  const tool = REGISTRY.find((t) => t.def.name === name);
  if (!tool) return null;
  if (!(await tool.present())) throw new Error("There is no such tool here.");
  if ("maxCredits" in args || "max_credits" in args) throw new Error("The price is not yours to approve: only a person approves spending.");
  const requestId = args.request_id;
  if (requestId !== undefined && (typeof requestId !== "string" || !/^[A-Za-z0-9._:-]{1,120}$/.test(requestId)))
    throw new Error("request_id must be 1–120 letters, digits, dots, colons, dashes or underscores.");
  const { path, body } = tool.request(args);
  const clean = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
  /* A token made to prepare jobs cannot ask the paid door anything (not even for a price): its call is filed for a person, unpriced; a person sees the price when approving. */
  let quote: { estimatedCredits?: unknown; price?: unknown; unit?: unknown };
  try { quote = (await call(path, { method: "POST", body: { ...clean, quoteOnly: true } })) as typeof quote; }
  catch (error) {
    if (!(error instanceof Error) || !/This token prepares jobs/.test(error.message)) throw error;
    const line = tool.prepared ? tool.prepared(clean) : name;
    const filed = tool.file === false ? NOT_KEPT : await fileForPerson(name, clean, line, call);
    if (!("id" in filed)) throw error;
    return `Prepared, not started.\n\n${line}\nprepared job: ${filed.id}\n\nThis needs a person's approval: nothing was started or spent. It waits in Particl › Settings › Connections, where its price is shown.`;
  }
  if (typeof quote.estimatedCredits !== "number" || !Number.isInteger(quote.estimatedCredits) || quote.estimatedCredits < 0 || typeof quote.price !== "number" || !Number.isFinite(quote.price))
    throw new Error("This could not be priced, so nothing was started.");
  const priceText = quote.unit === "usd" ? `$${Number(quote.price).toFixed(2)}` : `${quote.estimatedCredits} cr`;
  /* Ask (the default), Auto over the line, or Auto on anything but a draft: priced and prepared, not started. */
  if (!(await spendsWithoutAsking()) || !(tool.draft?.(clean) ?? false) || quote.estimatedCredits > (await autoLineCredits())) {
    const line = tool.prepared ? tool.prepared(clean) : name;
    const filed = tool.file === false ? NOT_KEPT : await fileForPerson(name, clean, line, call);
    return `${"id" in filed ? "Priced and prepared" : "Priced"}, not started.\n\nprice: ${priceText}\n${line}\n${filedWords(filed)}`;
  }
  /* Auto, at or under the line: the workspace's own standing setting approves it, at the price the server just gave. */
  const out = await call(path, { method: "POST", body: { ...clean, maxCredits: quote.estimatedCredits }, headers: requestId ? { "Idempotency-Key": `mcp-${name}:${requestId}` } : undefined });
  return tool.describe(out, { estimatedCredits: quote.estimatedCredits, price: quote.price, unit: String(quote.unit ?? "cr") });
}
