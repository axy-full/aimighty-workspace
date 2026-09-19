import { test, expect } from "@playwright/test";
import type { LibraryAsset } from "../../lib/genLibrary";
import type { Generation } from "../../lib/jobs";
import { projectTakes, takesSubtitle } from "../../lib/workspace/takes";
import { engineLabel, shotEngines, clampShotSeconds, defaultShotSeconds, resolveShotSettings } from "../../lib/workspace/engines";
import { MODELS, AUDIO_LABELS, getModel } from "../../lib/models";

const SHA = "a".repeat(64);
function gen(id: string, extra: Partial<Generation> = {}): LibraryAsset {
  const value = { id, projectId: "p", projectName: null, arkTaskId: null, kind: "video", reviewState: "", reviewBy: null, pickedBy: null, pickedAt: null,
    approvedBy: null, approvedAt: null, model: "dreamina-seedance-2-5-260628", prompt: "A prompt", title: null, params: { duration: 5 }, status: "succeeded",
    sourceUrl: null, storedUrl: "/api/media/" + id, totalTokens: null, costUsd: null, creditsBilled: 18, refineCostUsd: null, refineModel: null,
    refineInTokens: null, refineOutTokens: null, error: null, createdBy: "u", authorName: null, shotId: null, shotCode: null, shotScene: null,
    shotTitle: null, version: 1, durationMs: null, durationS: null, provider: "byteplus", attempts: 1, task: "generate", sourceGenId: null,
    createdAt: 10, updatedAt: 10, ...extra } as Generation;
  return { origin: "generation", value };
}
function upload(id: string, extra: Record<string, unknown> = {}): LibraryAsset {
  return { origin: "upload", value: { id, filename: id + ".jpg", mime: "image/jpeg", kind: "image", bytes: 1, width: 4032, height: 3024, durationS: null,
    sha256: SHA, url: "/api/uploads/" + id, createdAt: 5, ...extra } as never };
}

test("library assets map to Takes cards with billed credits, statuses and integrity", () => {
  const takes = projectTakes([
    gen("g1", { title: "The approach", version: 2, reviewState: "approved" }),
    gen("g2", { prompt: "The encounter", params: { duration: 6 }, creditsBilled: 21 }),
    gen("g3", { status: "failed", creditsBilled: 0, title: "Mirror fold" }),
    gen("g4", { status: "running", creditsBilled: null }),
    gen("g5", { model: "dreamina-seedance-2-0-260128", durationS: 5.04, reviewState: "changes", creditsBilled: 12, params: { originalSha256: "b".repeat(64) } }),
    gen("g6", { kind: "image", model: "gemini-3.1-flash-image", params: { resolution: "1K" }, creditsBilled: 1, reviewState: "picked" }),
    gen("g7", { status: "failed", creditsBilled: 4 }),
    gen("g8", { providerCreditQuote: { provider: "higgsfield", unit: "higgsfield_credits", credits: 30, basis: "approved_quote" }, creditsBilled: null }),
    gen("g9", { costUsd: 1.16, creditsBilled: null }),
    upload("u1"),
    upload("u2", { filename: "plate.mp4", mime: "video/mp4", kind: "video", width: 1920, height: 1080, durationS: 12, sha256: "" }),
  ]);
  expect(takes[0]).toEqual({ id: "generation:g1", sourceId: "g1", kind: "GEN", name: "The approach", version: "v2", meta: "2.5 · 5s", credits: 18, usd: null,
    status: "approved", sha256: null, createdAt: 10 });
  expect(takes[1]).toMatchObject({ name: "The encounter", meta: "2.5 · 6s", credits: 21, status: "review" });
  expect(takes[2]).toMatchObject({ status: "failed", credits: 0, failedUnbilled: true });
  expect(takes[3]).toMatchObject({ status: "rendering", credits: null });
  expect(takes[4]).toMatchObject({ meta: "2.0 · 5s", status: "changes", credits: 12, sha256: "b".repeat(64) });
  expect(takes[5]).toMatchObject({ meta: "Image 2 · 1K", status: "picked", credits: 1 });
  expect(takes[6]).toMatchObject({ status: "failed", credits: 4 });
  expect(takes[6]).not.toHaveProperty("failedUnbilled");
  expect(takes[7]).toMatchObject({ credits: null, status: "review" });
  expect(takes[8]).toMatchObject({ credits: null, usd: 1.16 });
  expect(takes[9]).toEqual({ id: "upload:u1", sourceId: "u1", kind: "UPLOAD", name: "u1.jpg", version: "v1", meta: "4032×3024 · JPEG", credits: null, usd: null,
    status: "uploaded", sha256: SHA, createdAt: 5 });
  expect(takes[10]).toMatchObject({ meta: "1920×1080 · MP4 · 12s", sha256: null });
  // No vendor name reaches a card.
  expect(JSON.stringify(takes.map((t) => t.meta))).not.toMatch(/seedance|kling|gemini|nano|higgsfield|eleven/i);

  expect(takesSubtitle(takes)).toBe("11 assets · 56 cr settled"); // 18 + 21 + 0 (failed) + 12 + 1 + 4 (billed failure)
  expect(takesSubtitle([])).toBe("0 assets · 0 cr settled");
  expect(takesSubtitle([{ credits: 1_200 }])).toBe("1 asset · 1,200 cr settled");
});

test("engine labels are neutral, short and long, for every catalogue and audio id", () => {
  expect(engineLabel("dreamina-seedance-2-5-260628")).toEqual({ short: "2.5", long: "Motion 2.5" });
  expect(engineLabel("dreamina-seedance-2-0-260128")).toEqual({ short: "2.0", long: "Motion 2.0" });
  expect(engineLabel("dreamina-seedance-2-5-999999")).toEqual({ short: "2.5", long: "Motion 2.5" });
  expect(engineLabel("gemini-3.1-flash-image").long).toBe("Image 2");
  expect(engineLabel("eleven_music").long).toBe("Music");
  expect(engineLabel("eleven_v3").long).toBe("Voice");
  expect(engineLabel(null)).toEqual({ short: "Engine", long: "Video engine" });
  expect(engineLabel("some/unknown-model").long).toBe("Video engine");
  const vendors = /seedance|kling|topaz|luma|bria|gemini|nano|banana|genjutsu|higgsfield|soul|flux|eleven|dreamina|google|openai|gpt|claude|veo|wan/i;
  for (const id of [...MODELS.map((m) => m.id), ...Object.keys(AUDIO_LABELS), "marketing_studio_video"]) {
    const label = engineLabel(id);
    expect(label.short, id).not.toMatch(vendors);
    expect(label.long, id).not.toMatch(vendors);
    expect(label.short.length, id).toBeGreaterThan(0);
  }
});

test("shot engines, defaults and the catalogue duration clamp", () => {
  const ids = shotEngines().map((m) => m.id);
  expect(ids).toContain("dreamina-seedance-2-5-260628");
  expect(ids).not.toContain("topaz/upscale/video/creative");
  expect(ids).not.toContain("fal-ai/bria/expand");
  const sd25 = getModel("dreamina-seedance-2-5-260628"), kling = getModel("fal-ai/kling-video/v3/standard"), still = getModel("gemini-3.1-flash-image");
  expect([clampShotSeconds(sd25, 1), clampShotSeconds(sd25, 4.4), clampShotSeconds(sd25, 12), clampShotSeconds(sd25, 45), clampShotSeconds(sd25, undefined)]).toEqual([4, 4, 12, 30, 5]);
  expect([clampShotSeconds(kling, 2), clampShotSeconds(kling, 16)]).toEqual([3, 15]);
  expect(clampShotSeconds(still, 5)).toBeUndefined();
  expect(defaultShotSeconds(sd25)).toBe(5);
  expect(resolveShotSettings({}, "9:16")).toEqual({ engine: "dreamina-seedance-2-5-260628", durationS: 5, ratio: "9:16", resolution: "720p" });
  expect(resolveShotSettings({ engine: "fal-ai/kling-video/v3/pro", ratio: "4:5", resolution: "720p" }, "4:5")).toEqual({ engine: "fal-ai/kling-video/v3/pro", durationS: 5, ratio: "16:9", resolution: "1080p" });
  expect(resolveShotSettings({ engine: "retired" })).toBeNull();
});
