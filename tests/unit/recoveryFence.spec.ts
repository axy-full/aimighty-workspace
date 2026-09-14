import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPlatformDatabaseClient } from "../../lib/localDatabaseClient";
import {
  RecoveryFence,
  RECOVERY_PROTOCOL,
} from "../../lib/recovery/control.mjs";
import { RecoveryDatabaseClient } from "../../lib/recoveryDatabaseClient";
import {
  recoveryFence,
  withRecoveryActivity,
  withRecoveryJob,
  recoveryRoute,
  acceptRecoveryJobTx,
  resolveRecoveryJobTx,
  recoveryFetch,
} from "../../lib/recovery";

const owner = "fixture-coordinator-01234567890123456789";
const preconditions = {
  deployments: [{ id: "local", protocol: RECOVERY_PROTOCOL }],
  oldDeploymentsStopped: true,
  externalWritersExcluded: true,
  evidence:
    "Disposable local fixture; only the test process has these credentials.",
};
const hash = "a".repeat(64),
  inventory = "b".repeat(64);
let directory: string;
let previous: string | undefined;
test.beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "particl-fence-"));
  previous = process.env.PLATFORM_DATABASE_URL;
  process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
});
test.afterEach(async () => {
  if (previous === undefined) delete process.env.PLATFORM_DATABASE_URL;
  else process.env.PLATFORM_DATABASE_URL = previous;
  await rm(directory, { recursive: true, force: true });
});
const raw = () =>
  createPlatformDatabaseClient({ url: process.env.PLATFORM_DATABASE_URL! });

test("atomic close rejects new writes while an admitted transaction drains", async () => {
  const client = new RecoveryDatabaseClient(raw());
  await client.execute("CREATE TABLE records(id TEXT PRIMARY KEY)");
  const tx = await client.transaction("write");
  await tx.execute("INSERT INTO records VALUES('before')");
  const close = recoveryFence().begin(owner, preconditions);
  // Control admission queued before a second application transaction can start.
  const second = client.execute("INSERT INTO records VALUES('after')");
  await tx.commit();
  tx.close();
  const lease = await close;
  await expect(second).rejects.toThrow(/paused/);
  expect(
    (await raw().execute("SELECT id FROM records")).rows.map((r) => r.id),
  ).toEqual(["before"]);
  const receipt = await recoveryFence().seal(
    owner,
    lease.epoch,
    hash,
    inventory,
  );
  expect(await recoveryFence().verify(receipt, hash)).toBe(true);
});
test("parent completion cannot hide an independently admitted child", async () => {
  const fence = recoveryFence();
  const parent = await fence.admit({ kind: "request" });
  const child = await fence.admit({ kind: "storage", parentId: parent });
  const lease = await fence.begin(owner, preconditions);
  await fence.finish(parent);
  await expect(fence.seal(owner, lease.epoch, hash, inventory)).rejects.toThrow(
    /remain/,
  );
  await fence.finish(child);
  await fence.seal(owner, lease.epoch, hash, inventory);
});
test("coordinator expiry and uncertain or crashed operations never become quiescence", async () => {
  let at = 1000;
  const fence = new RecoveryFence(raw(), "local", () => at);
  const id = await fence.admit({ kind: "external-mutation" });
  await fence.finish(id, true);
  const lease = await fence.begin(owner, preconditions, 100);
  at = 1000000;
  expect((await fence.status()).state).toBe("draining");
  await expect(fence.admit({ kind: "new" })).rejects.toThrow(/paused/);
  await fence.renew(owner, lease.epoch);
  await expect(fence.seal(owner, lease.epoch, hash, inventory)).rejects.toThrow(
    /remain/,
  );
  expect((await fence.status()).activities[0].state).toBe("uncertain");
});
test("accepted job resumes exact identity while fresh jobs and held releases cannot reserve", async () => {
  const client = new RecoveryDatabaseClient(raw());
  const tx = await client.transaction("write");
  await acceptRecoveryJobTx(tx, "ws_one", "job_one", "video");
  await tx.commit();
  tx.close();
  const lease = await recoveryFence().begin(owner, preconditions);
  let executed = false;
  await withRecoveryJob("ws_one", "job_one", async () => {
    await expect(
      withRecoveryJob("ws_two", "job_one", async () => {}),
    ).rejects.toThrow(/paused/);
    await expect(
      withRecoveryJob("ws_one", "job_two", async () => {}),
    ).rejects.toThrow(/paused/);
    const inner = await client.transaction("write");
    await expect(
      acceptRecoveryJobTx(inner, "ws_one", "job_two", "video"),
    ).rejects.toThrow(/paused/);
    await inner.rollback();
    inner.close();
    executed = true;
  });
  expect(executed).toBe(true);
  await expect(
    withRecoveryJob("ws_two", "job_one", async () => {}),
  ).rejects.toThrow(/paused/);
  await expect(
    withRecoveryJob("ws_one", "job_two", async () => {}),
  ).rejects.toThrow(/paused/);
  await expect(
    recoveryFence().seal(owner, lease.epoch, hash, inventory),
  ).rejects.toThrow(/remain/);
  await withRecoveryJob("ws_one", "job_one", async () => {
    const done = await client.transaction("write");
    await resolveRecoveryJobTx(done, "ws_one", "job_one");
    await done.commit();
    done.close();
    // Settled jobs may finish nested storage/receipt work under the same live
    // job admission, even though their durable intent is already resolved.
    await withRecoveryActivity("settlement", () =>
      withRecoveryJob("ws_one", "job_one", async () => {}),
    );
  });
  await recoveryFence().seal(owner, lease.epoch, hash, inventory);
  await expect(
    withRecoveryJob("ws_one", "job_one", async () => {}),
  ).rejects.toThrow(/paused/);
});
test("released request context does not authorize a deferred write during drain", async () => {
  let later!: () => Promise<void>;
  await withRecoveryActivity("request", async () => {
    later = () => withRecoveryActivity("after", async () => {});
  });
  await recoveryFence().begin(owner, preconditions);
  await expect(later()).rejects.toThrow(/paused/);
});
test("route refuses before handler/auth mutation; reopening invalidates receipt", async () => {
  const fence = recoveryFence();
  const lease = await fence.begin(owner, preconditions);
  let called = 0;
  const route = recoveryRoute(async () => {
    called++;
    return Response.json({ ok: true });
  });
  expect((await route()).status).toBe(503);
  expect(called).toBe(0);
  const receipt = await fence.seal(owner, lease.epoch, hash, inventory);
  await fence.reopen(owner, lease.epoch);
  await expect(fence.verify(receipt, hash)).rejects.toThrow(
    /fresh live closed/,
  );
  expect((await route()).status).toBe(200);
  expect(called).toBe(1);
});
test("local statement rejection rolls back and releases admission without replay", async () => {
  const client = new RecoveryDatabaseClient(raw());
  await client.execute("CREATE TABLE unique_rows(id INTEGER PRIMARY KEY)");
  await client.execute("INSERT INTO unique_rows VALUES(1)");
  await expect(
    client.execute("INSERT INTO unique_rows VALUES(1)"),
  ).rejects.toThrow();
  expect((await recoveryFence().status()).activities).toHaveLength(0);
  expect(
    (await raw().execute("SELECT COUNT(*) AS n FROM unique_rows")).rows[0].n,
  ).toBe(1);
});
test("external transport ambiguity is retained without automatically replaying a mutation", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new TypeError("fixture connection lost");
  };
  try {
    await expect(
      recoveryFetch("https://fixture.invalid/api", { method: "POST" }),
    ).rejects.toThrow("fixture connection lost");
  } finally {
    globalThis.fetch = original;
  }
  expect(calls).toBe(1);
  expect(
    (await recoveryFence().status()).activities.map(
      (r: { state: string }) => r.state,
    ),
  ).toEqual(["uncertain"]);
});
test("a reserved after-response callback blocks closure before it starts and may drain later", async () => {
  const { reserveRecoveryContinuation } = await import("../../lib/recovery");
  let later!: () => Promise<void>,
    called = 0;
  await withRecoveryActivity("request", async () => {
    later = await reserveRecoveryContinuation("after-response", async () => {
      called++;
      await withRecoveryActivity("storage", async () => {});
    });
  });
  const lease = await recoveryFence().begin(owner, preconditions);
  await expect(
    recoveryFence().seal(owner, lease.epoch, hash, inventory),
  ).rejects.toThrow(/remain/);
  await later();
  expect(called).toBe(1);
  await recoveryFence().seal(owner, lease.epoch, hash, inventory);
});
test("provider work already admitted drains, while direct provisioning and purge stay refused", async () => {
  const original = globalThis.fetch;
  let release!: (response: Response) => void,
    entered!: () => void,
    calls = 0;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  globalThis.fetch = async () => {
    calls++;
    entered();
    return new Promise<Response>((r) => {
      release = r;
    });
  };
  try {
    const paid = withRecoveryActivity("request", () =>
      recoveryFetch("https://fixture.invalid", { method: "POST" }),
    );
    await started;
    const lease = await recoveryFence().begin(owner, preconditions);
    await expect(
      recoveryFence().seal(owner, lease.epoch, hash, inventory),
    ).rejects.toThrow(/remain/);
    const { provisionTenantDatabase } = await import("../../lib/provision");
    await expect(provisionTenantDatabase("must-not-create")).rejects.toThrow(
      /paused/,
    );
    const { purgeWorkspace } = await import("../../lib/purge");
    await expect(
      purgeWorkspace({ id: "must-not-delete" } as Parameters<
        typeof purgeWorkspace
      >[0]),
    ).rejects.toThrow(/paused/);
    expect(calls).toBe(1);
    release(new Response("{}", { status: 200 }));
    await paid;
    await recoveryFence().seal(owner, lease.epoch, hash, inventory);
  } finally {
    globalThis.fetch = original;
  }
});

test("maintenance errors from another route module use the stable refusal code", async () => {
  const route = recoveryRoute(async () => {
    throw Object.assign(new Error("other module copy"), {
      code: "RECOVERY_FENCED",
    });
  });
  const response = await route();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: expect.stringContaining("paused"),
  });
});

test("acknowledged remote SQL rejection releases admission; lost transport remains uncertain without retries", async () => {
  let calls = 0;
  const fake = {
    protocol: "https",
    closed: false,
    execute: async () => {
      calls++;
      throw Object.assign(new Error("constraint rejected"), {
        code: "SQLITE_CONSTRAINT",
      });
    },
  } as unknown as import("@libsql/client").Client;
  const client = new RecoveryDatabaseClient(fake);
  await expect(client.execute("INSERT INTO fixture VALUES(1)")).rejects.toThrow(
    "constraint rejected",
  );
  expect(calls).toBe(1);
  expect((await recoveryFence().status()).activities).toHaveLength(0);
  fake.execute = async () => {
    calls++;
    throw new TypeError("network lost");
  };
  await expect(client.execute("INSERT INTO fixture VALUES(1)")).rejects.toThrow(
    "network lost",
  );
  expect(calls).toBe(2);
  expect((await recoveryFence().status()).activities[0].state).toBe(
    "uncertain",
  );
});

test("bounded drain attempts rotate past unresolved intents", async () => {
  const fence = recoveryFence(),
    client = new RecoveryDatabaseClient(raw());
  const tx = await client.transaction("write");
  for (const id of ["a", "b", "c", "d"])
    await acceptRecoveryJobTx(tx, "workspace", id, "text");
  await tx.commit();
  tx.close();
  await fence.begin(owner, preconditions);
  expect(
    (await fence.takeDrainIntents(2)).map((row: { id: string }) => row.id),
  ).toEqual(["a", "b"]);
  expect(
    (await fence.takeDrainIntents(2)).map((row: { id: string }) => row.id),
  ).toEqual(["c", "d"]);
});

test("remote transaction close without an acknowledged commit or rollback stays uncertain", async () => {
  let closed = false;
  const native = {
    protocol: "https",
    transaction: async () => ({
      execute: async () => ({}),
      close: () => {
        closed = true;
      },
      get closed() {
        return closed;
      },
    }),
  } as unknown as import("@libsql/client").Client;
  const client = new RecoveryDatabaseClient(native);
  const tx = await client.transaction("write");
  await tx.execute("INSERT INTO fixture VALUES(1)");
  tx.close();
  expect(closed).toBe(true);
  await expect
    .poll(async () =>
      (await recoveryFence().status()).activities.map(
        (row: { state: string }) => row.state,
      ),
    )
    .toEqual(["uncertain"]);
  const lease = await recoveryFence().begin(owner, preconditions);
  await expect(
    recoveryFence().seal(owner, lease.epoch, hash, inventory),
  ).rejects.toThrow(/remain/);
});

for (const rejected of [false, true])
  test(
    rejected
      ? "a late ambiguous queue rejection stays uncertain after fallback settles its job"
      : "a timed-out queue send stays admitted after fallback settles its job",
    async () => {
      const { dispatchRender } = await import("../../lib/renderDispatch");
      const { runInTenant } = await import("../../lib/tenant");
      const { db, ready } = await import("../../lib/db");
      const workspace = {
        id: "ws_queue",
        dbUrl: `file:${path.join(directory, "tenant.db")}`,
        legacy: false,
        keys: {},
        usesPlatformKeys: false,
      } as import("../../lib/tenant").TenantWorkspace;
      await runInTenant(workspace, async () => {
        await ready();
        await db().execute(
          "INSERT INTO generations(id,kind,provider,model,prompt,params,status,created_at,updated_at) VALUES('queue-job','image','google','fixture','fixture','{}','running',0,0)",
        );
        const fence = recoveryFence();
        await fence.tx((tx: import("@libsql/client").Transaction) =>
          fence.acceptJobTx(tx, workspace.id, "queue-job", "image"),
        );
        let finishSend!: () => void;
        const pending = new Promise<void>((resolve, reject) => {
          finishSend = rejected
            ? () => reject(new Error("fixture acknowledgment lost"))
            : resolve;
        });
        expect(
          await dispatchRender("queue-job", "image", () => pending, 10),
        ).toBe(false);
        const lease = await fence.begin(owner, preconditions);
        await withRecoveryJob(workspace.id, "queue-job", async () => {
          // Model a successfully persisted fallback outcome and its acknowledged
          // ledger receipt without calling a provider or putting actual media.
          await db().execute(
            "UPDATE generations SET status='succeeded',params='{\"paidClaim\":\"permanent\"}' WHERE id='queue-job'",
          );
          await fence.tx((tx: import("@libsql/client").Transaction) =>
            fence.resolveJobTx(tx, workspace.id, "queue-job"),
          );
        });
        expect((await fence.status()).intents).toHaveLength(0);
        expect(
          (await fence.status()).activities.map(
            (row: { kind: string }) => row.kind,
          ),
        ).toEqual(["queue-send"]);
        await expect(
          fence.seal(owner, lease.epoch, hash, inventory),
        ).rejects.toThrow(/remain/);
        finishSend();
        if (rejected) {
          await expect
            .poll(async () =>
              (await fence.status()).activities.map(
                (row: { state: string }) => row.state,
              ),
            )
            .toEqual(["uncertain"]);
          await expect(
            fence.seal(owner, lease.epoch, hash, inventory),
          ).rejects.toThrow(/remain/);
        } else {
          await expect
            .poll(async () => (await fence.status()).activities.length)
            .toBe(0);
          await fence.seal(owner, lease.epoch, hash, inventory);
        }
      });
    },
  );
