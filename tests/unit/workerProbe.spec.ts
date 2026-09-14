import { test, expect } from "@playwright/test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const dir = mkdtempSync(path.join(tmpdir(), "particl-worker-probe-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
process.env.ENGINE_MOCK = "1";
delete process.env.BLOB_READ_WRITE_TOKEN;
process.env.VERCEL_ENV = "preview";
process.env.VERCEL_DEPLOYMENT_ID = "unit-probe-deployment";

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
