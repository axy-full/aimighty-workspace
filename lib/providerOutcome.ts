/**
 * What the provider did with a take it rejected or failed: its own failure
 * code, a bounded copy of its own message, and — read from its own reply or
 * its own documentation, never guessed — whether it billed the attempt.
 *
 * Four billing states, and only these:
 *   billed      — the provider's reply states a charge (an amount in its own
 *                 unit), or its ledger lists one for this job;
 *   refunded    — its ledger lists a refund for this job, or its docs say
 *                 exactly this status is refunded;
 *   not_charged — its reply states a zero charge, or its docs say exactly
 *                 this outcome is not charged;
 *   unknown     — anything else: "the provider didn't say".
 *
 * Each mapping names its evidence (`basis`), and BASIS below is the whole
 * list, cited in one place. A provider whose docs say nothing about a
 * rejected request reads `unknown`; a reply that carries no billing field
 * reads `unknown`. Nothing here converts a provider's charge into credits.
 *
 * Pure and client-safe (no imports): the server records an outcome at the
 * failure point, and the pages read it back.
 */

export const BILLING_STATES = ["billed", "refunded", "not_charged", "unknown"] as const;
export type BillingState = (typeof BILLING_STATES)[number];
/** The provider's own unit: its credits, its dollars (xAI ticks are dollars), or its tokens. */
export const BILLING_UNITS = ["higgsfield_credits", "usd", "tokens"] as const;
export type BillingUnit = (typeof BILLING_UNITS)[number];

/**
 * The evidence for each mapping. Quotes are the providers' own words, read
 * 27 September 2026.
 */
export const BASIS = {
  /* docs.higgsfield.ai/docs/help/faq */
  "hf-refund": "Higgsfield API FAQ: failed and NSFW-flagged requests are not charged; their credits are automatically refunded.",
  "hf-success-only": "Higgsfield API FAQ: you are only billed for successful completions.",
  /* The connected account's own credit ledger (its MCP `transactions`: spend/refund/grant/deduct). */
  "hf-ledger": "The account's own credit ledger lists this job.",
  /* higgsfield.ai help centre: failed generations "usually" refund, "specific models might not", Grok is charged at start. */
  "hf-account-silent": "The account's reply names no charge or refund for this job.",
  /* docs.byteplus.com ModelArk pricing (1544106). */
  "ark-success-only": "ModelArk pricing: only successfully generated videos are charged; a failed generation is not.",
  /* ai.google.dev/gemini-api/docs/billing */
  "google-errors": "Gemini API billing: a request that fails with a 400 or 500 error is not charged.",
  "google-usage": "The reply's usage states the tokens.",
  /* The AI Gateway's reply (`usage.cost`). */
  "gateway-cost": "The gateway's reply states its cost.",
  /* docs.x.ai/developers/cost-tracking */
  "xai-ticks": "xAI: usage.cost_in_usd_ticks is the amount billed.",
  /* fal.ai/docs/model-apis/faq */
  "fal-5xx": "fal FAQ: server errors (HTTP 500+) are never charged.",
  silent: "The provider's reply says nothing about a charge.",
  "no-answer": "The provider never answered.",
} as const;
export type BillingBasis = keyof typeof BASIS;

export type ProviderBilling = { state: BillingState; amount?: number; unit?: BillingUnit; basis: BillingBasis };

/** Who answered. `higgsfield_account` is the person's own connected account; `higgsfield` the API on a key. */
export const OUTCOME_PROVIDERS = ["higgsfield", "higgsfield_account", "byteplus", "google", "gateway", "openai", "xai", "fal", "elevenlabs"] as const;
export type OutcomeProvider = (typeof OUTCOME_PROVIDERS)[number];
export const PROVIDER_NAME: Record<OutcomeProvider, string> = {
  higgsfield: "Higgsfield", higgsfield_account: "Higgsfield", byteplus: "BytePlus", google: "Google",
  gateway: "The AI Gateway", openai: "OpenAI", xai: "xAI", fal: "fal", elevenlabs: "ElevenLabs",
};

export const FAILURE_KINDS = [
  "content_filter", "rights", "invalid_request", "auth", "provider_quota", "rate_limited",
  "timeout", "canceled", "provider_error", "no_answer", "not_kept", "unknown",
] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

export type ProviderOutcome = {
  v: 1;
  provider: OutcomeProvider;
  /** Refused when it was sent, or failed after the provider took it. */
  stage: "submit" | "run";
  /** The provider's own code ("nsfw", "OutputVideoSensitiveContentDetected", "moderation_blocked", "http_422"). */
  code: string;
  kind: FailureKind;
  /** The provider's own words, bounded and redacted; null when it said nothing usable. */
  message: string | null;
  billing: ProviderBilling;
  /** Whose key the provider billed: the platform's, or the workspace's own. Absent on the connected account (always its owner's). */
  funding?: "platform" | "own";
  at: number;
};

/* ── Bounding and redaction ─────────────────────────────────────────── */

export const MESSAGE_MAX = 280;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * A provider's words, safe to keep and show: control characters out, links
 * and anything shaped like a credential or signature replaced, whitespace
 * collapsed, cut on a word boundary. Null when nothing readable is left.
 */
export function providerText(value: unknown, max = MESSAGE_MAX): string | null {
  if (typeof value !== "string") return null;
  let text = value
    .replace(/\p{Cc}/gu, " ")
    .replace(/https?:\/\/[^\s<>"'`]+/giu, "[link]")
    /* An Authorization value: "Bearer …", "Key id:secret" — only a token with a digit, so "key reference" stays. */
    .replace(/\b(?:bearer|basic|key|token)\s+(?=[A-Za-z0-9._~+/=:-]*\d)[A-Za-z0-9._~+/=:-]{16,}/giu, "[redacted]")
    .replace(/\b(?:sk|xai)-[A-Za-z0-9_-]{16,}/gu, "[redacted]")
    .replace(/\b(?:api[_-]?key|secret|password|authorization|token|signature|x-amz-[a-z-]+)\s*[:=]\s*\S+/giu, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/gu, "[redacted]")
    /* Anything long and unbroken (a secret, a signature, base64): a uuid (36) or a model id stays. */
    .replace(/[A-Za-z0-9+/=_-]{40,}/gu, (run) => (/\d/.test(run) && /[A-Za-z]/.test(run) ? "[redacted]" : run))
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gu, "[email]")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || !/[\p{L}\p{N}]/u.test(text)) return null;
  if (text.length > max) {
    const cut = text.slice(0, max - 1);
    const space = cut.lastIndexOf(" ");
    text = `${(space >= max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:·-]+$/, "")}…`;
  }
  return text;
}

/** A provider's code as a short token: letters, digits and ._:- only, or null. */
export function outcomeCode(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  if (typeof value !== "string") return null;
  const code = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(code) ? code : null;
}

const amountOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e12 ? value : null;

/** A JSON body, parsed once; the text itself when it is not JSON. */
export function parseBody(body: unknown): unknown {
  if (typeof body !== "string") return body;
  try { return JSON.parse(body); } catch { return body; }
}

/* ── Kinds, from the provider's own code and words ──────────────────── */

const CONTENT = /nsfw|sensitive|moderat|safety|content[_ ]?policy|content[_ ]?filter|prohibited|unsafe|explicit|blocked by|deepfake/i;
const RIGHTS = /ip_detected|copyright|intellectual|trademark|policyviolation|protected content|celebrit|public figure|real person|likeness|privacyinformation|recitation/i;

/** The kind of failure, read from the provider's code first and its words second. */
export function failureKindOf(code: string, message: string | null, status?: number | null): FailureKind {
  const both = `${code} ${message ?? ""}`;
  if (RIGHTS.test(code) || (RIGHTS.test(both) && CONTENT.test(both))) return "rights";
  if (CONTENT.test(code) || CONTENT.test(message ?? "")) return "content_filter";
  if (/^cancel/i.test(code)) return "canceled";
  if (/expired|timeout|timed[_ ]out|deadline/i.test(code)) return "timeout";
  if (/quota|insufficient|credit|balance|overdue|payment|billing/i.test(code) || status === 402) return "provider_quota";
  if (/rate|concurren|too_many|overload|burst|busy/i.test(code) || status === 429) return "rate_limited";
  if (/auth|api_key|unauthori|forbidden|permission|subscription|invalid_?account/i.test(code) || status === 401 || status === 403) return "auth";
  if (/invalid|missing|unsupported|parameter|validation|too_(?:large|small|long)|not_found|mismatch|constraint|download/i.test(code) || status === 400 || status === 404 || status === 413 || status === 415 || status === 422) return "invalid_request";
  if (status != null && status >= 500) return "provider_error";
  if (/fail|error|internal/i.test(code)) return "provider_error";
  return "unknown";
}

function outcome(
  provider: OutcomeProvider, stage: ProviderOutcome["stage"], code: string, message: string | null,
  billing: ProviderBilling, options: { kind?: FailureKind; status?: number | null; at?: number } = {},
): ProviderOutcome {
  return {
    v: 1, provider, stage, code, message,
    kind: options.kind ?? failureKindOf(code, message, options.status ?? null),
    billing, at: options.at ?? Date.now(),
  };
}
const said = (basis: BillingBasis, state: BillingState, amount?: number | null, unit?: BillingUnit): ProviderBilling =>
  amount != null && unit ? { state, amount, unit, basis } : { state, basis };
const unknown = (basis: BillingBasis = "silent"): ProviderBilling => ({ state: "unknown", basis });

/** A status code as the code a person can search for: "http_422". */
const httpCode = (status: number) => `http_${status}`;

/* ── Higgsfield: the API on a key (lib/engines/higgsfield.ts) ─────────── */

/**
 * A request the Higgsfield API finished without an output. Its docs list
 * the terminal statuses (docs.higgsfield.ai/docs/concepts/requests): `nsfw`
 * ("Input or output was rejected by content moderation"), `failed` (it "may
 * include an `error`"), `canceled` ("canceled before processing started").
 * Its FAQ: failed and NSFW requests are not charged and refunded
 * automatically; only successful completions are billed.
 */
export function higgsfieldRequestOutcome(raw: unknown): ProviderOutcome | null {
  if (!record(raw) || typeof raw.status !== "string") return null;
  const status = raw.status;
  if (!["failed", "nsfw", "canceled", "cancelled"].includes(status)) return null;
  const error = record(raw.error) ? raw.error : null;
  const message = providerText(typeof raw.error === "string" ? raw.error : error?.message ?? raw.message ?? raw.detail);
  const code = status === "failed" ? outcomeCode(error?.code ?? error?.type) ?? "failed" : status === "cancelled" ? "canceled" : status;
  const billing = status === "canceled" || status === "cancelled" ? said("hf-success-only", "not_charged") : said("hf-refund", "refunded");
  return outcome("higgsfield", "run", code, message, billing, { kind: status === "nsfw" ? "content_filter" : undefined });
}

/** An HTTP refusal from the Higgsfield API (a FastAPI `detail`, or its own words). */
export function higgsfieldRefusalOutcome(status: number, body: unknown): ProviderOutcome {
  const parsed = parseBody(body);
  const detail = record(parsed) ? parsed.detail : null;
  const code = (record(detail) ? outcomeCode(detail.code ?? detail.type) : null)
    ?? (Array.isArray(detail) && record(detail[0]) ? outcomeCode(detail[0].type) : null)
    ?? httpCode(status);
  const message = fieldMessage(detail) ?? providerText(record(parsed) ? parsed.message ?? parsed.error : typeof parsed === "string" ? parsed : null);
  /* Refused at the door: no request exists, and only successful completions are billed. */
  const billing = status >= 400 && status < 500 ? said("hf-success-only", "not_charged") : unknown();
  return outcome("higgsfield", "submit", code, message, billing, { status });
}

/** "prompt: field required; aspect_ratio: …" from a FastAPI/fal `detail` list, or its message. */
export function fieldMessage(detail: unknown): string | null {
  if (typeof detail === "string") return providerText(detail);
  if (record(detail)) return providerText(detail.message ?? detail.msg);
  if (!Array.isArray(detail)) return null;
  const parts = detail.slice(0, 4).flatMap((item) => {
    if (!record(item)) return [];
    const loc = Array.isArray(item.loc) ? item.loc.filter((l) => l !== "body" && (typeof l === "string" || typeof l === "number")).join(".") : "";
    const msg = typeof item.msg === "string" ? item.msg : typeof item.message === "string" ? item.message : "";
    return msg ? [`${loc ? `${loc}: ` : ""}${msg}`] : [];
  });
  return parts.length ? providerText(parts.join("; ")) : null;
}

/* ── Higgsfield: the person's connected account (MCP) ─────────────────── */

/** The account's credit ledger for one job, as lib/higgsfield-consumer/ledger.ts reads it. */
export type AccountLedger = { refunded: number | null; spent: number | null; refund: boolean; spend: boolean };

/**
 * A job the connected account ended without a result (`failed`,
 * `canceled`, `nsfw`, `ip_detected`). The status alone does not settle the
 * charge: the account's help centre says failed generations "usually" come
 * back, that "specific models might not refund credits", and that Grok is
 * "charged the moment they start" — and that every charge and refund is on
 * the account's own usage ledger. So the charge is read from that ledger
 * (`ledger`, when the job appears in it) and is otherwise unknown.
 */
export function higgsfieldAccountOutcome(status: string, options: { message?: unknown; ledger?: AccountLedger | null; stage?: ProviderOutcome["stage"]; at?: number } = {}): ProviderOutcome {
  const code = outcomeCode(status === "cancelled" ? "canceled" : status) ?? "failed";
  const kind: FailureKind = code === "nsfw" ? "content_filter" : code === "ip_detected" ? "rights" : code === "canceled" ? "canceled" : failureKindOf(code, providerText(options.message));
  return outcome("higgsfield_account", options.stage ?? "run", code, providerText(options.message), accountBilling(options.ledger ?? null), { kind, at: options.at });
}

/** What the account's own ledger says about one job: a refund wins over its spend; nothing listed is unknown. */
export function accountBilling(ledger: AccountLedger | null): ProviderBilling {
  if (ledger?.refund) return said("hf-ledger", "refunded", ledger.refunded, "higgsfield_credits");
  if (ledger?.spend) return said("hf-ledger", "billed", ledger.spent, "higgsfield_credits");
  return unknown("hf-account-silent");
}

/* ── BytePlus ModelArk (Seedance) ────────────────────────────────────── */

/**
 * A task ModelArk ended as `failed` (or `cancelled` while queued): its
 * `error` names the code (ModelArk error codes: InputTextSensitiveContentDetected,
 * OutputVideoSensitiveContentDetected, …PolicyViolation for copyright). ModelArk
 * pricing: "You are only charged for successfully generated videos. No fee is
 * charged if generation fails due to reasons such as content moderation."
 */
export function arkTaskOutcome(raw: unknown): ProviderOutcome | null {
  if (!record(raw)) return null;
  const status = String(raw.status ?? "").toLowerCase();
  if (status !== "failed" && status !== "cancelled" && status !== "canceled" && status !== "expired") return null;
  const error = record(raw.error) ? raw.error : null;
  const code = outcomeCode(error?.code) ?? (status === "failed" ? "failed" : status === "expired" ? "expired" : "canceled");
  return outcome("byteplus", "run", code, providerText(error?.message), said("ark-success-only", "not_charged"));
}

/** ModelArk refused the task when it was sent: no task exists, so no video was generated or charged. */
export function arkRefusalOutcome(status: number, body: unknown): ProviderOutcome {
  const parsed = parseBody(body);
  const error = record(parsed) && record(parsed.error) ? parsed.error : null;
  const code = outcomeCode(error?.code) ?? httpCode(status);
  const message = providerText(error?.message ?? (typeof parsed === "string" ? parsed : null));
  const billing = status >= 400 && status < 500 ? said("ark-success-only", "not_charged") : unknown();
  return outcome("byteplus", "submit", code, message, billing, { status });
}

/* ── Google (Nano Banana), direct ────────────────────────────────────── */

/** Google answered 4xx/5xx: its billing page says a 400 or 500 error is not charged. */
export function googleErrorOutcome(status: number, body: unknown): ProviderOutcome {
  const parsed = parseBody(body);
  const error = record(parsed) && record(parsed.error) ? parsed.error : null;
  const code = outcomeCode(error?.status ?? error?.code) ?? httpCode(status);
  const message = providerText(error?.message ?? (typeof parsed === "string" ? parsed : null));
  const billing = status >= 400 && status < 600 ? said("google-errors", "not_charged") : unknown();
  return outcome("google", "submit", code, message, billing, { status });
}

export type TokenUsage = { total_tokens?: unknown; input_tokens?: unknown; output_tokens?: unknown; prompt_tokens?: unknown; completion_tokens?: unknown };
export function usageTokens(usage: unknown): number | null {
  if (!record(usage)) return null;
  const u = usage as TokenUsage;
  const total = amountOf(u.total_tokens);
  if (total != null) return total;
  const input = amountOf(u.input_tokens ?? u.prompt_tokens), output = amountOf(u.output_tokens ?? u.completion_tokens);
  return input == null && output == null ? null : (input ?? 0) + (output ?? 0);
}

/**
 * Google answered 200 with no image — the model declined to draw it, in its
 * own words when it gave any. It reported the tokens it used in `usage`;
 * that count is its charge (in its own unit, tokens). With no usage, it did
 * not say. Why it declined is read from its reason or words, never assumed.
 */
export function googleRefusalOutcome(usage: unknown, text: unknown, finishReason?: unknown): ProviderOutcome {
  const tokens = usageTokens(usage);
  const code = outcomeCode(finishReason) ?? "no_image";
  const message = providerText(text);
  const billing = tokens == null ? unknown() : said("google-usage", tokens > 0 ? "billed" : "not_charged", tokens, "tokens");
  return outcome("google", "run", code, message, billing);
}

/* ── The AI Gateway ──────────────────────────────────────────────────── */

/** The gateway answered 200 with no image: its `usage.cost` is the charge, in dollars. */
export function gatewayRefusalOutcome(cost: unknown, text: unknown): ProviderOutcome {
  const usd = amountOf(cost);
  const billing = usd == null ? unknown() : said("gateway-cost", usd > 0 ? "billed" : "not_charged", usd, "usd");
  return outcome("gateway", "run", "no_image", providerText(text), billing);
}

/** The gateway refused the request: its docs state no rule for a refused request, so the charge is unknown. */
export function gatewayErrorOutcome(status: number, body: unknown): ProviderOutcome {
  const parsed = parseBody(body);
  const error = record(parsed) && record(parsed.error) ? parsed.error : null;
  const code = outcomeCode(error?.type ?? error?.code) ?? httpCode(status);
  return outcome("gateway", "submit", code, providerText(error?.message ?? (typeof parsed === "string" ? parsed : null)), unknown(), { status });
}

/* ── OpenAI (GPT Image), direct ──────────────────────────────────────── */

/**
 * OpenAI refused the image request (`moderation_blocked`, an invalid size…).
 * Its error body carries no usage and its docs state no rule for a refused
 * image request, so the charge is unknown.
 */
export function openaiErrorOutcome(status: number, body: unknown): ProviderOutcome {
  const parsed = parseBody(body);
  const error = record(parsed) && record(parsed.error) ? parsed.error : null;
  const code = outcomeCode(error?.code ?? error?.type) ?? httpCode(status);
  return outcome("openai", "submit", code, providerText(error?.message ?? (typeof parsed === "string" ? parsed : null)), unknown(), { status });
}

/* ── xAI (Grok Imagine) ──────────────────────────────────────────────── */

/** `usage.cost_in_usd_ticks`, xAI's own statement of the amount billed; ten billion ticks to the dollar. */
export function xaiBilling(usage: unknown): ProviderBilling {
  const ticks = record(usage) ? amountOf(usage.cost_in_usd_ticks) : null;
  if (ticks == null) return unknown();
  const usd = ticks / 1e10;
  return said("xai-ticks", usd > 0 ? "billed" : "not_charged", usd, "usd");
}

/**
 * A Grok Imagine video that ended without a clip: `failed` (with
 * error.code/message), `expired`, or `done` with `respect_moderation:false`
 * ("Video filtered by moderation"). The charge is whatever its usage says.
 */
export function xaiVideoOutcome(reply: unknown): ProviderOutcome | null {
  if (!record(reply)) return null;
  const status = String(reply.status ?? "");
  const video = record(reply.video) ? reply.video : null;
  const moderated = (status === "done" || status === "") && video?.respect_moderation === false;
  if (status !== "failed" && status !== "expired" && !moderated) return null;
  const error = record(reply.error) ? reply.error : null;
  const code = moderated ? "respect_moderation_false" : outcomeCode(error?.code) ?? status;
  return outcome("xai", "run", code, providerText(error?.message), xaiBilling(reply.usage), { kind: moderated ? "content_filter" : undefined });
}

/** xAI refused the request. An error body carries no usage, so the charge is whatever it says: usually nothing. */
export function xaiErrorOutcome(status: number, body: unknown): ProviderOutcome {
  const parsed = parseBody(body);
  const error = record(parsed) ? (record(parsed.error) ? parsed.error : parsed) : null;
  const code = outcomeCode(error?.code ?? error?.type) ?? httpCode(status);
  const message = providerText(record(parsed) && typeof parsed.error === "string" ? parsed.error : error?.message ?? (typeof parsed === "string" ? parsed : null));
  return outcome("xai", "submit", code, message, record(parsed) ? xaiBilling(parsed.usage) : unknown(), { status });
}

/* ── fal (Kling, Topaz) ──────────────────────────────────────────────── */

/**
 * fal refused or failed the request. Its errors carry `detail[]` with a
 * machine `type` (`content_policy_violation`, `image_too_large`, …). Its FAQ:
 * "Server errors (HTTP 500+) are never charged", while "client-side errors
 * like invalid inputs (HTTP 422) may still be charged" — so a 422 is unknown.
 */
export function falErrorOutcome(status: number, body: unknown, stage: ProviderOutcome["stage"] = "submit"): ProviderOutcome {
  const parsed = parseBody(body);
  const detail = record(parsed) ? parsed.detail : null;
  const code = (Array.isArray(detail) && record(detail[0]) ? outcomeCode(detail[0].type) : null)
    ?? (record(parsed) ? outcomeCode(parsed.error_type ?? parsed.type) : null) ?? httpCode(status);
  const message = fieldMessage(detail) ?? providerText(record(parsed) ? parsed.message ?? parsed.error : typeof parsed === "string" ? parsed : null);
  const billing = status >= 500 ? said("fal-5xx", "not_charged") : unknown();
  return outcome("fal", stage, code, message, billing, { status });
}

/* ── ElevenLabs ──────────────────────────────────────────────────────── */

/** ElevenLabs refused the request (`detail: {type, code, message}`). Its docs state no rule for a refused request. */
export function elevenLabsErrorOutcome(status: number, body: unknown): ProviderOutcome {
  const parsed = parseBody(body);
  const detail = record(parsed) ? parsed.detail : null;
  const code = (record(detail) ? outcomeCode(detail.code ?? detail.status ?? detail.type) : null) ?? httpCode(status);
  const message = providerText(record(detail) ? detail.message : typeof detail === "string" ? detail : record(parsed) ? parsed.message : null);
  return outcome("elevenlabs", "submit", code, message, unknown(), { status });
}

/* ── Nobody answered ─────────────────────────────────────────────────── */

/** Sent, and no answer came back (a timeout, a dropped connection, a 5xx with no body we trust): unknown. */
export function noAnswerOutcome(provider: OutcomeProvider, stage: ProviderOutcome["stage"], message?: unknown): ProviderOutcome {
  return outcome(provider, stage, "no_answer", providerText(message), unknown("no-answer"), { kind: "no_answer" });
}

/** The provider answered and ended the job, but said nothing about a charge (a finished job with no output). */
export function silentOutcome(provider: OutcomeProvider, stage: ProviderOutcome["stage"], code: string, message?: unknown): ProviderOutcome {
  return outcome(provider, stage, outcomeCode(code) ?? "failed", providerText(message), unknown());
}

/* ── Storage ─────────────────────────────────────────────────────────── */

export function serializeOutcome(value: ProviderOutcome): string {
  return JSON.stringify(value);
}

/** A stored outcome, checked field by field; anything unreadable is null (read as unknown). */
export function parseOutcome(value: unknown): ProviderOutcome | null {
  let v: unknown = value;
  if (typeof v === "string") {
    if (v.length > 4096) return null;
    try { v = JSON.parse(v); } catch { return null; }
  }
  if (!record(v) || v.v !== 1) return null;
  const billing = record(v.billing) ? v.billing : null;
  if (!OUTCOME_PROVIDERS.includes(v.provider as OutcomeProvider) || (v.stage !== "submit" && v.stage !== "run") ||
      !FAILURE_KINDS.includes(v.kind as FailureKind) || !billing || !BILLING_STATES.includes(billing.state as BillingState) ||
      typeof billing.basis !== "string" || !(billing.basis in BASIS) || typeof v.at !== "number") return null;
  const code = outcomeCode(v.code);
  if (!code) return null;
  const amount = amountOf(billing.amount);
  const unit = BILLING_UNITS.includes(billing.unit as BillingUnit) ? (billing.unit as BillingUnit) : undefined;
  return {
    v: 1, provider: v.provider as OutcomeProvider, stage: v.stage, code, kind: v.kind as FailureKind,
    message: providerText(v.message), at: v.at,
    billing: amount != null && unit ? { state: billing.state as BillingState, amount, unit, basis: billing.basis as BillingBasis } : { state: billing.state as BillingState, basis: billing.basis as BillingBasis },
    ...(v.funding === "platform" || v.funding === "own" ? { funding: v.funding } : {}),
  };
}

/* ── What a page may be told ─────────────────────────────────────────── */

/**
 * A failed take as the browser sees it. `billing` is the provider's outcome
 * in its own unit, or null when the viewer may not see it: a job on the
 * platform's key is billed to the platform, and what a vendor charged the
 * platform stays on the platform admin desk. `charge` is what Particl's own
 * ledger holds for the take (credit workspaces), added by the routes.
 */
export type TakeFailure = {
  provider: OutcomeProvider | null;
  stage: ProviderOutcome["stage"] | null;
  code: string;
  kind: FailureKind;
  message: string | null;
  billing: ProviderBilling | null;
  /** Whose key the provider billed: the platform's, the workspace's own, or the person's connected account. */
  payer: "platform" | "own" | "account" | null;
  charge?: TakeCharge | null;
};
/** Particl's own ledger for a failed take: the credits it holds, and whether that is settled. */
export type TakeCharge = { credits: number; settled: boolean };

/**
 * The failure a viewer may read. `credits`: the workspace pays Particl in
 * credits, so a provider's charge on the platform's key is never sent, and a
 * dollar amount is never sent at all (a job on the workspace's own key keeps
 * its state and a token or credit count). Without an outcome (a row from
 * before this was recorded) the take reads as unknown.
 */
export function takeFailure(outcome: ProviderOutcome | null, options: { credits: boolean }): TakeFailure {
  if (!outcome)
    return { provider: null, stage: null, code: "unknown", kind: "unknown", message: null, billing: options.credits ? null : unknown(), payer: options.credits ? null : "own" };
  let billing: ProviderBilling | null = outcome.billing;
  if (options.credits) {
    if (outcome.funding !== "own") billing = null;
    else if (billing.unit === "usd") billing = { state: billing.state, basis: billing.basis };
  }
  const payer = !options.credits ? "own" : outcome.funding === "own" ? "own" : outcome.funding === "platform" ? "platform" : null;
  return { provider: outcome.provider, stage: outcome.stage, code: outcome.code, kind: outcome.kind, message: outcome.message, billing, payer };
}

/** A take's failure from the connected account: always its owner's own credits. */
export function accountFailure(outcome: ProviderOutcome | null, fallbackCode: string | null): TakeFailure {
  if (outcome) return { provider: outcome.provider, stage: outcome.stage, code: outcome.code, kind: outcome.kind, message: outcome.message, billing: outcome.billing, payer: "account" };
  const code = outcomeCode(fallbackCode) ?? "unknown";
  return { provider: "higgsfield_account", stage: null, code, kind: code === "invalid_result" ? "not_kept" : "unknown", message: null, billing: unknown("hf-account-silent"), payer: "account" };
}

/** Parse a browser-side failure; anything unreadable is null. */
export function parseTakeFailure(value: unknown): TakeFailure | null {
  if (!record(value)) return null;
  const code = outcomeCode(value.code);
  if (!code || !FAILURE_KINDS.includes(value.kind as FailureKind)) return null;
  const billing = record(value.billing) && BILLING_STATES.includes(value.billing.state as BillingState) && typeof value.billing.basis === "string" && value.billing.basis in BASIS
    ? (() => {
        const b = value.billing as Record<string, unknown>;
        const amount = amountOf(b.amount), unit = BILLING_UNITS.includes(b.unit as BillingUnit) ? (b.unit as BillingUnit) : undefined;
        return amount != null && unit ? { state: b.state as BillingState, amount, unit, basis: b.basis as BillingBasis } : { state: b.state as BillingState, basis: b.basis as BillingBasis };
      })()
    : null;
  const charge = record(value.charge) && amountOf(value.charge.credits) != null && typeof value.charge.settled === "boolean"
    ? { credits: amountOf(value.charge.credits)!, settled: value.charge.settled }
    : null;
  return {
    provider: OUTCOME_PROVIDERS.includes(value.provider as OutcomeProvider) ? (value.provider as OutcomeProvider) : null,
    stage: value.stage === "submit" || value.stage === "run" ? value.stage : null,
    code, kind: value.kind as FailureKind, message: providerText(value.message), billing,
    payer: value.payer === "platform" || value.payer === "own" || value.payer === "account" ? value.payer : null,
    ...(charge ? { charge } : {}),
  };
}
