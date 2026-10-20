import type { ToolDef } from "./mcp";
import { lipSyncTools } from "./lipSync";

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
 *   behalf, and a `maxCredits` in the arguments is refused. The call returns the priced, prepared job and says it needs a person's approval, and nothing is started or
 *   spent. There is no Auto (owner, 20 Oct 2026: "Auto goes: every job is approved on its quote"): the stored setting `spendWithoutAsking` is no longer read, and
 *   whatever it holds ("auto" included) a call here starts nothing. A token that may not spend is refused by the route (requireRender); consent is only ever read by these tools.
 * - Declared once beside each engine's handler (`LIP_SYNC_TOOL`, ...); this file only maps them to MCP's shape. Names are the registry's tool ids.
 */
type Args = Record<string, string | number | boolean | undefined>;
type Call = (path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) => Promise<Record<string, unknown>>;

type DirectTool = {
  def: ToolDef;
  present: () => Promise<boolean>;
  /** The route and the body to send, from the tool's arguments; throws a sentence for an argument that is wrong. */
  request: (args: Args) => { path: string; body: Record<string, unknown> };
  /** One line saying what was prepared, for the "needs a person" answer. */
  prepared?: (body: Record<string, unknown>) => string;
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** Lip-sync over MCP: priced and prepared for a person, whichever model (lipsync-2, lipsync-2-pro, the default, or sync-3). */
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
  prepared: (b) => `prepared: lip-sync (${String(b.model ?? "lipsync-2-pro")}) of ${String(b.clipUploadId ?? b.clipGenId ?? "a clip")} with ${String(b.audioUploadId ?? b.audioGenId ?? "a voice track")}${b.projectId ? ` for production ${String(b.projectId)}` : ""}`,
};

const REGISTRY: DirectTool[] = [LIP_SYNC];

/** The direct engines' tools present for this workspace, in MCP's shape. */
export async function directEngineMcpTools(): Promise<ToolDef[]> {
  const out: ToolDef[] = [];
  for (const tool of REGISTRY) if (await tool.present()) out.push(tool.def);
  return out;
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
    const filed = await fileForPerson(name, clean, line, call);
    if (!("id" in filed)) throw error;
    return `Prepared, not started.\n\n${line}\nprepared job: ${filed.id}\n\nThis needs a person's approval: nothing was started or spent. It waits in Particl › Settings › Connections, where its price is shown.`;
  }
  if (typeof quote.estimatedCredits !== "number" || !Number.isInteger(quote.estimatedCredits) || quote.estimatedCredits < 0 || typeof quote.price !== "number" || !Number.isFinite(quote.price))
    throw new Error("This could not be priced, so nothing was started.");
  const priceText = quote.unit === "usd" ? `$${Number(quote.price).toFixed(2)}` : `${quote.estimatedCredits} cr`;
  /* Priced and prepared, never started: only a person approves it, at its price (no Auto since 20 Oct 2026). */
  const line = tool.prepared ? tool.prepared(clean) : name;
  const filed = await fileForPerson(name, clean, line, call);
  return `${"id" in filed ? "Priced and prepared" : "Priced"}, not started.\n\nprice: ${priceText}\n${line}\n${filedWords(filed)}`;
}
