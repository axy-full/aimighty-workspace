import type { CatalogModel, ReasoningOption } from "./catalog";

/** Public, serializable options shared by the picker and both Atomik APIs. */
export type AtomikEffortOption = { value: string; label: string; description?: string };
export type AtomikReasoningRequest = {
  maxTokens: number;
  providerOptions: Record<string, unknown>;
  /** Fields for the Gateway's raw /v1/chat/completions request body. */
  requestFields?: Record<string, unknown>;
};

const MAX_OUTPUT_TOKENS = 32_768;
const MAX_VISIBLE_TOKENS = 4_000;
const MIN_ANSWER_TOKENS = 900;
const BUDGET_PRESETS = [1_024, 4_096, 8_192] as const;
const NAMED = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const LABELS: Record<string, string> = {
  none: "Off", minimal: "Minimal", low: "Low", medium: "Medium",
  high: "High", xhigh: "Extra high", max: "Maximum",
};
const DESCRIPTIONS: Record<string, string> = {
  none: "Respond without optional reasoning.",
  minimal: "The lightest reasoning for quick replies.",
  low: "Prioritize speed with lighter reasoning.",
  medium: "Balance reasoning depth and response time.",
  high: "Spend more time on complex decisions.",
  xhigh: "Explore difficult decisions more thoroughly.",
  max: "Use the model's highest supported effort within the response limit.",
};

// Verified against the public Gateway catalog and provider documentation on
// 2026-09-15. Missing controls on other models must not invent capabilities.
const LEGACY_CLAUDE = new Set([
  "anthropic/claude-opus-4", "anthropic/claude-sonnet-4",
  "anthropic/claude-opus-4.5", "anthropic/claude-sonnet-4.5",
  "anthropic/claude-haiku-4.5",
]);
const OPENAI_NATIVE_MAX = new Set([
  "openai/gpt-5.6-luna", "openai/gpt-5.6-luna-fast",
  "openai/gpt-5.6-sol", "openai/gpt-5.6-sol-fast",
  "openai/gpt-5.6-terra", "openai/gpt-5.6-terra-fast",
  "openai/gpt-6-astra", "openai/gpt-6-astra-fast",
]);
const CLAUDE_NATIVE_MAX = new Set(["anthropic/claude-opus-5", "anthropic/claude-opus-5-fast"]);

function controls(model: CatalogModel): ReasoningOption[] {
  if (model.reasoningOptions?.length) return model.reasoningOptions;
  if (LEGACY_CLAUDE.has(model.id)) return [{ type: "toggle" }, { type: "budget_tokens", min: 1_024 }];
  return [];
}

function outputLimit(model: CatalogModel): number {
  const reported = model.maxTokens;
  const limit = typeof reported === "number" && Number.isFinite(reported) && reported > 0
    ? Math.floor(reported) : 8_192;
  // Sonnet 4.5's aggregate catalog advertises 64k, while its active Bedrock
  // and Vertex endpoints allow 8k. Keep those providers available safely.
  return Math.min(MAX_OUTPUT_TOKENS, limit, model.id === "anthropic/claude-sonnet-4.5" ? 8_192 : Infinity);
}

function canDisable(model: CatalogModel, options: ReasoningOption[]): boolean {
  // Fable's catalog currently advertises toggle, but its native API rejects
  // disabled thinking. Opus 5 also has effort-dependent disabling rules.
  if (/^anthropic\/claude-(?:fable-|opus-5)/.test(model.id)) return false;
  if (LEGACY_CLAUDE.has(model.id)) return true;
  if (!options.some(option => option.type === "toggle")) return false;
  if (model.owner === "anthropic") return true;
  return ["google/gemini-2.5-flash", "google/gemini-2.5-flash-lite"].includes(model.id);
}

export function atomikEffortOptions(model: CatalogModel): AtomikEffortOption[] {
  const result: AtomikEffortOption[] = [{ value: "auto", label: "Auto", description: "Use this model's default reasoning behavior." }];
  const options = controls(model);
  const named = new Set(options.flatMap(option => option.type === "effort" ? option.values : []));
  if (canDisable(model, options)) named.add("none");
  for (const value of NAMED) {
    if (!named.has(value)) continue;
    if (value === "max" && !OPENAI_NATIVE_MAX.has(model.id) && !CLAUDE_NATIVE_MAX.has(model.id)) continue;
    if (value === "none" && /^anthropic\/claude-(?:fable-|opus-5)/.test(model.id)) continue;
    result.push({ value, label: LABELS[value], description: DESCRIPTIONS[value] });
  }
  // Prefer adaptive effort when it exists. Fixed token budgets are deprecated
  // on Claude 4.6; exposing both would make one setting silently override another.
  if (options.some(option => option.type === "effort")) return result;
  const budget = options.find((option): option is Extract<ReasoningOption, { type: "budget_tokens" }> => option.type === "budget_tokens");
  if (!budget) return result;
  const min = Math.max(0, budget.min);
  const max = Math.min(budget.max ?? Infinity, outputLimit(model) - MIN_ANSWER_TOKENS);
  for (const tokens of BUDGET_PRESETS) {
    if (tokens < min || tokens > max) continue;
    result.push({
      value: `budget:${tokens}`,
      label: `${tokens.toLocaleString("en-US")} tokens`,
      description: `Allow up to ${tokens.toLocaleString("en-US")} thinking tokens, plus room for the answer.`,
    });
  }
  return result;
}

function invalidEffort(model: CatalogModel): Error & { status: number } {
  return Object.assign(new Error(`That effort setting is not available for ${model.name}. Choose one of this model's supported settings.`), { status: 422 });
}

/**
 * Native provider options avoid Gateway's shared translation of Gemini medium
 * to high and max to xhigh. All fields here are documented for raw HTTP calls:
 * https://vercel.com/docs/ai-gateway/models-and-providers/reasoning
 * https://vercel.com/docs/ai-gateway/models-and-providers/provider-options
 */
/** `maxVisible` lifts the planner's answer ceiling for callers that must return long documents (the script writer). */
export function atomikReasoningRequest(model: CatalogModel, effort: string | undefined, visibleTokens: number, maxVisible: number = MAX_VISIBLE_TOKENS): AtomikReasoningRequest {
  // Older clients did not send effort. Preserve their existing response ceiling.
  if (effort === undefined) return { maxTokens: Math.min(visibleTokens, model.maxTokens ?? Infinity), providerOptions: {} };
  if (!atomikEffortOptions(model).some(option => option.value === effort)) throw invalidEffort(model);
  if (!Number.isFinite(visibleTokens) || visibleTokens <= 0) throw invalidEffort(model);
  const visible = Math.min(Math.max(MAX_VISIBLE_TOKENS, maxVisible), Math.max(MIN_ANSWER_TOKENS, Math.floor(visibleTokens)));
  const limit = outputLimit(model);
  const request: AtomikReasoningRequest = { maxTokens: Math.min(visible, limit), providerOptions: {} };
  if (effort === "auto") {
    if (model.tags?.includes("reasoning") || controls(model).length) request.maxTokens = Math.min(limit, visible + 4_096);
    return request;
  }
  if (effort.startsWith("budget:")) {
    const budget = Number(effort.slice("budget:".length));
    request.maxTokens = Math.min(limit, visible + budget);
    if (budget >= request.maxTokens) throw invalidEffort(model);
    request.requestFields = { reasoning: { enabled: true, max_tokens: budget } };
    return request;
  }
  const allowance: Record<string, number> = { none: 0, minimal: 1_024, low: 4_096, medium: 8_192, high: 16_384, xhigh: 24_576, max: MAX_OUTPUT_TOKENS };
  request.maxTokens = Math.min(limit, visible + allowance[effort]);
  if (effort === "none" && model.owner !== "openai") {
    request.requestFields = { reasoning: { enabled: false } };
  } else if (model.owner === "google") {
    const thinkingConfig = { thinkingLevel: effort };
    request.providerOptions = { google: { thinkingConfig }, vertex: { thinkingConfig: { ...thinkingConfig } } };
  } else if (effort === "max" && model.owner === "openai") {
    request.providerOptions = { openai: { reasoningEffort: "max" }, gateway: { only: ["openai"] } };
  } else if (effort === "max" && model.owner === "anthropic") {
    request.providerOptions = {
      anthropic: { thinking: { type: "adaptive" }, effort: "max" },
      // Anthropic also documents Bedrock's native max shape, but its strict
      // structured-output support table has not qualified Opus 5 on Bedrock.
      gateway: { only: ["anthropic"] },
    };
  } else {
    request.requestFields = { reasoning_effort: effort };
  }
  return request;
}
