import { test, expect } from "@playwright/test";

process.env.ENGINE_MOCK = "1";

/** The writer is told the target engine's dialect. Under the mocked gateway the reply echoes the instruction, so the instruction itself can be read back. */
test("the writer writes for the engine's dialect: Kling gets one paragraph, Seedance 2.5 gets timestamps, 2.0 gets shot numbers", async () => {
  const { enhancePrompt } = await import("../../lib/enhance");
  const kling = await enhancePrompt({ prompt: "wet silk, sea, dusk", citations: [], model: "fal-ai/kling-video/v3/standard", durationS: 5, task: "generate", provider: "gateway" });
  expect(kling.text).toContain("as a Kling prompt");
  expect(kling.text).toContain("(Kling)");
  expect(kling.text).toContain("ONE plain paragraph");
  expect(kling.text).not.toContain("INTEGER-SECOND TIMESTAMPS");
  const sd25 = await enhancePrompt({ prompt: "wet silk, sea, dusk", citations: [], model: "dreamina-seedance-2-5-260628", durationS: 5, task: "generate", provider: "gateway" });
  expect(sd25.text).toContain("as a Seedance prompt");
  expect(sd25.text).toContain("INTEGER-SECOND TIMESTAMPS");
  const sd20 = await enhancePrompt({ prompt: "wet silk, sea, dusk", citations: [], model: "dreamina-seedance-2-0-260128", durationS: 5, task: "generate", provider: "gateway" });
  expect(sd20.text).toContain("does NOT respond to timestamps");
  expect(sd20.text).not.toContain("ONE plain paragraph");
});
