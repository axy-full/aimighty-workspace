import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  sourceDigest,
  parseOptions,
  validateLocalDatabase,
  summarizeSamples,
  runRehearsal,
  paidEntryCoverage,
} from "../../scripts/ops/load-rehearsal.mjs";

test("load rehearsal refuses remote/outside databases and unbounded input", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "load-options-"));
  try {
    assert.equal(
      validateLocalDatabase(
        pathToFileURL(path.join(dir, "local.db")).href,
        dir,
      ),
      path.join(dir, "local.db"),
    );
    for (const value of [
      "libsql://production.invalid",
      "https://production.invalid",
      "file://remote/path.db",
      pathToFileURL(path.join(dir, "..", "existing.db")).href,
    ])
      assert.throws(() => validateLocalDatabase(value, dir));
    for (const args of [
      ["--duration-ms", "0"],
      ["--concurrency", "1000"],
      ["--processes", "8", "--concurrency", "1"],
      ["--url", "https://production.invalid"],
      ["--database-url", "file:existing.db"],
    ])
      assert.throws(() => parseOptions(args));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inherited remote database configuration is refused before starting application children", async () => {
  const previous = process.env.PLATFORM_DATABASE_URL;
  process.env.PLATFORM_DATABASE_URL = "libsql://production.invalid";
  try {
    await assert.rejects(
      runRehearsal({ durationMs: 100, processes: 1, concurrency: 1 }),
      /REMOTE_DATABASE_ENVIRONMENT_REFUSED/,
    );
  } finally {
    if (previous === undefined) delete process.env.PLATFORM_DATABASE_URL;
    else process.env.PLATFORM_DATABASE_URL = previous;
  }
});

test("reported percentiles use nearest rank and preserve empty-sample uncertainty", () => {
  assert.deepEqual(summarizeSamples([]), {
    count: 0,
    p50Ms: null,
    p95Ms: null,
    p99Ms: null,
    maxMs: null,
  });
  assert.deepEqual(summarizeSamples([10, 1, 8, 2, 9, 3, 7, 4, 6, 5]), {
    count: 10,
    p50Ms: 5,
    p95Ms: 10,
    p99Ms: 10,
    maxMs: 10,
  });
});

test("paid-boundary evidence rejects a settled job without an entry, duplicate entries and entries for refused or unreserved jobs", () => {
  const charges = [
    { id: "succeeded", status: "succeeded" },
    { id: "pending", status: "running" },
  ];
  assert.equal(
    paidEntryCoverage(charges, [{ id: "succeeded" }], ["refused"]),
    true,
  );
  assert.equal(paidEntryCoverage(charges, [], []), false);
  assert.equal(
    paidEntryCoverage(charges, [{ id: "succeeded" }, { id: "succeeded" }], []),
    false,
  );
  assert.equal(
    paidEntryCoverage(
      charges,
      [{ id: "succeeded" }, { id: "refused" }],
      ["refused"],
    ),
    false,
  );
  assert.equal(
    paidEntryCoverage(charges, [{ id: "succeeded" }, { id: "unreserved" }], []),
    false,
  );
});

test(
  "real local source-module workload preserves credits, claims, acknowledged drafts and lease ownership",
  { timeout: 120000 },
  async () => {
    const result = await runRehearsal({
      durationMs: 250,
      concurrency: 4,
      processes: 1,
      workspaces: 2,
      activeLimit: 2,
    });
    assert.equal(
      result.ok,
      true,
      JSON.stringify({ errors: result.errors, invariants: result.invariants }),
    );
    assert.equal(result.unexpectedErrors, 0);
    assert.ok(result.measuredOperations > 10);
    assert.ok(result.counters.admitted > 0);
    assert.ok(result.observations.draftAcknowledgments > 0);
    assert.ok(result.counters.budget_expected_admission_402 > 0);
    assert.equal(result.observations.blockedNetworkAttempts, 0);
    assert.ok(
      result.metrics.reserve.count > 0 &&
        result.metrics.reserve.p99Ms >= result.metrics.reserve.p50Ms,
    );
    assert.ok(Object.values(result.invariants).every(Boolean));
    assert.equal(result.fixtureDirectory, undefined);
  },
);


test("source evidence changes when a recovery MJS or runtime CJS module changes", async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),"load-digest-"));
  try{
    await mkdir(path.join(dir,'lib/recovery'),{recursive:true});await mkdir(path.join(dir,'scripts/ops'),{recursive:true});
    for(const file of ['package.json','package-lock.json','scripts/ops/load-rehearsal.mjs','scripts/ops/load-rehearsal-runtime.cjs','lib/client.ts','lib/recovery/control.mjs','lib/runtime.cjs'])await writeFile(path.join(dir,file),'original');
    const before=await sourceDigest(dir);await writeFile(path.join(dir,'lib/recovery/control.mjs'),'changed fence');const after=await sourceDigest(dir);assert.notEqual(before,after);
    await writeFile(path.join(dir,'lib/runtime.cjs'),'changed runtime');assert.notEqual(after,await sourceDigest(dir));
  }finally{await rm(dir,{recursive:true,force:true});}
});
