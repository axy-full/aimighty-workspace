import { test, expect } from "@playwright/test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * The guard for the removed Higgsfield sign-in (CLAUDE.md ground rule 10: no
 * Particl feature may need a sign-in to a Higgsfield account; provider APIs and
 * loginless MCP only). The account's server code is gone: its sign-in, its MCP
 * client, its routes, services and background collection. What stays reads the
 * rows a database already holds (the jobs tray, Workspace › Usage, the /usage
 * history tab, the Library, purge and backups); nothing is deleted from a table.
 *
 * This fails if a sign-in endpoint, an OAuth or account MCP client, an account
 * route other than the history read, or a writer of new account work exists
 * again. It reads source files only.
 */

const CODE_ROOTS = ["app", "components", "lib", "mcp", "scripts"];
const CODE_FILES = ["proxy.ts", "instrumentation.ts", "next.config.ts", "vercel.json"];
function walk(root: string, pattern: RegExp): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? walk(file, pattern) : pattern.test(entry.name) ? [file] : [];
  });
}
const code = () => [...CODE_ROOTS.flatMap((root) => walk(root, /\.(ts|tsx|mts|mjs|js|cjs|json)$/)), ...CODE_FILES.filter((file) => existsSync(file))];
const appCode = () => ["app", "components", "lib"].flatMap((root) => walk(root, /\.(ts|tsx)$/));
const read = (file: string) => readFileSync(file, "utf8");
const importsOf = (source: string) => [...new Set([...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]))].sort();

const ACCOUNT_ROUTES = "app/api/higgsfield/consumer";

test("the account's routes are gone: the one left under /api/higgsfield/consumer is the credit history's read", () => {
  expect(walk(ACCOUNT_ROUTES, /./).map((file) => path.relative(ACCOUNT_ROUTES, file))).toEqual([path.join("activity", "route.ts")]);
  const history = read(`${ACCOUNT_ROUTES}/activity/route.ts`);
  /* A GET of the signed-in person's own ledger totals; it imports nothing that reaches a provider. */
  expect([...history.matchAll(/export const (GET|POST|PUT|PATCH|DELETE)\b/g)].map((match) => match[1])).toEqual(["GET"]);
  expect(importsOf(history)).toEqual(["@/lib/accountDb", "@/lib/auth", "@/lib/higgsfield-consumer/activity", "@/lib/tenant", "@/lib/workbench/request-scope"]);
  /* No other route anywhere signs in to, calls back from or reads the account: Atomik's connected step and recipes went too. */
  for (const gone of ["app/api/atomik/steps/[id]/connected/route.ts", "app/api/atomik/recipes/route.ts"]) expect(existsSync(gone), gone).toBe(false);
  const routes = walk("app", /^route\.(ts|tsx)$/).map((file) => file.split(path.sep).join("/"));
  expect(routes.filter((file) => /higgsfield\/consumer|\/connected\/route|consumer\/(connect|callback|client|connection)/.test(file))).toEqual([`${ACCOUNT_ROUTES}/activity/route.ts`]);
});

test("no code signs in to Higgsfield: no sign-in or account MCP host, no OAuth client, no account settings", () => {
  const files = code();
  expect(files.length).toBeGreaterThan(500);
  const FORBIDDEN: [string, RegExp][] = [
    ["the account's sign-in host", /clerk\.higgsfield\.ai/i],
    ["the account's MCP host", /mcp\.higgsfield\.ai/i],
    ["the CLI's developer gateway", /fnf-api-gw\.higgsfield\.ai/i],
    ["an OAuth authorize or token endpoint", /\/oauth\/(authorize|token|revoke)/i],
    ["a PKCE sign-in", /code_challenge|code_verifier/],
    ["sign-in discovery", /openid-configuration|oauth-authorization-server|oauth-protected-resource/],
    ["an authorization-code grant", /["'`]authorization_code["'`]|grant_type=authorization_code/],
    ["a refresh-token scope", /\boffline_access\b/],
    ["the account's settings", /\bHF_CONSUMER_[A-Z_]+/],
    ["the account's skill packs", /higgsfield-ai\/skills/],
  ];
  /* Higgsfield is reached on its API with a key, and named in links to its docs and key pages: nothing else. */
  const HOSTS = new Set(["api.higgsfield.ai", "cloud.higgsfield.ai", "console.higgsfield.ai", "docs.higgsfield.ai", "higgsfield.ai"]);
  const found: string[] = [];
  for (const file of files) {
    const source = read(file);
    for (const [what, pattern] of FORBIDDEN) if (pattern.test(source)) found.push(`${file}: ${what}`);
    for (const host of source.matchAll(/\b([a-z0-9-]+\.)*higgsfield\.ai\b/gi))
      if (!HOSTS.has(host[0].toLowerCase())) found.push(`${file}: the host ${host[0]}`);
  }
  expect(found).toEqual([]);
});

test("no code calls an account route but the history read, and no page keeps the Engines row's endpoint", () => {
  for (const file of appCode()) {
    const source = read(file);
    expect(source, file).not.toMatch(/\/api\/higgsfield\/consumer\/(?!activity\b)/);
    expect(source, file).not.toContain("CONNECTION_ENDPOINT");
  }
  expect(existsSync("components/graphite/ConnectedAccountRow.tsx")).toBe(false);
  expect(read("components/graphite/WorkspaceView.tsx")).not.toContain("ConnectedAccountRow");
});

test("the account folder keeps only its history readers, and none of them reaches the network, a grant or the account", () => {
  const KEPT = ["activity-types.ts", "activity.ts", "jobs.ts", "original-identity.ts", "original-retention.ts", "resume.ts", "video-original.ts"];
  expect(readdirSync("lib/higgsfield-consumer").sort()).toEqual(KEPT);
  const ALLOWED_IMPORTS = new Set(["@libsql/client", "@/lib/db", "../db", "@/lib/schemaInitialization", "@/lib/providerOutcome", "../uploadReservations",
    "./jobs", "./activity-types"]);
  for (const file of KEPT) {
    const source = read(`lib/higgsfield-consumer/${file}`);
    for (const id of importsOf(source)) expect(ALLOWED_IMPORTS.has(id), `${file} imports ${id}`).toBe(true);
    expect(source, file).not.toMatch(/\bfetch\(|node:https?|keyring|tokens_enc|access_token|Bearer|mcp|oauth|higgsfield\.ai/i);
  }
  /* Nothing outside the folder imports a module that went with the sign-in. */
  for (const file of [...appCode(), ...walk("scripts", /\.(ts|mjs)$/)])
    for (const id of importsOf(read(file)).filter((id) => id.includes("higgsfield-consumer/")))
      expect(KEPT.map((kept) => kept.replace(/\.ts$/, "")), `${file} imports ${id}`).toContain(id.split("higgsfield-consumer/")[1]);
});

test("nothing starts account work: no new job, media import, original or grant is written; only purge's disposal touches an old row", () => {
  const writers: Record<string, string[]> = {};
  for (const file of appCode()) {
    const source = read(file);
    for (const match of source.matchAll(/\b(INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+(higgsfield_consumer_\w+|consumer_video_originals|higgsfield_marketing_templates)\b/gi))
      (writers[`${match[1].toUpperCase().replace(/\s+/g, " ")} ${match[2]}`] ??= []).push(file);
  }
  expect(writers).toEqual({
    /* A deleted workspace's collected original is recorded as disposed on its job's row before purge removes the
       workspace (lib/purge.ts). It sends nothing. */
    "UPDATE higgsfield_consumer_jobs": ["lib/purge.ts"],
  });
  /* The tables stay, so a fresh database and an older backup read alike. */
  expect(read("lib/higgsfield-consumer/jobs.ts")).toContain("CREATE TABLE IF NOT EXISTS higgsfield_consumer_jobs");
  expect(read("lib/uploadReservations.ts")).toContain("CREATE TABLE IF NOT EXISTS consumer_video_originals");
});

test("the heartbeat collects nothing from the account, and the API-key collector inspects with its own module", () => {
  const heartbeat = read("app/api/cron/sync/route.ts");
  expect(heartbeat).not.toMatch(/connected_jobs|higgsfield-consumer|sweepConsumer/);
  const collector = read("lib/genjutsuVideo.ts");
  expect(collector).toContain('from "./videoOriginal"');
  expect(collector).not.toContain("higgsfield-consumer");
});

test("a capture never waits on account rows that can no longer settle", () => {
  const capture = read("scripts/ops/backup-automation.mjs");
  expect(capture).not.toMatch(/FROM\s+(higgsfield_consumer_\w+|consumer_video_originals)/);
  /* Older backups still restore and report them. */
  for (const file of ["scripts/ops/prepare-restore.mjs", "scripts/ops/recovery-report.mjs"]) expect(read(file), file).toContain("higgsfield_consumer_jobs");
});
