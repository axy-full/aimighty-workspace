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
    files: string[] = [];
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
    await rm(directory, { recursive: true, force: true });
  }
});
