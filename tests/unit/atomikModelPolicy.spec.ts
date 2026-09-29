import { test, expect } from "@playwright/test";
import { selectAtomikModel } from "../../lib/atomikModelPolicy";

test("Auto ignores unrelated providers and respects an available explicit route", () => {
  const available = ["new-provider/new-model", "anthropic/claude-opus-4.7", "anthropic/claude-sonnet-4.6"];
  expect(selectAtomikModel("auto", available, "new-provider/new-model")).toBe("anthropic/claude-sonnet-4.6");
  expect(selectAtomikModel("auto", available, "anthropic/claude-opus-4.7")).toBe("anthropic/claude-opus-4.7");
  expect(() => selectAtomikModel("auto", ["new-provider/new-model"])).toThrow("No supported Atomik");
});

test("an explicit retired or unapproved thinking model cannot silently become a different paid model", () => {
  const available = ["anthropic/claude-sonnet-4.6", "openai/gpt-5.5"];
  expect(selectAtomikModel("openai/gpt-5.5", available)).toBe("openai/gpt-5.5");
  expect(() => selectAtomikModel("google/gemini-3-pro-image", available)).toThrow("not offered");
  /* A model Atomik used to offer is refused with the reason, never swapped for another paid model. */
  expect(() => selectAtomikModel("google/gemini-3.1-pro-preview", [...available, "google/gemini-3.1-pro-preview"])).toThrow("no longer offered in Atomik");
  expect(() => selectAtomikModel("openai/gpt-5.5-pro", available)).toThrow("currently unavailable");
  expect(selectAtomikModel("anthropic/claude-sonnet-4.6", available)).toBe("anthropic/claude-sonnet-4.6");
});

test("the planner catalogue is the Claude, OpenAI and Grok part of the verified text catalogue, and excludes media and classifiers", async () => {
  const { ATOMIK_MODEL_IDS, VERIFIED_TEXT_MODEL_IDS, isAtomikModel, isVerifiedTextModel, isRetiredAtomikModel } = await import('../../lib/atomikModelPolicy');
  expect(VERIFIED_TEXT_MODEL_IDS.length).toBe(89);
  expect(ATOMIK_MODEL_IDS.length).toBe(78);
  for (const id of ['openai/gpt-6-astra', 'anthropic/claude-opus-5', 'openai/gpt-4o-mini', 'spacexai/grok-4.7', 'spacexai/grok-4.1-fast-reasoning']) expect(isAtomikModel(id)).toBe(true);
  /* Gemini is verified text, used by the prompt enhancer, and no longer Atomik's. */
  for (const id of ['google/gemini-3.8-flash', 'google/gemini-3.1-pro-preview']) {
    expect(isAtomikModel(id), id).toBe(false);
    expect(isVerifiedTextModel(id), id).toBe(true);
    expect(isRetiredAtomikModel(id), id).toBe(true);
  }
  for (const id of ['openai/gpt-image-2', 'openai/gpt-oss-safeguard-20b', 'google/gemma-3-27b-it', 'anthropic/not-a-real-model', 'spacexai/grok-imagine-image-2.0', 'spacexai/grok-tts']) {
    expect(isAtomikModel(id), id).toBe(false);
    expect(isRetiredAtomikModel(id), id).toBe(false);
  }
});

test('Gateway reasoning metadata rejects malformed and unknown controls', async () => {
  const { parseReasoningOptions } = await import('../../lib/catalog');
  expect(parseReasoningOptions(null)).toEqual([]);
  expect(parseReasoningOptions([{ type: 'effort', values: ['low','low','MAX','infinite',null,'max'] }, { type: 'budget_tokens', min: 1024, max: 8192 }, { type: 'toggle' }, { type: 'budget_tokens', min: -1 }, { type: 'budget_tokens', min: 1024, max: 512 }, { type: 'arbitrary' }])).toEqual([
    { type: 'effort', values: ['low','max'] }, { type: 'budget_tokens', min: 1024, max: 8192 }, { type: 'toggle' },
  ]);
});
