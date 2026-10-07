import { test, expect } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { newProject } from "../../lib/workbench/studio";
import { projectSchema } from "../../lib/workbench/studio-schema";
import { branchCopyProblem, branchWriteProblem } from "../helpers/blockingBranch";

/*
 * The branch-copy check for `production.blocking`, run by the lead before Thursday's train (skipped unless BLOCKING_BRANCH_DB_URL is set).
 * It only ever runs against a copy the owner made for it: the URL must carry "3d-blocking-test" and must not be a live database
 * (tests/helpers/blockingBranch.ts). Read-only unless BLOCKING_BRANCH_WRITE=1, and it never writes where VERCEL_ENV is set or
 * NODE_ENV is production.
 *
 *   BLOCKING_BRANCH_DB_URL=<the branch copy's libsql:// url> BLOCKING_BRANCH_DB_TOKEN=<its token> BLOCKING_BRANCH_WRITE=1 \
 *   npx playwright test --project=unit tests/unit/blocking-branch-copy.spec.ts --workers=1
 *
 * 1. Every stored project body on the copy still parses with the schema; the count that does not is asserted to be 0, and none already
 *    carries production.blocking. A workspace has its own database, so one copy covers one workspace: run it for each.
 * 2. With BLOCKING_BRANCH_WRITE=1, one throwaway row (owner "branch-check") carrying production.blocking is written, read back, parsed
 *    and deleted; no other row is written or deleted. No table or column changes: the field lives inside the project's JSON body.
 * Counts only are printed: no project text, name or id.
 */
const URL = process.env.BLOCKING_BRANCH_DB_URL;

test("branch copy: the guard, then every stored project parses and a project with blocking round-trips", async () => {
  test.skip(!URL, "set BLOCKING_BRANCH_DB_URL (a branch copy) to run this");
  const refused = branchCopyProblem(URL);
  expect(refused, "the URL must be a branch copy").toBeNull();
  const writing = process.env.BLOCKING_BRANCH_WRITE === "1";
  if (writing) expect(branchWriteProblem(), "writes are refused here").toBeNull();
  const db = createClient({ url: URL!, authToken: process.env.BLOCKING_BRANCH_DB_TOKEN });
  try {
    const rows = (await db.execute("SELECT body FROM workbench_projects")).rows;
    let failed = 0, withField = 0;
    for (const row of rows) {
      let body: unknown;
      try { body = JSON.parse(String(row.body)); } catch { failed++; continue; }
      if ((body as { production?: { blocking?: unknown } })?.production?.blocking !== undefined) withField++;
      if (!projectSchema.safeParse(body).success) failed++;
    }
    console.log(`branch copy: ${rows.length} stored projects, ${failed} that do not parse, ${withField} that already carry production.blocking`);
    expect(failed, "stored projects that do not parse").toBe(0);
    expect(withField, "stored projects that already carry the field").toBe(0);
    if (writing) {
      const plain = newProject("Branch check");
      const scene = { schemaVersion: 1, name: "Shot blocking", objects: [], lights: [], camera: { position: [0, -6, 1.6], target: [0, 0, 1.3], focalLength: 35 }, world: { color: "#23262c", strength: 0.6 }, timeline: { start: 1, end: 120, fps: 24 }, render: { width: 1280, height: 720, samples: 32, transparent: false } };
      const body = { ...plain, production: { blocking: { "node-check": { scene, move: { kind: "hold", meters: 0, seconds: 5 }, savedAt: new Date().toISOString() } } } };
      const key = `branch-check:${randomUUID()}`;
      await db.execute({ sql: "INSERT INTO workbench_projects (key,owner,project_id,name,body,revision,updated_at) VALUES (?,?,?,?,?,1,?)", args: [key, "branch-check", plain.id, "branch check", JSON.stringify(body), Date.now()] });
      try {
        const back = (await db.execute({ sql: "SELECT body FROM workbench_projects WHERE key = ?", args: [key] })).rows[0];
        const parsed = projectSchema.safeParse(JSON.parse(String(back.body)));
        expect(parsed.success, JSON.stringify(parsed.error?.issues[0])).toBe(true);
        expect(parsed.success && Object.keys(parsed.data.production?.blocking ?? {})).toEqual(["node-check"]);
      } finally { await db.execute({ sql: "DELETE FROM workbench_projects WHERE key = ? AND owner = 'branch-check'", args: [key] }); }
    }
  } finally { db.close(); }
});
