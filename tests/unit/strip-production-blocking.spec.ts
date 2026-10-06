import { test, expect } from "@playwright/test";
import { createClient } from "@libsql/client";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * The rollback step for 3D blocking (scripts/ops/strip-production-blocking.mjs), on a throwaway local file: a dry run by default that prints the host and counts only,
 * a write only with both flags, a copy of every value in the additive archive table BEFORE it is removed, and a restore that puts the values back.
 */
const SCRIPT = "scripts/ops/strip-production-blocking.mjs";
const BLOCKING = { "node-1": { scene: "s1" }, "node-2": { scene: "s2" } };

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "strip-blocking-"));
  const url = `file:${join(dir, "copy.db")}`;
  const db = createClient({ url });
  await db.execute("CREATE TABLE workbench_projects (key TEXT PRIMARY KEY, owner TEXT, project_id TEXT, name TEXT, body TEXT, revision INTEGER, updated_at INTEGER)");
  const rows: [string, Record<string, unknown>][] = [
    ["a", { id: "a", name: "Secret title A", production: { beats: { scenes: [] }, blocking: BLOCKING } }],
    ["b", { id: "b", name: "Secret title B", production: { beats: { scenes: [] } } }],
    ["c", { id: "c", name: "Secret title C" }],
  ];
  for (const [key, body] of rows) await db.execute({ sql: "INSERT INTO workbench_projects VALUES (?,?,?,?,?,?,?)", args: [key, "u", key, String(body.name), JSON.stringify(body), 4, 1] });
  const run = (...args: string[]) => spawnSync("node", [SCRIPT, ...args], { env: { ...process.env, STRIP_BLOCKING_DB_URL: url, STRIP_BLOCKING_DB_TOKEN: "secret-token-value" }, encoding: "utf8" });
  const tables = async () => (await db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")).rows.map((r) => String(r.name));
  const body = async (key: string) => JSON.parse(String((await db.execute({ sql: "SELECT body FROM workbench_projects WHERE key = ?", args: [key] })).rows[0].body));
  const revision = async (key: string) => Number((await db.execute({ sql: "SELECT revision FROM workbench_projects WHERE key = ?", args: [key] })).rows[0].revision);
  return { db, run, tables, body, revision, clean: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("a dry run reads and counts, names the database host and no secret, creates nothing; a half write is refused", async () => {
  const f = await fixture();
  try {
    const dry = f.run();
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain("Database host: a local file");
    expect(dry.stdout).toContain("DRY RUN (nothing written): 3 projects read, 1 hold production.blocking (2 entries), 0 unreadable");
    expect(dry.stdout + dry.stderr).not.toMatch(/Secret|secret-token|copy\.db/);
    expect(await f.tables()).toEqual(["workbench_projects"]);
    expect(await f.revision("a")).toBe(4);
    const half = f.run("--apply");
    expect(half.status).toBe(2);
    expect(half.stderr).toContain("--owner-said-yes");
    expect((await f.body("a")).production.blocking).toEqual(BLOCKING);
    expect(await f.tables()).toEqual(["workbench_projects"]);
  } finally { f.clean(); }
});

test("the write copies each value into the archive first, removes only the field, bumps the revision, and the restore puts the values back", async () => {
  const f = await fixture();
  try {
    const done = f.run("--apply", "--owner-said-yes");
    expect(done.status).toBe(0);
    expect(done.stdout).toContain("APPLIED: 3 projects read, 1 hold production.blocking (2 entries), 0 unreadable, 1 copied to workbench_blocking_archive, 1 rewritten without it, 0 changed meanwhile and left");
    /* The archive is the only new table; the value is in it. */
    expect(await f.tables()).toEqual(["sqlite_sequence", "workbench_blocking_archive", "workbench_projects"]);
    const archive = (await f.db.execute("SELECT project_key, revision_before, blocking_json, restored_at FROM workbench_blocking_archive")).rows;
    expect(archive).toHaveLength(1);
    expect([archive[0].project_key, archive[0].revision_before, JSON.parse(String(archive[0].blocking_json)), archive[0].restored_at]).toEqual(["a", 4, BLOCKING, null]);
    expect(await f.body("a")).toEqual({ id: "a", name: "Secret title A", production: { beats: { scenes: [] } } });
    expect(await f.revision("a")).toBe(5);
    expect([await f.revision("b"), await f.revision("c")]).toEqual([4, 4]);
    expect(Number((await f.db.execute("SELECT count(*) AS n FROM workbench_projects")).rows[0].n)).toBe(3);
    expect(f.run().stdout).toContain("0 hold production.blocking");

    /* Restore: dry by default, then both flags put the value back; the archive row is kept and marked. */
    const dry = f.run("--restore");
    expect(dry.stdout).toContain("Database host: a local file");
    expect(dry.stdout).toContain("DRY RUN (nothing written): 1 archived values waiting, 1 can be put back (2 entries), 0 left");
    expect((await f.body("a")).production.blocking).toBeUndefined();
    expect(f.run("--restore", "--apply").status).toBe(2);
    const back = f.run("--restore", "--apply", "--owner-said-yes");
    expect(back.stdout).toContain("RESTORED: 1 archived values waiting, 1 can be put back (2 entries), 0 left (project gone or holds blocking now), 0 unreadable, 1 restored");
    expect((await f.body("a")).production).toEqual({ beats: { scenes: [] }, blocking: BLOCKING });
    expect(await f.revision("a")).toBe(6);
    expect(Number((await f.db.execute("SELECT count(*) AS n FROM workbench_blocking_archive WHERE restored_at IS NOT NULL")).rows[0].n)).toBe(1);
    expect(f.run("--restore").stdout).toContain("0 archived values waiting");
  } finally { f.clean(); }
});

test("a restore never overwrites what a person has made since: a project that holds blocking again, or is gone, is left", async () => {
  const f = await fixture();
  try {
    expect(f.run("--apply", "--owner-said-yes").status).toBe(0);
    const now = await f.body("a");
    now.production.blocking = { "node-9": { scene: "newer" } };
    await f.db.execute({ sql: "UPDATE workbench_projects SET body = ?, revision = revision + 1 WHERE key = 'a'", args: [JSON.stringify(now)] });
    const out = f.run("--restore", "--apply", "--owner-said-yes");
    expect(out.stdout).toContain("1 archived values waiting, 0 can be put back (0 entries), 1 left (project gone or holds blocking now), 0 unreadable, 0 restored");
    expect((await f.body("a")).production.blocking).toEqual({ "node-9": { scene: "newer" } });
    await f.db.execute("DELETE FROM workbench_projects WHERE key = 'a'");
    expect(f.run("--restore").stdout).toContain("1 left");
  } finally { f.clean(); }
});

test("with no database named it reads nothing", () => {
  const out = spawnSync("node", [SCRIPT], { env: { ...process.env, STRIP_BLOCKING_DB_URL: "" }, encoding: "utf8" });
  expect(out.status).toBe(2);
  expect(out.stderr).toContain("STRIP_BLOCKING_DB_URL");
});
