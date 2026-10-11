import { test, expect } from "@playwright/test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PREVIEW_DATABASE_HOSTS,
  PREVIEW_SEED_CONFIG,
  previewOrigin,
  previewSeedGuard,
  runPreviewSeed,
  type PreviewSeedConfig,
} from "../../lib/previewSeed";

/**
 * The preview bootstrap's guard and link origin (lib/previewSeed.ts, run by
 * `prebuild`), against the real host constant. The full run on local file
 * databases is in tests/ops/preview-seed.test.mjs: it needs a fresh process,
 * because the database clients are process-wide and a shared worker would
 * hand it another spec's database.
 */
const dir = mkdtempSync(path.join(tmpdir(), "particl-preview-guard-"));
test.afterAll(() => rmSync(dir, { recursive: true, force: true }));
const platformFile = path.join(dir, `${PREVIEW_DATABASE_HOSTS.platform}-local.db`);
const primaryFile = path.join(dir, `${PREVIEW_DATABASE_HOSTS.primary}-local.db`);
const OWNER = "owner@example.com";
/* How the local run reads a host: the file's name, since a file: URL has none. The prefixes stay the real ones. */
const localConfig: PreviewSeedConfig = { hosts: PREVIEW_DATABASE_HOSTS, hostOf: (url) => path.basename(url, ".db") };

const good = {
  VERCEL_ENV: "preview",
  PLATFORM_DATABASE_URL: "libsql://particl-staging-platform-team.aws-ap-south-1.turso.io",
  TURSO_DATABASE_URL: "libsql://particl-mu191i1z5i3nsd-team.aws-ap-south-1.turso.io",
  SUPER_ADMIN_EMAIL: "Owner@Example.com",
};

test("the guard passes only a preview build on the staging databases with an owner named", () => {
  expect(previewSeedGuard(good)).toEqual({ ok: true, email: "owner@example.com" });
  // The bare prefix is the database itself.
  expect(previewSeedGuard({ ...good, PLATFORM_DATABASE_URL: "libsql://particl-staging-platform.turso.io" }).ok).toBe(true);
  const refused: [string, Record<string, string | undefined>][] = [
    ["no VERCEL_ENV", { ...good, VERCEL_ENV: undefined }],
    ["empty VERCEL_ENV", { ...good, VERCEL_ENV: "" }],
    ["production", { ...good, VERCEL_ENV: "production" }],
    ["development", { ...good, VERCEL_ENV: "development" }],
    ["no platform URL", { ...good, PLATFORM_DATABASE_URL: undefined }],
    ["no primary URL", { ...good, TURSO_DATABASE_URL: undefined }],
    ["wrong platform host", { ...good, PLATFORM_DATABASE_URL: "libsql://particl-platform-team.turso.io" }],
    ["wrong primary host", { ...good, TURSO_DATABASE_URL: "libsql://aimighty-workspace-team.turso.io" }],
    ["hosts swapped", { ...good, PLATFORM_DATABASE_URL: good.TURSO_DATABASE_URL, TURSO_DATABASE_URL: good.PLATFORM_DATABASE_URL }],
    ["prefix not at the start of the label", { ...good, PLATFORM_DATABASE_URL: "libsql://x-particl-staging-platform.turso.io" }],
    ["prefix run on without a dash", { ...good, TURSO_DATABASE_URL: "libsql://particl-mu191i1z5i3nsdx.turso.io" }],
    ["prefix in a later label", { ...good, PLATFORM_DATABASE_URL: "libsql://elsewhere.particl-staging-platform.turso.io" }],
    ["prefix only in the path", { ...good, PLATFORM_DATABASE_URL: "libsql://elsewhere.turso.io/particl-staging-platform" }],
    ["a username in a URL", { ...good, PLATFORM_DATABASE_URL: "libsql://reader@particl-staging-platform-team.turso.io" }],
    ["a password in a URL", { ...good, TURSO_DATABASE_URL: "libsql://u:p@particl-mu191i1z5i3nsd-team.turso.io" }],
    ["prod in a host", { ...good, PLATFORM_DATABASE_URL: "libsql://particl-staging-platform-prod.turso.io" }],
    ["PROD anywhere in a URL", { ...good, TURSO_DATABASE_URL: "libsql://particl-mu191i1z5i3nsd-team.turso.io?db=PROD" }],
    ["a local file", { ...good, PLATFORM_DATABASE_URL: `file:${platformFile}`, TURSO_DATABASE_URL: `file:${primaryFile}` }],
    ["no owner", { ...good, SUPER_ADMIN_EMAIL: undefined }],
    ["blank owner", { ...good, SUPER_ADMIN_EMAIL: "  " }],
    ["not an address", { ...good, SUPER_ADMIN_EMAIL: "owner" }],
  ];
  for (const [label, env] of refused) {
    const result = previewSeedGuard(env);
    expect(result.ok, label).toBe(false);
    // A reason names a variable, never a URL or an address.
    if (!result.ok) for (const value of Object.values(env)) if (value && /[:@]/.test(value)) expect(result.reason, label).not.toContain(value);
  }
  // The real config reads hosts from the URL; the local config never loosens the prefixes.
  expect(PREVIEW_SEED_CONFIG.hosts).toBe(PREVIEW_DATABASE_HOSTS);
  expect(previewSeedGuard({ ...good, PLATFORM_DATABASE_URL: "file:/tmp/other.db" }, localConfig).ok).toBe(false);
});

test("a refused run logs one line and opens no database", async () => {
  const untouched = path.join(dir, "untouched");
  for (const env of [
    {},
    { VERCEL_ENV: "production", PLATFORM_DATABASE_URL: `file:${platformFile}`, TURSO_DATABASE_URL: `file:${primaryFile}`, SUPER_ADMIN_EMAIL: OWNER },
    { ...good, SUPER_ADMIN_EMAIL: undefined },
    { VERCEL_ENV: "preview", PLATFORM_DATABASE_URL: `file:${untouched}-p.db`, TURSO_DATABASE_URL: `file:${untouched}-t.db`, SUPER_ADMIN_EMAIL: OWNER },
    // Passes the local config, but the process's own variables name other databases: refused before any is opened.
    { VERCEL_ENV: "preview", PLATFORM_DATABASE_URL: `file:${platformFile}`, TURSO_DATABASE_URL: `file:${primaryFile}`, SUPER_ADMIN_EMAIL: OWNER },
  ]) {
    const out: string[] = [];
    const report = await runPreviewSeed({ env, config: localConfig, log: (line) => out.push(line) });
    expect(report.skipped).toBeTruthy();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^preview seed: skipped \(.+\)$/);
  }
  expect(readdirSync(dir)).toEqual([]);
  expect(existsSync(platformFile)).toBe(false);
});

test("links point at this preview, never at a live site", () => {
  expect(previewOrigin({ VERCEL_ENV: "preview", VERCEL_BRANCH_URL: "app-git-x.vercel.app", VERCEL_URL: "app-abc.vercel.app", APP_ORIGIN: "https://staging.example.com" })).toBe("https://app-git-x.vercel.app");
  expect(previewOrigin({ VERCEL_ENV: "preview", VERCEL_URL: "app-abc.vercel.app", APP_ORIGIN: "https://staging.example.com" })).toBe("https://app-abc.vercel.app");
  expect(previewOrigin({ VERCEL_ENV: "preview", APP_ORIGIN: "https://staging.example.com/" })).toBe("https://staging.example.com");
  for (const live of ["https://particl.app", "https://www.particl.app", "https://particl.si", "https://WWW.PARTICL.SI/"])
    expect(previewOrigin({ VERCEL_ENV: "preview", APP_ORIGIN: live }), live).toBeNull();
  expect(previewOrigin({ VERCEL_ENV: "preview", VERCEL_BRANCH_URL: "particl.app" })).toBeNull();
  expect(previewOrigin({ VERCEL_ENV: "preview" })).toBeNull();
});
