import { APICallError } from "ai";
import { vendorKey, vendorKeyEnv, type VendorKeyName } from "./vendorKeys";
import { isTextDirect, type TextDirectVendor } from "./textDirectVendors";
import { gatewayReachable } from "./gateway";
import { engineMock } from "./mock";
import modelCatalogJson from "./modelCatalog.json";

/**
 * Which door a text model goes through (P4b, the gateway removal).
 *
 * `TEXT_DIRECT` is a comma list of the vendors that already go straight to
 * their own API: `anthropic`, `google`, `xai`. Empty (the default) keeps
 * today's behaviour: OpenAI direct when its key is set, everything else
 * through the gateway. Each vendor is switched on, and back off, by env alone.
 *
 * Google is always direct, whatever `TEXT_DIRECT` says (lib/textDirectVendors.ts; Vercel out, owner 14 Oct 2026): Gemini text carries the shared safety
 * settings (lib/geminiSafety.ts), and no Gemini id reaches the gateway.
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
  /* Only ids the owner's own keys listed on 11 October 2026 (each provider's free model list). */
  "anthropic/claude-opus-5": "claude-opus-5",
  "anthropic/claude-opus-5.5": "claude-opus-5-5",
  "anthropic/claude-sonnet-5": "claude-sonnet-5",
  "anthropic/claude-sonnet-5.5": "claude-sonnet-5-5",
  "anthropic/claude-haiku-5.5": "claude-haiku-5-5",
  "anthropic/claude-fable-5": "claude-fable-5",
  "anthropic/claude-fable-5.1": "claude-fable-5-1",
  "google/gemini-3-flash": "gemini-3-flash-preview",
  // Google shut the -preview id down; the key lists the stable id (11 Oct 2026).
  "google/gemini-3.1-flash-lite": "gemini-3.1-flash-lite",
  "google/gemini-3.1-pro-preview": "gemini-3.1-pro-preview",
  "google/gemini-3.5-flash": "gemini-3.5-flash",
  "google/gemini-3.5-flash-lite": "gemini-3.5-flash-lite",
  "google/gemini-3.6-flash": "gemini-3.6-flash",
  "google/gemini-3.7-flash": "gemini-3.7-flash",
  "spacexai/grok-4.7": "grok-4.7",
  "spacexai/grok-4.6": "grok-4.6",
  "spacexai/grok-4.5": "grok-4.5",
  "spacexai/grok-4.3": "grok-4.3",
  // The key lists only the dated id (docs.x.ai/docs/models agrees, 11 Oct 2026).
  "spacexai/grok-4.20-reasoning": "grok-4.20-0309-reasoning",
  // The gateway lists Grok under `spacexai/`; `xai/` is the provider's own spelling of the same models.
  "xai/grok-4.7": "grok-4.7",
  "xai/grok-4.6": "grok-4.6",
  "xai/grok-4.5": "grok-4.5",
  "xai/grok-4.3": "grok-4.3",
  "xai/grok-4.20-reasoning": "grok-4.20-0309-reasoning",
};

/**
 * Offered ids with no direct equivalent: the owner's keys did not list them on
 * 11 October 2026. The router refuses them, and no menu offers them while their
 * vendor is direct (textRouteWorks); they stay on the gateway while it is reachable.
 */
export const UNMAPPED_DIRECT_MODEL_IDS: readonly string[] = [
  "anthropic/claude-haiku-4.5",
  "anthropic/claude-opus-4",
  "anthropic/claude-opus-4.5",
  "anthropic/claude-opus-4.6",
  "anthropic/claude-opus-4.7",
  "anthropic/claude-opus-4.8",
  "anthropic/claude-sonnet-4",
  "anthropic/claude-sonnet-4.5",
  "anthropic/claude-sonnet-4.6",
  "google/gemini-2.5-flash",
  "google/gemini-2.5-flash-lite",
  "google/gemini-2.5-pro",
  "google/gemini-3.8-flash",
  "spacexai/grok-4.1-fast-reasoning",
  "xai/grok-4.1-fast-reasoning",
];

/**
 * Mapped (the router sends them) but on no menu: the provider's official price
 * page does not confirm the price the snapshot holds (11 October 2026).
 * Gemini 3.5 Flash and 3.7 Flash are not on Google's price page; Gemini 3.1
 * Flash-Lite's cached-input rate there ($0.025/M) differs from the snapshot's ($0.03/M).
 */
export const DIRECT_PRICE_TO_CONFIRM: readonly string[] = [
  "google/gemini-3.5-flash",
  "google/gemini-3.7-flash",
  "google/gemini-3.1-flash-lite",
];

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

/** The ids the gateway listed when the snapshot was taken (lib/modelCatalog.json `models`); a provider-priced model is not among them. */
const GATEWAY_LISTED = new Set<string>((modelCatalogJson as { models: { id: string }[] }).models.map((m) => m.id));

/**
 * Whether a text model has a door that works right now, so a menu may offer it:
 * OpenAI on its own key; a vendor switched on in TEXT_DIRECT with its key set
 * and the id mapped above (and its price confirmed); anything else only while the gateway is reachable
 * and the gateway listed it.
 * A gateway-only model is never offered once the gateway key is gone.
 */
export function textRouteWorks(model: string): boolean {
  if (engineMock()) return true;   // nothing is sent under ENGINE_MOCK
  const route = textRoute(model);
  if (route === "openai") return true;
  if (route === "gateway") return !model.startsWith("openai/") && gatewayReachable() && GATEWAY_LISTED.has(model);
  return Boolean(vendorKey(DIRECT_KEY[route])) && Object.hasOwn(DIRECT_MODEL_IDS, model) && !DIRECT_PRICE_TO_CONFIRM.includes(model);
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
  if (!key) throw new Error(vendor === "google"
    ? `${vendorKeyEnv(DIRECT_KEY[vendor])} is not set. Gemini text always goes direct to Google and needs ${vendorKeyEnv(DIRECT_KEY[vendor])}; nothing was sent.`
    : `${vendorKeyEnv(DIRECT_KEY[vendor])} is not set. Direct ${vendor} text is switched on in TEXT_DIRECT and has no key; nothing was sent.`);
  return key;
}

/**
 * Hardening (not the cause of any observed failure): set on an Anthropic call
 * whose tools stay defined but may not be used (`tool_choice: none`), by the
 * door's middleware (lib/language-provider.ts). The SDK drops the tools for
 * `toolChoice: none`, while the Messages API expects tools to stay defined when
 * the history holds tool_use / tool_result blocks; the fetch below keeps them
 * and sets the choice itself, a valid request either way. The header never
 * leaves the process.
 */
export const ANTHROPIC_NO_TOOL_HEADER = "x-particl-tool-choice-none";

function anthropicToolChoiceNone(init: RequestInit | undefined): RequestInit | undefined {
  const headers = new Headers(init?.headers);
  if (!headers.has(ANTHROPIC_NO_TOOL_HEADER)) return init;
  headers.delete(ANTHROPIC_NO_TOOL_HEADER);
  if (typeof init?.body !== "string") return { ...init, headers };
  const body = JSON.parse(init.body) as Record<string, unknown>;
  if (Array.isArray(body.tools) && body.tools.length) body.tool_choice = { type: "none" };
  return { ...init, headers, body: JSON.stringify(body) };
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
    const sent = vendor === "anthropic" ? anthropicToolChoiceNone(init) : init;
    return fetcher(input, { ...sent, redirect: "error" });
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
