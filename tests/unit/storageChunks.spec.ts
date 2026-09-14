import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";
import {
  currentTenant,
  runInTenant,
  type TenantWorkspace,
} from "../../lib/tenant";

test("cloud chunk assembly preserves each workspace's bytes and cleans up only its chunks", async () => {
  const objects = new Map<string, Buffer>();
  const reads: string[] = [];
  const blob = {
    async put(name: string, body: Buffer | AsyncIterable<Uint8Array>) {
      const parts: Uint8Array[] = [];
      if (Buffer.isBuffer(body)) parts.push(body);
      else for await (const part of body) parts.push(part);
      objects.set(name, Buffer.concat(parts));
      return { url: name };
    },
    async get(name: string) {
      reads.push(name);
      const bytes = objects.get(name);
      if (!bytes) return null;
      return {
        stream: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(bytes);
            c.close();
          },
        }),
      };
    },
    async del(names: string | string[]) {
      for (const name of Array.isArray(names) ? names : [names])
        objects.delete(name);
    },
  };
  // Exercise the real storage implementation with only the remote SDK replaced.
  // Local disk tests cannot expose a missing Blob workspace prefix.
  const filename = path.resolve("lib/storage.ts");
  const require = createRequire(filename);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const loaded = { exports: {} as typeof import("../../lib/storage") };
  const isolatedRequire = (name: string) =>
    name === "@vercel/blob"
      ? blob
      : name === "./tenant"
        ? { currentTenant }
        : require(name);
  const previous = process.env.BLOB_READ_WRITE_TOKEN;
  process.env.BLOB_READ_WRITE_TOKEN = "local-sdk-fixture-no-network";
  try {
    new Function("require", "module", "exports", compiled)(
      isolatedRequire,
      loaded,
      loaded.exports,
    );
    const storage = loaded.exports;
    const workspaces = [
      { id: "studio-a", legacy: false },
      { id: "studio-b", legacy: false },
      { id: "original", legacy: true },
    ] as TenantWorkspace[];
    for (const ws of workspaces) {
      await runInTenant(ws, async () => {
        await storage.storeChunk("same-session", 0, Buffer.from(ws.id + ":"));
        await storage.storeChunk(
          "same-session",
          1,
          Buffer.from("original bytes"),
        );
      });
    }
    for (const ws of workspaces) {
      await runInTenant(ws, async () => {
        const expected = Buffer.from(ws.id + ":original bytes");
        const result = await storage.streamAssembleUpload(
          "same-session",
          2,
          "upload",
          "bin",
          "application/octet-stream",
        );
        const prefix = ws.legacy ? "" : `ws/${ws.id}/`;
        expect(objects.get(prefix + "uploads/upload.bin")).toEqual(expected);
        expect(result.bytes).toBe(expected.length);
        expect(result.sha256).toBe(
          createHash("sha256").update(expected).digest("hex"),
        );
        expect(result.headChunk).toEqual(Buffer.from(ws.id + ":"));
        expect(reads.slice(-2)).toEqual([
          prefix + "chunks/same-session/0",
          prefix + "chunks/same-session/1",
        ]);
        await storage.deleteChunks("same-session", 2);
        expect(objects.has(prefix + "chunks/same-session/0")).toBe(false);
      });
    }
    expect([...objects.keys()].sort()).toEqual([
      "uploads/upload.bin",
      "ws/studio-a/uploads/upload.bin",
      "ws/studio-b/uploads/upload.bin",
    ]);
  } finally {
    if (previous === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = previous;
  }
});

test("local staging separates the same account and session across tenants while retaining legacy paths", async () => {
  const { mkdtempSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(path.join(tmpdir(), "particl-local-chunks-"));
  const filename = path.resolve("lib/storage.ts"), require = createRequire(filename);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const loaded = { exports: {} as typeof import("../../lib/storage") };
  new Function("require", "module", "exports", "process", compiled)((name: string) => name === "./tenant" ? { currentTenant } : require(name), loaded, loaded.exports, { ...process, cwd: () => dir, env: { ...process.env, BLOB_READ_WRITE_TOKEN: "" } });
  const storage = loaded.exports;
  for (const ws of [{ id: "a", legacy: false }, { id: "b", legacy: false }, { id: "legacy", legacy: true }] as TenantWorkspace[]) {
    await runInTenant(ws, async () => { await storage.storeChunk("owner/session", 0, Buffer.from(ws.id)); });
  }
  expect(existsSync(path.join(dir, ".data/chunks/ws/a/owner/session/0"))).toBe(true);
  expect(existsSync(path.join(dir, ".data/chunks/ws/b/owner/session/0"))).toBe(true);
  expect(existsSync(path.join(dir, ".data/chunks/owner/session/0"))).toBe(true);
  await runInTenant({ id: "a", legacy: false } as TenantWorkspace, async () => {
    expect(String(await storage.assembleChunks("owner/session", 1))).toBe("a");
    await storage.deleteChunks("owner/session", 1, true);
  });
  await runInTenant({ id: "b", legacy: false } as TenantWorkspace, async () => {
    expect(String(await storage.assembleChunks("owner/session", 1))).toBe("b");
    await expect(storage.streamAssembleUpload("owner/session", 1, "limited", "bin", "application/octet-stream", 0)).rejects.toThrow(/reserved byte limit/);
  });
  expect(existsSync(path.join(dir, ".data/chunks/owner/session/0"))).toBe(true);
});
