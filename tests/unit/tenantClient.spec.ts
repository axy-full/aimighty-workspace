import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TenantWorkspace } from "../../lib/tenant";

test("tenant connection and bootstrap follow same-id restored databases without closing existing work", async () => {
  const { tenantClient, ready, db } = await import("../../lib/db");
  const { runInTenant } = await import("../../lib/tenant");
  const dir = mkdtempSync(path.join(tmpdir(), "particl-tenant-rotation-"));
  const source = {
    id: "restored",
    legacy: false,
    dbUrl: "file:" + path.join(dir, "original.db"),
    dbToken: null,
  } as TenantWorkspace;
  const restored = {
    ...source,
    dbUrl: "file:" + path.join(dir, "restored.db"),
  };
  const oldClient = tenantClient(source);
  await runInTenant(source, async () => {
    await ready();
    await db().execute(
      "INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,created_at) VALUES('original','private','image/png','png',1,'hash','original',0)",
    );
  });
  await runInTenant(restored, async () => {
    await ready();
    expect(db()).not.toBe(oldClient);
    expect(
      (await db().execute("SELECT COUNT(*) n FROM uploads")).rows[0].n,
    ).toBe(0);
  });
  expect(
    (await oldClient.execute("SELECT COUNT(*) n FROM uploads")).rows[0].n,
  ).toBe(1);
  const remote = {
    ...source,
    dbUrl: "libsql://tenant-fixture.invalid",
    dbToken: "token-one",
  };
  const remoteA = tenantClient(remote),
    remoteB = tenantClient({ ...remote, dbToken: "token-two" });
  expect(remoteA).not.toBe(remoteB); // Creating HTTP clients makes no request.
  remoteA.close();
  remoteB.close();
  const tx = await oldClient.transaction("write");
  await tx.execute("UPDATE uploads SET bytes=2 WHERE id='original'");
  let completed = false;
  const ordinary = oldClient
    .execute("UPDATE uploads SET bytes=3 WHERE id='original'")
    .then(() => {
      completed = true;
    });
  await new Promise((resolve) => setImmediate(resolve));
  expect(completed).toBe(false);
  await tx.commit();
  tx.close();
  await ordinary;
  expect(
    (await oldClient.execute("SELECT bytes FROM uploads")).rows[0].bytes,
  ).toBe(3);
});
