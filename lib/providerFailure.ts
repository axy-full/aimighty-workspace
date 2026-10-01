/**
 * From a failed engine call to the provider's own outcome (lib/providerOutcome.ts).
 *
 * Each adapter throws its own typed error carrying the provider's status and
 * a bounded copy of its reply; this reads it. A failure that never left this
 * server (a preflight, a changed funding source, a missing key) is no
 * provider's outcome and reads null. A dropped connection or a timeout after
 * the request left is "no answer": sent, and the provider never said.
 *
 * Server-only: it knows the adapters' error classes and reads the meter to
 * say whose key the provider billed.
 */
import { APICallError, NoImageGeneratedError } from "ai";
import { ArkHttpError } from "./ark";
import { FalHttpError } from "./fal";
import { GatewayImageError, GoogleDoorError, StillRefusalError } from "./gemini";
import { HiggsfieldHttpError } from "./higgsfield";
import { ElevenLabsError } from "./elevenlabs";
import { XaiHttpError } from "./xaiErrors";
import { PreflightError } from "./preflight";
import { FundingSourceChangedError } from "./meter";
import { billedTo } from "./providers";
import { platformDb, platformReady } from "./platform";
import { currentTenant } from "./tenant";
import {
  arkRefusalOutcome, arkTaskOutcome, elevenLabsErrorOutcome, falErrorOutcome, gatewayErrorOutcome, higgsfieldRefusalOutcome,
  higgsfieldRequestOutcome, noAnswerOutcome, openaiErrorOutcome, xaiErrorOutcome, xaiVideoOutcome, type OutcomeProvider, type ProviderOutcome,
} from "./providerOutcome";

/** Who answered for a model's provider, through the door its call actually used. */
export function outcomeProviderFor(provider: string | null | undefined): OutcomeProvider {
  const door = billedTo(provider ?? "byteplus");
  if (door === "vercel") return "gateway";
  switch (provider) {
    case "higgsfield": case "byteplus": case "google": case "openai": case "xai": case "fal": case "elevenlabs": return provider;
    default: return "byteplus";
  }
}

/** Words a transport failure uses: the request may have left, and nobody answered. */
const TRANSPORT = /did not answer|could not reach|timed out|timeout|aborted|socket|network|fetch failed|econnreset|etimedout|unreadable|non-json/i;

/**
 * The provider's outcome for a thrown engine error, or null when the request
 * never reached a provider (or the error is ours, not the provider's).
 */
export function outcomeOfError(error: unknown, context: { provider: string | null | undefined; stage?: ProviderOutcome["stage"] }): ProviderOutcome | null {
  const stage = context.stage ?? "submit";
  if (error instanceof PreflightError || error instanceof FundingSourceChangedError) return null;
  if (error instanceof StillRefusalError) return error.outcome;
  if (error instanceof GatewayImageError) return error.outcome;
  if (error instanceof GoogleDoorError) return error.outcome;
  if (error instanceof ArkHttpError) return arkRefusalOutcome(error.status, error.body);
  if (error instanceof HiggsfieldHttpError) return higgsfieldRefusalOutcome(error.status, error.body);
  if (error instanceof FalHttpError) return falErrorOutcome(error.status, error.body, stage);
  if (error instanceof XaiHttpError) return xaiErrorOutcome(error.status, error.body);
  if (error instanceof ElevenLabsError) return elevenLabsErrorOutcome(error.status, error.body);
  const provider = outcomeProviderFor(context.provider);
  if (APICallError.isInstance(error) && typeof error.statusCode === "number") {
    const body = error.responseBody ?? error.data ?? null;
    if (provider === "gateway") return gatewayErrorOutcome(error.statusCode, body);
    if (provider === "xai") return xaiErrorOutcome(error.statusCode, body);
    return openaiErrorOutcome(error.statusCode, body);
  }
  if (NoImageGeneratedError.isInstance(error)) return noAnswerOutcome(provider, "run", "The engine returned no image.");
  const message = error instanceof Error ? error.message : String(error);
  if (APICallError.isInstance(error) || TRANSPORT.test(message)) return noAnswerOutcome(provider, stage);
  return null;
}

/** A task the provider's own status read ended without a result: its outcome from that read. */
export function outcomeOfPoll(provider: string | null | undefined, raw: unknown): ProviderOutcome | null {
  switch (provider ?? "byteplus") {
    case "byteplus": return arkTaskOutcome(raw);
    case "xai": return xaiVideoOutcome(raw);
    case "higgsfield": return higgsfieldRequestOutcome(raw);
    default: return null;
  }
}

/**
 * Whose key the provider billed for this job: the meter's own record of who
 * funded it (written at admission, never changed), or — for work that
 * predates the meter — platform-only diagnostics until its historical funding is known.
 */
export async function fundingOf(id: string): Promise<"platform" | "own"> {
  const workspaceId = currentTenant()?.workspace?.id;
  if (workspaceId) {
    try {
      await platformReady();
      const row = (await platformDb().execute({ sql: "SELECT paid_by_platform FROM meter_events WHERE id=? AND workspace_id=?", args: [id, workspaceId] })).rows[0];
      if (row) return Number(row.paid_by_platform) === 1 ? "platform" : "own";
    } catch {
      /* Missing funding evidence must never reveal platform diagnostics. */
    }
  }
  return "platform";
}

/** The outcome stamped with whose key it was, ready to store; null stays null. */
export async function fundedOutcome(outcome: ProviderOutcome | null, id: string, provider: string | null | undefined): Promise<ProviderOutcome | null> {
  void provider; // Kept compatible with failure call sites; historical funding comes only from the receipt.
  if (!outcome) return null;
  return { ...outcome, funding: await fundingOf(id) };
}
