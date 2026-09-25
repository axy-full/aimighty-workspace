import { now } from "@/lib/db";
import { workbenchTransaction } from "@/lib/workbench/records";
import { PROJECT_LIMITS } from "@/lib/workbench/project-limits";
import type { Asset } from "@/lib/workbench/studio";
import type { ConsumerOriginalKind } from "./original-identity";
import { connectedToolResultName, findConnectedTool, type ConnectedToolName } from "./tools";

/**
 * Filing a collected connected-account original into its project, on the
 * server, when the job completes — whoever asked for its status (the page, or
 * the cron sweep after the person left). It was the Gen composer's own effect
 * in the browser, so a take finished only while the composer stayed open.
 *
 * Only jobs quoted with `fileToProject` are filed here: other surfaces (Cast,
 * Atomik's explicit Save) file on their own terms, into their own categories.
 * Nothing here spends: it appends one asset to the owner's saved draft, under
 * the same write transaction every save uses, and never replaces a draft.
 */
export type ConsumerFiling = "filed" | "present" | "missing" | "full" | "unavailable";

export type ConsumerTakeInput = {
  generationId: string;
  url: string;
  kind: ConsumerOriginalKind;
  mime: string;
  credits: number;
  modelName: string;
  prompt: string;
  /** The account rewrote the prompt before rendering (`enhance_prompt`). */
  enhanced: boolean;
  /** A media tool preset: the result is named after its source, like Atomik's Tools. */
  tool?: { name: ConnectedToolName; sourceName: string } | null;
};

/** The project asset a Gen take becomes — the shape the composer filed in the browser. */
export function consumerTakeAsset(input: ConsumerTakeInput): Asset {
  const tool = input.tool ? findConnectedTool(input.tool.name) : null;
  const base = tool ? connectedToolResultName(tool, input.tool!.sourceName) : `${input.modelName} · ${input.prompt.slice(0, 80)}`;
  return {
    id: input.generationId,
    generationId: input.generationId,
    url: input.url,
    kind: input.kind === "model" ? "document" : input.kind,
    mime: input.mime,
    name: base.slice(0, 160),
    category: tool ? "Tools" : "Generate",
    description: `${tool ? `${tool.label} · ` : ""}${input.modelName} · ${input.credits} connected credits${input.enhanced ? " · enhanced on the account" : ""}`,
    prompt: input.prompt,
    status: "Draft",
    version: 1,
    locked: false,
    refs: [],
  };
}

/**
 * Append one collected original to the owner's draft unless it is already
 * there. Scoped by owner and draft inside this tenant's database; the stored
 * generation must still exist and not be deleted. Idempotent: a second call,
 * or the composer's own fallback, finds it and does nothing.
 */
export async function fileConsumerOriginal(owner: string, draftId: string, asset: Asset): Promise<ConsumerFiling> {
  const generationId = asset.generationId;
  if (!generationId || asset.id !== generationId) return "unavailable";
  return workbenchTransaction(async (tx) => {
    const row = (await tx.execute({ sql: "SELECT body,revision FROM workbench_projects WHERE owner=? AND project_id=?", args: [owner, draftId] })).rows[0];
    if (!row) return "missing";
    let body: { assets?: unknown } | null;
    try { body = JSON.parse(String(row.body)); } catch { return "missing"; }
    if (!body || typeof body !== "object" || !Array.isArray(body.assets)) return "missing";
    const assets = body.assets as Partial<Asset>[];
    if (assets.some((item) => item?.id === asset.id || item?.generationId === generationId)) return "present";
    if (assets.length >= PROJECT_LIMITS.assets) return "full";
    const live = await tx.execute({ sql: "SELECT 1 FROM generations WHERE id=? AND deleted=0", args: [generationId] });
    if (!live.rows.length) return "unavailable";
    const changed = await tx.execute({
      sql: "UPDATE workbench_projects SET body=?,revision=revision+1,updated_at=? WHERE owner=? AND project_id=? AND revision=?",
      args: [JSON.stringify({ ...body, assets: [...assets, asset] }), now(), owner, draftId, Number(row.revision)],
    });
    return changed.rowsAffected === 1 ? "filed" : "missing";
  });
}
