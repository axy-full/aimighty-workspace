import { studioRequest, StudioRequestError } from "@/components/workbench/GenerationDialog";
import { generationRequestBody, type GenerationBodyInput } from "../workbench/generation-request";
import { validAudioQuote } from "../workbench/generation-audio";
import {
  claimPendingGeneration,
  clearPendingGeneration,
  readPendingGeneration,
  type PendingGeneration,
} from "../workbench/pending-generation";
import { rememberWorkspaceQuote } from "./last-quote";
import { dispatchGate, neutralCopy } from "./rig";

/**
 * THE workspace-credit dispatch: re-quote the exact body that will be sent,
 * gate it against the price the person approved, claim the attempt in recovery
 * storage, and submit once with `maxCredits` (+ `quoteFingerprint` where the
 * route requires it).
 *
 * Extracted verbatim from the Rig's Generate (components/workspace/rig/
 * RigProvider.tsx, #233) so the Rig and the global Generate composer send one
 * shape through one gate. Nothing here invents a price.
 *
 * A claimed attempt whose reply never came back is never replayed blind
 * (settlePendingGeneration): the server says whether its Idempotency-Key
 * landed. Landed, that job is followed and nothing is sent. Never arrived,
 * the server fences the key so it cannot land later, and what is on screen
 * now is quoted, gated and sent under a new key. Not known yet, nothing is
 * sent. So a person never pays for a version they have since edited, and
 * never pays twice.
 *
 * The request body itself is always built by the shared builder
 * (lib/workbench/generation-request.ts, extracted in #236) or, for sound, by
 * `nodeAudioBody` — this module only prices, gates and posts it.
 */

export type DispatchRequest =
  /** Built from what is on screen now; always required for a new attempt. */
  | { endpoint: "/api/generate"; input: GenerationBodyInput | null }
  /** Sound: the same payload is quoted (with `quoteOnly`) and submitted. */
  | { endpoint: "/api/audio"; body: Record<string, unknown>; quoteBody: Record<string, unknown> };

export type DispatchOutcome =
  /**
   * Accepted: a real job id to bind progress to (an earlier attempt's job, when that one had landed). `status: "held"`
   * when admission held it instead of starting it (no credits or no slot yet): not charged until it runs.
   */
  | { state: "queued"; jobId: string; credits: number; status?: "held" }
  /** The price moved between the button and the click. Nothing was sent. */
  | { state: "repriced"; credits: number; reason: string }
  /** Refused before or during submission, with a reason that names no vendor. */
  | { state: "refused"; reason: string };

/** What became of an attempt claimed earlier whose reply never came back (settlePendingGeneration). */
export type SettledAttempt =
  /** No attempt is waiting. */
  | { state: "none" }
  /** It reached the server and made this job (`status` as it stands), at the credits approved then: follow it. Nothing is sent again. */
  | { state: "landed"; jobId: string; status: string; credits: number; model: string | null }
  /** It made nothing and never will: it never arrived (and is fenced now), or it was refused. Let go; nothing was charged. */
  | { state: "lost"; reason: string }
  /** Not known yet: it is still being accepted, or the server could not be asked. The claim stays and nothing is sent. */
  | { state: "unknown"; reason: string };

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

const FINGERPRINT = /^[a-f0-9]{64}$/;
const NEVER_ARRIVED = "Your last Generate never reached the server. Nothing was charged for it.";
const REFUSED = "Your last Generate was refused. Nothing was charged for it.";
const STILL_ACCEPTING = "Your last Generate is still being accepted. Nothing new was sent; press Generate again in a moment.";
const UNCHECKED = "Your last Generate could not be checked. Nothing new was sent; press Generate again in a moment.";
const UNREADABLE = "The saved generation request cannot be read. Check Activity before starting another take.";

/**
 * Before anything else is sent for `storageId`, the attempt claimed there
 * earlier (if any) is asked about by its own Idempotency-Key, route and body
 * (POST /api/generate/check). The server's record decides: a landed job is
 * returned to follow; a request that never arrived is fenced there and let go
 * here; one still being accepted, or a question that got no answer, leaves
 * the claim in place. It is never re-sent.
 */
export async function settlePendingGeneration(options: {
  scope: string; storageId: string; storage?: Storage;
  /** The route the claim was sent to, for a claim stored without one (the Make composer's audio). */
  endpoint?: "/api/generate" | "/api/audio" | "/api/audio/dub";
}): Promise<SettledAttempt> {
  const storage = options.storage ?? window.localStorage;
  let attempt: PendingGeneration | null;
  try {
    attempt = readPendingGeneration(storage, options.storageId);
  } catch {
    /* Unreadable recovery storage never becomes a new paid attempt. */
    return { state: "unknown", reason: UNREADABLE };
  }
  if (!attempt) return { state: "none" };
  let found: { state?: unknown; id?: unknown; status?: unknown };
  try {
    found = await studioRequest<{ state?: unknown; id?: unknown; status?: unknown }>("/api/generate/check", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Workbench-Scope": options.scope },
      body: JSON.stringify({ key: attempt.key, endpoint: attempt.endpoint ?? options.endpoint ?? "/api/generate", body: attempt.body }),
    });
  } catch {
    return { state: "unknown", reason: UNCHECKED };
  }
  if (found.state === "landed" && typeof found.id === "string" && found.id) {
    clearPendingGeneration(storage, options.storageId, attempt.key);
    let model: string | null = null;
    try { const sent = JSON.parse(attempt.body) as { model?: unknown }; model = typeof sent.model === "string" ? sent.model : null; } catch { /* the job is followed either way */ }
    return { state: "landed", jobId: found.id, status: typeof found.status === "string" ? found.status : "queued", credits: attempt.credits, model };
  }
  if (found.state === "absent" || found.state === "refused") {
    clearPendingGeneration(storage, options.storageId, attempt.key);
    return { state: "lost", reason: found.state === "absent" ? NEVER_ARRIVED : REFUSED };
  }
  return { state: "unknown", reason: found.state === "pending" ? STILL_ACCEPTING : UNCHECKED };
}

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
  /**
   * Whether this quote is the header's last price (lib/workspace/last-quote.ts). The Gen composer says
   * no: its button shows the whole press (every take), which it records itself.
   */
  remember?: boolean;
  /** Injected only by tests; the browser's own storage otherwise. */
  storage?: Storage;
}): Promise<DispatchOutcome> {
  const { scope, storageId, shown, request } = options;
  const storage = options.storage ?? window.localStorage;
  const headers = { "Content-Type": "application/json", "X-Workbench-Scope": scope };
  /* An earlier attempt whose reply was lost: followed if it landed, let go if it never did, and never sent again. */
  const settled = await settlePendingGeneration({ scope, storageId, storage });
  if (settled.state === "landed") return { state: "queued", jobId: settled.jobId, credits: settled.credits, ...(settled.status === "held" ? { status: "held" as const } : {}) };
  if (settled.state === "unknown") return { state: "refused", reason: settled.reason };
  let attempt: PendingGeneration | null = null;
  try {
    let credits: number;
    let body: Record<string, unknown>;
    if (options.quoted) {
      credits = options.quoted.credits;
      body = options.quoted.body;
    } else {
      const fresh = await quoteDispatch(scope, request);
      /* The header's last quote (lib/workspace/last-quote.ts): this is the figure the press is measured against. */
      if (options.remember !== false) rememberWorkspaceQuote(scope, fresh.credits);
      const gate = dispatchGate(shown, fresh.credits);
      if (!gate.ok) return { state: "repriced", credits: gate.credits, reason: gate.reason };
      credits = fresh.credits;
      body = fresh.body;
    }
    const proposed = { key: crypto.randomUUID(), body: JSON.stringify(body), credits, endpoint: request.endpoint };
    const claimed = claimPendingGeneration(storage, storageId, proposed);
    /* Another window claimed this one meanwhile: its request is its own to send, never this one's to replay. */
    if (claimed.key !== proposed.key) return { state: "refused", reason: "Another Generate of this is already on its way. Nothing new was sent." };
    attempt = claimed;
    options.onClaim?.(attempt.credits);
    const result = await studioRequest<{ id: string; status?: unknown }>(attempt.endpoint ?? "/api/generate", {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": attempt.key },
      body: attempt.body,
    });
    if (!result.id) throw new Error("The server has not confirmed a job yet. Generate again to recover this same request.");
    clearPendingGeneration(storage, storageId, attempt.key);
    return { state: "queued", jobId: result.id, credits: attempt.credits, ...(result.status === "held" ? { status: "held" as const } : {}) };
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

/**
 * What the quote route answers for `body`, asked without sending it: POST
 * /api/generate/quote, admission's own validation and pricing stopped before
 * anything is reserved, so asking is free. For a caller that prices its own
 * request (the rate-table Rig's Run node) this is not the price, which stays
 * the one on its button: it is whether the server has a price at all.
 *
 * `unpriced`: the route's own "no confirmed price" answer; nothing may be sent.
 * `refused`: any other refusal, which the paid POST would give the same way.
 * `failed`: no answer to go on (the connection, the server, an unreadable reply).
 */
export type QuoteCheck = "priced" | "unpriced" | "refused" | "failed";

/** What a Run with no confirmed price says, in place of a price (never "0 cr", never a guess). */
export const NO_CONFIRMED_PRICE = "No confirmed price for this setting yet.";

export async function checkQuote(scope: string, body: Record<string, unknown>): Promise<QuoteCheck> {
  try {
    const quote = await studioRequest<{ estimatedCredits?: unknown }>("/api/generate/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope },
      body: JSON.stringify(body),
    });
    const credits = quote.estimatedCredits;
    return typeof credits === "number" && Number.isFinite(credits) && credits >= 0 ? "priced" : "failed";
  } catch (error) {
    if (!(error instanceof StudioRequestError)) return "failed";
    if (/no confirmed price/i.test(error.message)) return "unpriced";
    return error.status >= 500 ? "failed" : "refused";
  }
}

/** What a claimed send became (sendClaimedGeneration). */
export type ClaimedSend =
  /** Accepted: a job to follow. `followed`: an earlier press's request had landed, and nothing new was sent. `status` is the job's own (a refused charge fails it, unbilled). */
  | { state: "queued"; jobId: string; status: string; credits: number; followed: boolean }
  /** Answered without a job: nothing was made or charged. A final answer lets the claim go; one that is not final keeps it, so the next press asks first. */
  | { state: "refused"; reason: string }
  /** Not known yet: this press's reply was lost (`lost`), or an earlier request could not be settled. The claim stays and nothing more was sent. */
  | { state: "unknown"; reason: string; lost: boolean };

const LOST_REPLY = "The connection dropped before the server answered. Press again to check what became of it; it is never sent twice.";

/**
 * A paid POST /api/generate for a caller that prices its own request (the
 * rate-table Rig: the phone board's Apply and the canvas's Run node) and sends
 * the price shown as the ceiling (`maxCredits`). Its Idempotency-Key is
 * claimed in recovery storage before it is sent, so a second press after a
 * lost reply is never a second paid job: that press settles the earlier one
 * first (settlePendingGeneration). Landed, its job is followed and nothing is
 * sent; never arrived or refused, it is fenced there and this press's body goes
 * under a new key; not known yet, nothing is sent.
 */
export async function sendClaimedGeneration(options: {
  scope: string;
  /** Recovery-storage key for this one request's slot (pendingGenerationKey). */
  storageId: string;
  /** The exact body to send, its ceiling included. */
  body: Record<string, unknown>;
  /** The credits shown for it, kept with the claim. */
  credits: number;
  /** Injected only by tests; the browser's own storage otherwise. */
  storage?: Storage;
}): Promise<ClaimedSend> {
  const { scope, storageId, body, credits } = options;
  const storage = options.storage ?? window.localStorage;
  const settled = await settlePendingGeneration({ scope, storageId, storage });
  if (settled.state === "landed") return { state: "queued", jobId: settled.jobId, status: settled.status, credits: settled.credits, followed: true };
  if (settled.state === "unknown") return { state: "unknown", reason: settled.reason, lost: false };
  let attempt: PendingGeneration;
  try {
    const proposed = { key: crypto.randomUUID(), body: JSON.stringify(body), credits, endpoint: "/api/generate" as const };
    attempt = claimPendingGeneration(storage, storageId, proposed);
    /* Another window claimed this one meanwhile: its request is its own to send, never this one's to replay. */
    if (attempt.key !== proposed.key) return { state: "unknown", reason: "Another Generate of this is already on its way. Nothing new was sent.", lost: false };
  } catch (error) {
    /* No recovery storage, no paid request: a lost reply could not be told from a new press. */
    return { state: "refused", reason: error instanceof Error ? error.message : "Enable local storage to safely recover this generation." };
  }
  try {
    const result = await studioRequest<{ id?: unknown; status?: unknown }>("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Workbench-Scope": scope, "Idempotency-Key": attempt.key },
      body: attempt.body,
    });
    if (typeof result.id !== "string" || !result.id) return { state: "unknown", reason: "The server has not confirmed a job yet. Press again to check what became of it; it is never sent twice.", lost: true };
    clearPendingGeneration(storage, storageId, attempt.key);
    return { state: "queued", jobId: result.id, status: typeof result.status === "string" ? result.status : "queued", credits, followed: false };
  } catch (error) {
    if (!(error instanceof StudioRequestError) || error.status >= 500) return { state: "unknown", reason: LOST_REPLY, lost: true };
    /* A refused charge files a failed job: answered, nothing billed. */
    const final = error.resolved || typeof error.data.id === "string";
    if (final) clearPendingGeneration(storage, storageId, attempt.key);
    return { state: "refused", reason: neutralCopy(error.message) };
  }
}

/** What a stored request (a key and the exact body sent under it) became, and whether it may go again (settleStoredRequest). */
export type StoredSettle =
  /** It reached the server and made this job: follow it; nothing is sent again. */
  | { state: "landed"; jobId: string; status: string }
  /** It made nothing and never will (never arrived, now set aside; or refused), and the same request is quoted now at exactly the price approved for it: it may go again, under a new key. */
  | { state: "resend" }
  /** It made nothing and never will, but the same request is quoted now at another price: nothing may go until that price is shown and approved. */
  | { state: "repriced"; price: number; unit: "cr" | "usd"; credits: number }
  /** Not known yet, or not priced: nothing is sent, and the stored request stays. */
  | { state: "unknown"; reason: string };

const sameAmount = (a: number, b: number, unit: "cr" | "usd") => (unit === "cr" ? a === b : Math.abs(a - b) < 0.005);

/**
 * For a stored request that is not a PendingGeneration claim (a Make composer
 * batch take, or its audio claim): the key it was sent under is asked about
 * first (POST /api/generate/check). Landed, its job is followed. Never arrived
 * or refused, its key is set aside there, and the same request is quoted again:
 * it may go under a new key only at exactly the price approved for it. With
 * `ask: false` (a key already known to have been refused) only the quote is taken.
 */
export async function settleStoredRequest(options: {
  scope: string; key: string; endpoint: "/api/generate" | "/api/audio"; body: string;
  /** The price shown and approved for this one request, in the workspace's unit. */
  approved: { price: number; unit: "cr" | "usd" };
  ask?: boolean;
}): Promise<StoredSettle> {
  const headers = { "Content-Type": "application/json", "X-Workbench-Scope": options.scope };
  if (options.ask !== false) {
    let found: { state?: unknown; id?: unknown; status?: unknown };
    try {
      found = await studioRequest("/api/generate/check", { method: "POST", headers, body: JSON.stringify({ key: options.key, endpoint: options.endpoint, body: options.body }) });
    } catch {
      return { state: "unknown", reason: UNCHECKED };
    }
    if (found.state === "landed" && typeof found.id === "string" && found.id)
      return { state: "landed", jobId: found.id, status: typeof found.status === "string" ? found.status : "queued" };
    if (found.state !== "absent" && found.state !== "refused")
      return { state: "unknown", reason: found.state === "pending" ? STILL_ACCEPTING : UNCHECKED };
  }
  let fresh: { estimatedCredits?: unknown; price?: unknown; unit?: unknown };
  try {
    const sent = JSON.parse(options.body) as Record<string, unknown>;
    fresh = options.endpoint === "/api/generate"
      ? await studioRequest("/api/generate/quote", { method: "POST", headers, body: options.body })
      : await studioRequest("/api/audio", { method: "POST", headers, body: JSON.stringify({ ...sent, quoteOnly: true }) });
  } catch {
    return { state: "unknown", reason: "The price could not be checked. Nothing was sent; try again in a moment." };
  }
  const credits = fresh.estimatedCredits, price = fresh.price, unit = fresh.unit;
  if (typeof credits !== "number" || !Number.isInteger(credits) || credits < 0 || typeof price !== "number" || !Number.isFinite(price) || price < 0 || (unit !== "cr" && unit !== "usd"))
    return { state: "unknown", reason: "The price could not be checked. Nothing was sent; try again in a moment." };
  if (unit === options.approved.unit && sameAmount(price, options.approved.price, unit)) return { state: "resend" };
  return { state: "repriced", price, unit, credits };
}
