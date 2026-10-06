import { test, expect } from "@playwright/test";
import { createClient } from "@libsql/client";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* The rollback step for 3D blocking (scripts/ops/strip-production-blocking.mjs): a dry run by default that prints counts only, and a write only with both flags, on a throwaway local file here. */
const SCRIPT = "scripts/ops/strip-production-blocking.mjs";

test("it reads and counts by default, refuses a write without the owner's yes, and with it removes only the field and bumps the revision", async () => {
  const dir = mkdtempSync(join(tmpdir(), "strip-blocking-"));
  const url = `file:${join(dir, "copy.db")}`;
  const db = createClient({ url });
  try {
    await db.execute("CREATE TABLE workbench_projects (key TEXT PRIMARY KEY, owner TEXT, project_id TEXT, name TEXT, body TEXT, revision INTEGER, updated_at INTEGER)");
    const rows = [
      ["a", { id: "a", name: "Secret title A", production: { beats: { scenes: [] }, blocking: { "node-1": {}, "node-2": {} } } }],
      ["b", { id: "b", name: "Secret title B", production: { beats: { scenes: [] } } }],
      ["c", { id: "c", name: "Secret title C" }],
    ] as const;
    for (const [key, body] of rows) await db.execute({ sql: "INSERT INTO workbench_projects VALUES (?,?,?,?,?,?,?)", args: [key, "u", key, body.name, JSON.stringify(body), 4, 1] });
    const run = (...args: string[]) => spawnSync("node", [SCRIPT, ...args], { env: { ...process.env, STRIP_BLOCKING_DB_URL: url }, encoding: "utf8" });

    const dry = run();
    expect(dry.status).toBe(0);
    expect(dry.stdout.trim()).toBe("DRY RUN (nothing written): 3 projects read, 1 hold production.blocking (2 entries), 0 unreadable");
    expect(dry.stdout + dry.stderr).not.toContain("Secret");
    expect((await db.execute("SELECT revision FROM workbench_projects WHERE key='a'")).rows[0].revision).toBe(4);

    const half = run("--apply");
    expect(half.status).toBe(2);
    expect(half.stderr).toContain("--owner-said-yes");
    expect((await db.execute("SELECT body FROM workbench_projects WHERE key='a'")).rows[0].body).toContain("blocking");

    const done = run("--apply", "--owner-said-yes");
    expect(done.status).toBe(0);
    expect(done.stdout.trim()).toBe("APPLIED: 3 projects read, 1 hold production.blocking (2 entries), 0 unreadable, 1 rewritten without it");
    const a = (await db.execute("SELECT body, revision FROM workbench_projects WHERE key='a'")).rows[0];
    expect(JSON.parse(String(a.body))).toEqual({ id: "a", name: "Secret title A", production: { beats: { scenes: [] } } });
    expect(a.revision).toBe(5);
    expect((await db.execute("SELECT revision FROM workbench_projects WHERE key IN ('b','c')")).rows.map((r) => r.revision)).toEqual([4, 4]);
    expect((await db.execute("SELECT count(*) AS n FROM workbench_projects")).rows[0].n).toBe(3);
    expect(run().stdout).toContain("0 hold production.blocking");
    expect(run().status).toBe(0);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("with no database named it reads nothing", () => {
  const out = spawnSync("node", [SCRIPT], { env: { ...process.env, STRIP_BLOCKING_DB_URL: "" }, encoding: "utf8" });
  expect(out.status).toBe(2);
  expect(out.stderr).toContain("STRIP_BLOCKING_DB_URL");
});
