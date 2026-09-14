import { test, expect } from "@playwright/test";
import { selectAtomikModel } from "../../lib/atomikModelPolicy";

test("Auto ignores an unapproved platform route and never accepts newly discovered models", () => {
  const available = ["new-provider/new-model", "anthropic/claude-opus-4.7", "anthropic/claude-sonnet-4.6"];
  expect(selectAtomikModel("auto", available, "new-provider/new-model")).toBe("anthropic/claude-sonnet-4.6");
  expect(selectAtomikModel("auto", available, "anthropic/claude-opus-4.7")).toBe("anthropic/claude-opus-4.7");
  expect(() => selectAtomikModel("auto", ["new-provider/new-model"])).toThrow("No supported Atomik");
});

test("an explicit retired or unapproved thinking model cannot silently become a different paid model", () => {
  const available = ["anthropic/claude-sonnet-4.6", "openai/gpt-5.5"];
  expect(() => selectAtomikModel("openai/gpt-5.5", available)).toThrow("not offered");
  expect(() => selectAtomikModel("openai/gpt-5.5-pro", available)).toThrow("currently unavailable");
  expect(selectAtomikModel("anthropic/claude-sonnet-4.6", available)).toBe("anthropic/claude-sonnet-4.6");
});
