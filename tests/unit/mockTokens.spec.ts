import { test, expect } from "@playwright/test";

process.env.ENGINE_MOCK = "1";

/** The mocked engine charges for what was asked (brief §2 rule 1 lives on mocks): a mocked 480p 4 s clip costs what the button said, never a fixed 1080p 5 s one. */
test("a mocked Ark task reports the catalogue's token estimate for the clip it was asked for", async () => {
  const { submitTask, fetchTask, mockTokensFor } = await import("../../lib/ark");
  const { estimateTokens } = await import("../../lib/models");
  const id = await submitTask("dreamina-seedance-2-5-260628", "a paper lantern over a dark river", { ratio: "16:9", resolution: "480p", duration: 4, watermark: false });
  expect(id).toMatch(/^mock_ark_480p-16x9-4-0_\d+$/);
  // A birth time far in the past: done, without waiting three seconds.
  const done = id.replace(/_\d+$/, "_1000");
  const task = await fetchTask(done);
  expect(task.status).toBe("succeeded");
  expect(task.totalTokens).toBe(estimateTokens("480p", "16:9", 4));
  expect(task.totalTokens).toBeLessThan(244_800);
  // An id from before the tag keeps the old fixed count, so old rows still seal.
  expect(mockTokensFor("mock_ark_1000")).toBe(244_800);
  expect((await fetchTask("mock_ark_1000")).totalTokens).toBe(244_800);
  // A 1080p 5 s request still costs a 1080p 5 s clip.
  expect(mockTokensFor("mock_ark_1080p-16x9-5-0_1000")).toBe(estimateTokens("1080p", "16:9", 5));
});
