import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";

const directory = mkdtempSync(
  path.join(tmpdir(), "particl-consumer-lifecycle-"),
);
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(directory, "primary.db")}`;
process.env.KEYRING_SECRET = "unit-consumer-lifecycle-not-a-real-secret";
delete process.env.BLOB_READ_WRITE_TOKEN;

test("the existing grace-period purge deletes the consumer tenant ledger and owned media, preserving another tenant", async () => {
  const { platformDb, platformReady, getWorkspace } =
    await import("../../lib/platform");
  const { markWorkspaceDeleted, purgeWorkspace } =
    await import("../../lib/purge");
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const jobs = await import("../../lib/higgsfield-consumer/jobs");
  const { accountDbReady } = await import("../../lib/accountDb");
  await platformReady();
  await accountDbReady();
  const clients: Client[] = [],
    files: string[] = [],
    databases: string[] = [];
  const realFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls++;
    throw new Error("Unexpected network in local purge fixture");
  };
  try {
    const fixtures = [];
    for (const id of ["consumer-retired", "consumer-retained"]) {
      const databasePath = path.join(directory, `${id}.db`),
        uploadId = randomUUID();
      databases.push(databasePath);
      await platformDb().execute({
        sql: "INSERT INTO workspaces(id,slug,name,db_url,owner_id,created_at,updated_at) VALUES(?,?,?,?,?,0,0)",
        args: [id, id, id, `file:${databasePath}`, "owner"],
      });
      const workspace = (await getWorkspace(id))!;
      const file = path.join(
        process.cwd(),
        ".data",
        "uploads",
        `${uploadId}.png`,
      );
      files.push(file);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `original-${id}`);
      const job = await runInTenant(workspace, async () => {
        await ready();
        clients.push(db());
        await db().execute({
          sql: "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,created_at) VALUES(?,?,'image/png','png',1,'fixture-hash',?,0)",
          args: [uploadId, "original.png", `/api/uploads/${uploadId}`],
        });
        await db().execute(
          "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES('owner-draft','owner','draft','Campaign','{}',1,0)",
        );
        return (
          await jobs.createConsumerJob({
            userId: "owner",
            draftId: "draft",
            connectedOwnerId: "owner",
            connectionGeneration: randomUUID(),
            workflow: "marketing-video",
            idempotencyKey: "consumer-quote",
            payload: { prompt: "Fixture" },
            quoteCredits: 4,
            quoteExpiresAt: Date.now() + 60_000,
            originalAssetIds: [uploadId],
          })
        ).job;
      });
      fixtures.push({ workspace, file, databasePath, job });
    }
    const [retired, retained] = fixtures;
    expect((await purgeWorkspace(retired.workspace)).errors).toHaveLength(1);
    await markWorkspaceDeleted(retired.workspace.id);
    expect((await purgeWorkspace(retired.workspace)).pending).toBe(true);
    expect(await readFile(retired.file, "utf8")).toBe(
      "original-consumer-retired",
    );
    await runInTenant(retired.workspace, async () => {
      expect(
        (
          await jobs.getConsumerJob({
            userId: "owner",
            draftId: "draft",
            id: retired.job.id,
          })
        )?.id,
      ).toBe(retired.job.id);
    });
    await platformDb().execute({
      sql: "UPDATE workspace_purges SET next_attempt_at=0 WHERE workspace_id=?",
      args: [retired.workspace.id],
    });
    const { uploadReservationsReady } =
      await import("../../lib/uploadReservations");
    await runInTenant(retired.workspace, async () => {
      await uploadReservationsReady();
      // Even a terminal job cannot release an independently ambiguous write.
      await db().execute("UPDATE higgsfield_consumer_jobs SET status='failed'");
      await db().execute({
        sql: `INSERT INTO consumer_video_originals(job_id,generation_id,owner_id,draft_id,provider_job_id,state,bytes,lease_until,updated_at)
              VALUES(?,'pending-original','owner','draft',?,'preparing',99,0,0)`,
        args: [retired.job.id, randomUUID()],
      });
    });
    for (const liveLease of [false, true]) {
      if (liveLease) {
        await runInTenant(retired.workspace, () =>
          db().execute({
            sql: "UPDATE consumer_video_originals SET bytes=0,lease_until=?",
            args: [Date.now() + 60_000],
          }),
        );
        await platformDb().execute({
          sql: "UPDATE workspace_purges SET next_attempt_at=0 WHERE workspace_id=?",
          args: [retired.workspace.id],
        });
      }
      const blocked = await purgeWorkspace(retired.workspace);
      expect(blocked.completed).toBe(false);
      expect(blocked.pending).toBe(true);
      expect(blocked.errors).toContain(
        "Consumer original storage is still being reconciled.",
      );
      expect(await readFile(retired.file, "utf8")).toBe(
        "original-consumer-retired",
      );
      expect((await stat(retired.databasePath)).isFile()).toBe(true);
      expect(
        (
          await platformDb().execute({
            sql: "SELECT files_at,key_at,database_at FROM workspace_purges WHERE workspace_id=?",
            args: [retired.workspace.id],
          })
        ).rows[0],
      ).toMatchObject({ files_at: null, key_at: null, database_at: null });
    }
    await runInTenant(retired.workspace, () =>
      db().execute("UPDATE consumer_video_originals SET bytes=0,lease_until=0"),
    );
    await platformDb().execute({
      sql: "UPDATE workspace_purges SET next_attempt_at=0 WHERE workspace_id=?",
      args: [retired.workspace.id],
    });
    expect((await purgeWorkspace(retired.workspace)).completed).toBe(true);
    await expect(stat(retired.databasePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(retired.file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(retained.file, "utf8")).toBe(
      "original-consumer-retained",
    );
    await runInTenant(retained.workspace, async () => {
      expect(
        (
          await jobs.getConsumerJob({
            userId: "owner",
            draftId: "draft",
            id: retained.job.id,
          })
        )?.id,
      ).toBe(retained.job.id);
    });
    expect((await purgeWorkspace(retired.workspace)).completed).toBe(true);
    expect(networkCalls).toBe(0);
  } finally {
    globalThis.fetch = realFetch;
    for (const client of clients) client.close();
    for (const file of files) await rm(file, { force: true });
    // The process-wide platform client may still point at this fixture folder
    // for subsequent test files. Remove only the owned, closed tenant databases.
    for (const database of databases)
      for (const suffix of ["", "-journal", "-wal", "-shm"])
        await rm(database + suffix, { force: true });
  }
});
