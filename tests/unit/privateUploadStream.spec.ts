import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  currentTenant,
  runInTenant,
  type TenantWorkspace,
} from "../../lib/tenant";
import { byteRange } from "../../lib/mediaRange";
import { servingFor } from "../../lib/serveType";
import { loadIsolated } from "./storageSeam";

function load<T>(file: string, dependencies: Record<string, unknown>): T {
  return loadIsolated<T>(file, dependencies, {
    process: {
      ...process,
      env: {
        ...process.env,
        BLOB_READ_WRITE_TOKEN: "isolated-sdk-fixture-no-network",
      },
    },
  });
}

const original = readFileSync(path.resolve("tests/fixtures/astra-source.mp4"));
const workspace = {
  id: "private-stream-studio",
  legacy: false,
} as TenantWorkspace;

test("uploaded and generated video ranges reject encoded byte offsets and cancel the upstream stream", async () => {
  let cancelled = 0;
  const calls: string[] = [];
  const storage = load<typeof import("../../lib/storage")>("lib/storage.ts", {
    "./tenant": { currentTenant },
    "@vercel/blob": {
      get: async (
        name: string,
        options: { headers: Record<string, string> },
      ) => {
        calls.push(name);
        expect(options.headers).toEqual({
          "Accept-Encoding": "identity",
          Range: "bytes=0-15",
        });
        return {
          headers: new Headers({
            "content-range": `bytes 0-15/${original.length}`,
            "content-encoding": "gzip",
          }),
          blob: { size: 16 },
          stream: new ReadableStream({
            cancel() {
              cancelled++;
            },
          }),
        };
      },
    },
  });
  await runInTenant(workspace, async () => {
    const range = { start: 0, end: 15, total: original.length };
    await expect(
      storage.openUploadStream("fixture", "mp4", range),
    ).rejects.toThrow(/honor/);
    await expect(storage.openVideoStream("generation", range)).rejects.toThrow(
      /honor/,
    );
  });
  expect(cancelled).toBe(2);
  expect(calls).toEqual([
    "ws/private-stream-studio/uploads/fixture.mp4",
    "ws/private-stream-studio/generations/generation.mp4",
  ]);
});

for (const variant of [
  "missing",
  "known",
  "encoded",
  "invalid",
  "unsafe",
  "range",
] as const) {
  test(`private upload route preserves original bytes with ${variant} upstream length`, async () => {
    const ranged = variant === "range",
      expected = ranged ? original.subarray(0, 16) : original;
    const calls: {
      name: string;
      options: { headers: Record<string, string>; abortSignal: AbortSignal };
    }[] = [];
    const headers = new Headers();
    if (variant === "known")
      headers.set("content-length", String(original.length));
    if (variant === "encoded") {
      headers.set("content-length", "10");
      headers.set("content-encoding", "gzip");
    }
    if (variant === "invalid") headers.set("content-length", "4117junk");
    if (variant === "unsafe") headers.set("content-length", "9007199254740992");
    if (ranged) headers.set("content-range", `bytes 0-15/${original.length}`);
    const storage = load<typeof import("../../lib/storage")>("lib/storage.ts", {
      "./tenant": { currentTenant },
      "@vercel/blob": {
        get: async (
          name: string,
          options: (typeof calls)[number]["options"],
        ) => {
          calls.push({ name, options });
          return {
            // Match the installed SDK: missing Content-Length becomes size: 0.
            blob: {
              size: headers.has("content-length")
                ? parseInt(headers.get("content-length")!, 10)
                : 0,
            },
            headers,
            stream: new ReadableStream<Uint8Array>({
              start(c) {
                c.enqueue(expected);
                c.close();
              },
            }),
          };
        },
      },
    });
    const route = load<typeof import("../../app/api/uploads/[id]/route")>(
      "app/api/uploads/[id]/route.ts",
      {
        "@/lib/storage": storage,
        "@/lib/auth": {
          withTenant: (handler: unknown) => handler,
          requireUser: async () => ({ user: { id: "internal-fixture" } }),
        },
        "@/lib/db": {
          ready: async () => {},
          db: () => ({
            execute: async () => ({
              rows: [
                {
                  mime: "video/mp4",
                  ext: "mp4",
                  bytes: original.length,
                  filename: "source.mp4",
                  stored_url: "",
                  kind: "video",
                },
              ],
            }),
          }),
        },
        "@/lib/contentDisposition": await import("../../lib/contentDisposition"),
        "@/lib/serveType": { servingFor },
        "@/lib/mediaRange": { byteRange },
        "@/lib/tenant": {},
        "@/lib/workbench/request-scope": {},
        "@/lib/workbench/records": {},
        "@/lib/mediaBindings": {},
        "@/lib/uploadReservations": {},
      },
    );
    const req = new Request("https://studio.test/api/uploads/fixture", {
      headers: ranged ? { range: "bytes=0-15" } : {},
    });
    await runInTenant(workspace, async () => {
      const response = await route.GET(req, {
        params: Promise.resolve({ id: "fixture" }),
      });
      expect(response.status).toBe(ranged ? 206 : 200);
      expect(response.headers.get("content-length")).toBe(
        ranged ? "16" : variant === "known" ? String(original.length) : null,
      );
      expect(response.headers.get("content-range")).toBe(
        ranged ? `bytes 0-15/${original.length}` : null,
      );
      expect(response.headers.get("content-type")).toBe("video/mp4");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(expected);
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("ws/private-stream-studio/uploads/fixture.mp4");
    expect(calls[0].options.abortSignal).toBe(req.signal);
    expect(calls[0].options.headers["Accept-Encoding"]).toBe("identity");
  });
}
