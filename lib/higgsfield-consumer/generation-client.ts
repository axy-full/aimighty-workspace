import { consumerGenerationInputSchema, type ConsumerGenerationInput } from "./generation-contract";
import { CONNECTED_OUTPUT_TYPES, type ConnectedOutputType } from "./catalogue";
import { findConnectedTool, type ConnectedToolName } from "./tools";

/**
 * The browser side of the connected account's generation workflow, in one
 * place: the three request bodies POST /api/higgsfield/consumer/generation
 * takes, the saved-job shape it answers with, and the validated original that
 * may become a project asset.
 *
 * Extracted verbatim from components/suites/AtomikGenerate.tsx so the Atomik
 * Generate page and the workspace's global Generate composer quote, approve
 * and submit through one shape. The durable paid path itself lives server-side
 * in lib/higgsfield-consumer/generation-service.ts: a validated quote
 * (`get_cost`), the owner's approval of the exact connected-credit price and
 * wallet, then one admitted submit. Nothing here retries a paid call.
 */

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export const CONNECTED_GENERATION_ENDPOINT = "/api/higgsfield/consumer/generation";

export type ConnectedJobTool = { name: ConnectedToolName; label: string; model: string; suffix: string };
export type ConnectedJobSource = { role: string; kind: string; name: string };
export type ConnectedJob = {
  id: string;
  draftId: string;
  status: "quoted" | "dispatching" | "accepted" | "uncertain" | "failed" | "completed";
  input: ConsumerGenerationInput;
  model: { id: string; name: string; outputType: ConnectedOutputType };
  tool: ConnectedJobTool | null;
  sources: ConnectedJobSource[];
  workspaceId: string;
  workspaceName: string;
  quoteCredits: number;
  creditUnit: "higgsfield_credits";
  quoteExpiresAt: number;
  quoteExpired?: boolean;
  providerJobId: string | null;
  result?: unknown;
  providerReceipt?: unknown;
  originalAvailable?: boolean;
  originalAvailability?: string;
  /** Why a failed job failed: the account refused it, or it finished but its result could not be kept. */
  failureCode?: string | null;
  createdAt: number;
};

/** A saved job, verified field by field; an unverifiable record is never shown or acted on. */
export function parseConnectedJob(value: unknown, draftId: string): ConnectedJob {
  if (!record(value) || typeof value.id !== "string" || !uuid.test(value.id) || value.draftId !== draftId ||
      !["quoted", "dispatching", "accepted", "uncertain", "failed", "completed"].includes(String(value.status)) ||
      typeof value.workspaceId !== "string" || !uuid.test(value.workspaceId) || typeof value.workspaceName !== "string" || value.workspaceName.length > 200 ||
      value.creditUnit !== "higgsfield_credits" || typeof value.quoteCredits !== "number" || !Number.isFinite(value.quoteCredits) || value.quoteCredits <= 0 || value.quoteCredits > 100000 ||
      !(value.providerJobId === null || (typeof value.providerJobId === "string" && uuid.test(value.providerJobId))) ||
      typeof value.quoteExpiresAt !== "number" || typeof value.createdAt !== "number" ||
      !record(value.model) || typeof value.model.id !== "string" || typeof value.model.name !== "string" || !CONNECTED_OUTPUT_TYPES.includes(value.model.outputType as ConnectedOutputType))
    throw new Error("The saved generation job could not be verified. Refresh before continuing.");
  const tool = record(value.tool) && findConnectedTool(String(value.tool.name)) && typeof value.tool.model === "string"
    ? { name: value.tool.name as ConnectedToolName, label: findConnectedTool(String(value.tool.name))!.label, model: value.tool.model.slice(0, 80), suffix: findConnectedTool(String(value.tool.name))!.suffix }
    : null;
  const sources: ConnectedJobSource[] = Array.isArray(value.sources)
    ? value.sources.flatMap((item) => record(item) && typeof item.role === "string" && typeof item.name === "string" ? [{ role: item.role, kind: String(item.kind), name: item.name.slice(0, 160) }] : []).slice(0, 30)
    : [];
  return { ...value, tool, sources, input: consumerGenerationInputSchema.parse(value.input) } as ConnectedJob;
}

/** Request one exact price for this input. The schema parse is the contract. */
export function connectedQuoteRequest(draftId: string, input: ConsumerGenerationInput) {
  return { action: "quote" as const, draftId, input: consumerGenerationInputSchema.parse(input), idempotencyKey: crypto.randomUUID() };
}

/**
 * Submit one quoted job. The wallet and the exact quoted credits ride along;
 * the service refuses the submission if either has changed since the quote.
 */
export function connectedSubmitRequest(draftId: string, job: Pick<ConnectedJob, "id" | "workspaceId" | "quoteCredits">) {
  return { action: "submit" as const, draftId, id: job.id, workspaceId: job.workspaceId, credits: job.quoteCredits };
}

export function connectedStatusRequest(draftId: string, id: string) {
  return { action: "status" as const, draftId, id };
}

/** What a failed job means for the owner: a refused render is not billed; a
 * result the account finished but Particl could not keep may have been. */
export function connectedFailureText(job: Pick<ConnectedJob, "failureCode">) {
  return job.failureCode === "invalid_result"
    ? "The account finished this job, but its result could not be kept. Its receipt is saved."
    : "The connected account reported this job as failed. Failed renders are not billed.";
}
/** A submitted job may already have reached the account: it is never re-sent, only reconciled. */
export const connectedRecoverable = (job: Pick<ConnectedJob, "status">) => ["dispatching", "accepted", "uncertain"].includes(job.status);

/** The preflight refusals that release a held submission so a fresh quote may be taken. */
export const CONNECTED_PREFLIGHT_CODES = new Set([
  "quote_expired", "quote_changed", "workspace_changed", "unapproved_adjustment", "insufficient_credits",
  "approval_changed", "invalid_input", "preflight_unavailable", "reconnect_required", "connection_changed",
  "connection_busy", "model_unknown", "parameter_invalid", "parameter_unknown",
]);

export type ConnectedOriginal = {
  generationId: string;
  url: string;
  kind: "image" | "video" | "audio" | "model";
  mime: string;
  credits: number;
};

/**
 * The completed job's collected local original, or null. Only a byte-for-byte
 * stored original whose receipt matches the approved job may become a project
 * asset; anything else is reported as unavailable rather than guessed at.
 */
/** The prompt the account says it rendered, when the job enhanced on the account; shown as provenance, never re-sent. */
export function connectedEnhancedPrompt(job: ConnectedJob): string | null {
  if (job.status !== "completed" || !record(job.result) || !record(job.result.providerResult)) return null;
  const text = job.result.providerResult.enhancedPrompt;
  return typeof text === "string" && text.trim() && text.length <= 8000 ? text : null;
}
export function connectedOriginal(job: ConnectedJob): ConnectedOriginal | null {
  if (job.status !== "completed" || job.originalAvailable !== true || job.originalAvailability !== "available" ||
      !record(job.result) || !record(job.result.original)) return null;
  const original = job.result.original, asset = original.asset;
  const expected = { image: "image", video: "video", audio: "audio", "3d": "model" }[job.model.outputType];
  if (!record(asset) || typeof original.generationId !== "string" || !/^gen_hfc_[a-f0-9]{40}$/.test(original.generationId) || !job.providerJobId ||
      original.providerJobId !== job.providerJobId || original.creditUnit !== "higgsfield_credits" || original.credits !== job.quoteCredits ||
      typeof original.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(original.sha256) || typeof original.bytes !== "number" || original.bytes <= 0 ||
      asset.generationId !== original.generationId || typeof asset.mime !== "string" || asset.url !== `/api/media/${original.generationId}` ||
      asset.kind !== expected) return null;
  return { generationId: original.generationId, url: String(asset.url), kind: expected as ConnectedOriginal["kind"], mime: asset.mime, credits: job.quoteCredits };
}
