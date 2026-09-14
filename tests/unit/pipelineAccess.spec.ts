import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdmissionActor } from "../../lib/admissionTypes";

const dir = mkdtempSync(path.join(tmpdir(), "particl-pipeline-access-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET = "unit-test-keyring-secret-unit-test-keyring";
const actor: AdmissionActor = {
  user: {
    id: "member",
    email: "member@example.invalid",
    name: "Member",
    role: "admin",
    owner: true,
    disabled: false,
    createdAt: 0,
    lastSeen: null,
  },
};
async function fixture(name: string) {
  const { platformReady, platformDb, rowToWorkspace } =
    await import("../../lib/platform");
  await platformReady();
  await platformDb().batch(
    [
      "INSERT OR IGNORE INTO accounts(id,email,name,password_hash,created_at) VALUES('member','member@example.invalid','Member','never-expose-this-hash',0)",
      {
        sql: "INSERT INTO workspaces(id,slug,name,db_url,owner_id,created_at,updated_at) VALUES(?,?,?,?,?,0,0)",
        args: [
          name,
          name,
          name,
          `file:${path.join(dir, name + ".db")}`,
          "member",
        ],
      },
      {
        sql: "INSERT INTO memberships(workspace_id,account_id,role,created_at) VALUES(?,'member','owner',0)",
        args: [name],
      },
    ],
    "write",
  );
  return rowToWorkspace(
    (
      await platformDb().execute({
        sql: "SELECT * FROM workspaces WHERE id=?",
        args: [name],
      })
    ).rows[0],
  );
}

test("pipeline execution restores current standing and roles without copying credential fields", async () => {
  const { withPipelineActor } = await import("../../lib/pipeline/actor");
  const { platformDb } = await import("../../lib/platform");
  const { currentTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const ws = await fixture("actor");
  let called = 0;
  const check = async (current: AdmissionActor) => {
    called++;
    expect(currentTenant()?.workspace?.id).toBe(ws.id);
    expect(currentTenant()?.user).toEqual(current.user);
    expect(currentTenant()?.token).toBeUndefined();
    expect(JSON.stringify(current)).not.toMatch(/password|hash|token|key/i);
    await db().execute("SELECT 1");
    return current.user;
  };
  expect(await withPipelineActor(ws.id, "member", check)).toMatchObject({
    role: "admin",
    owner: true,
  });
  await platformDb().execute({
    sql: "UPDATE memberships SET role='member' WHERE workspace_id=?",
    args: [ws.id],
  });
  expect(await withPipelineActor(ws.id, "member", check)).toMatchObject({
    role: "member",
    owner: false,
  });
  for (const [deny, restore, status] of [
    [
      "UPDATE memberships SET disabled=1 WHERE workspace_id='actor'",
      "UPDATE memberships SET disabled=0 WHERE workspace_id='actor'",
      403,
    ],
    [
      "UPDATE accounts SET disabled=1 WHERE id='member'",
      "UPDATE accounts SET disabled=0 WHERE id='member'",
      403,
    ],
    [
      "UPDATE accounts SET deleted_at=1 WHERE id='member'",
      "UPDATE accounts SET deleted_at=NULL WHERE id='member'",
      403,
    ],
    [
      "UPDATE workspaces SET suspended_at=1 WHERE id='actor'",
      "UPDATE workspaces SET suspended_at=NULL WHERE id='actor'",
      423,
    ],
    [
      "UPDATE workspaces SET deleted_at=1 WHERE id='actor'",
      "UPDATE workspaces SET deleted_at=NULL WHERE id='actor'",
      403,
    ],
  ] as const) {
    await platformDb().execute(deny);
    await expect(
      withPipelineActor(ws.id, "member", check),
    ).rejects.toMatchObject({ status });
    await platformDb().execute(restore);
  }
  expect(called).toBe(2);
});

test("pipeline actor rejects API tokens and mismatched ambient accounts/workspaces before work", async () => {
  const { withPipelineActor } = await import("../../lib/pipeline/actor");
  const { runInTenant } = await import("../../lib/tenant");
  const ws = await fixture("scope"),
    other = await fixture("other");
  const denied = () => {
    throw new Error("A rejected pipeline must not execute");
  };
  await runInTenant(
    ws,
    async () => {
      await expect(
        withPipelineActor(ws.id, "member", denied),
      ).rejects.toMatchObject({ status: 403 });
    },
    {
      ...actor,
      token: { id: "token", name: "Render", scope: "render", capUsd: null },
    },
  );
  await runInTenant(
    ws,
    async () => {
      await expect(
        withPipelineActor(other.id, "member", denied),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        withPipelineActor(ws.id, "someone-else", denied),
      ).rejects.toMatchObject({ status: 403 });
    },
    actor,
  );
});

test("pipeline retention protects immutable, quoted, attempted, selected and assembled media while excluding another workspace", async () => {
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const { workbenchReady } = await import("../../lib/workbench/records");
  const { PipelineStore } = await import("../../lib/pipeline/store");
  const { mediaBindingProblem } = await import("../../lib/mediaBindings");
  const { mediaMutation } = await import("../../lib/mediaMutation");
  const ws = await fixture("retention");
  await runInTenant(
    ws,
    async () => {
      await workbenchReady();
      const problem = (kind: "upload" | "generation", id = "retained") =>
        mediaMutation((tx) => mediaBindingProblem(tx, kind, id));
      // Compatibility: ordinary deletion doesn't bootstrap or require pipeline tables.
      expect(await problem("upload")).toBeNull();
      await new PipelineStore(db(), ws.id).ready();
      const fixtures = [
        {
          table: "pipeline_versions",
          column: "body",
          sql: "INSERT INTO pipeline_versions(workspace_id,id,version,owner,project_id,bible_version,body,fingerprint,created_at) VALUES(?,'v',1,'private-owner','project',1,?,'hash',0)",
          body: {
            stages: [
              {
                inputs: [
                  {
                    source: "asset",
                    media: { source: "upload", id: "retained" },
                  },
                ],
              },
            ],
          },
          kind: "upload",
        },
        {
          table: "pipeline_quotes",
          column: "body",
          sql: "INSERT INTO pipeline_quotes(workspace_id,id,run_id,stage_id,base_revision,input_hash,fingerprint,body,expires_at,created_at) VALUES(?,'quote','run','stage',1,'input','hash',?,0,0)",
          body: {
            units: [
              {
                prepared: {
                  compiled: {
                    references: [
                      { uploadId: "retained", storedUrl: "private-storage" },
                    ],
                  },
                },
              },
            ],
          },
          kind: "upload",
        },
        {
          table: "pipeline_attempts",
          column: "prepared",
          sql: "INSERT INTO pipeline_attempts(workspace_id,id,run_id,stage_id,unit,number,request_key,prepared,state,created_at,updated_at) VALUES(?,'attempt','run','stage',0,1,'request',?,'queued',0,0)",
          body: { compiled: { references: [{ genId: "retained" }] } },
          kind: "generation",
        },
        {
          table: "pipeline_selections",
          column: "body",
          sql: "INSERT INTO pipeline_selections(workspace_id,run_id,stage_id,revision,body,created_at) VALUES(?,'run','stage',1,?,0)",
          body: { generationId: "retained" },
          kind: "generation",
        },
        {
          table: "pipeline_runs",
          column: "assemblies",
          sql: "INSERT INTO pipeline_runs(workspace_id,id,owner,pipeline_id,pipeline_version,state,assemblies,created_at,updated_at) VALUES(?,'run','private-owner','v',1,'paused',?,0,0)",
          body: { clips: [{ generationId: "retained" }] },
          kind: "generation",
        },
      ] as const;
      for (const item of fixtures) {
        await db().execute({
          sql: item.sql,
          args: ["different-workspace", JSON.stringify(item.body)],
        });
        expect(await problem(item.kind)).toBeNull();
        await db().execute({
          sql: item.sql,
          args: [ws.id, JSON.stringify(item.body)],
        });
        const message = await problem(item.kind);
        expect(message).toMatch(/production pipeline/);
        expect(message).not.toMatch(
          /private-owner|private-storage|different-workspace/,
        );
        expect(await problem(item.kind, "unrelated")).toBeNull();
        await db().execute({
          sql: `UPDATE ${item.table} SET ${item.column}='broken json' WHERE workspace_id=?`,
          args: [ws.id],
        });
        expect(await problem(item.kind, "unrelated")).toMatch(
          /could not be checked/,
        );
        await db().execute(`DELETE FROM ${item.table}`);
      }
      await db().execute(
        "INSERT INTO pipeline_attempts(workspace_id,id,run_id,stage_id,unit,number,request_key,prepared,state,generation_id,created_at,updated_at) VALUES('retention','bound','run','stage',0,1,'bound-key','{}','succeeded','retained',0,0)",
      );
      expect(await problem("generation")).toMatch(/production pipeline/);
    },
    actor,
  );
});
