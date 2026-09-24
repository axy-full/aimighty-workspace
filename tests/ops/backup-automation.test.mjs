import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import {
  ARTIFACT_PREFIX,
  FRESHNESS_MS,
  sourceFingerprint,
  retentionDays,
  assertQuiescence,
  assertNoActiveOrUncertain,
  freshness,
  githubFreshness,
  captureVerified,
} from "../../scripts/ops/backup-automation.mjs";

const at = Date.parse("2026-09-14T02:17:00Z");
const config = { databases: [], label: "fixture", quiesced: true };
const confirmation = (source = config) => ({
  issuedAt: new Date(at - 60_000).toISOString(),
  expiresAt: new Date(at + 60 * 60_000).toISOString(),
  sourceFingerprint: sourceFingerprint(source),
  mutationsPaused: true,
  workersPaused: true,
  uploadsPaused: true,
  provisioningPaused: true,
  purgePaused: true,
});
test("quiescence is fresh, source-bound, and covers every mutating service", () => {
  assertQuiescence(config, confirmation(), at);
  assert.throws(
    () => assertQuiescence(config, confirmation(), at + 3 * 60 * 60_000),
    /fresh/,
  );
  assert.throws(
    () =>
      assertQuiescence({ ...config, label: "different" }, confirmation(), at),
    /exact sources/,
  );
  for (const field of [
    "mutationsPaused",
    "workersPaused",
    "uploadsPaused",
    "provisioningPaused",
    "purgePaused",
  ])
    assert.throws(
      () => assertQuiescence(config, { ...confirmation(), [field]: false }, at),
      /mutating service/,
    );
});
test("every weekly backup is retained for 12 weeks", () => {
  assert.equal(retentionDays(at), 84);
  assert.equal(retentionDays(Date.parse("2026-09-13T02:17:00Z")), 84);
});
test("freshness ignores unrelated, expired, empty and future artifacts; missing/stale backup fails", () => {
  const record = {
    name: ARTIFACT_PREFIX + "fixture",
    created_at: new Date(at - 3600_000).toISOString(),
    expired: false,
    size_in_bytes: 1024,
  };
  assert.equal(freshness([record], at).fresh, true);
  assert.throws(
    () =>
      freshness(
        [
          {
            ...record,
            created_at: new Date(at - FRESHNESS_MS - 1).toISOString(),
          },
        ],
        at,
      ),
    /older/,
  );
  for (const change of [
    { expired: true },
    { size_in_bytes: 0 },
    { name: "browser-evidence" },
    { created_at: new Date(at + 1000).toISOString() },
  ])
    assert.throws(
      () => freshness([{ ...record, ...change }], at),
      /No retained/,
    );
});
test("freshness paginates read-only artifact metadata and refuses API failures", async () => {
  let calls = 0;
  const fetcher = async (url, options) => {
    calls++;
    assert.match(
      url,
      /^https:\/\/api.github.com\/repos\/fixture\/repo\/actions\/artifacts/,
    );
    assert.equal(options.headers.Authorization, "Bearer fixture-token");
    return {
      ok: true,
      json: async () => ({
        artifacts:
          calls === 1
            ? Array.from({ length: 100 }, () => ({ name: "unrelated" }))
            : [
                {
                  name: ARTIFACT_PREFIX + "fixture",
                  created_at: new Date().toISOString(),
                  expired: false,
                  size_in_bytes: 10,
                },
              ],
      }),
    };
  };
  assert.equal(
    (
      await githubFreshness(
        { GITHUB_REPOSITORY: "fixture/repo", GITHUB_TOKEN: "fixture-token" },
        fetcher,
      )
    ).fresh,
    true,
  );
  assert.equal(calls, 2);
  await assert.rejects(
    githubFreshness(
      { GITHUB_REPOSITORY: "fixture/repo", GITHUB_TOKEN: "fixture-token" },
      async () => ({ ok: false }),
    ),
    /Could not read/,
  );
});
test("preflight rejects actual live/uncertain rows without modifying them", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "particl-backup-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const url = pathToFileURL(join(root, "fixture.db")).href,
    db = createClient({ url });
  t.after(() => db.close());
  await db.executeMultiple(`CREATE TABLE generations(status TEXT,params TEXT,cost_usd REAL); CREATE TABLE paid_text_jobs(status TEXT);
    CREATE TABLE meter_events(status TEXT,billed_credits INTEGER); INSERT INTO generations VALUES('held','{}',0);`);
  const source = { databases: [{ url }] };
  await assertNoActiveOrUncertain(source, {});
  for (const status of ["queued", "running", "uncertain"]) {
    await db.execute({
      sql: "INSERT INTO paid_text_jobs VALUES(?)",
      args: [status],
    });
    await assert.rejects(
      assertNoActiveOrUncertain(source, {}),
      /live or uncertain/,
    );
    assert.equal(
      (await db.execute("SELECT COUNT(*) AS n FROM paid_text_jobs")).rows[0].n,
      1,
    );
    await db.execute("DELETE FROM paid_text_jobs");
  }
  await db.execute(
    `INSERT INTO generations VALUES('failed','{"paidClaim":"permanent"}',1.88)`,
  );
  await assert.rejects(
    assertNoActiveOrUncertain(source, {}),
    /live or uncertain/,
  );
  await db.execute("DELETE FROM generations WHERE status='failed'");
  await db.execute("INSERT INTO meter_events VALUES('failed',29)");
  await assert.rejects(
    assertNoActiveOrUncertain(source, {}),
    /live or uncertain/,
  );
  await db.execute("DELETE FROM meter_events");
  await assertNoActiveOrUncertain(source, {});
  await db.executeMultiple(
    "CREATE TABLE astra_render_jobs(status TEXT,settled INTEGER); INSERT INTO astra_render_jobs VALUES('completed',0);",
  );
  await assert.rejects(
    assertNoActiveOrUncertain(source, {}),
    /live or uncertain/,
  );
  await db.execute("UPDATE astra_render_jobs SET settled=1");
  await assertNoActiveOrUncertain(source, {});
});
test("capture publishes only after full restore and removes plaintext verification", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "particl-backup-publish-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let checks = 0;
  const result = await captureVerified(config, join(root, "capture"), {
    env: {},
    verifyFence: async () => true,
    quiescence: confirmation(),
    now: () => at,
    preflight: async () => {
      checks++;
    },
    capture: async (_, bundle) => {
      await mkdir(bundle);
      await writeFile(join(bundle, "fixture.enc"), "ciphertext");
      return { databases: 1 };
    },
    restore: async (_, folder) => {
      await mkdir(folder);
      await writeFile(join(folder, "recovery-secrets.json"), "fixture-key");
      return { verified: true, databases: 1, media: 0 };
    },
  });
  assert.equal(checks, 2);
  assert.equal(
    await readFile(join(result.bundle, "fixture.enc"), "utf8"),
    "ciphertext",
  );
  await assert.rejects(stat(join(root, "capture/verification")), {
    code: "ENOENT",
  });
});
test("late uncertain work, expired fence or failed restore removes the unpublished archive", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "particl-backup-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const mode of ["late-work", "expired", "corrupt"]) {
    let checks = 0,
      clock = at;
    const destination = join(root, mode);
    await assert.rejects(
      captureVerified(config, destination, {
        env: {},
        verifyFence: async () => true,
        quiescence: confirmation(),
        now: () => clock,
        preflight: async () => {
          if (++checks === 2 && mode === "late-work")
            throw new Error("live work appeared");
        },
        capture: async (_, bundle) => {
          await mkdir(bundle);
          await writeFile(join(bundle, "fixture.enc"), "ciphertext");
          if (mode === "expired") clock += 3 * 60 * 60_000;
          return {};
        },
        restore: async () => {
          throw new Error("restore integrity failure");
        },
      }),
    );
    await assert.rejects(stat(destination), { code: "ENOENT" });
  }
});

test("development admission, uncertain BYOK phases and unsettled terminal costs block backup without rewriting claims", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "particl-development-backup-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const url = pathToFileURL(join(root, "fixture.db")).href, db = createClient({ url });
  t.after(() => db.close());
  await db.executeMultiple(`CREATE TABLE workbench_development_jobs(id TEXT,status TEXT,settled INTEGER);
    CREATE TABLE workbench_development_steps(job_id TEXT,step_index INTEGER,status TEXT,response TEXT);`);
  const source = { databases: [{ url }] };
  for (const status of ["queued", "running", "uncertain"]) {
    await db.execute({ sql: "INSERT INTO workbench_development_jobs VALUES('development',?,1)", args: [status] });
    await assert.rejects(assertNoActiveOrUncertain(source, {}), /live or uncertain/);
    assert.equal((await db.execute("SELECT status FROM workbench_development_jobs")).rows[0].status, status);
    await db.execute("DELETE FROM workbench_development_jobs");
  }
  for (const status of ["succeeded", "failed"]) {
    await db.execute({ sql: "INSERT INTO workbench_development_jobs VALUES('development',?,0)", args: [status] });
    await assert.rejects(assertNoActiveOrUncertain(source, {}), /live or uncertain/);
    await db.execute("UPDATE workbench_development_jobs SET settled=1");
    await assertNoActiveOrUncertain(source, {});
    await db.execute("DELETE FROM workbench_development_jobs");
  }
  // A parent/child discrepancy must not hide an already-started provider call.
  await db.execute("INSERT INTO workbench_development_jobs VALUES('development','failed',1)");
  for (const status of ["running", "uncertain"]) {
    await db.execute({ sql: "INSERT INTO workbench_development_steps VALUES('development',0,?,'saved paid reply')", args: [status] });
    await assert.rejects(assertNoActiveOrUncertain(source, {}), /live or uncertain/);
    assert.equal((await db.execute("SELECT response FROM workbench_development_steps")).rows[0].response, "saved paid reply");
    await db.execute("DELETE FROM workbench_development_steps");
  }
  await db.execute("INSERT INTO workbench_development_steps VALUES('development',1,'queued',NULL)");
  await assertNoActiveOrUncertain(source, {});
});
