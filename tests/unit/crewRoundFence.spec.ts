import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";
import { clearPendingRound, pendingRoundKey, readPendingRound, roundFate, writePendingRound } from "../../lib/crew/pending-round";

const dir = mkdtempSync(path.join(tmpdir(), "particl-crew-round-fence-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";

function workspace(name: string): TenantWorkspace {
  return { id: `ws_${name}`, slug: name, name, legacy: false, dbUrl: `file:${path.join(dir, `${name}.db`)}`, dbToken: null,
    keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null, ownerId: "u_test", createdAt: 0,
    suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null, storageQuotaBytes: null, deletedAt: null };
}

/* A crew round files no job and binds no Idempotency-Key, so POST /api/generate/check cannot answer for it.
   Its key is its number: a round is claimed only while the rounds before it have run, in one write. */
test("a crew round is claimed by its number: never twice while it runs, never again once it billed, and open again only if it stopped unbilled", async () => {
  const { claimRound, releaseRound, createSession, readSession } = await import("../../lib/crew/store");
  const { DEFAULT_CONTEXT } = await import("../../lib/crew/room");
  const { runInTenant } = await import("../../lib/tenant");
  await runInTenant(workspace("crew-fence"), async () => {
    const session = await createSession("u_test", { projectId: "p1", goal: "Find the ending", context: DEFAULT_CONTEXT, model: "grok-test" });
    const claims: boolean[] = [];
    claims.push(await claimRound("u_test", session.id, 1));
    /* While round 1 runs, a second press (or the lost request arriving late) takes nothing. */
    claims.push(await claimRound("u_test", session.id, 1));
    await releaseRound("u_test", session.id, { spendUsd: 0.05, spendCr: 1 });
    /* Billed: round 1 is never claimed again, however late its request arrives; the next round is 2. */
    claims.push(await claimRound("u_test", session.id, 1));
    expect(claims).toEqual([true, false, false]);
    expect(await claimRound("u_test", session.id, 3)).toBe(false);
    expect(await claimRound("u_test", session.id, 2)).toBe(true);
    expect(await readSession("u_test", session.id)).toMatchObject({ roundsRun: 1, running: true });
    /* A round that stopped unbilled leaves its number open, and nothing was charged for it. */
    await releaseRound("u_test", session.id);
    expect(await readSession("u_test", session.id)).toMatchObject({ roundsRun: 1, running: false });
    expect(await claimRound("u_other", session.id, 2)).toBe(false);
    expect(await claimRound("u_test", session.id, 2)).toBe(true);
  });
});

test("a round sent from this browser is kept until the room says what became of it", () => {
  const items = new Map<string, string>();
  const storage = { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v), removeItem: (k: string) => void items.delete(k) };
  const key = pendingRoundKey("particl-active-ws-u", "crews_1");
  expect(readPendingRound(storage, key)).toBeNull();
  writePendingRound(storage, key, { sessionId: "crews_1", round: 2, credits: 3 });
  expect(readPendingRound(storage, key)).toEqual({ sessionId: "crews_1", round: 2, credits: 3 });
  /* Only that round's answer clears it. */
  clearPendingRound(storage, key, 1);
  expect(readPendingRound(storage, key)?.round).toBe(2);
  clearPendingRound(storage, key, 2);
  expect(readPendingRound(storage, key)).toBeNull();
  storage.setItem(key, JSON.stringify({ sessionId: "crews_1", round: 0, credits: 3 }));
  expect(readPendingRound(storage, key)).toBeNull();
  /* The room decides: it ran (billed), it is running, or it has not run (the only case in which another may go). */
  expect(roundFate({ round: 2 }, { roundsRun: 2 })).toBe("ran");
  expect(roundFate({ round: 2 }, { roundsRun: 3, running: true })).toBe("ran");
  expect(roundFate({ round: 2 }, { roundsRun: 1, running: true })).toBe("running");
  expect(roundFate({ round: 2 }, { roundsRun: 1, running: false })).toBe("not-run");
  expect(roundFate({ round: 2 }, { roundsRun: 1 })).toBe("not-run");
});
