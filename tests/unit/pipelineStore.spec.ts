import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { createPlatformDatabaseClient } from "../../lib/localDatabaseClient";
import * as compiler from "../../lib/pipeline/compile";
import * as schema from "../../lib/pipeline/schema";
import type { PipelineRun } from "../../lib/pipeline/store";

const owner = "account",
  workspaceId = "workspace",
  at = 1_000_000;
const source = {
  brief: "Sunrise",
  script: "Good morning",
  nodes: [{ id: "shot", text: "A cyclist" }],
  assets: [
    {
      id: "look",
      kind: "image",
      uploadId: "source",
      url: "/api/uploads/source",
    },
  ],
};
const specification = (extra = false) => ({
  schemaVersion: 1,
  name: "A film",
  context: { projectId: "project", bibleVersion: 1 },
  stages: [
    {
      id: "image",
      label: "Image",
      kind: "image",
      model: "image-model",
      prompt: { source: "node", nodeId: "shot" },
      resolution: "1K",
      units: 2,
      inputs: [{ source: "asset", assetId: "look", role: "reference_image" }],
    },
    ...(extra
      ? [
          {
            id: "select",
            label: "Select",
            kind: "review",
            candidates: [
              { stageId: "image", unit: 0 },
              { stageId: "image", unit: 1 },
            ],
          },
          {
            id: "motion",
            label: "Motion",
            kind: "video",
            model: "video-model",
            prompt: { source: "brief" },
            resolution: "720p",
            duration: 5,
            inputs: [
              { source: "stage", stageId: "select", role: "first_frame" },
            ],
          },
        ]
      : []),
  ],
});
async function fixture(extra = false, input: unknown = specification(extra)) {
  const dir = mkdtempSync(path.join(tmpdir(), "particl-pipeline-store-"));
  const client = createPlatformDatabaseClient({
    url: "file:" + path.join(dir, "workspace.db"),
  });
  await client.batch(
    [
      "CREATE TABLE projects(id TEXT PRIMARY KEY)",
      "CREATE TABLE workbench_bibles(project_id TEXT,version INTEGER,body TEXT)",
      "CREATE TABLE workbench_projects(owner TEXT,body TEXT)",
      "CREATE TABLE uploads(id TEXT PRIMARY KEY,kind TEXT,sha256 TEXT,stored_url TEXT,bytes INTEGER,duration_s REAL)",
      "CREATE TABLE generations(id TEXT PRIMARY KEY,kind TEXT,status TEXT,stored_url TEXT,bytes INTEGER,params TEXT,created_by TEXT,project_id TEXT,error TEXT,deleted INTEGER DEFAULT 0)",
      { sql: "INSERT INTO projects VALUES(?)", args: ["project"] },
      {
        sql: "INSERT INTO workbench_bibles VALUES(?,?,?)",
        args: ["project", 1, JSON.stringify(source)],
      },
      {
        sql: "INSERT INTO uploads VALUES(?,?,?,?,?,?)",
        args: ["source", "image", "a".repeat(64), "private/source", 42, null],
      },
    ],
    "write",
  );
  const dependencies = {
    "node:crypto": await import("node:crypto"),
    "../db": {},
    "../tenant": {},
    "../workbench/records": {},
    "../mediaMutation": { validateMediaSources: async () => {} },
    "./compile": compiler,
    "./schema": schema,
  };
  const output = ts.transpileModule(
    readFileSync(path.resolve("lib/pipeline/store.ts"), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  const mod = { exports: {} as typeof import("../../lib/pipeline/store") };
  new Function("require", "module", "exports", output)(
    (name: keyof typeof dependencies) => {
      if (!(name in dependencies)) throw new Error("Unexpected import " + name);
      return dependencies[name];
    },
    mod,
    mod.exports,
  );
  const store = new mod.exports.PipelineStore(client, workspaceId);
  const version = await store.saveVersion(owner, input, 0, undefined, at);
  const run = await store.createRun(owner, version.id, 1, at);
  const prepared = (
    kind: "image" | "video" = "image",
    price = 10,
  ): schema.PreparedStageAdmission => ({
    version: 1,
    kind,
    workspaceId,
    actorId: owner,
    compiled: {},
    request: {
      projectId: "project",
      prompt: "Frozen text",
      model: "model",
      maxCredits: price,
    },
    quote: {
      fingerprint: compiler.pipelineHash({ kind, price }),
      estimatedCredits: price,
      price,
      unit: "cr",
    },
  });
  const quote = async (
    current: PipelineRun,
    stageId = "image",
    units = [0, 1],
  ) =>
    store.quoteStage(
      owner,
      run.id,
      current.revision,
      stageId,
      (await store.stageInputs(owner, run.id, stageId)).inputHash,
      units.map((unit) => ({
        unit,
        prepared: prepared(stageId === "image" ? "image" : "video"),
      })),
      at + 10,
    );
  const generation = async (id: string, status = "succeeded", kind = "image") =>
    client.execute({
      sql: "INSERT INTO generations(id,kind,status,stored_url,bytes,params,created_by,project_id,error) VALUES(?,?,?,?,?,?,?,?,?)",
      args: [
        id,
        kind,
        status,
        status === "succeeded" ? "private/" + id : null,
        100,
        "{}",
        owner,
        "project",
        status === "failed" ? "Provider refused" : null,
      ],
    });
  return {
    client,
    store,
    version,
    run,
    quote,
    prepared,
    generation,
    module: mod.exports,
    Class: mod.exports.PipelineStore,
  };
}

test("immutable versions use CAS and never read private drafts; owner and workspace stay isolated", async () => {
  const f = await fixture();
  const changed = { ...specification(), name: "Changed" };
  const results = await Promise.allSettled([
    f.store.saveVersion(owner, changed, 1, f.version.id),
    f.store.saveVersion(owner, changed, 1, f.version.id),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(
    (await f.store.getVersion(owner, f.version.id, 1)).compiled.spec.name,
  ).toBe("A film");
  expect(
    (await f.store.getVersion(owner, f.version.id, 2)).compiled.spec.name,
  ).toBe("Changed");
  await expect(f.store.getRun("other-account", f.run.id)).rejects.toThrow(
    /not found/,
  );
  await expect(
    new f.Class(f.client, "other-workspace").getRun(owner, f.run.id),
  ).rejects.toThrow(/not found/);
  await f.client.execute({
    sql: "INSERT INTO workbench_projects VALUES(?,?)",
    args: [owner, JSON.stringify(source)],
  });
  await expect(
    f.store.saveVersion(
      owner,
      {
        ...specification(),
        context: { projectId: "project", bibleVersion: 2 },
      },
      0,
    ),
  ).rejects.toThrow(/Private drafts/);
});

test("concurrent approval and a lost approval response create exactly one immutable request per unit", async () => {
  const f = await fixture(),
    q = await f.quote(f.run);
  const replies = await Promise.all(
    [0, 1].map(() =>
      f.store.approveQuote(
        owner,
        f.run.id,
        q.baseRevision,
        q.id,
        q.fingerprint,
        at + 20,
      ),
    ),
  );
  expect(replies[0].attempts).toHaveLength(2);
  expect(replies[1].attempts.map((a) => a.requestKey)).toEqual(
    replies[0].attempts.map((a) => a.requestKey),
  );
  expect(new Set(replies[0].attempts.map((a) => a.requestKey)).size).toBe(2);
  await expect(
    f.store.approveQuote(
      owner,
      f.run.id,
      q.baseRevision,
      q.id,
      "tampered",
      at + 20,
    ),
  ).rejects.toThrow(/displayed quote/);
  await expect(f.quote(replies[0])).rejects.toThrow(/Recover the existing/);
});

test("approval binds source storage identity and quote revision; stale inputs cannot be silently adopted", async () => {
  const f = await fixture(),
    q = await f.quote(f.run);
  await f.client.execute(
    "UPDATE uploads SET sha256='changed',stored_url='private/new-object' WHERE id='source'",
  );
  await expect(
    f.store.approveQuote(
      owner,
      f.run.id,
      q.baseRevision,
      q.id,
      q.fingerprint,
      at + 20,
    ),
  ).rejects.toThrow(/source changed/);
  expect((await f.store.getRun(owner, f.run.id)).attempts).toHaveLength(0);
  const q2 = await f.quote(await f.store.getRun(owner, f.run.id));
  await expect(
    f.store.approveQuote(
      owner,
      f.run.id,
      q.baseRevision,
      q.id,
      q.fingerprint,
      at + 20,
    ),
  ).rejects.toThrow(/run changed/);
  await expect(
    f.store.approveQuote(
      owner,
      f.run.id,
      q2.baseRevision,
      q2.id,
      q2.fingerprint,
      q2.expiresAt,
    ),
  ).rejects.toThrow(/expired/);
});

test("pause blocks unstarted approved work; expired worker fencing rejects delayed results", async () => {
  const f = await fixture(),
    q = await f.quote(f.run);
  const approved = await f.store.approveQuote(
    owner,
    f.run.id,
    q.baseRevision,
    q.id,
    q.fingerprint,
    at + 20,
  );
  const paused = await f.store.setState(
    owner,
    f.run.id,
    approved.revision,
    "paused",
    at + 21,
  );
  const old = (await f.store.claimRun(f.run.id, at + 30, 1000))!;
  expect(
    await f.store.beginAttempt(old, approved.attempts[0].id, at + 31),
  ).toBeNull();
  await f.store.setState(owner, f.run.id, paused.revision, "running", at + 32);
  expect(
    (await f.store.beginAttempt(old, approved.attempts[0].id, at + 33))?.state,
  ).toBe("submitting");
  expect(await f.store.claimRun(f.run.id, at + 34)).toBeNull();
  const takeover = (await f.store.claimRun(f.run.id, at + 1031))!;
  expect(takeover.epoch).toBe(old.epoch + 1);
  await expect(
    f.store.recordAdmission(
      old,
      approved.attempts[0].id,
      { status: 503, body: {} },
      at + 1032,
    ),
  ).rejects.toThrow(/lease was lost/);
  await f.store.releaseRun(old);
  expect(await f.store.claimRun(f.run.id, at + 1033)).toBeNull();
  expect(
    (await f.store.beginAttempt(takeover, approved.attempts[0].id, at + 1033))
      ?.requestKey,
  ).toBe(approved.attempts[0].requestKey);
});

test("uncertain responses retain their key; known failed jobs only retry through a new explicit quote", async () => {
  const f = await fixture(),
    q = await f.quote(f.run);
  let run = await f.store.approveQuote(
    owner,
    f.run.id,
    q.baseRevision,
    q.id,
    q.fingerprint,
    at + 20,
  );
  const [first, second] = run.attempts,
    lease = (await f.store.claimRun(run.id, at + 21))!;
  await f.store.beginAttempt(lease, first.id, at + 22);
  run = await f.store.recordAdmission(
    lease,
    first.id,
    { status: 502, body: {}, headers: { "Idempotency-Status": "complete" } },
    at + 23,
  );
  expect(run.attempts[0].state).toBe("uncertain");
  await expect(f.quote(run, "image", [0])).rejects.toThrow(
    /Recover the existing/,
  );
  expect(
    (await f.store.beginAttempt(lease, first.id, at + 24))?.requestKey,
  ).toBe(first.requestKey);
  await f.generation("first");
  run = await f.store.recordAdmission(
    lease,
    first.id,
    { status: 200, body: { id: "first" } },
    at + 25,
  );
  await f.store.beginAttempt(lease, second.id, at + 26);
  await f.generation("failed", "failed");
  run = await f.store.recordAdmission(
    lease,
    second.id,
    { status: 502, body: { id: "failed" } },
    at + 27,
  );
  expect(run.attempts.map((a) => [a.state, a.generationId])).toEqual([
    ["succeeded", "first"],
    ["failed", "failed"],
  ]);
  await expect(f.quote(run, "image", [0])).rejects.toThrow(
    /Recover the existing/,
  );
  const retry = await f.quote(run, "image", [1]);
  run = await f.store.approveQuote(
    owner,
    run.id,
    retry.baseRevision,
    retry.id,
    retry.fingerprint,
    at + 40,
  );
  expect(run.attempts.filter((a) => a.unit === 0)).toHaveLength(1);
  expect(run.attempts.filter((a) => a.unit === 1).map((a) => a.number)).toEqual(
    [1, 2],
  );
  expect(run.attempts[2].requestKey).not.toBe(second.requestKey);
});

test("new wakeups arriving while work is leased survive acknowledgement and concurrent claims", async () => {
  const f = await fixture();
  await f.store.scheduleWake(f.run.id, at);
  const claims = await Promise.all([
    f.store.claimWake(at),
    f.store.claimWake(at),
  ]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  const wake = claims.find(Boolean)!;
  await f.store.scheduleWake(f.run.id, at + 1);
  await f.store.acknowledgeWake(wake);
  const newer = (await f.store.claimWake(at + 2))!;
  expect(newer.sequence).toBe(wake.sequence + 1);
  await f.store.acknowledgeWake(wake);
  expect(await f.store.claimWake(at + 3)).toBeNull();
  await f.store.acknowledgeWake(newer);
  expect(await f.store.claimWake(at + 100000)).toBeNull();
});

test("selected takes are exact completed IDs and cannot change after downstream approval", async () => {
  const f = await fixture(true),
    q = await f.quote(f.run);
  let run = await f.store.approveQuote(
    owner,
    f.run.id,
    q.baseRevision,
    q.id,
    q.fingerprint,
    at + 20,
  );
  const lease = (await f.store.claimRun(run.id, at + 21))!;
  for (const attempt of run.attempts) {
    await f.generation("take" + attempt.unit);
    await f.store.beginAttempt(lease, attempt.id, at + 22);
    run = await f.store.recordAdmission(
      lease,
      attempt.id,
      { status: 200, body: { id: "take" + attempt.unit } },
      at + 23,
    );
  }
  await expect(f.store.stageInputs(owner, run.id, "motion")).rejects.toThrow(
    /Select a completed/,
  );
  await expect(
    f.store.select(
      owner,
      run.id,
      run.revision,
      "select",
      { stageId: "image", unit: 0 },
      "take1",
      at + 30,
    ),
  ).rejects.toThrow(/completed candidate/);
  run = await f.store.select(
    owner,
    run.id,
    run.revision,
    "select",
    { stageId: "image", unit: 0 },
    "take0",
    at + 31,
  );
  expect(
    (await f.store.stageInputs(owner, run.id, "motion")).references[0].id,
  ).toBe("take0");
  const motion = await f.quote(run, "motion", [0]);
  run = await f.store.approveQuote(
    owner,
    run.id,
    motion.baseRevision,
    motion.id,
    motion.fingerprint,
    at + 40,
  );
  await expect(
    f.store.select(
      owner,
      run.id,
      run.revision,
      "select",
      { stageId: "image", unit: 1 },
      "take1",
      at + 41,
    ),
  ).rejects.toThrow(/Downstream work/);
});

test("lowercase definitive refusals can be requoted; cancelled jobs keep their ID and become terminal", async () => {
  const f = await fixture(),
    q = await f.quote(f.run);
  let run = await f.store.approveQuote(
    owner,
    f.run.id,
    q.baseRevision,
    q.id,
    q.fingerprint,
    at + 20,
  );
  const lease = (await f.store.claimRun(run.id, at + 21))!;
  run = await f.store.recordAdmission(
    lease,
    run.attempts[0].id,
    {
      status: 402,
      body: { error: "No balance" },
      headers: { "idempotency-status": "complete" },
    },
    at + 22,
  );
  expect(run.attempts[0].state).toBe("refused");
  await f.generation("cancelled", "cancelled");
  run = await f.store.recordAdmission(
    lease,
    run.attempts[1].id,
    { status: 200, body: { id: "cancelled" } },
    at + 23,
  );
  expect(run.attempts[1]).toMatchObject({
    state: "failed",
    generationId: "cancelled",
  });
  expect(
    (await f.quote(run, "image", [0, 1])).units.map((u) => u.number),
  ).toEqual([2, 2]);
});

async function executorModule(f: Awaited<ReturnType<typeof fixture>>) {
  const dependencies = {
    "../generationAdmission": {},
    "../audioAdmission": {},
    "../tenant": { requireTenant: () => ({ id: workspaceId }) },
    "./schema": schema,
    "./store": { ...f.module, pipelineStore: async () => f.store },
    "./actor": {
      withPipelineActor: async (
        _ws: string,
        _owner: string,
        work: (actor: unknown) => Promise<unknown>,
      ) => work({ user: { id: owner } }),
    },
  };
  const output = ts.transpileModule(
    readFileSync(path.resolve("lib/pipeline/executor.ts"), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  const mod = { exports: {} as typeof import("../../lib/pipeline/executor") };
  new Function("require", "module", "exports", output)(
    (name: keyof typeof dependencies) => {
      if (!(name in dependencies)) throw new Error("Unexpected import " + name);
      return dependencies[name];
    },
    mod,
    mod.exports,
  );
  return mod.exports;
}
const actor = {
  user: {
    id: owner,
    email: "pipeline@example.test",
    name: "Owner",
    role: "admin" as const,
    owner: true,
    disabled: false,
    createdAt: 0,
    lastSeen: null,
  },
};

test("a quote for an independent frontier does not suspend another stage's approved attempts", async () => {
  const spec = specification();
  spec.stages.push({ ...spec.stages[0], id: "parallel" });
  const f = await fixture(false, spec),
    executor = await executorModule(f);
  const first = await f.quote(f.run, "image", [0]);
  let run = await f.store.approveQuote(
    owner,
    f.run.id,
    first.baseRevision,
    first.id,
    first.fingerprint,
    at + 20,
  );
  const inputs = await f.store.stageInputs(owner, run.id, "parallel");
  await f.store.quoteStage(
    owner,
    run.id,
    run.revision,
    "parallel",
    inputs.inputHash,
    [{ unit: 0, prepared: f.prepared() }],
  );
  let calls = 0;
  await executor.advancePipelineRun(f.store, run.id, {
    actor,
    defer: () => {},
    image: async () => {
      calls++;
      await f.generation("approved-only");
      return { status: 200, body: { id: "approved-only" } };
    },
  });
  run = await f.store.getRun(owner, run.id);
  expect(calls).toBe(1);
  expect(run.attempts[0]).toMatchObject({
    stageId: "image",
    state: "succeeded",
  });
  expect(run.attempts.some((a) => a.stageId === "parallel")).toBeFalsy();
});

test("a paused tick never creates a missing admission after crashing at the submitting checkpoint", async () => {
  const f = await fixture(),
    executor = await executorModule(f),
    q = await f.quote(f.run, "image", [0]);
  let run = await f.store.approveQuote(
    owner,
    f.run.id,
    q.baseRevision,
    q.id,
    q.fingerprint,
    at + 20,
  );
  const lease = (await f.store.claimRun(run.id))!;
  await f.store.beginAttempt(lease, run.attempts[0].id);
  await f.store.releaseRun(lease);
  run = await f.store.getRun(owner, run.id);
  run = await f.store.setState(owner, run.id, run.revision, "paused");
  let calls = 0;
  const options = {
    actor,
    defer: () => {},
    image: async () => {
      calls++;
      await f.generation("resumed");
      return { status: 200, body: { id: "resumed" } };
    },
  };
  await executor.advancePipelineRun(f.store, run.id, options);
  expect(calls).toBe(0);
  run = await f.store.getRun(owner, run.id);
  expect(run.attempts[0].state).toBe("submitting");
  await f.store.setState(owner, run.id, run.revision, "running");
  await executor.advancePipelineRun(f.store, run.id, options);
  expect(calls).toBe(1);
});

test("pending worker ticks wait for the next due wake; cancellation during admission never starts its sibling", async () => {
  const f = await fixture(),
    executor = await executorModule(f),
    q = await f.quote(f.run);
  let run = await f.store.approveQuote(
    owner,
    f.run.id,
    q.baseRevision,
    q.id,
    q.fingerprint,
    at + 20,
  );
  const wake = (await f.store.claimWake())!;
  let calls = 0;
  await executor.advancePipelineRun(f.store, run.id, {
    actor,
    defer: () => {},
    image: async () => {
      calls++;
      const current = await f.store.getRun(owner, run.id);
      await f.store.setState(owner, run.id, current.revision, "cancelled");
      await f.generation("accepted-before-cancel", "running");
      return { status: 202, body: { id: "accepted-before-cancel" } };
    },
  });
  run = await f.store.getRun(owner, run.id);
  expect(calls).toBe(1);
  expect(run.state).toBe("cancelled");
  expect(run.attempts[0].generationId).toBe("accepted-before-cancel");
  expect(run.attempts[1].state).toBe("queued");
  await f.store.acknowledgeWake(wake);
  expect(await f.store.claimWake()).toBeNull();
});

test("same-key uncertain replay survives a new worker and the persisted poll cannot hot-loop", async () => {
  const f = await fixture(),
    executor = await executorModule(f),
    q = await f.quote(f.run, "image", [0]);
  let run = await f.store.approveQuote(
    owner,
    f.run.id,
    q.baseRevision,
    q.id,
    q.fingerprint,
    at + 20,
  );
  const seen: string[] = [];
  const options = {
    actor,
    defer: () => {},
    image: async (
      _p: schema.PreparedStageAdmission,
      _actor: unknown,
      context: { requestKey: string },
    ) => {
      seen.push(context.requestKey);
      if (seen.length === 1) throw new Error("Lost admission response");
      await f.generation("recovered", "running");
      return { status: 202, body: { id: "recovered" } };
    },
  };
  let wake = (await f.store.claimWake())!;
  await executor.advancePipelineRun(f.store, run.id, options);
  await f.store.acknowledgeWake(wake);
  expect(await f.store.claimWake()).toBeNull();
  run = await f.store.getRun(owner, run.id);
  expect(run.attempts[0].state).toBe("uncertain");
  await f.store.scheduleWake(run.id);
  wake = (await f.store.claimWake())!;
  await executor.advancePipelineRun(f.store, run.id, options);
  await f.store.acknowledgeWake(wake);
  expect(seen).toEqual([
    run.attempts[0].requestKey,
    run.attempts[0].requestKey,
  ]);
  expect(await f.store.claimWake()).toBeNull();
  await f.client.execute(
    "UPDATE generations SET status='succeeded',stored_url='private/recovered' WHERE id='recovered'",
  );
  await executor.advancePipelineRun(f.store, run.id, options);
  expect(seen).toHaveLength(2);
  expect((await f.store.getRun(owner, run.id)).attempts[0].state).toBe(
    "succeeded",
  );
});
