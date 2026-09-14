import { test, expect } from "@playwright/test";
import { createClient } from "@libsql/client";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

async function fixture(options: { timeout?: number } = { timeout: 0 }) {
  const { createPlatformDatabaseClient } =
    await import("../../lib/localDatabaseClient");
  const dir = mkdtempSync(path.join(tmpdir(), "particl-platform-lock-"));
  const file = path.join(dir, "platform.db");
  const client = createPlatformDatabaseClient({
    url: `file:${file}`,
    ...options,
  });
  const equivalent = createPlatformDatabaseClient({
    url: pathToFileURL(file).href,
    ...options,
  });
  expect(equivalent).toBe(client);
  const witness = createClient({ url: `file:${file}` });
  await client.execute(
    "CREATE TABLE counter(id INTEGER PRIMARY KEY,n INTEGER NOT NULL)",
  );
  await client.execute("INSERT INTO counter VALUES(1,0)");
  return { client, witness, file };
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

// A real separate process can release its native SQLite lock while the caller's
// synchronous driver waits. No sockets, app configuration, or providers are used.
async function externalWriter(file: string) {
  const script = String.raw`
    const {createClient} = require(process.argv[1]);
    const client = createClient({url: process.argv[2]});
    let tx;
    const watchdog = setTimeout(() => { tx?.close(); client.close(); process.exit(2); }, 10000);
    (async () => {
      tx = await client.transaction('write');
      await tx.execute('UPDATE counter SET n=n+1 WHERE id=1');
      process.on('message', (message) => {
        if (message.releaseAfter !== undefined) setTimeout(async () => {
          try { await tx.commit(); tx.close(); client.close(); clearTimeout(watchdog); process.send({type:'released'}); process.disconnect(); }
          catch { process.exit(3); }
        }, message.releaseAfter);
      });
      process.send({type:'held'});
    })().catch(() => process.exit(4));
  `;
  const child = spawn(
    process.execPath,
    ["-e", script, require.resolve("@libsql/client"), pathToFileURL(file).href],
    {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { PATH: process.env.PATH, NODE_ENV: "test" },
    },
  );
  let heldResolve!: () => void,
    releasedResolve!: () => void,
    failed!: (error: Error) => void;
  const held = new Promise<void>((resolve, reject) => {
    heldResolve = resolve;
    failed = reject;
  });
  const released = new Promise<void>((resolve) => {
    releasedResolve = resolve;
  });
  const exited = new Promise<void>((resolve) =>
    child.once("exit", (code) => {
      if (code) failed(new Error("LOCAL_WRITER_FAILED"));
      resolve();
    }),
  );
  child.on("message", (message) => {
    const type = (message as { type: string }).type;
    if (type === "held") heldResolve();
    if (type === "released") releasedResolve();
  });
  child.on("error", failed);
  await held;
  return {
    releaseAfter: (ms: number) => child.send({ releaseAfter: ms }),
    released,
    stop: async () => {
      if (child.exitCode === null) child.kill();
      await exited;
    },
  };
}

for (const operation of ["execute", "transaction"] as const) {
  test(`default local timeout waits for a different process before ${operation} and applies the write exactly once`, async () => {
    const { client, witness, file } = await fixture({});
    const writer = await externalWriter(file);
    try {
      writer.releaseAfter(80);
      if (operation === "execute")
        await client.execute("UPDATE counter SET n=n+10 WHERE id=1");
      else {
        const tx = await client.transaction("write");
        try {
          await tx.execute("UPDATE counter SET n=n+10 WHERE id=1");
          await tx.commit();
        } finally {
          tx.close();
        }
      }
      await writer.released;
      expect(
        Number((await witness.execute("SELECT n FROM counter")).rows[0].n),
      ).toBe(11);
      // transaction() detaches the first native connection; reconnect creates another.
      expect(
        Number((await client.execute("PRAGMA busy_timeout")).rows[0].timeout),
      ).toBe(2000);
      await client.reconnect();
      expect(
        Number((await client.execute("PRAGMA busy_timeout")).rows[0].timeout),
      ).toBe(2000);
    } finally {
      await writer.stop();
      client.close();
      witness.close();
    }
  });
}

test("an explicit local timeout still rejects a persistent external lock without replaying the rejected write", async () => {
  const { client, witness, file } = await fixture({ timeout: 25 });
  const writer = await externalWriter(file);
  try {
    await expect(
      client.execute("UPDATE counter SET n=n+10 WHERE id=1"),
    ).rejects.toMatchObject({ code: "SQLITE_BUSY" });
    writer.releaseAfter(0);
    await writer.released;
    await client.execute("UPDATE counter SET n=n+100 WHERE id=1");
    expect(
      Number((await witness.execute("SELECT n FROM counter")).rows[0].n),
    ).toBe(101);
    expect(
      Number((await client.execute("PRAGMA busy_timeout")).rows[0].timeout),
    ).toBe(25);
  } finally {
    await writer.stop();
    client.close();
    witness.close();
  }
});

test("explicit timeout zero remains fail-fast on every local connection", async () => {
  const { client, witness } = await fixture({ timeout: 0 });
  try {
    expect(
      Number((await client.execute("PRAGMA busy_timeout")).rows[0].timeout),
    ).toBe(0);
    const tx = await client.transaction("write");
    try {
      await tx.commit();
    } finally {
      tx.close();
    }
    expect(
      Number((await client.execute("PRAGMA busy_timeout")).rows[0].timeout),
    ).toBe(0);
    await client.reconnect();
    expect(
      Number((await client.execute("PRAGMA busy_timeout")).rows[0].timeout),
    ).toBe(0);
  } finally {
    client.close();
    witness.close();
  }
});
