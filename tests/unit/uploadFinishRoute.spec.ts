import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";
import { loadRoute } from "../helpers/routeModule";

/**
 * POST /api/uploads/finish claims the session at once and assembles in the
 * background: a slow finish answers 202, the session turns `committed` with
 * the receipt the route used to answer, a failure releases the storage
 * reservation exactly once and shows on the session, an identical finish while
 * it runs is 409 and after it commits is the saved receipt. A small finish
 * still answers its receipt directly.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-upload-finish-route-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

function workspace(name: string): TenantWorkspace {
  return {
    id: name, name, slug: name, dbUrl: `file:${path.join(dir, name + ".db")}`, legacy: false, dbToken: null, keys: {},
    usesPlatformKeys: false, allowanceUsd: null, ownerId: "owner", createdAt: 0, gatewayKeyId: null, suspendedAt: null,
    suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null,
    storageQuotaBytes: 1_000_000, deletedAt: null,
  };
}
const hash = "a".repeat(64);

type Assembly = { sha256: string; bytes: number; headChunk: Buffer };
async function harness(name: string) {
  const db = await import("../../lib/db");
  const { runInTenant } = await import("../../lib/tenant");
  const deleted: string[] = [];
  const compiled = ts.transpileModule(readFileSync(path.resolve("lib/uploadReservations.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} as typeof import("../../lib/uploadReservations") };
  const reservationDeps: Record<string, unknown> = {
    "./db": db,
    "./limits": await import("../../lib/limits"),
    "./archive": await import("../../lib/archive"),
    "./storage": {
      deleteChunks: async (key: string) => void deleted.push("chunks:" + key),
      deleteUpload: async (id: string) => void deleted.push("upload:" + id),
    },
    "node:crypto": await import("node:crypto"),
  };
  new Function("require", "module", "exports", compiled)(
    (dep: string) => {
      if (!(dep in reservationDeps)) throw new Error("Unexpected import " + dep);
      return reservationDeps[dep];
    },
    mod,
    mod.exports,
  );
  const api = mod.exports;
  const ws = workspace(name);
  /** The assembly each test controls: a gate to hold it, or a failure to throw. */
  const assembly: { gate?: Promise<void>; fail?: Error; bytes?: number; calls: number } = { calls: 0 };
  const afters: Promise<unknown>[] = [];
  const reserved: string[] = [];
  const next = createRequire(path.resolve("package.json"))("next/server") as typeof import("next/server");
  const route = loadRoute<{ POST: (req: Request) => Promise<Response> }>("app/api/uploads/finish/route.ts", {
    "next/server": { NextResponse: next.NextResponse, after: (task: Promise<unknown>) => void afters.push(task) },
    "@/lib/auth": {
      requireUser: async () => ({ user: { id: "owner" }, token: null }),
      withTenant: (handler: (req: Request) => Promise<Response>) => (req: Request) => runInTenant(ws, () => handler(req)),
    },
    "@/lib/tenant": { requireTenant: () => ws },
    "@/lib/recovery": {
      reserveRecoveryContinuation: async (kind: string, run: () => Promise<unknown>) => {
        reserved.push(kind);
        return run;
      },
    },
    "@/lib/workbench/request-scope": { workbenchScopeProblem: () => null },
    "@/lib/imagemeta": { identifyImage: () => null },
    "@/lib/audioMeta": { identifyAudio: () => null },
    "@/lib/mediaSource.server": { inspectStoredUploadSeconds: async () => null },
    "@/lib/storage": {
      assembleChunks: async () => Buffer.alloc(0),
      uploadPath: (id: string, ext: string) => `/stored/${id}.${ext}`,
      streamAssembleUpload: async (_key: string, _count: number, _id: string, _ext: string, _type: string, bytes: number): Promise<Assembly> => {
        assembly.calls++;
        await assembly.gate;
        if (assembly.fail) throw assembly.fail;
        return { sha256: "b".repeat(64), bytes: assembly.bytes ?? bytes, headChunk: Buffer.alloc(0) };
      },
    },
    "@/lib/uploadIntake": { storeReferenceUpload: async () => { throw new Error("not used"); } },
    "@/lib/uploadReservations": api,
  });
  const inTenant = <T>(work: () => Promise<T>) => runInTenant(ws, work);
  /** A session with `count` stored 4-byte chunks. */
  async function stored(session: string, count: number) {
    await inTenant(async () => {
      for (let index = 0; index < count; index++) {
        const chunk = await api.reserveUploadChunk({ owner: "owner", session, index, bytes: 4, sha256: hash });
        await api.markUploadChunkStored(chunk.key, index, chunk.lease);
      }
    });
  }
  const finish = (session: string, count: number, headers: Record<string, string> = {}) =>
    route.POST(new Request("http://localhost/api/uploads/finish", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ session, count, filename: "long.mov", purpose: "chat" }),
    }));
  return {
    api, assembly, afters, reserved, deleted, finish, stored, inTenant,
    status: (session: string, at?: number) => inTenant(() => api.uploadSessionStatus("owner", session, at)),
    reservedBytes: () => inTenant(() => api.reservedUploadBytes()),
    uploads: () => inTenant(async () => Number((await db.db().execute("SELECT COUNT(*) n FROM uploads")).rows[0].n)),
    settled: () => Promise.all(afters),
  };
}
/** Answer after 20 ms instead of 10 s: the test-only hook, live only under ENGINE_MOCK outside production. */
const quick = { "x-particl-test-finish-answer-ms": "20" };

test("a slow finish answers 202 at once, and the session turns committed with the receipt the route used to answer", async () => {
  const h = await harness("slow");
  const session = "11111111-1111-4111-8111-111111111111";
  await h.stored(session, 3);
  let open!: () => void;
  h.assembly.gate = new Promise((resolve) => (open = resolve));
  const accepted = await h.finish(session, 3, quick);
  expect(accepted.status).toBe(202);
  expect(await accepted.json()).toEqual({ state: "assembling", pollAfterMs: 1000 });
  expect(accepted.headers.get("Retry-After")).toBe("1");
  expect(h.reserved).toEqual(["upload-finish"]);
  expect(h.afters).toHaveLength(1);
  const running = await h.status(session);
  expect(running?.state).toBe("assembling");
  expect(running?.retryAfterMs).toBeGreaterThan(0);
  expect(running?.upload).toBeUndefined();
  expect(await h.reservedBytes()).toBe(12);

  // An identical finish while it runs is refused for the moment, not assembled twice.
  const duplicate = await h.finish(session, 3, quick);
  expect(duplicate.status).toBe(409);
  expect((await duplicate.json()).error).toMatch(/still finishing/);
  expect(h.assembly.calls).toBe(1);

  open();
  await h.settled();
  const committed = await h.status(session);
  expect(committed?.state).toBe("committed");
  expect(committed?.upload).toMatchObject({ filename: "long.mov", bytes: 12, sha256: "b".repeat(64), kind: "file" });
  const receipt = committed!.upload as { id: string; url: string };
  expect(receipt.url).toBe(`/api/uploads/${receipt.id}`);
  expect(await h.reservedBytes()).toBe(0);
  expect(await h.uploads()).toBe(1);

  // After it commits, the same finish answers the saved receipt and stores nothing again.
  const replay = await h.finish(session, 3, quick);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(committed!.upload);
  expect(h.assembly.calls).toBe(1);
  expect(await h.uploads()).toBe(1);
});

test("a small finish still answers its receipt directly, and the test hook is off outside the mock", async () => {
  const h = await harness("fast");
  const session = "22222222-2222-4222-8222-222222222222";
  await h.stored(session, 1);
  const done = await h.finish(session, 1);
  expect(done.status).toBe(200);
  const receipt = await done.json();
  expect(receipt).toMatchObject({ filename: "long.mov", bytes: 4 });
  expect((await h.status(session))?.upload).toEqual(receipt);

  const other = "33333333-3333-4333-8333-333333333333";
  await h.stored(other, 1);
  process.env.ENGINE_MOCK = "0";
  try {
    const started = Date.now();
    // Ignored without the mock: no delay, and the usual answer window.
    const direct = await h.finish(other, 1, { "x-particl-test-finish-delay-ms": "60000", "x-particl-test-finish-answer-ms": "0" });
    expect(direct.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(5_000);
  } finally {
    process.env.ENGINE_MOCK = "1";
  }
});

test("a background failure releases the reservation exactly once and the session shows why", async () => {
  const h = await harness("fails");
  const session = "44444444-4444-4444-8444-444444444444";
  await h.stored(session, 2);
  let open!: () => void;
  h.assembly.gate = new Promise((resolve) => (open = resolve));
  h.assembly.fail = new Error("R2 connection reset (internal detail)");
  expect((await h.finish(session, 2, quick)).status).toBe(202);
  open();
  await h.settled();
  const failed = await h.status(session);
  // The planned final object may have been accepted remotely: its lease holds the bytes until cleanup.
  expect(failed?.state).toBe("aborting");
  expect(failed?.failure).toEqual({
    error: "The upload could not finish. Its reserved storage will be released after cleanup. Try again shortly.",
    status: 503,
  });
  expect(JSON.stringify(failed)).not.toContain("internal detail");
  expect(await h.reservedBytes()).toBe(8);
  const later = Date.now() + h.api.UPLOAD_LEASE_MS + 1_000;
  expect(await h.inTenant(() => h.api.cleanupExpiredUploads(5, later))).toEqual({ attempted: 1, cleaned: 1, failed: 0 });
  expect(await h.reservedBytes()).toBe(0);
  expect(await h.inTenant(() => h.api.cleanupExpiredUploads(5, later + 1))).toEqual({ attempted: 0, cleaned: 0, failed: 0 });
  expect(h.deleted.filter((item) => item.startsWith("upload:"))).toHaveLength(1);
  expect((await h.status(session, later + 2))?.state).toBe("aborted");
  expect((await h.status(session, later + 2))?.failure?.status).toBe(503);
  const again = await h.finish(session, 2, quick);
  expect(again.status).toBe(410);
  expect(await h.uploads()).toBe(0);
});

test("a refusal found while assembling is shown on the session with its own words", async () => {
  const h = await harness("refused");
  const session = "55555555-5555-4555-8555-555555555555";
  await h.stored(session, 2);
  let open!: () => void;
  h.assembly.gate = new Promise((resolve) => (open = resolve));
  h.assembly.bytes = 7; // The stored object is not the 8 bytes its chunks reserved.
  expect((await h.finish(session, 2, quick)).status).toBe(202);
  open();
  await h.settled();
  expect((await h.status(session))?.failure).toEqual({ error: "The upload bytes do not match its chunks.", status: 400 });
  expect(await h.uploads()).toBe(0);
});
