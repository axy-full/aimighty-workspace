import { test, expect } from "@playwright/test";
import { createClient } from "@libsql/client";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { prepareLocalDatabaseDirectory } from "../../lib/localDatabase";

const directory = mkdtempSync(path.join(tmpdir(), "particl-fresh-database-"));
const platformPath = path.join(directory, "platform", "nested", "platform.db");
const legacyPath = path.join(directory, "legacy", "nested", "legacy.db");
process.env.PLATFORM_DATABASE_URL = `file:${path.relative(process.cwd(), platformPath)}`;
process.env.TURSO_DATABASE_URL = `file:${legacyPath}`;

test.afterAll(async () => {
  const { platformDb } = await import("../../lib/platform");
  platformDb().close();
  rmSync(directory, { recursive: true, force: true });
});

test("fresh platform bootstrap creates missing local platform and legacy directories", async () => {
  expect(existsSync(path.dirname(platformPath))).toBe(false);
  expect(existsSync(path.dirname(legacyPath))).toBe(false);
  const { platformReady, platformDb } = await import("../../lib/platform");
  await platformReady();
  expect(existsSync(platformPath)).toBe(true);
  expect(existsSync(legacyPath)).toBe(true);
  const result = await platformDb().execute(
    "SELECT COUNT(*) AS count FROM accounts",
  );
  expect(Number(result.rows[0].count)).toBe(0);
  await platformReady();
});

test("local preparation preserves encoded absolute file URLs and existing data", async () => {
  const dbPath = path.join(directory, "encoded folder", "deep", "test.db");
  const url = pathToFileURL(dbPath).href;
  prepareLocalDatabaseDirectory(url);
  const client = createClient({ url });
  try {
    await client.execute("CREATE TABLE retained(value TEXT)");
    await client.execute("INSERT INTO retained VALUES ('saved')");
    prepareLocalDatabaseDirectory(url);
    const result = await client.execute("SELECT value FROM retained");
    expect(result.rows[0].value).toBe("saved");
  } finally {
    client.close();
  }
});

test("remote and memory database URLs require no filesystem bootstrap", async () => {
  // An inaccessible local path in a remote URL must never be treated as disk.
  for (const url of [
    "libsql://example.invalid/particl/remote/database.db",
    "https://example.invalid/particl/remote/database.db",
    ":memory:",
    "file::memory:?cache=shared",
  ])
    expect(() => prepareLocalDatabaseDirectory(url)).not.toThrow();
  const client = createClient({ url: "file::memory:?cache=shared" });
  try {
    expect(
      Number((await client.execute("SELECT 1 AS value")).rows[0].value),
    ).toBe(1);
  } finally {
    client.close();
  }
});
