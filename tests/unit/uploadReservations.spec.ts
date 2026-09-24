import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace } from "../../lib/tenant";

const dir = mkdtempSync(path.join(tmpdir(), "particl-upload-reservations-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
function workspace(name: string, quota = 10): TenantWorkspace {
  return {
    id: name,
    name,
    slug: name,
    dbUrl: `file:${path.join(dir, name + ".db")}`,
    legacy: false,
    dbToken: null,
    keys: {},
    usesPlatformKeys: false,
    allowanceUsd: null,
    ownerId: "owner",
    createdAt: 0,
    gatewayKeyId: null,
    suspendedAt: null,
    suspendedReason: null,
    flaggedAt: null,
    flagNote: null,
    concurrency: null,
    rendersPerHour: null,
    storageQuotaBytes: quota,
    deletedAt: null,
  };
}
const session = "12345678-1234-1234-1234-123456789abc";
const hash = "a".repeat(64);
async function load() {
  const db = await import("../../lib/db");
  const limits = await import("../../lib/limits");
  let failDeletion = false;
  const deleted: string[] = [];
  const filename = path.resolve("lib/uploadReservations.ts");
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} as typeof import("../../lib/uploadReservations") };
  const dependencies = {
    "./db": db,
    "./limits": limits,
    "./archive": await import("../../lib/archive"),
    "./storage": {
      deleteChunks: async (key: string) => {
        if (failDeletion) throw new Error("fixture deletion unavailable");
        deleted.push(key);
      },
      deleteUpload: async (id: string) => {
        if (failDeletion) throw new Error("fixture deletion unavailable");
        deleted.push(id);
      },
    },
    "node:crypto": await import("node:crypto"),
  };
  new Function("require", "module", "exports", compiled)(
    (name: keyof typeof dependencies) => {
      if (!(name in dependencies)) throw new Error("Unexpected import " + name);
      return dependencies[name];
    },
    mod,
    mod.exports,
  );
  return {
    ...mod.exports,
    deleted,
    failDeletion: (value: boolean) => {
      failDeletion = value;
    },
  };
}

test("concurrent upload sessions atomically reserve quota; duplicate immutable chunks do not charge twice", async () => {
  const api = await load(),
    { runInTenant } = await import("../../lib/tenant");
  await runInTenant(workspace("quota"), async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, index) =>
        api.reserveUploadChunk({
          owner: "owner",
          session,
          index,
          bytes: 4,
          sha256: hash,
        }),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(2);
    expect(await api.reservedUploadBytes()).toBe(8);
    const first = results[0];
    expect(first.status).toBe("fulfilled");
    if (first.status !== "fulfilled") return;
    await expect(
      api.reserveUploadChunk({
        owner: "owner",
        session,
        index: 0,
        bytes: 4,
        sha256: hash,
      }),
    ).rejects.toThrow(/still being stored/);
    await api.markUploadChunkStored(first.value.key, 0, first.value.lease);
    expect(
      (
        await api.reserveUploadChunk({
          owner: "owner",
          session,
          index: 0,
          bytes: 4,
          sha256: hash,
        })
      ).stored,
    ).toBe(true);
    expect(await api.reservedUploadBytes()).toBe(8);
    await expect(
      api.reserveUploadChunk({
        owner: "owner",
        session,
        index: 0,
        bytes: 4,
        sha256: "b".repeat(64),
      }),
    ).rejects.toThrow(/different bytes/);
  });
});

test("abort waits for uncertain chunk writes and retains bytes until storage deletion succeeds", async () => {
  const api = await load(),
    { runInTenant } = await import("../../lib/tenant");
  const at = Date.now();
  await runInTenant(workspace("abort"), async () => {
    await api.reserveUploadChunk(
      { owner: "owner", session, index: 0, bytes: 4, sha256: hash },
      at,
    );
    await api.abortUploadSession("owner", session);
    expect(await api.cleanupExpiredUploads(5, at + 1)).toEqual({
      attempted: 0,
      cleaned: 0,
      failed: 0,
    });
    await expect(
      api.reserveUploadChunk({
        owner: "owner",
        session,
        index: 1,
        bytes: 1,
        sha256: hash,
      }),
    ).rejects.toThrow(/closed/);
    api.failDeletion(true);
    expect(
      await api.cleanupExpiredUploads(5, at + api.CHUNK_LEASE_MS + 100),
    ).toEqual({ attempted: 1, cleaned: 0, failed: 1 });
    expect(await api.reservedUploadBytes()).toBe(4);
    api.failDeletion(false);
    expect(
      await api.cleanupExpiredUploads(5, at + api.CHUNK_LEASE_MS + 101),
    ).toEqual({ attempted: 1, cleaned: 1, failed: 0 });
    expect(await api.reservedUploadBytes()).toBe(0);
    expect(api.deleted).toEqual(["owner/" + session]);
  });
  await runInTenant(workspace("unrelated"), async () => {
    expect(await api.reservedUploadBytes()).toBe(0);
    expect((await api.cleanupExpiredUploads()).attempted).toBe(0);
  });
});

test("finish validates contiguous chunks and bytes before assembly, reserves derivatives and commits once", async () => {
  const api = await load(),
    { runInTenant } = await import("../../lib/tenant"),
    { db } = await import("../../lib/db");
  await runInTenant(workspace("finish"), async () => {
    const chunk = await api.reserveUploadChunk({
      owner: "owner",
      session,
      index: 0,
      bytes: 4,
      sha256: hash,
    });
    await expect(
      api.beginUploadFinish("owner", session, {
        count: 1,
        filename: "image.png",
        purpose: "reference",
      }),
    ).rejects.toThrow(/missing/);
    await api.markUploadChunkStored(chunk.key, 0, chunk.lease);
    const input = {
      count: 1,
      filename: "image.png",
      purpose: "reference" as const,
    };
    const claim = await api.beginUploadFinish("owner", session, input);
    await expect(
      api.beginUploadFinish("owner", session, input),
    ).rejects.toThrow(/still finishing/);
    await expect(
      api.planUploadObjects(claim, [{ id: claim.uploadId, ext: "png" }], 11),
    ).rejects.toThrow(/Storage is full/);
    await api.planUploadObjects(
      claim,
      [
        { id: claim.uploadId, ext: "png" },
        { id: claim.uploadId + "-api", ext: "jpg" },
      ],
      6,
    );
    expect(await api.reservedUploadBytes()).toBe(6);
    const response = {
      id: claim.uploadId,
      url: "/api/uploads/" + claim.uploadId,
    };
    await api.prepareUpload(claim, {
      count: 1,
      response,
      record: {
        id: claim.uploadId,
        filename: "image.png",
        mime: "image/png",
        ext: "png",
        bytes: 4,
        sha256: hash,
        width: 100,
        height: 100,
        kind: "image",
        storedUrl: response.url,
        durationS: null,
        derivativeBytes: 2,
      },
    });
    api.failDeletion(true);
    await expect(api.completeUpload(claim)).rejects.toThrow(/unavailable/);
    expect(
      (await db().execute("SELECT COUNT(*) n FROM uploads")).rows[0].n,
    ).toBe(0);
    await api.abandonUpload(claim);
    const recovered = await api.beginUploadFinish("owner", session, input);
    expect(recovered.uploadId).toBe(claim.uploadId);
    expect(recovered.prepared).toBeTruthy();
    api.failDeletion(false);
    expect(await api.completeUpload(recovered)).toEqual(response);
    expect(await api.reservedUploadBytes()).toBe(0);
    const replay = await api.beginUploadFinish("owner", session, input);
    expect(await api.completeUpload(replay)).toEqual(response);
    expect(
      (await db().execute("SELECT COUNT(*) n FROM uploads")).rows[0].n,
    ).toBe(1);
    await expect(
      api.beginUploadFinish("owner", session, {
        ...input,
        filename: "different.png",
      }),
    ).rejects.toThrow(/changed/);
    await expect(api.beginDirectUpload("owner", 5)).rejects.toThrow(
      /Storage is full/,
    );
  });
});

test("database failure after final object preparation recovers without rereading deleted chunks", async () => {
  const api = await load(),
    { runInTenant } = await import("../../lib/tenant"),
    { db } = await import("../../lib/db");
  await runInTenant(workspace("commit"), async () => {
    const c = await api.reserveUploadChunk({
      owner: "owner",
      session,
      index: 0,
      bytes: 4,
      sha256: hash,
    });
    await api.markUploadChunkStored(c.key, 0, c.lease);
    const input = { count: 1, filename: "chat.bin", purpose: "chat" as const },
      claim = await api.beginUploadFinish("owner", session, input);
    await api.planUploadObjects(claim, [{ id: claim.uploadId, ext: "bin" }], 4);
    await api.prepareUpload(claim, {
      count: 1,
      response: { id: claim.uploadId },
      record: {
        id: claim.uploadId,
        filename: "chat.bin",
        mime: "application/octet-stream",
        ext: "bin",
        bytes: 4,
        sha256: hash,
        width: null,
        height: null,
        kind: "file",
        storedUrl: "/api/uploads/" + claim.uploadId,
        durationS: null,
      },
    });
    await db().execute(
      "CREATE TRIGGER fail_upload BEFORE INSERT ON uploads BEGIN SELECT RAISE(ABORT,'fixture DB failure'); END",
    );
    await expect(api.completeUpload(claim)).rejects.toThrow(
      /fixture DB failure/,
    );
    expect(api.deleted).toEqual([c.key]);
    expect(await api.reservedUploadBytes()).toBe(4);
    await api.abandonUpload(claim);
    await db().execute("DROP TRIGGER fail_upload");
    expect(
      await api.completeUpload(
        await api.beginUploadFinish("owner", session, input),
      ),
    ).toEqual({ id: claim.uploadId });
    expect(await api.reservedUploadBytes()).toBe(0);
  });
});

test("failed final writes keep planned objects and quota until their acceptance lease expires", async () => {
  const api = await load(),
    { runInTenant } = await import("../../lib/tenant");
  const at = Date.now();
  await runInTenant(workspace("partial"), async () => {
    const claim = await api.beginDirectUpload("owner", 4, at);
    await api.planUploadObjects(
      claim,
      [
        { id: claim.uploadId, ext: "png" },
        { id: claim.uploadId + "-api", ext: "jpg" },
      ],
      6,
    );
    await api.abandonUpload(claim);
    expect((await api.cleanupExpiredUploads(5, at + 100)).attempted).toBe(0);
    expect(await api.reservedUploadBytes()).toBe(6);
    expect(
      (await api.cleanupExpiredUploads(5, at + api.UPLOAD_LEASE_MS + 1))
        .cleaned,
    ).toBe(1);
    expect(api.deleted).toEqual([claim.uploadId, claim.uploadId + "-api"]);
    expect(await api.reservedUploadBytes()).toBe(0);
    await expect(api.beginDirectUpload("owner", -1)).rejects.toThrow(/between/);
  });
});

test("upload recovery status is owner-scoped, exposes immutable finish facts, and never revives removed media", async () => {
  const api = await load(),
    { runInTenant } = await import("../../lib/tenant"),
    { db } = await import("../../lib/db");
  await runInTenant(workspace("recovery"), async () => {
    expect(await api.uploadSessionStatus("owner", session)).toBeNull();
    const chunk = await api.reserveUploadChunk({
      owner: "owner",
      session,
      index: 0,
      bytes: 4,
      sha256: hash,
    });
    expect(
      (await api.uploadSessionStatus("owner", session))?.retryAfterMs,
    ).toBeGreaterThan(0);
    expect(await api.uploadSessionStatus("another-owner", session)).toBeNull();
    await api.markUploadChunkStored(chunk.key, 0, chunk.lease);
    const open = await api.uploadSessionStatus("owner", session);
    expect(open?.state).toBe("open");
    expect(open?.storedChunks).toEqual([0]);
    const finish = {
        count: 1,
        filename: "saved.bin",
        purpose: "chat" as const,
      },
      claim = await api.beginUploadFinish("owner", session, finish);
    expect((await api.uploadSessionStatus("owner", session))?.state).toBe(
      "assembling",
    );
    await api.prepareUpload(claim, {
      count: 1,
      response: { id: claim.uploadId },
      record: {
        id: claim.uploadId,
        filename: "saved.bin",
        mime: "application/octet-stream",
        ext: "bin",
        bytes: 4,
        sha256: hash,
        width: null,
        height: null,
        storedUrl: "/api/uploads/" + claim.uploadId,
        kind: "file",
        durationS: null,
      },
    });
    await api.abandonUpload(claim);
    const prepared = await api.uploadSessionStatus("owner", session);
    expect(prepared?.state).toBe("prepared");
    expect(prepared?.finish).toEqual(finish);
    expect(JSON.stringify(prepared)).not.toContain(claim.lease);
    await api.completeUpload(
      await api.beginUploadFinish("owner", session, finish),
    );
    expect((await api.uploadSessionStatus("owner", session))?.upload).toEqual({
      id: claim.uploadId,
    });
    await db().execute({
      sql: "DELETE FROM uploads WHERE id=?",
      args: [claim.uploadId],
    });
    expect((await api.uploadSessionStatus("owner", session))?.state).toBe(
      "removed",
    );
    await expect(
      api.beginUploadFinish("owner", session, finish),
    ).rejects.toThrow(/removed/);
  });
});

test("the documented two-GiB chat limit accepts the browser's 614th bounded chunk", async () => {
  const api = await load(),
    { runInTenant } = await import("../../lib/tenant");
  await runInTenant(workspace("last-chunk"), async () => {
    expect(api.MAX_UPLOAD_CHUNKS).toBe(614);
    const last = await api.reserveUploadChunk({
      owner: "owner",
      session,
      index: 613,
      bytes: 1,
      sha256: hash,
    });
    await api.markUploadChunkStored(last.key, 613, last.lease);
    await expect(
      api.reserveUploadChunk({
        owner: "owner",
        session,
        index: 614,
        bytes: 1,
        sha256: hash,
      }),
    ).rejects.toThrow(/Invalid upload chunk/);
    await expect(
      api.beginUploadFinish("owner", session, {
        count: 614,
        filename: "large.bin",
        purpose: "chat",
      }),
    ).rejects.toThrow(/missing/);
  });
});

test("failed upload cleanup rotates bounded attempts and preserves each reservation", async () => {
  const api = await load(),
    { runInTenant } = await import("../../lib/tenant"),
    { db } = await import("../../lib/db");
  await runInTenant(workspace("fair-cleanup"), async () => {
    await api.uploadReservationsReady();
    for (const id of ["a-fails", "b-next", "c-last"])
      await db().execute({
        sql: "INSERT INTO upload_sessions(id,owner_id,state,reserved_bytes,created_at,expires_at,upload_id,objects) VALUES(?,'owner','aborting',1,0,1,?,?)",
        args: [
          id,
          id,
          JSON.stringify([{ id, ext: "png", url: "/api/uploads/" + id }]),
        ],
      });
    api.failDeletion(true);
    expect(await api.cleanupExpiredUploads(1, 10)).toEqual({
      attempted: 1,
      cleaned: 0,
      failed: 1,
    });
    expect(await api.cleanupExpiredUploads(1, 20)).toEqual({
      attempted: 1,
      cleaned: 0,
      failed: 1,
    });
    expect(await api.cleanupExpiredUploads(1, 30)).toEqual({
      attempted: 1,
      cleaned: 0,
      failed: 1,
    });
    expect(
      (
        await db().execute(
          "SELECT id,cleanup_attempted_at FROM upload_sessions ORDER BY id",
        )
      ).rows.map((row) => [row.id, row.cleanup_attempted_at]),
    ).toEqual([
      ["a-fails", 10],
      ["b-next", 20],
      ["c-last", 30],
    ]);
    expect(await api.reservedUploadBytes()).toBe(3);
    api.failDeletion(false);
    expect((await api.cleanupExpiredUploads(3, 40)).cleaned).toBe(3);
    expect(await api.reservedUploadBytes()).toBe(0);
  });
});

test("existing upload session rows survive the additive cleanup fairness migration", async () => {
  const api = await load(),
    { runInTenant } = await import("../../lib/tenant"),
    { db, ready } = await import("../../lib/db");
  await runInTenant(workspace("cleanup-migration"), async () => {
    await ready();
    await db().execute(`CREATE TABLE upload_sessions (
      id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,state TEXT NOT NULL,reserved_bytes INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,lease TEXT,lease_until INTEGER,finish_key TEXT,upload_id TEXT NOT NULL,
      objects TEXT NOT NULL DEFAULT '[]',prepared TEXT,response TEXT
    )`);
    await db().execute(
      "INSERT INTO upload_sessions(id,owner_id,state,reserved_bytes,created_at,expires_at,upload_id) VALUES('legacy','owner','open',4,0,1,'up-legacy')",
    );
    await api.uploadReservationsReady();
    const row = (
      await db().execute("SELECT * FROM upload_sessions WHERE id='legacy'")
    ).rows[0];
    expect(row.reserved_bytes).toBe(4);
    expect(row.upload_id).toBe("up-legacy");
    expect(row.cleanup_attempted_at).toBe(0);
    expect((await api.cleanupExpiredUploads(1, 10)).cleaned).toBe(1);
    expect(await api.reservedUploadBytes()).toBe(0);
  });
});
