import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * An upload dropped into a project whose connection dropped is resumed from Uploads (components/UploadRecovery.tsx).
 * The drop that would have filed it into the project's Library is gone by then, so the saved record carries the
 * project, and a successful resume files it there — once, however many times it is resumed, checked or raced.
 */
async function client(fetch: typeof globalThis.fetch) {
  const items = new Map<string, string>();
  const storage = {
    get length() {
      return items.size;
    },
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
  const locks = new Map<string, Promise<unknown>>();
  const lockedClaim = async <T>(key: string, fn: () => T) => {
    const next = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
    locks.set(key, next);
    try {
      return await next;
    } finally {
      if (locks.get(key) === next) locks.delete(key);
    }
  };
  function module<T>(file: string, dependencies: Record<string, unknown>): T {
    const output = ts.transpileModule(readFileSync(path.resolve(file), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const mod = { exports: {} };
    new Function("module", "exports", "require", "fetch", "localStorage", "window", output)(
      mod,
      mod.exports,
      (name: string) => {
        if (!(name in dependencies)) throw new Error("Unexpected import " + name);
        return dependencies[name];
      },
      fetch,
      storage,
      { dispatchEvent() {} },
    );
    return mod.exports as T;
  }
  const recovery = module<typeof import("../../lib/uploadRecovery")>("lib/uploadRecovery.ts", { "./usePaidAction": { lockedClaim } });
  const upload = module<typeof import("../../lib/uploadClient")>("lib/uploadClient.ts", { "./uploadRecovery": recovery });
  return { ...upload, ...recovery, items };
}

const scope = "particl-active-workspace-owner";
const result = { id: "resumed-upload", kind: "image", url: "/api/uploads/resumed-upload" };
const picture = () => new File([new Uint8Array(1_000)], "look.png", { type: "image/png" });

/** The finish's answer is lost the first time (a dropped connection), then the server says the upload is stored. */
function droppingServer() {
  let finishes = 0;
  const fetch = (async (url: string) => {
    if (url.includes("/session?")) return Response.json({ state: "committed", storedChunks: [0], retryAfterMs: 0, upload: result });
    if (url.endsWith("/finish") && finishes++ === 0) throw new TypeError("Failed to fetch");
    if (url.endsWith("/finish")) return Response.json(result);
    return Response.json({ ok: true });
  }) as typeof globalThis.fetch;
  return fetch;
}

test("a resumed upload is filed into the project it was dropped into, exactly once", async () => {
  const api = await client(droppingServer());
  const file = picture();
  await expect(api.uploadFile(file, "reference", undefined, { scope, projectId: "proj_a" })).rejects.toThrow(TypeError);
  const [entry] = api.listUploadEnvelopes(scope);
  expect(entry).toMatchObject({ state: "pending", projectId: "proj_a" });
  expect(entry.filedAt).toBeUndefined();

  /* Nothing is filed before the upload is stored. */
  const filed: [string, string, string][] = [];
  const file1 = async (projectId: string, uploadId: string, s: string) => void filed.push([projectId, uploadId, s]);
  expect(await api.fileCompletedUpload(entry, file1)).toBeNull();
  expect(filed).toEqual([]);

  expect(await api.resumeUpload(entry)).toEqual(result);
  /* Two tabs (or a double press) racing, then a later status check: one filing. */
  const raced = await Promise.all([api.fileCompletedUpload(entry, file1), api.fileCompletedUpload(entry, file1)]);
  expect(raced.sort()).toEqual([null, "proj_a"]);
  expect(await api.fileCompletedUpload(entry, file1)).toBeNull();
  expect(filed).toEqual([["proj_a", "resumed-upload", scope]]);
  expect(api.listUploadEnvelopes(scope)[0].filedAt).toEqual(expect.any(Number));
});

test("a filing that fails is tried again on the next resume, and its reason is the caller's to show", async () => {
  const api = await client(droppingServer());
  await expect(api.uploadFile(picture(), "reference", undefined, { scope, projectId: "proj_a" })).rejects.toThrow(TypeError);
  const [entry] = api.listUploadEnvelopes(scope);
  await api.resumeUpload(entry);
  let calls = 0;
  const flaky = async () => {
    if (calls++ === 0) throw new Error("Project filing could not be confirmed.");
  };
  await expect(api.fileCompletedUpload(entry, flaky)).rejects.toThrow("Project filing could not be confirmed.");
  expect(api.listUploadEnvelopes(scope)[0].filedAt).toBeUndefined();
  expect(await api.fileCompletedUpload(entry, flaky)).toBe("proj_a");
  expect(await api.fileCompletedUpload(entry, flaky)).toBeNull();
  expect(calls).toBe(2);
});

test("an upload its own drop already filed, or one picked into no project, is never filed by recovery", async () => {
  const fetch = (async (url: string) => (url.endsWith("/finish") ? Response.json(result) : Response.json({ ok: true }))) as typeof globalThis.fetch;
  const api = await client(fetch);
  const stored = await api.uploadFile(picture(), "reference", undefined, { scope, projectId: "proj_a" });
  await api.markUploadFiled(scope, stored.id, "proj_a");
  let calls = 0;
  const count = async () => void calls++;
  expect(await api.fileCompletedUpload(api.listUploadEnvelopes(scope)[0], count)).toBeNull();

  const loose = await client(fetch);
  await loose.uploadFile(new File([new Uint8Array(500)], "notes.txt", { type: "text/plain" }), "chat", undefined, { scope });
  const [entry] = loose.listUploadEnvelopes(scope);
  expect(entry.projectId).toBeUndefined();
  expect(await loose.fileCompletedUpload(entry, count)).toBeNull();
  expect(calls).toBe(0);
});

test("the same file dropped into another project is for that project now; a record can't carry a malformed project", async () => {
  const api = await client(droppingServer());
  const file = picture();
  await expect(api.uploadFile(file, "reference", undefined, { scope, projectId: "proj_a" })).rejects.toThrow(TypeError);
  const first = api.listUploadEnvelopes(scope)[0];
  const again = await api.claimUploadEnvelope(scope, file, "reference", "proj_b");
  expect(again.session).toBe(first.session);
  expect(again.projectId).toBe("proj_b");
  expect((await api.claimUploadEnvelope(scope, file, "reference")).projectId).toBe("proj_b");

  const key = [...api.items.keys()][0];
  api.items.set(key, JSON.stringify({ ...JSON.parse(api.items.get(key)!), projectId: 7 }));
  expect(() => api.listUploadEnvelopes(scope)).toThrow(/cannot be read/);
});

test("Uploads files what Resume, Choose original file and a committed Check status bring back", () => {
  const source = readFileSync(path.resolve("components/UploadRecovery.tsx"), "utf8");
  expect(source).toContain("resumeUpload(entry).then(() => fileRecoveredUpload(entry))");
  expect(source).toContain("resumeUpload(entry, selected).then(() => fileRecoveredUpload(entry))");
  expect(source).toMatch(/if \(result\.state === "committed"\) await fileRecoveredUpload\(entry\);/);
  const library = readFileSync(path.resolve("lib/workspace/library.ts"), "utf8");
  expect(library).toContain("const projectId = await fileCompletedUpload(entry, fileProjectUpload);");
  /* Every drop into a project records the project, and says when it filed it. */
  expect(library.match(/, \{ scope, projectId \}\);/g)).toHaveLength(4);
  expect(library.match(/await markUploadFiled\(scope, stored\.id, projectId\);/g)).toHaveLength(2);
});
