import type { ToolDef } from "./mcp";
import { lipSyncTools } from "./lipSync";
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
  prepared: (b) => `prepared: lip-sync (${String(b.model ?? "lipsync-2-pro")}) of ${String(b.clipUploadId ?? b.clipGenId ?? "a clip")} with ${String(b.audioUploadId ?? b.audioGenId ?? "a voice track")} for production ${String(b.projectId)}`,
  describe: (out, quote) => `Lip-sync started.\n\nid: ${String(out.id)}\nprice: ${quote.unit === "usd" ? `$${Number(quote.price).toFixed(2)}` : `${quote.estimatedCredits} cr`}\n\nCall get_render with this id to collect it.`,
};

const REGISTRY: DirectTool[] = [LIP_SYNC];

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
  const quote = (await call(path, { method: "POST", body: { ...clean, quoteOnly: true } })) as { estimatedCredits?: unknown; price?: unknown; unit?: unknown };
  if (typeof quote.estimatedCredits !== "number" || !Number.isInteger(quote.estimatedCredits) || quote.estimatedCredits < 0 || typeof quote.price !== "number" || !Number.isFinite(quote.price))
    throw new Error("This could not be priced, so nothing was started.");
  const priceText = quote.unit === "usd" ? `$${Number(quote.price).toFixed(2)}` : `${quote.estimatedCredits} cr`;
  /* Ask (the default), or Auto over the line: priced and prepared, not started. */
  if (!(await spendsWithoutAsking()) || quote.estimatedCredits > (await autoLineCredits()))
    return `Priced and prepared, not started.\n\nprice: ${priceText}\n${tool.prepared ? `${tool.prepared(clean)}\n` : ""}\nThis needs a person's approval: nothing was started or spent. A person approves it in Particl.`;
  /* Auto, at or under the line: the workspace's own standing setting approves it, at the price the server just gave. */
  const out = await call(path, { method: "POST", body: { ...clean, maxCredits: quote.estimatedCredits }, headers: requestId ? { "Idempotency-Key": `mcp-${name}:${requestId}` } : undefined });
  return tool.describe(out, { estimatedCredits: quote.estimatedCredits, price: quote.price, unit: String(quote.unit ?? "cr") });
}
