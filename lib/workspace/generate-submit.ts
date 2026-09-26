import { studioRequest, StudioRequestError } from "@/components/workbench/GenerationDialog";
import { generationRequestBody, type GenerationBodyInput } from "../workbench/generation-request";
import { validAudioQuote } from "../workbench/generation-audio";
import {
  claimPendingGeneration,
  clearPendingGeneration,
  readPendingGeneration,
  type PendingGeneration,
} from "../workbench/pending-generation";
import { dispatchGate, neutralCopy } from "./rig";

/**
 * THE workspace-credit dispatch: re-quote the exact body that will be sent,
 * gate it against the price the person approved, claim the attempt in recovery
 * storage, and submit once with `maxCredits` (+ `quoteFingerprint` where the
 * route requires it).
 *
 * Extracted verbatim from the Rig's Generate (components/workspace/rig/
 * RigProvider.tsx, #233) so the Rig and the global Generate composer send one
 * shape through one gate. Nothing here invents a price, and a claimed attempt
 * is never re-created: a retry recovers the same request.
 *
 * The request body itself is always built by the shared builder
 * (lib/workbench/generation-request.ts, extracted in #236) or, for sound, by
 * `nodeAudioBody` — this module only prices, gates and posts it.
 */

export type DispatchRequest =
  /** `input` is read only when no claimed attempt is waiting; a replay uses the saved body. */
  | { endpoint: "/api/generate"; input: GenerationBodyInput | null }
  /** Sound: the same payload is quoted (with `quoteOnly`) and submitted. */
  | { endpoint: "/api/audio"; body: Record<string, unknown>; quoteBody: Record<string, unknown> };

export type DispatchOutcome =
  /** Accepted: a real job id to bind progress to. `status` is admission's own word for it ("held": waiting for credits, not charged until it runs). */
  | { state: "queued"; jobId: string; credits: number; status?: string }
  /** The price moved between the button and the click. Nothing was sent. */
  | { state: "repriced"; credits: number; reason: string }
  /** Refused before or during submission, with a reason that names no vendor. */
  | { state: "refused"; reason: string };

const FINGERPRINT = /^[a-f0-9]{64}$/;

/** The exact body a request will be sent as, priced by the server now: `maxCredits` (+ the quote's fingerprint) is its approval. */
export type QuotedDispatch = { credits: number; body: Record<string, unknown> };

/**
 * Price `request` exactly as it will be sent (POST /api/generate/quote, or the
 * audio route's `quoteOnly`), without sending it. The body that comes back
 * carries the quoted credits as its ceiling. Throws when no live price can be
 * confirmed; nothing is ever sent from here.
 */
export async function quoteDispatch(scope: string, request: DispatchRequest): Promise<QuotedDispatch> {
  const headers = { "Content-Type": "application/json", "X-Workbench-Scope": scope };
  if (request.endpoint === "/api/generate") {
    if (!request.input) throw new Error("This request could not be prepared. Nothing was submitted.");
    const fresh = await studioRequest<{ estimatedCredits: number; fingerprint: string }>("/api/generate/quote", {
      method: "POST",
      headers,
      body: JSON.stringify(generationRequestBody(request.input)),
    });
    if (!Number.isFinite(fresh.estimatedCredits) || fresh.estimatedCredits < 0 || !FINGERPRINT.test(fresh.fingerprint ?? ""))
      throw new Error("The live price could not be confirmed. Nothing was submitted.");
    return { credits: fresh.estimatedCredits, body: generationRequestBody({ ...request.input, maxCredits: fresh.estimatedCredits, quoteFingerprint: fresh.fingerprint }) };
  }
  const fresh = await studioRequest<{ estimatedCredits: number }>("/api/audio", {
    method: "POST",
    headers,
    body: JSON.stringify({ ...request.quoteBody, quoteOnly: true }),
  });
  if (!validAudioQuote(fresh)) throw new Error("The live price could not be confirmed. Nothing was submitted.");
  return { credits: fresh.estimatedCredits, body: { ...request.body, maxCredits: fresh.estimatedCredits } };
}

export async function dispatchGeneration(options: {
  scope: string;
  /** Recovery-storage key for this project + node (pendingGenerationKey). */
  storageId: string;
  /** The exact figure shown on the button, which is what the person approved. */
  shown: number | null;
  request: DispatchRequest;
  /** Called once the attempt is claimed, before the paid POST, with its approved credits. */
  onClaim?: (credits: number) => void;
  /**
   * Already priced by quoteDispatch and approved by the caller (a batch gates
   * the sum of its takes' quotes before any take is sent): sent as it is, never
   * priced again, so a batch is never stopped half way by a second quote.
   */
  quoted?: QuotedDispatch;
  /** Injected only by tests; the browser's own storage otherwise. */
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}): Promise<DispatchOutcome> {
  const { scope, storageId, shown, request } = options;
  const storage = options.storage ?? window.localStorage;
  const headers = { "Content-Type": "application/json", "X-Workbench-Scope": scope };
  let attempt: PendingGeneration | null = null;
  try {
    attempt = readPendingGeneration(storage, storageId);
    if (!attempt) {
      let credits: number;
      let body: Record<string, unknown>;
      if (options.quoted) {
        credits = options.quoted.credits;
        body = options.quoted.body;
      } else {
        const fresh = await quoteDispatch(scope, request);
        const gate = dispatchGate(shown, fresh.credits);
        if (!gate.ok) return { state: "repriced", credits: gate.credits, reason: gate.reason };
        credits = fresh.credits;
        body = fresh.body;
      }
      attempt = claimPendingGeneration(storage, storageId, {
        key: crypto.randomUUID(),
        body: JSON.stringify(body),
        credits,
        endpoint: request.endpoint,
      });
    }
    options.onClaim?.(attempt.credits);
    const result = await studioRequest<{ id: string; status?: unknown }>(attempt.endpoint ?? "/api/generate", {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": attempt.key },
      body: attempt.body,
    });
    if (!result.id) throw new Error("The server has not confirmed a job yet. Generate again to recover this same request.");
    clearPendingGeneration(storage, storageId, attempt.key);
    return { state: "queued", jobId: result.id, credits: attempt.credits, ...(typeof result.status === "string" ? { status: result.status } : {}) };
  } catch (error) {
    if (attempt && error instanceof StudioRequestError) {
      if (typeof error.data.id === "string") {
        clearPendingGeneration(storage, storageId, attempt.key);
        return { state: "queued", jobId: error.data.id, credits: attempt.credits };
      }
      /* Only a durable, completed refusal permits a fresh request and another quote. */
      if (error.resolved && error.status >= 400 && error.status < 500) clearPendingGeneration(storage, storageId, attempt.key);
    }
    return { state: "refused", reason: neutralCopy(error instanceof Error ? error.message : "Generation could not be submitted.") };
  }
}
