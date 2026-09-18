import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import type { TenantWorkspace, TenantStore } from "../../lib/tenant";
import {
  workbenchScopeFor,
  workbenchScopeProblem,
} from "../../lib/workbench/request-scope";
import { MediaSourceError } from "../../lib/mediaBindings";

const directory = mkdtempSync(
  path.join(tmpdir(), "particl-consumer-activity-"),
);
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.KEYRING_SECRET ??= "consumer-activity-isolated-test-key";
process.env.ENGINE_MOCK = "1";
let sequence = 0;
function workspace(): TenantWorkspace {
  const id = `activity-${++sequence}`;
  return {
    id,
    slug: id,
    name: id,
    legacy: true,
    dbUrl: `file:${path.join(directory, `${id}.db`)}`,
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
async function fixture() {
  const database = await import("../../lib/db"),
    jobs = await import("../../lib/higgsfield-consumer/jobs"),
    activity = await import("../../lib/higgsfield-consumer/activity"),
    tenant = await import("../../lib/tenant");
  const ws = workspace();
  const run = <T>(fn: () => Promise<T>) => tenant.runInTenant(ws, fn);
  async function draft(
    userId = "owner",
    draftId = "draft",
    name = "Own project",
  ) {
    await database.ready();
    await database.db().execute({
      sql: "INSERT OR REPLACE INTO workbench_projects(key,owner,project_id,name,body,revision,updated_at) VALUES(?,?,?,?,?,1,?)",
      args: [`${userId}-${draftId}`, userId, draftId, name, "{}", Date.now()],
    });
  }
  async function row(
    status:
      | "quoted"
      | "dispatching"
      | "accepted"
      | "uncertain"
      | "failed"
      | "completed",
    quoteCredits: number,
    options: {
      userId?: string;
      draftId?: string;
      admitted?: boolean;
      workflow?: "marketing-video" | "reference-match" | "virality";
    } = {},
  ) {
    const userId = options.userId ?? "owner",
      draftId = options.draftId ?? "draft";
    const { job } = await jobs.createConsumerJob({
      userId,
      draftId,
      workflow: options.workflow ?? "marketing-video",
      connectedOwnerId: userId,
      connectionGeneration: randomUUID(),
      idempotencyKey: randomUUID(),
      payload: { private: "NEVER_SERIALIZE_PAYLOAD" },
      quoteCredits,
      quoteExpiresAt: Date.now() + 60_000,
      originalAssetIds: [],
    });
    const admitted = options.admitted ?? status !== "quoted";
    if (admitted)
      await jobs.claimConsumerDispatch({ userId, draftId, id: job.id });
    // Terminal fixture states isolate aggregation; lifecycle CAS has its own tests.
    await database.db().execute({
      sql: "UPDATE higgsfield_consumer_jobs SET status=?,provider_receipt=?,result_manifest=? WHERE id=?",
      args: [
        status,
        '{"secret":"NEVER_SERIALIZE_RECEIPT"}',
        '{"private":"NEVER_SERIALIZE_MANIFEST"}',
        job.id,
      ],
    });
    return job;
  }
  return { ws, run, draft, row, database, activity, tenant };
}

test("activity totals only own admitted jobs, keeps Higgsfield quotes separate, and excludes unused or restored unsubmitted quotes", async () => {
  const f = await fixture();
  await f.run(async () => {
    await f.draft();
    await f.row("completed", 75);
    await f.row("completed", 0, { workflow: "reference-match" });
    await f.row("failed", 4.25, { workflow: "virality" });
    await f.row("quoted", 900);
    await f.row("uncertain", 800, { admitted: false });
    await f.row("failed", 700, { admitted: false });
    await f.row("dispatching", 1.25);
    await f.row("accepted", 2.5);
    await f.row("uncertain", 3.75);
    const result = await f.activity.getConsumerCreditActivity("owner");
    expect(result).toMatchObject({
      creditUnit: "higgsfield_credits",
      basis: "approved_quotes",
      scope: "own_account",
      totals: {
        completed: { jobs: 2, quoteCredits: 75 },
        pending: { jobs: 2, quoteCredits: 3.75 },
        uncertain: { jobs: 1, quoteCredits: 3.75 },
        failed: { jobs: 1, quoteCredits: 4.25 },
      },
      projectsTruncated: false,
    });
    expect(result.projects).toEqual([
      {
        draftId: "draft",
        name: "Own project",
        available: true,
        totals: result.totals,
      },
    ]);
    const text = JSON.stringify(result);
    expect(text).not.toMatch(
      /NEVER_SERIALIZE|payload|providerReceipt|connectionGeneration|costUsd|balance|idempotency/,
    );
  });
});

test("same draft ids and owner ids cannot cross users or tenants; deleted or reassigned project names remain private", async () => {
  const f = await fixture();
  await f.run(async () => {
    await f.draft();
    await f.row("completed", 12.5);
    await f.draft("another", "draft", "PRIVATE OTHER PROJECT");
    await f.row("completed", 999, { userId: "another" });
    expect(
      (await f.activity.getConsumerCreditActivity("owner")).totals.completed
        .quoteCredits,
    ).toBe(12.5);
    expect(
      (await f.activity.getConsumerCreditActivity("another")).totals.completed
        .quoteCredits,
    ).toBe(999);
    await f.database
      .db()
      .execute("DELETE FROM workbench_projects WHERE owner='owner'");
    const deleted = await f.activity.getConsumerCreditActivity("owner");
    expect(deleted.projects[0]).toMatchObject({
      draftId: "draft",
      name: null,
      available: false,
    });
    expect(JSON.stringify(deleted)).not.toContain("PRIVATE OTHER PROJECT");
    await f.tenant.runInTenant(workspace(), async () => {
      const empty = await f.activity.getConsumerCreditActivity("owner");
      expect(empty.projects).toEqual([]);
      expect(empty.totals.completed).toEqual({ jobs: 0, quoteCredits: 0 });
    });
    expect(
      (await f.activity.getConsumerCreditActivity("owner")).totals.completed
        .jobs,
    ).toBe(1);
  });
});

test("project response is bounded while all-project totals remain complete", async () => {
  const f = await fixture();
  await f.run(async () => {
    await f.draft();
    const seed = await f.row("completed", 1.125);
    await f.database.db().batch(
      Array.from({ length: 101 }, (_, i) => ({
        sql: `INSERT INTO higgsfield_consumer_jobs(id,user_id,draft_id,connected_owner_id,connection_generation,workflow,idempotency_key,payload_json,payload_hash,immutable_hash,quote_credits,quote_expires_at,original_asset_ids,status,dispatch_claim_hash,created_at,updated_at)
        SELECT ?,user_id,?,connected_owner_id,connection_generation,workflow,?,payload_json,payload_hash,immutable_hash,quote_credits,quote_expires_at,original_asset_ids,status,dispatch_claim_hash,?,updated_at FROM higgsfield_consumer_jobs WHERE id=?`,
        args: [
          randomUUID(),
          `missing-${i}`,
          randomUUID(),
          Date.now() + i,
          seed.id,
        ],
      })),
      "write",
    );
    const result = await f.activity.getConsumerCreditActivity("owner");
    expect(result.projects).toHaveLength(100);
    expect(result).toMatchObject({
      projectLimit: 100,
      projectsTruncated: true,
      totals: { completed: { jobs: 102, quoteCredits: 114.75 } },
    });
    expect(result.projects[0].draftId).toBe("missing-100");
    await expect(
      f.activity.getConsumerCreditActivity("bad user"),
    ).rejects.toThrow("Invalid activity account");
  });
});

async function routeFixture() {
  const auth = await import("../../lib/auth"),
    tenant = await import("../../lib/tenant"),
    account = await import("../../lib/accountDb");
  let store = {
    workspace: { id: "workspace", keys: {}, legacy: false, deletedAt: null },
    user: {
      id: "owner",
      name: "Owner",
      email: "owner@example.test",
      role: "admin",
      owner: true,
    },
  } as TenantStore;
  const source = ts.createSourceFile(
    "auth.ts",
    readFileSync("lib/auth.ts", "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const statement = source.statements.find(
    (s) => ts.isFunctionDeclaration(s) && s.name?.text === "withTenant",
  )!;
  const wrapper = ts.transpileModule(statement.getText(source), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const wrapperExports = {} as Pick<typeof auth, "withTenant">;
  new Function(
    "exports",
    "resolveStore",
    "runWithStore",
    "NoTenantError",
    "MediaSourceError",
    "workbenchScopeFor",
    "recoveryRoute",
    wrapper,
  )(
    wrapperExports,
    async () => store,
    tenant.runWithStore,
    tenant.NoTenantError,
    MediaSourceError,
    workbenchScopeFor,
    (fn: unknown) => fn,
  );
  const reads: string[] = [],
    limits: unknown[][] = [];
  let failure: unknown,
    limited = false;
  const deps: Record<string, unknown> = {
    "@/lib/workbench/request-scope": { workbenchScopeProblem },
    "@/lib/auth": { ...auth, withTenant: wrapperExports.withTenant },
    "@/lib/tenant": tenant,
    "@/lib/accountDb": {
      AccountError: account.AccountError,
      takeAccountLimit: async (...args: unknown[]) => {
        limits.push(args);
        if (limited)
          throw new account.AccountError("PRIVATE LIMIT DETAIL", 429);
      },
    },
    "@/lib/higgsfield-consumer/activity": {
      getConsumerCreditActivity: async (id: string) => {
        reads.push(id);
        if (failure) throw failure;
        return { scope: "own_account", creditUnit: "higgsfield_credits" };
      },
    },
  };
  const output = {
    exports: {} as { GET(req: Request, ctx: unknown): Promise<Response> },
  };
  const route = ts.transpileModule(
    readFileSync("app/api/higgsfield/consumer/activity/route.ts", "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  new Function("require", "module", "exports", route)(
    (name: string) => {
      if (!(name in deps)) throw new Error(`Unexpected dependency ${name}`);
      return deps[name];
    },
    output,
    output.exports,
  );
  return {
    store: () => store,
    setStore: (value: TenantStore) => {
      store = value;
    },
    reads,
    limits,
    fail: () => {
      failure = new Error("PRIVATE DATABASE DETAIL");
    },
    limit: () => {
      limited = true;
    },
    get: (scope: string | null = workbenchScopeFor("workspace", "owner")) =>
      output.exports.GET(
        new Request(
          "http://localhost/api/higgsfield/consumer/activity?userId=other&workspaceId=other",
          { headers: scope === null ? {} : { "X-Workbench-Scope": scope } },
        ),
        undefined,
      ),
  };
}

test("activity route uses signed-in identity, rejects bearer/stale scopes, and lets former owners read only their own history", async () => {
  const f = await routeFixture(),
    original = f.store();
  for (const scope of [
    null,
    "",
    workbenchScopeFor("other", "owner"),
    workbenchScopeFor("workspace", "other"),
  ])
    expect((await f.get(scope)).status).toBe(409);
  f.setStore({ ...original, user: null });
  expect((await f.get(null)).status).toBe(401);
  for (const scope of ["read", "render"] as const) {
    f.setStore({
      ...original,
      token: { id: "token", scope } as TenantStore["token"],
    });
    expect((await f.get(null)).status).toBe(403);
  }
  expect(f.reads).toEqual([]);
  expect(f.limits).toEqual([]);
  f.setStore({
    ...original,
    user: { ...original.user!, owner: false, role: "member" },
  });
  const response = await f.get();
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(f.reads).toEqual(["owner"]);
  expect(f.limits).toEqual([
    ["higgsfield-consumer-activity:workspace:owner", 60, 60_000],
  ]);
});

test("activity route errors are bounded and do not expose storage or limiter details", async () => {
  const failed = await routeFixture();
  failed.fail();
  const error = await failed.get();
  expect(error.status).toBe(503);
  expect(await error.text()).not.toContain("PRIVATE");
  const limited = await routeFixture();
  limited.limit();
  const response = await limited.get();
  expect(response.status).toBe(429);
  expect(await response.text()).not.toContain("PRIVATE");
  expect(limited.reads).toEqual([]);
});
