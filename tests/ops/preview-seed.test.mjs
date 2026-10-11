import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/* The prebuild step (scripts/ops/preview-seed.cjs): what CI and local builds
   see, and the whole seed run through its own TypeScript loader on local
   files. The guard's cases are in tests/unit/previewSeed.spec.ts. */
const root = resolve(import.meta.dirname, "../..");
const entry = join(root, "scripts/ops/preview-seed.cjs");
const base = { PATH: process.env.PATH, HOME: process.env.HOME };

function run(env, args = [entry]) {
  const out = spawnSync(process.execPath, args, { cwd: root, env: { ...base, ...env }, encoding: "utf8", timeout: 240_000 });
  return { status: out.status, lines: out.stdout.split("\n").filter(Boolean), stderr: out.stderr };
}

test("outside a preview build, prebuild prints one skipped line and succeeds", () => {
  const staging = {
    PLATFORM_DATABASE_URL: "libsql://particl-staging-platform-team.turso.io",
    TURSO_DATABASE_URL: "libsql://particl-mu191i1z5i3nsd-team.turso.io",
    SUPER_ADMIN_EMAIL: "owner@example.com",
  };
  for (const [env, reason] of [
    [{}, "VERCEL_ENV is not set"],
    [{ ...staging }, "VERCEL_ENV is not set"],
    [{ ...staging, VERCEL_ENV: "production" }, "production deployment"],
    [{ ...staging, VERCEL_ENV: "preview", SUPER_ADMIN_EMAIL: "" }, "SUPER_ADMIN_EMAIL is not set"],
    [{ ...staging, VERCEL_ENV: "preview", TURSO_DATABASE_URL: "libsql://particl-prod-team.turso.io" }, "a database URL names production"],
  ]) {
    const result = run(env);
    assert.equal(result.status, 0);
    assert.deepEqual(result.lines, [`preview seed: skipped (${reason})`]);
  }
});

test("a full seed on local files: no accounts, then the house without him, then his reset link; reruns change nothing", (t) => {
  // A fresh process (tests/ops/preview-seed-scenario.cjs) through the build step's own loader.
  const dir = mkdtempSync(join(tmpdir(), "particl-preview-seed-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = run({}, [join(root, "tests/ops/preview-seed-scenario.cjs"), dir]);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.lines.at(-1));
  assert.equal(summary.ok, true);
  assert.equal(summary.lines, result.lines.length - 1);
  for (const line of result.lines.slice(0, -1)) assert.doesNotMatch(line, /@|https?:|\/reset\/|invite=|file:/);
});
