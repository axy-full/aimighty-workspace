import { test, expect } from "@playwright/test";
import { createClient } from "@libsql/client";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

async function fixture() {
  const { createPlatformDatabaseClient } =
    await import("../../lib/localDatabaseClient");
  const dir = mkdtempSync(path.join(tmpdir(), "particl-platform-lock-"));
  const file = path.join(dir, "platform.db");
  const client = createPlatformDatabaseClient({ url: `file:${file}` });
  const equivalent = createPlatformDatabaseClient({
    url: pathToFileURL(file).href,
  });
  expect(equivalent).toBe(client);
  const witness = createClient({ url: `file:${file}` });
  await client.execute(
    "CREATE TABLE counter(id INTEGER PRIMARY KEY,n INTEGER NOT NULL)",
  );
  await client.execute("INSERT INTO counter VALUES(1,0)");
  return { client, witness };
}

for (const ending of ["commit", "rollback", "close"] as const) {
  test(`ordinary platform writes wait for transaction ${ending} and leave the native database unlocked`, async () => {
    const { client, witness } = await fixture();
    const tx = await client.transaction("write");
    try {
      await tx.execute("UPDATE counter SET n=n+1 WHERE id=1");
      let settled = false;
      const waiting = client
        .execute("UPDATE counter SET n=n+10 WHERE id=1")
        .finally(() => {
          settled = true;
        });
      await nextTurn();
      expect(settled).toBe(false);
      if (ending === "close") tx.close();
      else await tx[ending]();
      await waiting;
      // A second native connection catches the persistent implicit write lock
      // that SELECT 1 and same-client writes cannot detect.
      await witness.execute("UPDATE counter SET n=n+100 WHERE id=1");
      expect(
        Number((await witness.execute("SELECT n FROM counter")).rows[0].n),
      ).toBe(ending === "commit" ? 111 : 110);
    } finally {
      tx.close();
      client.close();
      witness.close();
    }
  });
}

test("a rejected ordinary statement does not poison the platform operation queue", async () => {
  const { client, witness } = await fixture();
  try {
    await expect(
      client.execute("INSERT INTO counter VALUES(1,99)"),
    ).rejects.toMatchObject({ code: "SQLITE_CONSTRAINT" });
    await client.execute("UPDATE counter SET n=n+1 WHERE id=1");
    await witness.execute("UPDATE counter SET n=n+1 WHERE id=1");
    expect(
      Number((await witness.execute("SELECT n FROM counter")).rows[0].n),
    ).toBe(2);
  } finally {
    client.close();
    witness.close();
  }
});

test("a native BUSY from an external writer is reported once and its connection is clean for later work", async () => {
  const { client, witness } = await fixture();
  const external = await witness.transaction("write");
  try {
    await external.execute("UPDATE counter SET n=n+1 WHERE id=1");
    // This must reject while the other writer is still active, not retry or
    // block the event loop that needs to commit that writer.
    await expect(
      client.execute("UPDATE counter SET n=n+10 WHERE id=1"),
    ).rejects.toMatchObject({ code: "SQLITE_BUSY" });
    await external.commit();
    await client.execute("UPDATE counter SET n=n+100 WHERE id=1");
    await witness.execute("UPDATE counter SET n=n+1000 WHERE id=1");
    expect(
      Number((await witness.execute("SELECT n FROM counter")).rows[0].n),
    ).toBe(1101);
  } finally {
    external.close();
    client.close();
    witness.close();
  }
});

test("a failed transaction BEGIN releases admission for the next operation", async () => {
  const { client, witness } = await fixture();
  const external = await witness.transaction("write");
  try {
    await external.execute("UPDATE counter SET n=n+1 WHERE id=1");
    await expect(client.transaction("write")).rejects.toMatchObject({
      code: "SQLITE_BUSY",
    });
    await external.commit();
    await client.execute("UPDATE counter SET n=n+10 WHERE id=1");
    await witness.execute("UPDATE counter SET n=n+100 WHERE id=1");
    expect(
      Number((await witness.execute("SELECT n FROM counter")).rows[0].n),
    ).toBe(111);
  } finally {
    external.close();
    client.close();
    witness.close();
  }
});

test("failed COMMIT keeps ordinary writes gated until the transaction is rolled back", async () => {
  const { client, witness } = await fixture();
  const reader = await witness.transaction("read");
  await reader.execute("SELECT n FROM counter");
  const tx = await client.transaction("write");
  try {
    await tx.execute("UPDATE counter SET n=n+1 WHERE id=1");
    await expect(tx.commit()).rejects.toMatchObject({ code: "SQLITE_BUSY" });
    let settled = false;
    const waiting = client
      .execute("UPDATE counter SET n=n+10 WHERE id=1")
      .finally(() => {
        settled = true;
      });
    await nextTurn();
    expect(settled).toBe(false);
    await reader.commit();
    await tx.rollback();
    await waiting;
    await witness.execute("UPDATE counter SET n=n+100 WHERE id=1");
    expect(
      Number((await witness.execute("SELECT n FROM counter")).rows[0].n),
    ).toBe(110);
  } finally {
    reader.close();
    tx.close();
    client.close();
    witness.close();
  }
});

test("closing and reconnecting the local client leaves its queue and ordinary method shape usable", async () => {
  const { client, witness } = await fixture();
  try {
    expect(typeof client.execute).toBe("function");
    expect(typeof client.batch).toBe("function");
    expect(typeof client.transaction).toBe("function");
    client.close();
    expect(client.closed).toBe(true);
    await expect(client.execute("SELECT 1")).rejects.toMatchObject({
      code: "CLIENT_CLOSED",
    });
    await client.reconnect();
    expect(client.closed).toBe(false);
    await client.execute("UPDATE counter SET n=? WHERE id=?", [5, 1]);
    await witness.execute("UPDATE counter SET n=n+1 WHERE id=1");
    expect(
      Number((await client.execute("SELECT n FROM counter")).rows[0].n),
    ).toBe(6);
  } finally {
    client.close();
    witness.close();
  }
});

test("remote configurations keep the ordinary libSQL HTTP client without opening a connection", async () => {
  const { createPlatformDatabaseClient } =
    await import("../../lib/localDatabaseClient");
  let requests = 0;
  const config = {
    url: "https://example.invalid",
    authToken: "unit-test-not-a-real-token",
    fetch: async () => {
      requests++;
      throw new Error("This compatibility test must not contact a database.");
    },
  };
  const raw = createClient(config);
  const client = createPlatformDatabaseClient(config);
  try {
    expect(Object.getPrototypeOf(client)).toBe(Object.getPrototypeOf(raw));
    expect(client.protocol).toBe(raw.protocol);
    expect(typeof client.execute).toBe("function");
    expect(typeof client.transaction).toBe("function");
    expect(client.closed).toBe(false);
    await nextTurn();
    expect(requests).toBe(0);
  } finally {
    client.close();
    raw.close();
  }
});
