import { test, expect } from "@playwright/test";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ASTRA_MODEL,
  DEFAULT_ASTRA,
  astraInput,
  astraSettings,
} from "../../lib/astra";
import type { TenantWorkspace } from "../../lib/tenant";
const dir = mkdtempSync(path.join(tmpdir(), "particl-astra-"));
process.env.PLATFORM_DATABASE_URL = `file:${dir}/platform.db`;
process.env.TURSO_DATABASE_URL = `file:${dir}/primary.db`;
process.env.ENGINE_MOCK = "1";
process.env.BLOB_READ_WRITE_TOKEN = "";

test("Astra controls are bounded, output FPS is explicit and a 4K source is never mistaken for 720p", () => {
  expect(astraInput("source", DEFAULT_ASTRA, 2160)).toMatchObject({
    upscale_factor: 1,
    target_fps: 30,
    realism: 0.5,
    creativity: 0.5,
    sharp: 0.5,
    H264_output: true,
  });
  expect(
    astraInput("source", { ...DEFAULT_ASTRA, fps: 60 }, 480),
  ).toMatchObject({ upscale_factor: 4, target_fps: 60 });
  for (const value of [
    undefined,
    {},
    { ...DEFAULT_ASTRA, fps: 120 },
    { ...DEFAULT_ASTRA, sharpness: "1" },
    { ...DEFAULT_ASTRA, realism: Infinity },
    { ...DEFAULT_ASTRA, creativity: -1 },
  ])
    expect(() => astraSettings(value)).toThrow();
  expect(() => astraInput("source", DEFAULT_ASTRA, NaN)).toThrow();
});
test("source inspection measures original track timing and dimensions through bounded storage ranges", async () => {
  const { runInTenant } = await import("../../lib/tenant"),
    { storeUpload } = await import("../../lib/storage"),
    { inspectOriginalVideo } = await import("../../lib/videoMetadata.server");
  await runInTenant(
    {
      id: "astra-probe",
      name: "Test",
      slug: "astra-probe",
      legacy: true,
      dbUrl: `file:${dir}/tenant.db`,
      dbToken: null,
      keys: {},
      usesPlatformKeys: false,
    } as TenantWorkspace,
    async () => {
      const bytes = readFileSync("tests/fixtures/astra-source.mp4"),
        id = "astra-probe-original";
      const stored = await storeUpload(id, "mp4", bytes, "video/mp4");
      const ref = {
        id,
        mime: "video/mp4",
        ext: "mp4",
        storedUrl: stored.url,
        role: "reference_video" as const,
        kind: "video" as const,
        fromGeneration: false,
      };
      expect(await inspectOriginalVideo(ref, bytes.length)).toMatchObject({
        width: 720,
        height: 1280,
        seconds: 1.5,
      });
      await expect(inspectOriginalVideo(ref, bytes.length + 1)).rejects.toThrow(
        /length changed/,
      );
      await expect(
        inspectOriginalVideo(ref, 201 * 1024 * 1024),
      ).rejects.toThrow(/200 MB/);
      await storeUpload("astra-invalid", "mp4", Buffer.alloc(128), "video/mp4");
      await expect(
        inspectOriginalVideo({ ...ref, id: "astra-invalid" }, 128),
      ).rejects.toThrow();
    },
  );
});
test("new Astra quotes expose one 4K budget and double only for the selected 60 fps output", async () => {
  const { getModel } = await import("../../lib/models"),
    { estimateCostUsd } = await import("../../lib/vendorPricing");
  expect(getModel(ASTRA_MODEL).resolutions).toEqual(["4k"]);
  expect(
    estimateCostUsd(ASTRA_MODEL, "4k", "16:9", 10, 0, false, {
      task: "upscale",
      fps60: false,
    })?.net,
  ).toBe(5);
  expect(
    estimateCostUsd(ASTRA_MODEL, "4k", "16:9", 10, 0, false, {
      task: "upscale",
      fps60: true,
    })?.net,
  ).toBe(10);
});
