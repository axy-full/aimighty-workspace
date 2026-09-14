import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { createRequire } from "node:module";
import type { TenantWorkspace } from "../../lib/tenant";
import { referencedMedia } from "../../lib/mediaBindings";
import { requireTenant } from "../../lib/tenant";
const dir = mkdtempSync(path.join(tmpdir(), "particl-media-bindings-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
const workspace = (name: string) =>
  ({
    id: name,
    name,
    slug: name,
    dbUrl: `file:${path.join(dir, name + ".db")}`,
    legacy: false,
    dbToken: null,
    usesPlatformKeys: false,
    storageQuotaBytes: 1000,
    keys: {},
  }) as TenantWorkspace;
async function load(kind: "uploads" | "jobs", cleanupFails = false) {
  const deleted: string[] = [];
  const dependencies: Record<string, unknown> = {
    "next/server": createRequire(path.resolve("package.json"))("next/server"),
    "@/lib/db": await import("../../lib/db"),
    "@/lib/tenant": await import("../../lib/tenant"),
    "@/lib/workbench/request-scope":
      await import("../../lib/workbench/request-scope"),
    "@/lib/workbench/records": await import("../../lib/workbench/records"),
    "@/lib/mediaBindings": await import("../../lib/mediaBindings"),
    "@/lib/mediaRange": await import("../../lib/mediaRange"),
    "@/lib/mediaDeletion": {
      ...(await import("../../lib/mediaDeletion")),
      cleanupDeletedGenerations: async (
        _limit: number,
        _at: number,
        id: string,
      ) => {
        deleted.push(id);
        if (cleanupFails) return { attempted: 1, cleaned: 0, failed: 1 };
        const { db } = await import("../../lib/db");
        await db().execute({
          sql: "UPDATE generations SET stored_url=NULL,source_url=NULL,bytes=0 WHERE id=?",
          args: [id],
        });
        await db().execute({
          sql: "DELETE FROM generation_deletions WHERE id=?",
          args: [id],
        });
        return { attempted: 1, cleaned: 1, failed: 0 };
      },
    },
    "@/lib/uploadReservations": {
      ...(await import("../../lib/uploadReservations")),
      cleanupExpiredUploads: async () => ({
        attempted: 1,
        cleaned: 0,
        failed: 1,
      }),
    },
    "@/lib/auth": {
      withTenant: (fn: unknown) => fn,
      requireUser: async () => ({ user: { id: "owner" } }),
    },
    "@/lib/storage": {
      deleteVideo: async (id: string) => {
        deleted.push(id);
      },
    },
    "@/lib/serveType": {},
    "@/lib/recovery": { reserveRecoveryContinuation: async (_kind: string, handler: unknown) => handler },
    "@/lib/jobs": {},
    "@/lib/shots": {},
    "@/lib/push": {},
    "@/lib/cache": { invalidate: () => {} },
  };
  const file = path.resolve(`app/api/${kind}/[id]/route.ts`);
  const compiled = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = {
    exports: {} as {
      DELETE: (
        req: Request,
        ctx: { params: Promise<{ id: string }> },
      ) => Promise<Response>;
    },
  };
  new Function("require", "module", "exports", compiled)(
    (name: string) => {
      if (!(name in dependencies)) throw new Error("Unexpected import " + name);
      return dependencies[name];
    },
    mod,
    mod.exports,
  );
  return {
    deleted,
    remove: (id: string) =>
      mod.exports.DELETE(
        new Request("http://localhost/api/" + kind + "/" + id, {
          method: "DELETE",
          headers: {
            "X-Workbench-Scope": `particl-active-${requireTenant().id}-owner`,
          },
        }),
        { params: Promise.resolve({ id }) },
      ),
  };
}

test("binding identities include encoded URLs and nested version lineage", () => {
  const refs = referencedMedia({
    assets: [
      {
        id: "child",
        parent: "master",
        variants: [{ url: "/api/uploads/up%5Fid?download=1" }],
        refs: [{ generationId: "generation-a" }],
      },
    ],
    sharedAssets: [{ generationId: "generation-b", uploadId: "upload-b" }],
    old: "/api/media/gen%5Fid",
    external: "https://other.test/api/media/no",
  });
  expect([...refs.uploads].sort()).toEqual(["up_id", "upload-b"]);
  expect([...refs.generations].sort()).toEqual([
    "gen_id",
    "generation-a",
    "generation-b",
  ]);
});

test("generation DELETE preserves active provider jobs and media referenced by private or published context", async () => {
  const route = await load("jobs"),
    { runInTenant } = await import("../../lib/tenant"),
    { db } = await import("../../lib/db"),
    { workbenchReady } = await import("../../lib/workbench/records");
  await runInTenant(workspace("generation-delete"), async () => {
    await workbenchReady();
    for (const status of ["queued", "running", "held", "succeeded"])
      await db().execute({
        sql: "INSERT INTO generations(id,model,prompt,params,status,stored_url,created_at,updated_at) VALUES(?,'fixture','','{}',?,'original',0,0)",
        args: [status, status],
      });
    for (const status of ["queued", "running", "held"])
      expect((await route.remove(status)).status).toBe(409);
    await db().execute({
      sql: "INSERT INTO workbench_bibles(project_id,version,owner,body,created_at) VALUES('old-published',1,'other-private-user',?,0)",
      args: [JSON.stringify({ assets: [{ url: "/api/media/succeeded" }] })],
    });
    const blocked = await route.remove("succeeded");
    expect(blocked.status).toBe(409);
    expect(JSON.stringify(await blocked.json())).not.toContain(
      "other-private-user",
    );
    expect(route.deleted).toEqual([]);
    expect(
      (
        await db().execute(
          "SELECT COUNT(*) n FROM generations WHERE deleted=0 AND stored_url='original'",
        )
      ).rows[0].n,
    ).toBe(4);
    await db().execute("DELETE FROM workbench_bibles");
    expect((await route.remove("succeeded")).status).toBe(200);
    expect(route.deleted).toEqual(["succeeded"]);
    expect(
      (
        await db().execute(
          "SELECT deleted FROM generations WHERE id='succeeded'",
        )
      ).rows[0].deleted,
    ).toBe(1);
  });
});

test("upload DELETE checks every owner's context then transfers master and derivative bytes to durable cleanup", async () => {
  const route = await load("uploads"),
    { runInTenant } = await import("../../lib/tenant"),
    { db } = await import("../../lib/db"),
    { workbenchReady } = await import("../../lib/workbench/records"),
    { reservedUploadBytes } = await import("../../lib/uploadReservations");
  await runInTenant(workspace("upload-delete"), async () => {
    await workbenchReady();
    await db().execute(
      "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,derivative_url,derivative_bytes,created_at) VALUES('up_id','Master','image/png','png',4,'hash','https://private.blob.fixture/master-random.png','/api/uploads/up_id-api',2,0)",
    );
    await db().execute({
      sql: "INSERT INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES('private','other-user','private','Private draft',?,1,0)",
      args: [
        JSON.stringify({
          assets: [{ parent: "old", url: "/api/uploads/up%5Fid" }],
        }),
      ],
    });
    expect((await route.remove("up_id")).status).toBe(409);
    expect(
      (await db().execute("SELECT COUNT(*) n FROM uploads")).rows[0].n,
    ).toBe(1);
    await db().execute("DELETE FROM workbench_projects");
    const removed = await route.remove("up_id");
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true, cleanupPending: true });
    expect(
      (await db().execute("SELECT COUNT(*) n FROM uploads")).rows[0].n,
    ).toBe(0);
    expect(await reservedUploadBytes()).toBe(6);
    const row = (await db().execute("SELECT * FROM upload_sessions")).rows[0];
    expect(JSON.parse(String(row.objects))).toEqual([
      {
        id: "up_id",
        ext: "png",
        url: "https://private.blob.fixture/master-random.png",
      },
      { id: "up_id-api", ext: "jpg", url: "/api/uploads/up_id-api" },
    ]);
  });
  await runInTenant(workspace("other-upload-delete"), async () => {
    expect(await reservedUploadBytes()).toBe(0);
  });
});

test("catalog, identity, cast, chat and render input records protect referenced media outside the workbench", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const { workbenchReady, workbenchTransaction } =
    await import("../../lib/workbench/records");
  const { mediaBindingProblem } = await import("../../lib/mediaBindings");
  await runInTenant(workspace("authoritative-bindings"), async () => {
    await workbenchReady();
    const cases = [
      {
        kind: "upload",
        sql: "INSERT INTO attribute_versions(id,attribute_id,element_id,upload_id,created_at) VALUES('v','a','e','protected',0)",
        clear: "DELETE FROM attribute_versions",
      },
      {
        kind: "generation",
        sql: "INSERT INTO attribute_versions(id,attribute_id,element_id,gen_id,created_at) VALUES('v','a','e','protected',0)",
        clear: "DELETE FROM attribute_versions",
      },
      {
        kind: "upload",
        sql: `INSERT INTO identities(id,name,photos,created_at,updated_at) VALUES('i','Identity','["protected"]',0,0)`,
        clear: "DELETE FROM identities",
      },
      {
        kind: "upload",
        sql: "INSERT INTO identities(id,name,cover_upload_id,created_at,updated_at) VALUES('i','Identity','protected',0,0)",
        clear: "DELETE FROM identities",
      },
      {
        kind: "upload",
        sql: "INSERT INTO cast_members(id,name,upload_id,created_at) VALUES('cast','Cast','protected',0)",
        clear: "DELETE FROM cast_members",
      },
      {
        kind: "upload",
        sql: "INSERT INTO messages(id,user_id,upload_id,created_at) VALUES('m','owner','protected',0)",
        clear: "DELETE FROM messages",
      },
      {
        kind: "generation",
        sql: `INSERT INTO boards(id,project_id,name,nodes,created_at,updated_at) VALUES('b','p','Board','[{"output":{"genId":"protected"}}]',0,0)`,
        clear: "DELETE FROM boards",
      },
      {
        kind: "upload",
        sql: `INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at) VALUES('g','fixture','','{"references":[{"uploadId":"protected"}]}','queued',0,0)`,
        clear: "DELETE FROM generations",
      },
      {
        kind: "generation",
        sql: `INSERT INTO generations(id,model,prompt,params,status,created_at,updated_at) VALUES('g','fixture','','{"sourceGenId":"protected"}','succeeded',0,0)`,
        clear: "DELETE FROM generations",
      },
    ] as const;
    await db().execute(
      "INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES('owner','owner@example.test','Owner','admin','fixture',0)",
    );
    for (const item of cases) {
      await db().execute(item.sql);
      expect(
        await workbenchTransaction((tx) =>
          mediaBindingProblem(tx, item.kind, "protected"),
        ),
        item.sql,
      ).toBeTruthy();
      await db().execute(item.clear);
      expect(
        await workbenchTransaction((tx) =>
          mediaBindingProblem(tx, item.kind, "protected"),
        ),
      ).toBeNull();
    }
  });
});

test("generation DELETE returns accepted cleanup-pending without releasing retained bytes on storage failure", async () => {
  const route = await load("jobs", true);
  const { runInTenant } = await import("../../lib/tenant"),
    { db } = await import("../../lib/db"),
    { workbenchReady } = await import("../../lib/workbench/records");
  await runInTenant(workspace("route-storage-failure"), async () => {
    await workbenchReady();
    await db().execute(
      "INSERT INTO generations(id,model,prompt,params,status,stored_url,source_url,bytes,cost_usd,created_at,updated_at) VALUES('take','fixture','','{}','succeeded','original-stored','original-source',7,2.5,0,1)",
    );
    const response = await route.remove("take");
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, cleanupPending: true });
    const row = (
      await db().execute("SELECT * FROM generations WHERE id='take'")
    ).rows[0];
    expect(row.deleted).toBe(1);
    expect(row.bytes).toBe(7);
    expect(row.stored_url).toBe("original-stored");
    expect(row.source_url).toBe("original-source");
    expect(row.cost_usd).toBe(2.5);
  });
});
