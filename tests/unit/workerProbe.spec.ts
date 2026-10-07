import { test, expect } from "@playwright/test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const dir = mkdtempSync(path.join(tmpdir(), "particl-worker-probe-"));
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
delete process.env.BLOB_READ_WRITE_TOKEN;
/* The probe reads which deployment it runs on from VERCEL_ENV and
   VERCEL_DEPLOYMENT_ID, and its databases from the two URLs. They are set for
   this spec's tests only, never at load: the runner loads every spec before it
   starts workers, so a value set at load lands in every worker's environment,
   and other specs (the owner privacy guard, the recovery fence's deployment
   label) would read a preview deployment that is not there. */
const PROBE_ENV = {
  PLATFORM_DATABASE_URL: `file:${path.join(dir, "platform.db")}`,
  TURSO_DATABASE_URL: `file:${path.join(dir, "primary.db")}`,
  VERCEL_ENV: "preview",
  VERCEL_DEPLOYMENT_ID: "unit-probe-deployment",
} as const;
let envBefore: Record<string, string | undefined> = {};
test.beforeAll(() => {
  envBefore = Object.fromEntries(Object.keys(PROBE_ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, PROBE_ENV);
});
test.afterAll(() => {
  for (const [k, v] of Object.entries(envBefore)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

async function workspace(id: string, legacy = false) {
  const { platformDb, platformReady, getWorkspace } =
    await import("../../lib/platform");
  await platformReady();
  await platformDb().execute({
    sql: "INSERT INTO workspaces(id,slug,name,db_url,owner_id,legacy,created_at,updated_at) VALUES(?,?,?,?,?,?,0,0)",
    args: [
      id,
      id,
      id,
      `file:${path.join(dir, `${id}.db`)}`,
      "u_test",
      legacy ? 1 : 0,
    ],
  });
  return (await getWorkspace(id))!;
}

test("worker probe records real scoped DB/storage proof, cleans its challenge, and replays without side effects", async () => {
  const { runWorkerProbe, latestWorkerProbe } =
    await import("../../lib/workerProbe");
  const { runInTenant } = await import("../../lib/tenant");
  const { db } = await import("../../lib/db");
  const ws = await workspace("ws_worker_probe");
  const input = {
    workspaceId: ws.id,
    probeId: "probe_unit_0001",
    expectedDeployment: "unit-probe-deployment",
    expectedEnvironment: "preview",
  };
  const receipt = await runWorkerProbe(input);
  expect(receipt).toMatchObject({
    status: "succeeded",
    workspaceId: ws.id,
    environment: "preview",
    deployment: "unit-probe-deployment",
    database: true,
    storage: true,
    cleanup: true,
    blob: false,
  });
  expect(receipt.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(receipt.storagePath).toMatch(
    /^ws\/ws_worker_probe\/uploads\/worker_probe_[a-f0-9]{64}\.txt$/,
  );
  expect(
    existsSync(
      path.join(
        process.cwd(),
        ".data",
        "uploads",
        path.basename(receipt.storagePath),
      ),
    ),
  ).toBe(false);
  expect(await runWorkerProbe(input)).toEqual(receipt);
  await runInTenant(ws, async () => {
    expect(await latestWorkerProbe()).toEqual(receipt);
    expect(
      (await db().execute("SELECT COUNT(*) AS n FROM worker_probe_receipts"))
        .rows[0].n,
    ).toBe(1);
    process.env.VERCEL_DEPLOYMENT_ID = "different-deployment";
    try {
      expect(await latestWorkerProbe()).toBeNull();
    } finally {
      process.env.VERCEL_DEPLOYMENT_ID = "unit-probe-deployment";
    }
  });
});

test("probe refuses wrong deployment, legacy workspace and missing scope before storage work", async () => {
  const { runWorkerProbe } = await import("../../lib/workerProbe");
  const ws = await workspace("ws_probe_legacy", true);
  await expect(
    runWorkerProbe({
      workspaceId: ws.id,
      probeId: "probe_unit_0002",
      expectedEnvironment: "production",
    }),
  ).rejects.toThrow(/different deployment or environment/);
  await expect(
    runWorkerProbe({ workspaceId: ws.id, probeId: "probe_unit_0002" }),
  ).rejects.toThrow(/isolated probe workspace/);
  await expect(
    runWorkerProbe({ workspaceId: "", probeId: "probe_unit_0002" }),
  ).rejects.toThrow(/workspace/);
});
