import { test, expect } from "@playwright/test";
import { byteRange } from "../../lib/mediaRange";
import {
  runInTenant,
  currentTenant,
  type TenantWorkspace,
} from "../../lib/tenant";
import { loadIsolated } from "./storageSeam";
test("single byte ranges handle inclusive ends, suffixes and overshoot without integer overflow", () => {
  expect(byteRange(null, 100)).toBe(null);
  expect(byteRange("bytes=20-29", 100)).toEqual({
    start: 20,
    end: 29,
    total: 100,
  });
  expect(byteRange("bytes=90-", 100)).toEqual({
    start: 90,
    end: 99,
    total: 100,
  });
  expect(byteRange("bytes=-10", 100)).toEqual({
    start: 90,
    end: 99,
    total: 100,
  });
  expect(byteRange("bytes=0-999", 100)).toEqual({
    start: 0,
    end: 99,
    total: 100,
  });
  for (const header of [
    "bytes=",
    "bytes=100-",
    "bytes=9-8",
    "bytes=-0",
    "bytes=0-1,4-9",
    "bytes=99999999999999999999-",
    "bytes=0-99999999999999999999",
  ])
    expect(() => byteRange(header, 100)).toThrow();
});
test("private Blob range reads stay scoped and reject a full or mismatched response instead of mislabeling bytes", async () => {
  const calls: { name: string; options: Record<string, unknown> }[] = [];
  let matching = true,
    cancelled = false;
  const blob = {
    get: async (name: string, options: Record<string, unknown>) => {
      calls.push({ name, options });
      return {
        stream: new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        headers: new Headers(
          matching ? { "content-range": "bytes 4-7/12" } : {},
        ),
        blob: { size: 4 },
      };
    },
  };
  const previous = process.env.BLOB_READ_WRITE_TOKEN;
  process.env.BLOB_READ_WRITE_TOKEN = "test-only-no-network";
  try {
    const mod = {
      exports: loadIsolated<typeof import("../../lib/storage")>("lib/storage.ts", {
        "@vercel/blob": blob,
        "./tenant": { currentTenant },
      }),
    };
    await runInTenant(
      { id: "range-studio", legacy: false } as TenantWorkspace,
      async () => {
        const result = await mod.exports.openUploadStream("upload", "mp4", {
          start: 4,
          end: 7,
          total: 12,
        });
        expect(result.size).toBe(4);
        await result.stream.cancel();
        expect(calls[0].name).toBe("ws/range-studio/uploads/upload.mp4");
        expect(calls[0].options).toMatchObject({
          access: "private",
          headers: { Range: "bytes=4-7" },
        });
        matching = false;
        cancelled = false;
        await expect(
          mod.exports.openUploadStream("upload", "mp4", {
            start: 4,
            end: 7,
            total: 12,
          }),
        ).rejects.toThrow(/honor/);
        expect(cancelled).toBe(true);
      },
    );
  } finally {
    if (previous === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = previous;
  }
});
