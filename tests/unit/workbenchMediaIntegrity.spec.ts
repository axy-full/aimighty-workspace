import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Asset } from "../../lib/workbench/studio";
import type { TenantWorkspace } from "../../lib/tenant";

const dir = mkdtempSync(path.join(tmpdir(), "particl-workbench-integrity-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";

function workspace(name: string): TenantWorkspace {
  return {
    id: "ws_" + name,
    slug: name,
    name,
    legacy: true,
    dbUrl: `file:${path.join(dir, name + ".db")}`,
    dbToken: null,
    keys: {},
    usesPlatformKeys: false,
    allowanceUsd: null,
    gatewayKeyId: null,
    ownerId: "owner",
    createdAt: 0,
    suspendedAt: null,
    suspendedReason: null,
    flaggedAt: null,
    flagNote: null,
    concurrency: null,
    rendersPerHour: null,
    storageQuotaBytes: null,
    deletedAt: null,
  };
}
function asset(id: string, kind: "upload" | "generation"): Asset {
  return {
    id: "asset-" + id,
    name: "Source",
    kind: "image",
    category: "Reference",
    url: `/api/${kind === "upload" ? "uploads" : "media"}/${id}`,
    description: "",
    prompt: "",
    status: "Draft",
    locked: false,
    version: 1,
    refs: [],
    ...(kind === "upload" ? { uploadId: id } : { generationId: id }),
  };
}

test("stale drafts cannot restore deleted upload or generation references, including frozen shared assets", async () => {
  const { saveDraft, readDraft, publishBible, workbenchReady } =
    await import("../../lib/workbench/records");
  const { newProject } = await import("../../lib/workbench/studio");
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  await runInTenant(workspace("deleted-source"), async () => {
    await workbenchReady();
    await db().execute(
      `INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,created_at) VALUES('up_source','source.png','image/png','png',1,'hash','local',0)`,
    );
    await db().execute(
      `INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at) VALUES('gen_source','mock','test','{}','succeeded',0,0)`,
    );
    const source = asset("up_source", "upload"),
      take = asset("gen_source", "generation");
    const p = {
      ...newProject("Retained sources"),
      assets: [source, take],
      sharedAssets: [take],
    };
    await saveDraft("author", p, 0);
    const current = (await readDraft("author", p.id))!;
    // Simulate a source removed by an older app version, before guarded deletion.
    await db().execute(`DELETE FROM uploads WHERE id='up_source'`);
    await expect(
      saveDraft(
        "author",
        { ...current.project, name: "Lost edit" },
        current.revision,
      ),
    ).rejects.toThrow(/referenced upload/);
    expect((await readDraft("author", p.id))?.project.name).toBe(
      "Retained sources",
    );
    await db().execute(
      `UPDATE generations SET deleted=1 WHERE id='gen_source'`,
    );
    await expect(
      saveDraft("author", { ...current.project, assets: [] }, current.revision),
    ).rejects.toThrow(/referenced generation/);
    await expect(publishBible("author", "Author", p.id, 0)).rejects.toThrow(
      /referenced generation/,
    );
    expect(
      Number(
        (await db().execute("SELECT COUNT(*) AS n FROM workbench_bibles"))
          .rows[0].n,
      ),
    ).toBe(0);
    expect((await readDraft("author", p.id))?.revision).toBe(current.revision);
  });
});

test("a draft save racing source deletion never commits a dangling reference", async () => {
  const { saveDraft, readDraft, workbenchTransaction, workbenchReady } =
    await import("../../lib/workbench/records");
  const { mediaBindingProblem } = await import("../../lib/mediaBindings");
  const { newProject } = await import("../../lib/workbench/studio");
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  await runInTenant(workspace("save-delete-race"), async () => {
    await workbenchReady();
    for (const order of ["save-first", "delete-first"] as const) {
      const p = newProject(order),
        id = "up_" + order;
      await saveDraft("author", p, 0);
      const current = (await readDraft("author", p.id))!;
      await db().execute({
        sql: `INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,created_at) VALUES(?,'source.png','image/png','png',1,'hash','local',0)`,
        args: [id],
      });
      const save = () =>
        saveDraft(
          "author",
          { ...current.project, assets: [asset(id, "upload")] },
          current.revision,
        );
      const remove = () =>
        workbenchTransaction(async (tx) => {
          const problem = await mediaBindingProblem(tx, "upload", id);
          if (problem) throw new Error(problem);
          await tx.execute({
            sql: "DELETE FROM uploads WHERE id=?",
            args: [id],
          });
        });
      const results = await Promise.allSettled(
        order === "save-first" ? [save(), remove()] : [remove(), save()],
      );
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const final = (await readDraft("author", p.id))!;
      const present = (
        await db().execute({
          sql: "SELECT id FROM uploads WHERE id=?",
          args: [id],
        })
      ).rows.length;
      expect(final.project.assets.length > 0).toBe(present > 0);
      // Once committed, either outcome remains protected against a later stale retry.
      if (present)
        await expect(remove()).rejects.toThrow(/used by a production/);
      else await expect(save()).rejects.toThrow(/referenced upload/);
    }
  });
});

test("a same-workspace database replacement initializes shared context and shot mapping tables", async () => {
  const { workbenchReady, saveDraft, readDraft, publishBible } =
    await import("../../lib/workbench/records");
  const { newProject } = await import("../../lib/workbench/studio");
  const { runInTenant } = await import("../../lib/tenant");
  const ws = workspace("restore"),
    p = newProject("Restored workspace");
  await runInTenant(ws, async () => {
    await workbenchReady();
    await saveDraft("author", p, 0);
  });
  await runInTenant(
    { ...ws, dbUrl: `file:${path.join(dir, "replacement.db")}` },
    async () => {
      await workbenchReady();
      expect(await readDraft("author", p.id)).toBeNull();
      await saveDraft("author", p, 0);
      expect((await publishBible("author", "Author", p.id, 0)).version).toBe(1);
    },
  );
});
