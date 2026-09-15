import { test, expect } from "@playwright/test";
import type { CatalogModel, ReasoningOption } from "../../lib/catalog";
import { atomikEffortOptions, atomikReasoningRequest } from "../../lib/atomik-reasoning";

function model(id: string, reasoningOptions?: ReasoningOption[], extra: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id, name: id.split("/")[1], owner: id.split("/")[0], type: "language",
    description: "", contextWindow: 200_000, maxTokens: 128_000, pricing: null,
    reasoningOptions, tags: ["reasoning"], ...extra,
  };
}
const effort = (...values: string[]): ReasoningOption[] => [{ type: "effort", values }];

test("new settings allocate reasoning room while omitted settings preserve older clients", () => {
  const gpt = model("openai/gpt-6-astra", effort("low", "medium", "high", "xhigh", "max"));
  expect(atomikReasoningRequest(gpt, undefined, 2_300)).toEqual({ maxTokens: 2_300, providerOptions: {} });
  expect(atomikReasoningRequest(gpt, "auto", 2_300)).toEqual({ maxTokens: 6_396, providerOptions: {} });
  expect(atomikReasoningRequest({ ...gpt, maxTokens: 1_024 }, undefined, 2_300)).toEqual({ maxTokens: 1_024, providerOptions: {} });
  expect(atomikReasoningRequest(gpt, "high", 4_000)).toEqual({ maxTokens: 20_384, providerOptions: {}, requestFields: { reasoning_effort: "high" } });
  expect(atomikReasoningRequest(gpt, "max", 30_000).maxTokens).toBe(32_768);
  const oldGpt = model("openai/gpt-4o", undefined, { tags: [], maxTokens: 16_384 });
  expect(atomikEffortOptions(oldGpt).map(option => option.value)).toEqual(["auto"]);
  expect(atomikReasoningRequest(oldGpt, "auto", 7_000).maxTokens).toBe(4_000);
});

test("Gemini minimal and medium reach native controls without Gateway effort translation", () => {
  const gemini = model("google/gemini-3.6-flash", effort("minimal", "low", "medium", "high"));
  for (const level of ["minimal", "low", "medium", "high"]) {
    const request = atomikReasoningRequest(gemini, level, 4_000);
    expect(request.requestFields).toBeUndefined();
    expect(request.providerOptions).toEqual({
      google: { thinkingConfig: { thinkingLevel: level } },
      vertex: { thinkingConfig: { thinkingLevel: level } },
    });
  }
  const newer = model("google/gemini-3.8-flash", effort("low", "medium", "high"));
  expect(() => atomikReasoningRequest(newer, "minimal", 4_000)).toThrow("not available");
  expect(atomikEffortOptions(newer).map(option => option.value)).toEqual(["auto", "low", "medium", "high"]);
});

test("native maximum keeps its exact value on explicitly compatible serving providers", () => {
  for (const id of ["openai/gpt-6-astra", "openai/gpt-6-astra-fast", "openai/gpt-5.6-luna"]) {
    const request = atomikReasoningRequest(model(id, effort("low", "medium", "high", "xhigh", "max")), "max", 4_000);
    expect(request.maxTokens).toBe(32_768);
    expect(request.requestFields).toBeUndefined();
    expect(request.providerOptions).toEqual({ openai: { reasoningEffort: "max" }, gateway: { only: ["openai"] } });
  }
  const opus = model("anthropic/claude-opus-5", effort("low", "medium", "high", "xhigh", "max"));
  expect(atomikReasoningRequest(opus, "max", 4_000).providerOptions).toEqual({
    anthropic: { thinking: { type: "adaptive" }, effort: "max" },
    gateway: { only: ["anthropic"] },
  });
  expect(atomikReasoningRequest({ ...opus, id: "anthropic/claude-opus-5-fast" }, "max", 4_000).providerOptions).toEqual({
    anthropic: { thinking: { type: "adaptive" }, effort: "max" }, gateway: { only: ["anthropic"] },
  });
});

test("ordinary Claude effort and GPT OSS preserve lossless provider routing", () => {
  for (const id of ["anthropic/claude-sonnet-4.6", "anthropic/claude-fable-5", "openai/gpt-oss-120b", "openai/o3-mini"]) {
    const request = atomikReasoningRequest(model(id, effort("low", "medium", "high")), "medium", 2_000);
    expect(request).toEqual({ maxTokens: 10_192, providerOptions: {}, requestFields: { reasoning_effort: "medium" } });
  }
});

test("legacy budgets use exact token controls, bounded by model and fallback endpoint limits", () => {
  const sonnet = model("anthropic/claude-sonnet-4.5", [{ type: "budget_tokens", min: 1_024 }], { maxTokens: 64_000 });
  expect(atomikEffortOptions(sonnet).map(option => option.value)).toEqual(["auto", "none", "budget:1024", "budget:4096"]);
  expect(atomikReasoningRequest(sonnet, "budget:4096", 4_000)).toEqual({
    maxTokens: 8_096, providerOptions: {}, requestFields: { reasoning: { enabled: true, max_tokens: 4_096 } },
  });
  expect(() => atomikReasoningRequest(sonnet, "budget:8192", 4_000)).toThrow("not available");
  const oldOpus = model("anthropic/claude-opus-4", undefined, { maxTokens: 8_192 });
  expect(atomikEffortOptions(oldOpus).map(option => option.value)).toEqual(["auto", "none", "budget:1024", "budget:4096"]);
  expect(atomikReasoningRequest(oldOpus, "auto", 4_000).maxTokens).toBe(8_096);
  const tinyBudget = model("google/gemini-2.5-pro", [{ type: "budget_tokens", min: 2_048, max: 5_000 }]);
  expect(atomikEffortOptions(tinyBudget).map(option => option.value)).toEqual(["auto", "budget:4096"]);
  const tinyOutput = model("anthropic/claude-haiku-4.5", [{ type: "budget_tokens", min: 1_024 }], { maxTokens: 1_024 });
  expect(atomikEffortOptions(tinyOutput).map(option => option.value)).toEqual(["auto", "none"]);
  const tightOutput = { ...tinyOutput, maxTokens: 8_193 };
  expect(atomikEffortOptions(tightOutput).map(option => option.value)).not.toContain("budget:8192");
  expect(atomikReasoningRequest(tightOutput, "budget:4096", 1).maxTokens).toBe(4_996);
});

test("Off is offered only when the selected model permits disabling reasoning", () => {
  const options: ReasoningOption[] = [{ type: "toggle" }, ...effort("low", "medium", "high", "xhigh")];
  for (const id of ["anthropic/claude-fable-5", "anthropic/claude-fable-5.1", "anthropic/claude-opus-5"]) {
    const entry = model(id, options);
    expect(atomikEffortOptions(entry).map(option => option.value)).not.toContain("none");
    expect(() => atomikReasoningRequest(entry, "none", 4_000)).toThrow("not available");
  }
  const flash = model("google/gemini-2.5-flash-lite", [{ type: "toggle" }, { type: "budget_tokens", min: 512, max: 24_576 }]);
  expect(atomikReasoningRequest(flash, "none", 4_000)).toEqual({ maxTokens: 4_000, providerOptions: {}, requestFields: { reasoning: { enabled: false } } });
  const pro = model("google/gemini-2.5-pro", [{ type: "budget_tokens", min: 128, max: 32_768 }]);
  expect(atomikEffortOptions(pro).map(option => option.value)).not.toContain("none");
  const gpt = model("openai/gpt-5.6-sol", effort("none", "low", "medium", "high", "xhigh", "max"));
  expect(atomikReasoningRequest(gpt, "none", 4_000)).toEqual({ maxTokens: 4_000, providerOptions: {}, requestFields: { reasoning_effort: "none" } });
});

test("unsupported settings fail with a friendly 422 before a request can be created", () => {
  const entry = model("openai/gpt-5-pro", effort("high"));
  for (const selected of ["medium", "xhigh", "max", "budget:8192", "budget:1e3", "HIGH", "", "provider-default"]) {
    try {
      atomikReasoningRequest(entry, selected, 4_000);
      throw new Error("Expected invalid effort to be rejected");
    } catch (error) {
      expect((error as Error & { status?: number }).status).toBe(422);
      expect((error as Error).message).toContain(entry.name);
    }
  }
  const unknown = model("openai/future-model", undefined);
  expect(atomikEffortOptions(unknown).map(option => option.value)).toEqual(["auto"]);
  expect(atomikEffortOptions(model("openai/future-model", effort("max"))).map(option => option.value)).toEqual(["auto"]);
});

test("adaptive Claude controls do not expose the deprecated token-budget interface", () => {
  const entry = model("anthropic/claude-opus-4.6", [{ type: "toggle" }, ...effort("low", "medium", "high"), { type: "budget_tokens", min: 1_024 }]);
  expect(atomikEffortOptions(entry).map(option => option.value)).toEqual(["auto", "none", "low", "medium", "high"]);
  expect(() => atomikReasoningRequest(entry, "budget:1024", 4_000)).toThrow("not available");
});

test("all offered settings respect response ceilings and leave room after a fixed budget", () => {
  const entries = [
    model("openai/gpt-6-astra", effort("low", "medium", "high", "xhigh", "max")),
    model("anthropic/claude-opus-5", effort("low", "medium", "high", "xhigh", "max")),
    model("google/gemini-2.5-pro", [{ type: "budget_tokens", min: 128, max: 32_768 }]),
    model("anthropic/claude-haiku-4.5", [{ type: "toggle" }, { type: "budget_tokens", min: 1_024 }], { maxTokens: 64_000 }),
  ];
  for (const entry of entries) for (const option of atomikEffortOptions(entry)) {
    const request = atomikReasoningRequest(entry, option.value, 4_000);
    expect(request.maxTokens).toBeLessThanOrEqual(32_768);
    expect(request.maxTokens).toBeLessThanOrEqual(entry.maxTokens!);
    if (option.value.startsWith("budget:")) expect(request.maxTokens).toBeGreaterThan(Number(option.value.split(":")[1]));
    expect(JSON.parse(JSON.stringify(request))).toEqual(request);
  }
});
