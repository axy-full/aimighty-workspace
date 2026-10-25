import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantStore, TenantUser, TenantWorkspace } from "../../lib/tenant";
import type { ReadingWorker } from "../../lib/reading/worker";
import type { ReadingStore } from "../../lib/reading/store";

/**
 * `read_document` (lib/reading/read.ts; docs/reading-lane-plan.md, Step 2): off unless DOCLING_ENABLED is "1" for the workspace;
 * page by page through a mock reader only; every shape Zod-checked; text over 4,000 characters split, never cut; a page-less file
 * is page 1, the whole page; a bad block, a timeout or no reader fails with a code and never the text; the store is a stub until
 * the tables' migration; a second workspace, or a member who may not open the upload, reads nothing. Local temporary databases;
 * no network: a stand-in for fetch fails the test if anything reaches for it.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-read-document-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

const SENTINEL = "SENTINEL-brief-text-7f3a";
const workspace = (id: string): TenantWorkspace => ({
  id, slug: id, name: id, dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null, legacy: false, usesPlatformKeys: true, keys: {}, ownerId: "tester", createdAt: 0,
  allowanceUsd: null, gatewayKeyId: null, suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null,
});
const person = (id: string, disabled = false): TenantUser => ({ id, email: `${id}@example.invalid`, name: id, role: "member", owner: false, disabled, createdAt: 0, lastSeen: null });
const ALICE = { user: person("u_alice") };

let realFetch: typeof fetch;
test.beforeEach(() => { realFetch = globalThis.fetch; globalThis.fetch = (async () => { throw new Error("No network in this test."); }) as typeof fetch; });
test.afterEach(() => { globalThis.fetch = realFetch; delete process.env.DOCLING_ENABLED; });

/* The house (where an engine's switch alone turns it on) holds Alice's uploads: a PDF, a text file, a huge one. */
async function house() {
  const { HOUSE_WORKSPACE_ID } = await import("../../lib/houseWorkspace");
  return workspace(HOUSE_WORKSPACE_ID);
}
let seeded = false;
async function seed() {
  if (seeded) return;
  seeded = true;
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  await runInTenant(await house(), async () => {
    await ready();
    const add = (id: string, mime: string, bytes: number, uploader: string | null) => db().execute({
      sql: "INSERT INTO uploads(id, filename, mime, ext, bytes, sha256, stored_url, created_at, uploader_id) VALUES (?,?,?,?,?,?,?,?,?)",
      args: [id, `${id}.bin`, mime, "bin", bytes, "a".repeat(64), `stored/${id}`, 0, uploader],
    });
    await add("up_pdf", "application/pdf", 1000, "u_alice");
    await add("up_txt", "text/plain", 10, "u_alice");
    await add("up_huge", "application/pdf", 2 * 1024 ** 3 + 1, "u_alice");
  });
}

async function read(input: unknown, who: Partial<TenantStore> = ALICE, deps: Parameters<typeof import("../../lib/reading/read").readDocument>[1] = {}, ws?: TenantWorkspace) {
  await seed();
  const { runInTenant } = await import("../../lib/tenant");
  const { readDocument } = await import("../../lib/reading/read");
  return runInTenant(ws ?? (await house()), () => readDocument(input, deps), who);
}
const refusal = async (p: Promise<unknown>) => p.then(() => null, (e: { status?: number; message?: string }) => ({ status: e.status, message: e.message }));

/* A store that records what it was asked to keep (the real one waits for the migration). */
function recorder(): ReadingStore & { log: string[] } {
  const log: string[] = [];
  return { keeps: false, log, async begin(m) { log.push(`begin:${m.pages}:${m.geometry}`); return "r1"; }, async addPage(_id, b) { log.push(`page:${b.length}`); }, async finish(_id, o) { log.push(o.ok ? "done" : `failed:${o.errorCode}`); } };
}
const worker = (pages: Record<number, unknown>, opened: unknown = { pages: Object.keys(pages).length, geometry: "page", readerVersion: "t-1" }): ReadingWorker & { asked: number[] } => {
  const asked: number[] = [];
  return { asked, async open() { return opened as never; }, async page(n) { asked.push(n); return pages[n] as never; } };
};
const block = (over: Record<string, unknown> = {}) => ({ kind: "paragraph", x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.5, text: "Text.", confidence: null, ...over });

test("off unless DOCLING_ENABLED is exactly \"1\": nothing is read and the reader is never asked", async () => {
  const w = worker({ 1: { page: 1, blocks: [block()] } });
  for (const value of [undefined, "0", "true", " 1"]) {
    if (value === undefined) delete process.env.DOCLING_ENABLED; else process.env.DOCLING_ENABLED = value;
    expect(await read({ uploadId: "up_pdf" }, ALICE, { worker: w }), String(value)).toEqual({ state: "off", message: "Reading is off here." });
  }
  expect(w.asked).toEqual([]);
});

test("on, a PDF is read page by page through the mock reader; blocks carry page, box and reading order; nothing is stored yet", async () => {
  process.env.DOCLING_ENABLED = "1";
  const out = await read({ uploadId: "up_pdf", projectId: "prj_1" });
  if (out.state !== "done") throw new Error(JSON.stringify(out));
  expect(out).toMatchObject({ pages: 2, geometry: "page", readerVersion: "mock-1", stored: false });
  expect(out.blocks.map((b) => [b.page, b.seq, b.part, b.kind])).toEqual([[1, 0, 0, "heading"], [1, 1, 0, "paragraph"], [2, 2, 0, "heading"], [2, 3, 0, "paragraph"]]);
  for (const b of out.blocks) expect(b.x0 <= b.x1 && b.y0 <= b.y1 && b.x0 >= 0 && b.y1 <= 1).toBe(true);
});

test("a file without pages is page 1, the whole page, geometry none", async () => {
  process.env.DOCLING_ENABLED = "1";
  const out = await read({ uploadId: "up_txt" });
  expect(out).toMatchObject({ state: "done", pages: 1, geometry: "none", blocks: [{ page: 1, seq: 0, part: 0, x0: 0, y0: 0, x1: 1, y1: 1 }] });
  /* A page-less reader's own box is ignored: the whole page stands. */
  const odd = await read({ uploadId: "up_txt" }, ALICE, { worker: worker({ 1: { page: 1, blocks: [block({ x0: 0.2, x1: 0.3 })] } }, { pages: 1, geometry: "none", readerVersion: "t" }) });
  expect(odd).toMatchObject({ state: "done", blocks: [{ x0: 0, y0: 0, x1: 1, y1: 1 }] });
});

test("text over 4,000 characters is split into parts, never cut: each part its own seq, and the parts join back exactly", async () => {
  process.env.DOCLING_ENABLED = "1";
  const long = ("word ".repeat(1900) + "x".repeat(4100)).trim();
  const store = recorder();
  const out = await read({ uploadId: "up_pdf" }, ALICE, { store, worker: worker({ 1: { page: 1, blocks: [block({ text: long }), block({ kind: "caption", text: "After." })] } }) });
  if (out.state !== "done") throw new Error(JSON.stringify(out));
  const parts = out.blocks.filter((b) => b.kind === "paragraph");
  expect(parts.length).toBeGreaterThan(2);
  expect(parts.every((b) => b.text.length <= 4000)).toBe(true);
  expect(parts.map((b) => b.text).join("")).toBe(long);
  expect(parts.map((b) => b.part)).toEqual(parts.map((_, i) => i));
  expect(out.blocks.map((b) => b.seq)).toEqual(out.blocks.map((_, i) => i));
  expect(out.blocks.at(-1)).toMatchObject({ kind: "caption", part: 0 });
  expect(store.log).toEqual(["begin:1:page", `page:${out.blocks.length}`, "done"]);
});

test("a bad block, a page out of turn, a bad open, a timeout or no reader fails with a code, keeps nothing of it, and never echoes the text", async () => {
  process.env.DOCLING_ENABLED = "1";
  const bad = [
    { 1: { page: 1, blocks: [block({ x0: 0.9, x1: 0.1, text: SENTINEL })] } },
    { 1: { page: 1, blocks: [block({ y1: 1.5, text: SENTINEL })] } },
    { 1: { page: 1, blocks: [block({ kind: "secret", text: SENTINEL })] } },
    { 1: { page: 1, blocks: [{ ...block({ text: SENTINEL }), extra: SENTINEL }] } },
    { 1: { page: 2, blocks: [block({ text: SENTINEL })] } },
    { 1: { page: 1, blocks: [block({ confidence: 2, text: SENTINEL })] } },
  ];
  for (const pages of bad) {
    const store = recorder();
    const out = await read({ uploadId: "up_pdf" }, ALICE, { store, worker: worker(pages) });
    expect(out, JSON.stringify(pages)).toEqual({ state: "failed", errorCode: "bad_block", message: "This file couldn't be read." });
    expect(store.log).toEqual(["begin:1:page", "failed:bad_block"]);
    expect(JSON.stringify(out)).not.toContain(SENTINEL);
  }
  expect(await read({ uploadId: "up_pdf" }, ALICE, { worker: worker({}, { pages: 0, geometry: "page", readerVersion: "t" }) })).toMatchObject({ state: "failed", errorCode: "bad_block" });
  expect(await read({ uploadId: "up_pdf" }, ALICE, { worker: worker({}, { pages: 3000, geometry: "page", readerVersion: "t" }) })).toMatchObject({ state: "failed", errorCode: "too_large" });
  const hangs: ReadingWorker = { async open() { return { pages: 1, geometry: "page", readerVersion: "t" }; }, page: () => new Promise(() => {}) };
  expect(await read({ uploadId: "up_pdf" }, ALICE, { worker: hangs, pageMs: 50 })).toMatchObject({ state: "failed", errorCode: "timeout" });
  const throws: ReadingWorker = { async open() { throw new Error(SENTINEL); }, async page() { throw new Error(SENTINEL); } };
  const thrown = await read({ uploadId: "up_pdf" }, ALICE, { worker: throws });
  expect(thrown).toMatchObject({ state: "failed", errorCode: "unreadable" });
  expect(JSON.stringify(thrown)).not.toContain(SENTINEL);
  expect(await read({ uploadId: "up_pdf" }, ALICE, { worker: null })).toEqual({ state: "failed", errorCode: "worker_unavailable", message: "Reading isn't available now. Nothing billed." });
  /* Off ENGINE_MOCK there is no reader yet. */
  delete process.env.ENGINE_MOCK;
  try { expect(await read({ uploadId: "up_pdf" })).toMatchObject({ state: "failed", errorCode: "worker_unavailable" }); } finally { process.env.ENGINE_MOCK = "1"; }
  /* Over 2 GiB is never read. */
  expect(await read({ uploadId: "up_huge" }, ALICE, { worker: worker({}) })).toMatchObject({ state: "failed", errorCode: "too_large" });
});

test("tenancy: another workspace, another member's private upload and a missing id are answered alike; nothing is read", async () => {
  process.env.DOCLING_ENABLED = "1";
  const { platformDb, platformReady } = await import("../../lib/platform");
  await platformReady();
  await platformDb().execute({ sql: "INSERT INTO platform_layer(key, value, updated_at) VALUES ('site', ?, 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value", args: [JSON.stringify({ enginesOnWorkspaces: ["ws_other"] })] });
  const w = worker({ 1: { page: 1, blocks: [block()] } });
  const { runInTenant } = await import("../../lib/tenant");
  const { ready } = await import("../../lib/db");
  await runInTenant(workspace("ws_other"), () => ready());
  const missing = await refusal(read({ uploadId: "up_nope" }, ALICE, { worker: w }));
  expect(missing).toEqual({ status: 404, message: "No such upload." });
  expect(await refusal(read({ uploadId: "up_pdf" }, ALICE, { worker: w }, workspace("ws_other")))).toEqual(missing);
  expect(await refusal(read({ uploadId: "up_pdf" }, { user: person("u_bob") }, { worker: w }))).toEqual(missing);
  expect(w.asked).toEqual([]);
});

test("callers: a person, or a token acting as one; an Atomik run only as the person it acts for; no one, a disabled person or bad input is refused", async () => {
  process.env.DOCLING_ENABLED = "1";
  const ok = { state: "done", pages: 2 };
  expect(await read({ uploadId: "up_pdf" }, { user: person("u_alice"), token: { id: "t", name: "t", scope: "read", capUsd: null } })).toMatchObject(ok);
  expect(await read({ uploadId: "up_pdf" }, { user: person("agent:run_1") }, { forPerson: "u_alice" })).toMatchObject(ok);
  for (const [who, deps] of [[{ user: person("agent:run_1") }, {}], [{ user: person("agent:run_1") }, { forPerson: "agent:run_2" }], [{ user: null }, {}], [{}, {}], [{ user: person("u_alice", true) }, {}]] as const) {
    expect(await refusal(read({ uploadId: "up_pdf" }, who, deps)), JSON.stringify(who)).toEqual({ status: 403, message: "Only a signed-in person can read this." });
  }
  /* An Atomik run for a person who may not open the upload reads nothing. */
  expect(await refusal(read({ uploadId: "up_pdf" }, { user: person("agent:run_1") }, { forPerson: "u_bob" }))).toEqual({ status: 404, message: "No such upload." });
  for (const input of [{}, { uploadId: "" }, { uploadId: "a b" }, { uploadId: "up_pdf", extra: 1 }, { uploadId: "up_pdf", projectId: "../x" }, null, "up_pdf"]) {
    expect(await refusal(read(input)), JSON.stringify(input)).toEqual({ status: 400, message: "Name the upload by its id." });
  }
});

test("the split itself: parts end at whitespace inside the limit, never between a surrogate pair, and join back", async () => {
  const { splitText } = await import("../../lib/reading/split");
  expect(splitText("")).toEqual([""]);
  expect(splitText("ab cd ef", 4)).toEqual(["ab ", "cd ", "ef"]);
  expect(splitText("abcdefgh", 3)).toEqual(["abc", "def", "gh"]);
  const emoji = "a😀😀😀";
  for (const part of splitText(emoji, 2)) expect(/^[\uDC00-\uDFFF]/.test(part) || /[\uD800-\uDBFF]$/.test(part)).toBe(false);
  expect(splitText(emoji, 2).join("")).toBe(emoji);
  expect(() => splitText("x", 1)).toThrow(RangeError);
});
