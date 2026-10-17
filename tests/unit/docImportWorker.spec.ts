import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { docx, textPng, zip } from "../helpers/docImportFixtures";

const dir = mkdtempSync(path.join(tmpdir(), "particl-doc-import-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
delete process.env.DOC_IMPORT_ENABLED;

/**
 * The document import worker (v30 Phase A item 2, part 1) behind
 * DOC_IMPORT_ENABLED: off by default, it registers nothing, queues nothing
 * and reads nothing; on, it reads the workspace's own source, stores the
 * pictures and the one normalized result under ws/<workspace>/imports/, and
 * hands Inngest counts only. Storage is an in-memory fake keyed by the real
 * path function; no network, no model, no spend.
 */

const workspace = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, slug: id, name: id, legacy: false, dbUrl: "file::memory:", dbToken: null, keys: {}, usesPlatformKeys: true, allowanceUsd: null, suspendedAt: null, deletedAt: null, gatewayKeyId: null, ...extra }) as never;

const IMPORT = "imp_0123456789";

async function load() {
  return {
    ...(await import("../../lib/docImport/worker")),
    ...(await import("../../lib/docImport/flag")),
    ...(await import("../../lib/storage")),
    ...(await import("../../lib/tenant")),
  };
}

/** A memory store that builds every key with the real importObjectPath, inside the tenant. */
async function memoryStore(sources: Record<string, Buffer>) {
  const { importObjectPath } = await load();
  const objects = new Map<string, { bytes: Buffer; contentType: string }>();
  const reads: string[] = [];
  return {
    objects,
    reads,
    read: async (importId: string, file: string, maxBytes: number) => {
      const key = importObjectPath(importId, file);
      reads.push(key);
      const bytes = sources[key];
      if (!bytes) throw new Error("blob not found");
      if (bytes.length > maxBytes) throw new Error("The import file is larger than the limit.");
      return bytes;
    },
    store: async (importId: string, file: string, bytes: Buffer, contentType: string) => {
      const key = importObjectPath(importId, file);
      objects.set(key, { bytes, contentType });
      return key;
    },
  };
}

test("the switch is off unless DOC_IMPORT_ENABLED says 1, true or on", async () => {
  const { docImportEnabled } = await load();
  expect(docImportEnabled({})).toBe(false);
  expect(docImportEnabled({ NODE_ENV: "development" })).toBe(false);
  for (const value of ["0", "false", "off", "yes", "", " "]) expect(docImportEnabled({ DOC_IMPORT_ENABLED: value })).toBe(false);
  for (const value of ["1", "true", "on", " ON "]) expect(docImportEnabled({ DOC_IMPORT_ENABLED: value })).toBe(true);
  expect(docImportEnabled()).toBe(false);
});

test("off: the Inngest route serves no import function; on: one function on its event, two at once, one per workspace", async () => {
  const { docImportFunctions, docImportWorker, DOC_IMPORT_REQUESTED } = await load();
  expect(docImportFunctions({})).toEqual([]);
  expect(docImportFunctions({ DOC_IMPORT_ENABLED: "0" })).toEqual([]);
  expect(docImportFunctions({ DOC_IMPORT_ENABLED: "1" })).toEqual([docImportWorker]);
  const opts = docImportWorker.opts as { id: string; triggers?: { event?: string }[]; concurrency?: unknown; retries?: number };
  expect(docImportWorker.id()).toBe("document-import");
  expect(opts.triggers?.map((t) => t.event)).toEqual([DOC_IMPORT_REQUESTED]);
  expect(opts.concurrency).toEqual([{ limit: 2 }, { limit: 1, key: "event.data.workspaceId" }]);
  expect(opts.retries).toBe(1);
  // The existing registration is untouched by this feature.
  const { functions } = await import("../../lib/workers");
  expect(functions.map((fn) => fn.id())).not.toContain("document-import");
});

test("off: a delivered event reads nothing, stores nothing and returns skipped", async () => {
  const { runDocumentImport } = await load();
  let touched = 0;
  const outcome = await runDocumentImport(
    { workspaceId: "ws_a", importId: IMPORT, extension: "docx" },
    {
      workspaceOf: async () => { touched++; return workspace("ws_a"); },
      read: async () => { touched++; return Buffer.alloc(0); },
      store: async () => { touched++; return ""; },
      extract: async () => { touched++; throw new Error("never"); },
    },
  );
  expect(outcome).toEqual({ importId: IMPORT, skipped: "disabled" });
  expect(touched).toBe(0);
});

test("off: nothing is queued, even with Inngest configured", async () => {
  const { enqueueDocumentImport } = await load();
  let sent = 0;
  const result = await enqueueDocumentImport(
    { importId: IMPORT, extension: "docx" },
    { configured: () => true, send: async () => { sent++; } },
  );
  expect(result).toEqual({ queued: false, reason: "disabled" });
  expect(sent).toBe(0);
});

test("on: the workspace's own source is extracted; pictures and the result land under ws/<id>/imports/<import>/, and Inngest gets counts only", async () => {
  const { runDocumentImport } = await load();
  const picture = textPng("HELLO", 2);
  const store = await memoryStore({ [`ws/ws_a/imports/${IMPORT}/source.docx`]: docx(["A private brief line."], { image: picture }) });
  const outcome = await runDocumentImport(
    { workspaceId: "ws_a", importId: IMPORT, extension: "docx" },
    { enabled: () => true, workspaceOf: async (id) => (id === "ws_a" ? workspace("ws_a") : null), read: store.read, store: store.store },
  );
  expect(outcome).toEqual({ importId: IMPORT, ok: true, kind: "docx", characters: "A private brief line.".length, sections: 1, images: 1, warnings: 0 });
  expect(JSON.stringify(outcome)).not.toContain("private brief");
  expect(store.reads).toEqual([`ws/ws_a/imports/${IMPORT}/source.docx`]);
  expect([...store.objects.keys()].sort()).toEqual([`ws/ws_a/imports/${IMPORT}/images/1.png`, `ws/ws_a/imports/${IMPORT}/result.json`]);
  expect(store.objects.get(`ws/ws_a/imports/${IMPORT}/images/1.png`)).toMatchObject({ contentType: "image/png" });
  const saved = JSON.parse(store.objects.get(`ws/ws_a/imports/${IMPORT}/result.json`)!.bytes.toString("utf8"));
  expect(saved.ok).toBe(true);
  expect(saved.document).toMatchObject({
    kind: "docx",
    format: "plain",
    text: "A private brief line.",
    images: [{ name: "image1.png", mime: "image/png", path: `ws/ws_a/imports/${IMPORT}/images/1.png`, bytes: picture.length }],
    warnings: [],
  });
  expect(saved.document.sha256).toMatch(/^[0-9a-f]{64}$/);
});

test("on: a refused file stores its plain refusal as the result and is not retried", async () => {
  const { runDocumentImport } = await load();
  const bomb = zip([{ name: "[Content_Types].xml", data: "<Types/>" }, { name: "word/document.xml", data: Buffer.alloc(8 * 1024 * 1024, 0x20) }]);
  const store = await memoryStore({ [`ws/ws_a/imports/${IMPORT}/source.docx`]: bomb });
  const outcome = await runDocumentImport(
    { workspaceId: "ws_a", importId: IMPORT, extension: "docx" },
    { enabled: () => true, workspaceOf: async () => workspace("ws_a"), read: store.read, store: store.store },
  );
  expect(outcome).toEqual({ importId: IMPORT, failed: "unsafe" });
  const saved = JSON.parse(store.objects.get(`ws/ws_a/imports/${IMPORT}/result.json`)!.bytes.toString("utf8"));
  expect(saved).toEqual({ ok: false, error: { code: "unsafe", message: expect.stringMatching(/Nothing was imported\.$/) } });
  expect(store.objects.size).toBe(1);
});

test("on: the event names its workspace and nothing else; an unknown, deleted, suspended or different workspace is refused before any read", async () => {
  const { runDocumentImport } = await load();
  const store = await memoryStore({});
  const deps = (found: unknown) => ({ enabled: () => true, workspaceOf: async () => found as never, read: store.read, store: store.store });
  const data = { workspaceId: "ws_a", importId: IMPORT, extension: "docx" };
  await expect(runDocumentImport(data, deps(null))).rejects.toThrow(/unavailable/);
  await expect(runDocumentImport(data, deps(workspace("ws_b")))).rejects.toThrow(/unavailable/);
  await expect(runDocumentImport(data, deps(workspace("ws_a", { deletedAt: 1 })))).rejects.toThrow(/unavailable/);
  await expect(runDocumentImport(data, deps(workspace("ws_a", { suspendedAt: 1 })))).rejects.toThrow(/unavailable/);
  for (const bad of [
    { ...data, workspaceId: "" },
    { ...data, workspaceId: "../ws_b" },
    { ...data, importId: "../../ws_b/imports/x" },
    { ...data, importId: "short" },
    { ...data, extension: "docx/../../x" },
    { ...data, languages: "eng+fra" },
  ])
    await expect(runDocumentImport(bad, deps(workspace("ws_a")))).rejects.toThrow(/Invalid document import event/);
  expect(store.reads).toEqual([]);
});

test("import paths are always workspace-prefixed (the original workspace too), fixed in shape, and need a workspace in scope", async () => {
  const { importObjectPath, runInTenant } = await load();
  expect(() => importObjectPath(IMPORT, "result.json")).toThrow(/No workspace is in scope/);
  await runInTenant(workspace("ws_legacy", { legacy: true }), async () => {
    expect(importObjectPath(IMPORT, "result.json")).toBe(`ws/ws_legacy/imports/${IMPORT}/result.json`);
  });
  await runInTenant(workspace("ws_a"), async () => {
    expect(importObjectPath(IMPORT, "source.pdf")).toBe(`ws/ws_a/imports/${IMPORT}/source.pdf`);
    expect(importObjectPath(IMPORT, "images/12.png")).toBe(`ws/ws_a/imports/${IMPORT}/images/12.png`);
    for (const file of ["../result.json", "images/../../x.png", "images/a.png", "source.PDF", "result.json/x", "/etc/passwd", "notes.txt"])
      expect(() => importObjectPath(IMPORT, file)).toThrow(/Invalid import path/);
    for (const id of ["../x", "a/b", "x", ""]) expect(() => importObjectPath(id, "result.json")).toThrow(/Invalid import path/);
  });
});

test("on: the queued event carries identifiers only (no file name, no text, no path), its workspace from the tenant in scope", async () => {
  const { enqueueDocumentImport, runInTenant, DOC_IMPORT_REQUESTED } = await load();
  const sent: unknown[] = [];
  const on = { enabled: () => true, configured: () => true, send: async (event: unknown) => { sent.push(event); } };
  await expect(enqueueDocumentImport({ importId: IMPORT, extension: "docx" }, on)).rejects.toThrow();
  await runInTenant(workspace("ws_a"), async () => {
    expect(await enqueueDocumentImport({ importId: IMPORT, extension: "PNG", languages: ["eng", "hin"] }, on)).toEqual({ queued: true });
    expect(await enqueueDocumentImport({ importId: IMPORT, extension: "docx" }, { ...on, configured: () => false })).toEqual({ queued: false, reason: "no_queue" });
  });
  expect(sent).toEqual([
    { id: `document-import-${IMPORT}`, name: DOC_IMPORT_REQUESTED, data: { workspaceId: "ws_a", importId: IMPORT, extension: "png", languages: "eng+hin" } },
  ]);
});
