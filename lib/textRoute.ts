import { APICallError } from "ai";
import { vendorKey, vendorKeyEnv, type VendorKeyName } from "./vendorKeys";
import { isTextDirect, type TextDirectVendor } from "./textDirectVendors";

/**
 * Which door a text model goes through (P4b, the gateway removal).
 *
 * `TEXT_DIRECT` is a comma list of the vendors that already go straight to
 * their own API: `anthropic`, `google`, `xai`. Empty (the default) keeps
 * today's behaviour: OpenAI direct when its key is set, everything else
 * through the gateway. Each vendor is switched on, and back off, by env alone.
 *
 * There is no fallback between doors. A vendor that is switched on and has no
 * key fails with the name of the missing variable; it never quietly goes back
 * to the gateway, and an unmapped model id is refused rather than guessed.
 */
/** `TEXT_DIRECT` is parsed in one place (lib/textDirectVendors.ts), shared with the catalogue's offer rule. */
export type DirectVendor = TextDirectVendor;
export type TextRoute = "openai" | DirectVendor | "gateway";

/** The vendor key each direct door reads. Google text shares the Nano Banana key. */
export const DIRECT_KEY: Record<DirectVendor, VendorKeyName> = { anthropic: "anthropic", google: "gemini", xai: "xai" };
/** The only origin each direct door may send a key to. */
export const DIRECT_BASE_URL: Record<DirectVendor, string> = {
  anthropic: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  xai: "https://api.x.ai/v1",
};
/** The language endpoints each door calls. Nothing else on that origin is reachable with the key. */
const DIRECT_PATHS: Record<DirectVendor, RegExp> = {
  anthropic: /^\/v1\/messages$/,
  google: /^\/v1beta\/models\/[A-Za-z0-9._-]+:(?:generateContent|streamGenerateContent)$/,
  xai: /^\/v1\/responses$/,
};

/**
 * App id → provider id, checked in by hand. Never derived at runtime: an id
 * that is not listed here has no direct door. Verify against each provider's
 * `GET /v1/models` during the owner's smoke run before switching a vendor on.
 */
export const DIRECT_MODEL_IDS: Readonly<Record<string, string>> = {
  "anthropic/claude-haiku-4.5": "claude-haiku-4-5",
  "anthropic/claude-opus-4": "claude-opus-4-0",
  "anthropic/claude-opus-4.5": "claude-opus-4-5",
  "anthropic/claude-opus-4.6": "claude-opus-4-6",
  "anthropic/claude-opus-4.7": "claude-opus-4-7",
  "anthropic/claude-opus-4.8": "claude-opus-4-8",
  "anthropic/claude-opus-5": "claude-opus-5",
  "anthropic/claude-sonnet-4": "claude-sonnet-4-0",
  "anthropic/claude-sonnet-4.5": "claude-sonnet-4-5",
  "anthropic/claude-sonnet-4.6": "claude-sonnet-4-6",
  "anthropic/claude-sonnet-5": "claude-sonnet-5",
  "anthropic/claude-fable-5": "claude-fable-5",
  "anthropic/claude-fable-5.1": "claude-fable-5-1",
  "google/gemini-2.5-flash": "gemini-2.5-flash",
  "google/gemini-2.5-flash-lite": "gemini-2.5-flash-lite",
  "google/gemini-2.5-pro": "gemini-2.5-pro",
  "google/gemini-3-flash": "gemini-3-flash-preview",
  "google/gemini-3.1-flash-lite": "gemini-3.1-flash-lite-preview",
  "google/gemini-3.1-pro-preview": "gemini-3.1-pro-preview",
  "google/gemini-3.5-flash": "gemini-3.5-flash",
  "google/gemini-3.5-flash-lite": "gemini-3.5-flash-lite",
  "google/gemini-3.6-flash": "gemini-3.6-flash",
  "google/gemini-3.7-flash": "gemini-3.7-flash",
  "google/gemini-3.8-flash": "gemini-3.8-flash",
  "spacexai/grok-4.7": "grok-4.7",
  "spacexai/grok-4.6": "grok-4.6",
  "spacexai/grok-4.5": "grok-4.5",
  "spacexai/grok-4.3": "grok-4.3",
  "spacexai/grok-4.20-reasoning": "grok-4.20-reasoning",
  "spacexai/grok-4.1-fast-reasoning": "grok-4-1-fast-reasoning",
  // The gateway lists Grok under `spacexai/`; `xai/` is the provider's own spelling of the same models.
  "xai/grok-4.7": "grok-4.7",
  "xai/grok-4.6": "grok-4.6",
  "xai/grok-4.5": "grok-4.5",
  "xai/grok-4.3": "grok-4.3",
  "xai/grok-4.20-reasoning": "grok-4.20-reasoning",
  "xai/grok-4.1-fast-reasoning": "grok-4-1-fast-reasoning",
};

/**
 * Offered ids with no direct equivalent; the router refuses them. None today:
 * the three there were (the `-fast` listings, a gateway product, and Claude 3
 * Haiku, retired by Anthropic on 2026-04-19) left every menu on 8 October 2026,
 * and a choice saved on one reads as its alias before it reaches the router
 * (lib/modelAliases.ts).
 */
export const UNMAPPED_DIRECT_MODEL_IDS: readonly string[] = [];

/** The vendor a model belongs to by its app prefix, whether or not it is switched on. */
export function directVendorOf(model: string): DirectVendor | null {
  if (model.startsWith("anthropic/")) return "anthropic";
  if (model.startsWith("google/")) return "google";
  if (model.startsWith("spacexai/") || model.startsWith("xai/")) return "xai";
  return null;
}

export function isDirectRoute(route: TextRoute): route is DirectVendor {
  return route !== "openai" && route !== "gateway";
}

/** The door for one model, decided once before the first call. */
export function textRoute(model: string): TextRoute {
  if (model.startsWith("openai/") && vendorKey("openai")) return "openai";
  const vendor = directVendorOf(model);
  return vendor && isTextDirect(vendor) ? vendor : "gateway";
}

/** The provider's own id for an app id. Unlisted ids are refused. */
export function directModelId(model: string): string {
  const id = Object.hasOwn(DIRECT_MODEL_IDS, model) ? DIRECT_MODEL_IDS[model] : undefined;
  if (!id) throw new Error(`${model} has no direct provider model. Choose another model.`);
  return id;
}

/** The key for a direct door, or an error that names the missing variable. */
export function directKey(vendor: DirectVendor): string {
  const key = vendorKey(DIRECT_KEY[vendor]);
  if (!key) throw new Error(`${vendorKeyEnv(DIRECT_KEY[vendor])} is not set. Direct ${vendor} text is switched on in TEXT_DIRECT and has no key; nothing was sent.`);
  return key;
}

/**
 * Credentials go only to the vendor's own language endpoint, and a redirect is
 * refused before a client could forward an authenticated request elsewhere.
 * The same rule as `openAIFetch`.
 */
export function directFetch(vendor: DirectVendor, fetcher: typeof fetch): typeof fetch {
  const origin = new URL(DIRECT_BASE_URL[vendor]).origin;
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== origin || !DIRECT_PATHS[vendor].test(url.pathname)) throw new Error("The language endpoint is not supported.");
    return fetcher(input, { ...init, redirect: "error" });
  };
}

/**
 * The same provider error without `requestBodyValues` (the prompt) or a cause
 * that could hold it. Status, headers, response body and retryability stay, so
 * failure classification (lib/providerFailure.ts) reads it as before.
 */
export function redactProviderError(error: unknown): unknown {
  if (!APICallError.isInstance(error)) return error;
  return new APICallError({ message: error.message, url: error.url, requestBodyValues: undefined, statusCode: error.statusCode,
    responseHeaders: error.responseHeaders, responseBody: error.responseBody, isRetryable: error.isRetryable, data: error.data });
}
