import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace, TenantUser } from "../../lib/tenant";
import type {
  CreateSoulIdentityInput,
  SoulIdentity,
} from "../../lib/soulIdentities";

const directory = mkdtempSync(path.join(tmpdir(), "particl-soul-identities-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(directory, "primary.db")}`;
process.env.KEYRING_SECRET = "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
const providerId = "31a51537-0563-4bcf-bc5a-f99f2979759f";
const user: TenantUser = {
  id: "alice",
  email: "alice@example.test",
  name: "Alice",
  role: "admin",
  owner: true,
  disabled: false,
  lastSeen: null,
  createdAt: 0,
};
function workspace(name: string): TenantWorkspace {
  return {
    id: `ws_${name}`,
    slug: name,
    name,
    legacy: false,
    dbUrl: `file:${path.join(directory, `${name}.db`)}`,
    dbToken: null,
    keys: {},
    usesPlatformKeys: true,
    allowanceUsd: null,
    gatewayKeyId: null,
    ownerId: user.id,
    createdAt: 0,
    suspendedAt: null,
    suspendedReason: null,
    flaggedAt: null,
    flagNote: null,
    concurrency: 10,
    rendersPerHour: 100,
    storageQuotaBytes: null,
    deletedAt: null,
  };
}
async function scope<T>(
  name: string,
  run: (
    ws: TenantWorkspace,
    projectId: string,
    productionId: string,
  ) => Promise<T>,
  credits = 1000,
): Promise<T> {
  const { platformReady, platformDb } = await import("../../lib/platform");
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { saveDraft } = await import("../../lib/workbench/records");
  const { newProject } = await import("../../lib/workbench/studio");
  const ws = workspace(name);
  await platformReady();
  await platformDb().execute({
    sql: "INSERT INTO credit_grants(id,workspace_id,credits,kind,created_at) VALUES(?,?,?,'manual',0)",
    args: [`grant_${name}`, ws.id, credits],
  });
  return runInTenant(
    ws,
    async () => {
      await ready();
      await db().execute(
        "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,created_at) VALUES('source','Face','image/png','png',100,'hash','/api/uploads/source',0)",
      );
      const project = newProject("Identity production");
      const saved = await saveDraft(user.id, project, 0);
      return run(ws, project.id, saved.productionProjectId);
    },
    { user },
  );
}
const input = (projectId: string): CreateSoulIdentityInput => ({
  projectId,
  name: "One character",
  description: "A fictional character",
  subjectType: "character",
  references: [{ uploadId: "source" }],
  consent: true,
  maxCredits: 38,
});
async function submit(
  value: CreateSoulIdentityInput,
  key: string,
  deps: Parameters<
    typeof import("../../lib/soulIdentities").createSoulIdentity
  >[2] = {},
) {
  const {
    withGenerationRequestData,
    generationFingerprint,
    SpendReservationError,
  } = await import("../../lib/generationRequests");
  const { createSoulIdentity, SoulIdentityError } =
    await import("../../lib/soulIdentities");
  return withGenerationRequestData(
    { userId: user.id, key, fingerprint: generationFingerprint(value) },
    async (claim) => {
      try {
        return Response.json(
          { identity: await createSoulIdentity(value, claim, deps) },
          { status: 202 },
        );
      } catch (error) {
        if (
          error instanceof SpendReservationError ||
          error instanceof SoulIdentityError
        )
          return Response.json(
            { error: error.message },
            { status: error.status },
          );
        throw error;
      }
    },
  );
}
const read = async (response: Response): Promise<SoulIdentity> =>
  (await response.json()).identity;
async function meterFor(id: string) {
  const { platformDb } = await import("../../lib/platform");
  return (
    await platformDb().execute({
      sql: "SELECT * FROM meter_events WHERE id=?",
      args: [id],
    })
  ).rows[0];
}

test("training reserves once before submission, concurrent request replay recovers the same immutable identity, and completion settles once", async () =>
  scope("once", async (_ws, project, production) => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0,
      identityId = "";
    const deps = {
      submit: async () => {
        calls++;
        const { db } = await import("../../lib/db");
        identityId = String(
          (await db().execute("SELECT id FROM soul_identities")).rows[0].id,
        );
        expect((await meterFor(identityId)).status).toBe("running");
        await wait;
        return { id: providerId, status: "queued" as const };
      },
    };
    const first = submit(input(project), "same-request-key", deps);
    await expect.poll(() => calls).toBe(1);
    const replay = await submit(input(project), "same-request-key", deps);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect((await read(replay)).id).toBe(identityId);
    release();
    expect((await read(await first)).status).toBe("training");
    const { syncSoulIdentity, requireReadySoulIdentity } =
      await import("../../lib/soulIdentities");
    await expect(
      requireReadySoulIdentity(identityId, production, project),
    ).rejects.toThrow(/not ready/);
    const completed = await syncSoulIdentity(identityId, {
      poll: async () => ({ id: providerId, status: "completed" }),
    });
    expect(completed?.status).toBe("ready");
    expect(completed?.creditsBilled).toBe(38);
    expect(
      (await requireReadySoulIdentity(identityId, production, project))
        .providerReferenceId,
    ).toBe(providerId);
    await syncSoulIdentity(identityId, {
      poll: async () => {
        throw new Error("must not repoll terminal");
      },
    });
    expect(Number((await meterFor(identityId)).billed_credits)).toBe(38);
    expect(calls).toBe(1);
    const serialized = JSON.stringify(completed);
    expect(serialized).not.toMatch(
      /provider_reference|credential|cost_usd|31a51537/,
    );
    expect(
      (
        await submit(
          { ...input(project), name: "Different" },
          "same-request-key",
          deps,
        )
      ).status,
    ).toBe(409);
  }));

test("ambiguous POST keeps its reservation and never retries after a replay or status refresh", async () =>
  scope("ambiguous", async (_ws, project) => {
    let calls = 0;
    const deps = {
      submit: async () => {
        calls++;
        throw new Error("transport disconnected after acceptance");
      },
    };
    const identity = await read(
      await submit(input(project), "ambiguous-key", deps),
    );
    expect(identity.status).toBe("uncertain");
    const { syncSoulIdentity, purgeSoulIdentities } =
      await import("../../lib/soulIdentities");
    await submit(input(project), "ambiguous-key", deps);
    await syncSoulIdentity(identity.id);
    expect(calls).toBe(1);
    expect(Number((await meterFor(identity.id)).engine_cost_usd)).toBe(2.5);
    expect((await meterFor(identity.id)).status).toBe("running");
    await expect(purgeSoulIdentities()).rejects.toThrow(/reconciled/);
  }));

test("a definitive rejected POST refunds only this unsent training and never submits twice", async () =>
  scope("rejected", async (_ws, project) => {
    const { HiggsfieldHttpError } = await import("../../lib/higgsfield");
    let calls = 0;
    const deps = {
      submit: async () => {
        calls++;
        throw new HiggsfieldHttpError(422);
      },
    };
    const identity = await read(
      await submit(input(project), "rejected-key", deps),
    );
    expect(identity.status).toBe("failed");
    await submit(input(project), "rejected-key", deps);
    expect(Number((await meterFor(identity.id)).billed_credits)).toBe(0);
    expect(calls).toBe(1);
  }));

test("an accepted failed training retains its documented per-request charge and resolves its known-terminal recovery intent", async () =>
  scope("failed", async (ws, project) => {
    const identity = await read(
      await submit(input(project), "accepted-failed", {
        submit: async () => ({ id: providerId, status: "failed" }),
      }),
    );
    expect(identity.status).toBe("failed");
    expect(identity.creditsBilled).toBe(38);
    const { platformDb } = await import("../../lib/platform");
    expect(
      (
        await platformDb().execute({
          sql: "SELECT state FROM recovery_intents WHERE workspace_id=? AND id=?",
          args: [ws.id, identity.id],
        })
      ).rows[0].state,
    ).toBe("resolved");
  }));

test("a persisted platform receipt recovers a known handle after tenant outcome writes fail, without another paid request", async () =>
  scope("receipt", async (_ws, project) => {
    const { db } = await import("../../lib/db");
    const { syncSoulIdentity } = await import("../../lib/soulIdentities");
    let calls = 0;
    const identity = await read(
      await submit(input(project), "receipt-key", {
        submit: async () => {
          calls++;
          await db().execute(
            "CREATE TRIGGER deny_soul_outcome BEFORE UPDATE OF provider_reference_id ON soul_identities BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END",
          );
          return { id: providerId, status: "completed" };
        },
      }),
    );
    expect(identity.status).toBe("submitting");
    await db().execute("DROP TRIGGER deny_soul_outcome");
    const recovered = await syncSoulIdentity(identity.id, {
      poll: async () => {
        throw new Error("receipt already terminal");
      },
    });
    expect(recovered?.status).toBe("ready");
    expect(calls).toBe(1);
    expect(recovered?.creditsBilled).toBe(38);
  }));

test("empty funding and changed quote reject before provider work", async () =>
  scope(
    "empty",
    async (_ws, project) => {
      let calls = 0;
      const deps = {
        submit: async () => {
          calls++;
          return { id: providerId, status: "queued" as const };
        },
      };
      expect((await submit(input(project), "unfunded-key", deps)).status).toBe(
        402,
      );
      expect(
        (
          await submit(
            { ...input(project), maxCredits: 37 },
            "bad-price-key",
            deps,
          )
        ).status,
      ).toBe(409);
      expect(calls).toBe(0);
      const { db } = await import("../../lib/db");
      expect(
        (await db().execute("SELECT * FROM soul_identities")).rows,
      ).toHaveLength(1);
    },
    0,
  ));

test("cross-tenant IDs, private draft IDs, foreign generation projects and arbitrary URLs cannot become training references", async () =>
  scope("sources", async (_ws, project) => {
    const { db } = await import("../../lib/db");
    const { createSoulIdentity } = await import("../../lib/soulIdentities");
    const claim = { userId: user.id, key: "not-admitted-key" };
    const deps = {
      submit: async () => {
        throw new Error("must not submit");
      },
    };
    await expect(
      createSoulIdentity(
        { ...input(project), projectId: "foreign-draft" },
        claim,
        deps,
      ),
    ).rejects.toThrow(/Save this production/);
    await expect(
      createSoulIdentity(
        { ...input(project), references: [{ uploadId: "foreign-upload" }] },
        claim,
        deps,
      ),
    ).rejects.toThrow(/no longer available/);
    await expect(
      createSoulIdentity(
        {
          ...input(project),
          references: [{ image_url: "https://evil.invalid/face" }] as never,
        },
        claim,
        deps,
      ),
    ).rejects.toThrow(/existing still/);
    await db().execute(
      "INSERT INTO generations(id,model,prompt,params,status,kind,stored_url,created_at,updated_at) VALUES('foreign-gen','test','prompt','{}','succeeded','image','/api/media/foreign-gen',0,0)",
    );
    await expect(
      createSoulIdentity(
        { ...input(project), references: [{ genId: "foreign-gen" }] },
        claim,
        deps,
      ),
    ).rejects.toThrow(/from this production/);
    expect(
      (await db().execute("SELECT * FROM soul_identities")).rows,
    ).toHaveLength(0);
  }));

test("ready identity bindings require the original provider account and exact authorized production mapping", async () =>
  scope("bindings", async (_ws, project, production) => {
    const identity = await read(
      await submit(input(project), "binding-key", {
        submit: async () => ({ id: providerId, status: "completed" }),
      }),
    );
    const { requireReadySoulIdentity, getSoulIdentity } =
      await import("../../lib/soulIdentities");
    await expect(
      requireReadySoulIdentity(identity.id, "wrong-production", project),
    ).rejects.toThrow(/mapping/);
    const { runInTenant } = await import("../../lib/tenant");
    await runInTenant(
      workspace("other"),
      async () => {
        expect(await getSoulIdentity(identity.id)).toBeNull();
      },
      { user },
    );
    process.env.ENGINE_MOCK = "0";
    process.env.HF_CREDENTIALS = "other-key:other-secret";
    try {
      await expect(
        requireReadySoulIdentity(identity.id, production, project),
      ).rejects.toThrow(/different Higgsfield account/);
    } finally {
      process.env.ENGINE_MOCK = "1";
      delete process.env.HF_CREDENTIALS;
    }
  }));

test("status refresh is leased across concurrent readers and terminal identity handles remain immutable", async () =>
  scope("polling", async (_ws, project) => {
    const identity = await read(
      await submit(input(project), "polling-key", {
        submit: async () => ({ id: providerId, status: "queued" }),
      }),
    );
    const { syncSoulIdentity } = await import("../../lib/soulIdentities");
    let calls = 0;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        syncSoulIdentity(identity.id, {
          poll: async () => {
            calls++;
            return { id: providerId, status: "completed" };
          },
        }),
      ),
    );
    expect(calls).toBe(1);
    expect((await syncSoulIdentity(identity.id))?.status).toBe("ready");
  }));

test("new unsaved draft can read empty identities and terms, but a paid request needs a saved production", async () =>
  scope("unsaved", async () => {
    const { listSoulIdentities, soulIdentityTerms } =
      await import("../../lib/soulIdentities");
    expect(await listSoulIdentities("new-unsaved-draft")).toEqual([]);
    expect(soulIdentityTerms().trainingCredits).toBe(38);
    expect(
      (await submit(input("new-unsaved-draft"), "new-draft-key")).status,
    ).toBe(404);
  }));

test("concurrent different trainings share the atomic all-job concurrency reservation", async () =>
  scope("slots", async (ws, project) => {
    ws.concurrency = 1;
    let calls = 0;
    const deps = {
      submit: async () => {
        calls++;
        return { id: providerId, status: "queued" as const };
      },
    };
    const responses = await Promise.all([
      submit(input(project), "slot-request-one", deps),
      submit(input(project), "slot-request-two", deps),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      202, 409,
    ]);
    expect(calls).toBe(1);
  }));

test("expired pre-submission crash releases a reservation; paid claims never expire into another POST", async () =>
  scope("preclaim", async (_ws, project) => {
    const { db } = await import("../../lib/db");
    const identity = await read(
      await submit(input(project), "preclaim-key", {
        submit: async () => {
          throw new Error("unknown");
        },
      }),
    );
    await db().execute({
      sql: "UPDATE soul_identities SET paid_claim=NULL,status='submitting',created_at=0 WHERE id=?",
      args: [identity.id],
    });
    const { syncSoulIdentity } = await import("../../lib/soulIdentities");
    expect((await syncSoulIdentity(identity.id))?.status).toBe("failed");
    expect(Number((await meterFor(identity.id)).billed_credits)).toBe(0);
  }));

test("successful provider completion stays unavailable until a failed meter settlement is recovered", async () =>
  scope("settlement", async (_ws, project, production) => {
    const { platformDb } = await import("../../lib/platform");
    const { syncSoulIdentity, requireReadySoulIdentity } =
      await import("../../lib/soulIdentities");
    const identity = await read(
      await submit(input(project), "settlement-key", {
        submit: async () => {
          await platformDb().execute(
            "CREATE TRIGGER deny_soul_meter BEFORE UPDATE ON meter_events WHEN NEW.status='succeeded' BEGIN SELECT RAISE(ABORT,'fixture settlement failure'); END",
          );
          return { id: providerId, status: "completed" };
        },
      }),
    );
    expect(identity.status).toBe("training");
    await expect(
      requireReadySoulIdentity(identity.id, production, project),
    ).rejects.toThrow(/not ready/);
    await platformDb().execute("DROP TRIGGER deny_soul_meter");
    const recovered = await syncSoulIdentity(identity.id);
    expect(recovered?.status).toBe("ready");
    expect(recovered?.creditsBilled).toBe(38);
    const receipt = (
      await platformDb().execute({
        sql: "SELECT settled_at FROM soul_training_receipts WHERE id=?",
        args: [identity.id],
      })
    ).rows[0];
    expect(receipt.settled_at).not.toBeNull();
  }));

test("whole workspace purge removes acknowledged remote handles and their platform recovery receipts", async () =>
  scope("purge", async (_ws, project) => {
    const identity = await read(
      await submit(input(project), "purge-key", {
        submit: async () => ({ id: providerId, status: "completed" }),
      }),
    );
    const { purgeSoulIdentities, getSoulIdentity } =
      await import("../../lib/soulIdentities");
    const { platformDb } = await import("../../lib/platform");
    await purgeSoulIdentities();
    expect(await getSoulIdentity(identity.id)).toBeNull();
    expect(
      (
        await platformDb().execute({
          sql: "SELECT id FROM soul_training_receipts WHERE id=?",
          args: [identity.id],
        })
      ).rows,
    ).toHaveLength(0);
  }));

test("unresolved submissions rotate so bounded cron reaches later accepted training", async () =>
  scope("fairness", async (_ws, project) => {
    const { db } = await import("../../lib/db");
    const { syncSoulIdentities, getSoulIdentity } =
      await import("../../lib/soulIdentities");
    const pending: string[] = [];
    for (let index = 0; index < 5; index++) {
      const identity = await read(
        await submit(input(project), `unknown-receipt-${index}`, {
          submit: async () => {
            throw new Error("unknown acceptance");
          },
        }),
      );
      pending.push(identity.id);
      await db().execute({
        sql: "UPDATE soul_identities SET created_at=? WHERE id=?",
        args: [index, identity.id],
      });
    }
    const later = await read(
      await submit(input(project), "known-receipt-later", {
        submit: async () => ({ id: providerId, status: "queued" }),
      }),
    );
    expect(await syncSoulIdentities(5)).toEqual({
      synced: 5,
      failed: 0,
      deferred: 0,
    });
    expect((await getSoulIdentity(later.id))?.status).toBe("training");
    expect(await syncSoulIdentities(1)).toEqual({
      synced: 1,
      failed: 0,
      deferred: 0,
    });
    expect((await getSoulIdentity(later.id))?.status).toBe("ready");
    for (const id of pending)
      expect((await getSoulIdentity(id))?.status).toBe("uncertain");
  }));

test("definitive rejection releases the exact paid claim after a recovery poll labels it uncertain", async () =>
  scope("rejection_race", async (_ws, project) => {
    const { db } = await import("../../lib/db");
    const { syncSoulIdentity } = await import("../../lib/soulIdentities");
    const { HiggsfieldHttpError } = await import("../../lib/higgsfield");
    let rejectSubmit!: () => void;
    const pending = new Promise<void>((resolve) => {
      rejectSubmit = resolve;
    });
    let calls = 0;
    const running = submit(input(project), "rejection-poll-race", {
      submit: async () => {
        calls++;
        await pending;
        throw new HiggsfieldHttpError(422);
      },
    });
    await expect.poll(() => calls).toBe(1);
    const recovered = await read(
      await submit(input(project), "rejection-poll-race"),
    );
    expect((await syncSoulIdentity(recovered.id))?.status).toBe("uncertain");
    expect(Number((await meterFor(recovered.id)).billed_credits)).toBe(38);
    rejectSubmit();
    const finished = await read(await running);
    expect(finished.status).toBe("failed");
    expect(finished.creditsBilled).toBe(0);
    expect((await meterFor(finished.id)).status).toBe("failed");
    expect(Number((await meterFor(finished.id)).engine_cost_usd)).toBe(0);
    expect(
      (
        await db().execute({
          sql: "SELECT settled_at,paid_claim FROM soul_identities WHERE id=?",
          args: [finished.id],
        })
      ).rows[0].settled_at,
    ).not.toBeNull();
    await submit(input(project), "rejection-poll-race");
    expect(calls).toBe(1);
  }));

test("stale never-submitted cleanup loses to an acquired paid claim and cannot refund an in-flight accepted request", async () =>
  scope("cleanup_race", async (_ws, project) => {
    const { db } = await import("../../lib/db");
    const { syncSoulIdentity } = await import("../../lib/soulIdentities");
    const client = db();
    let releaseSign!: () => void,
      releaseProvider!: () => void,
      releaseSnapshot!: () => void;
    const signGate = new Promise<void>((resolve) => {
      releaseSign = resolve;
    });
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    let signing = false,
      submitted = 0,
      snapshotBlocked = false;
    const running = submit(input(project), "cleanup-submit-race", {
      sign: async () => {
        signing = true;
        await signGate;
        return "https://fixture.invalid/signed";
      },
      submit: async () => {
        submitted++;
        await providerGate;
        return { id: providerId, status: "completed" };
      },
    });
    await expect.poll(() => signing).toBe(true);
    const identity = await read(
      await submit(input(project), "cleanup-submit-race"),
    );
    await client.execute({
      sql: "UPDATE soul_identities SET created_at=0 WHERE id=?",
      args: [identity.id],
    });
    const original = client.execute;
    let snapshots = 0;
    client.execute = (async (...args: unknown[]) => {
      const result = await Reflect.apply(original, client, args);
      const statement = args[0] as { sql?: string };
      if (
        statement?.sql ===
          "SELECT * FROM soul_identities WHERE id=? AND purged_at IS NULL" &&
        ++snapshots === 2
      ) {
        snapshotBlocked = true;
        await snapshotGate;
      }
      return result;
    }) as typeof client.execute;
    try {
      const cleanup = syncSoulIdentity(identity.id);
      await expect.poll(() => snapshotBlocked).toBe(true);
      releaseSign();
      await expect.poll(() => submitted).toBe(1);
      releaseSnapshot();
      expect((await cleanup)?.status).toBe("submitting");
      expect((await meterFor(identity.id)).status).toBe("running");
      expect(Number((await meterFor(identity.id)).billed_credits)).toBe(38);
    } finally {
      client.execute = original;
      releaseSnapshot();
      releaseSign();
      releaseProvider();
    }
    const finished = await read(await running);
    expect(finished.status).toBe("ready");
    expect(finished.creditsBilled).toBe(38);
    expect(submitted).toBe(1);
  }));
