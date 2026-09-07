import { test, expect } from "@playwright/test";
import { chatBody } from "../../lib/gateway";

/** The instruction, the rule library and the Setup are the same on every call, so they are sent cacheable (brief 1.8) — and plainly when a model refuses the mark. */
test("a chat call marks its instruction cacheable, and the plain shape is the same call without the mark", () => {
  const call = { model: "anthropic/claude-sonnet-5", system: "THE RULES", user: "the scene", maxTokens: 900 };
  const rich = JSON.parse(chatBody(call));
  expect(rich.model).toBe("anthropic/claude-sonnet-5");
  expect(rich.max_tokens).toBe(900);
  expect(rich.messages[0]).toEqual({ role: "system", content: "THE RULES", cache_control: { type: "ephemeral" } });
  expect(rich.messages[1]).toEqual({ role: "user", content: "the scene" });
  const plain = JSON.parse(chatBody(call, false));
  expect(plain.messages[0]).toEqual({ role: "system", content: "THE RULES" });
  expect(plain.messages[1]).toEqual(rich.messages[1]);
  expect(JSON.parse(chatBody({ model: "m", system: "s", user: "u" })).max_tokens).toBe(1200);
});
