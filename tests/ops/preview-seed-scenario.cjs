/* eslint-disable @typescript-eslint/no-require-imports -- A child process for tests/ops/preview-seed.test.mjs, loaded through the build step's own TypeScript loader. */
/**
 * The full preview seed against two temporary file databases, in a fresh
 * process: the platform and tenant clients are process-wide singletons, so a
 * shared test worker could hand this run another spec's database.
 *
 * The files are NAMED after the staging hosts, and the config differs from the
 * real one only in how a host is read (a file: URL has none). The allowed
 * prefixes are the real constant. Prints the log lines, then one JSON line.
 */
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createClient } = require("@libsql/client");

const dir = process.argv[2];
if (!dir || !fs.statSync(dir).isDirectory() || fs.readdirSync(dir).length) throw new Error("EMPTY_TEMP_DIRECTORY_REQUIRED");
const root = path.resolve(__dirname, "../..");
const OWNER = "owner@example.com";
const STUDIO = "studio@example.com";
const KEYRING = "unit-test-keyring-secret-preview-seed-01";
const MAIL_KEY = "re_unit_test_not_a_real_key";
const PLATFORM = "particl-staging-platform-local";
const PRIMARY = "particl-mu191i1z5i3nsd-local";
const platformFile = path.join(dir, `${PLATFORM}.db`);
const primaryFile = path.join(dir, `${PRIMARY}.db`);
// A restored workspace row naming a database the guard never checked.
const foreignFile = path.join(dir, "foreign-tenant.db");
for (const name of ["TURSO_API_TOKEN", "TURSO_ORG", "TURSO_AUTH_TOKEN", "PLATFORM_AUTH_TOKEN", "RESEND_API_KEY", "MAIL_FROM", "APP_ORIGIN", "VERCEL_URL", "NODE_ENV"])
  delete process.env[name];
Object.assign(process.env, {
  PLATFORM_DATABASE_URL: `file:${platformFile}`,
  TURSO_DATABASE_URL: `file:${primaryFile}`,
  WORKSPACE_DB_DIRECTORY: path.join(dir, "tenants"),
  KEYRING_SECRET: KEYRING,
  SUPER_ADMIN_EMAIL: OWNER,
  ENGINE_MOCK: "1",
  VERCEL_ENV: "preview",
  VERCEL_BRANCH_URL: "preview-branch.example.com",
});

const seed = require(path.join(root, "scripts/ops/preview-seed.cjs")).loadPreviewSeed();
const platform = require(path.join(root, "lib/platform.ts"));
const { createFirstAdmin, tokenHash, verifyPassword } = require(path.join(root, "lib/auth.ts"));
const { resetAccountPassword } = require(path.join(root, "lib/passwordReset.ts"));

const config = { hosts: seed.PREVIEW_DATABASE_HOSTS, hostOf: (url) => path.basename(url, ".db") };
const lines = [];
const secrets = [OWNER, STUDIO, KEYRING, MAIL_KEY, dir];
const sent = [];
const deliver = async (msg) => {
  sent.push(msg);
};
const failing = async () => {
  throw new Error(`Email not sent (422): ${OWNER} rejected`);
};
let runs = 0;
const run = (send = deliver) => {
  runs++;
  return seed.runPreviewSeed({ config, log: (line) => lines.push(line), send });
};
const logged = (line) => assert.ok(lines.includes(line), `missing log line: ${line}`);

async function rowsOf(file) {
  const c = createClient({ url: `file:${file}` });
  try {
    const out = {};
    const tables = (await c.execute(`SELECT name, sql FROM sqlite_master ORDER BY type, name`)).rows;
    out["(schema)"] = tables;
    for (const t of tables) if (String(t.sql ?? "").startsWith("CREATE TABLE")) out[String(t.name)] = (await c.execute(`SELECT * FROM "${String(t.name)}"`)).rows;
    return out;
  } finally {
    c.close();
  }
}
async function snapshot() {
  const hash = createHash("sha256");
  for (const file of [platformFile, primaryFile]) hash.update(file).update(JSON.stringify(await rowsOf(file)));
  return hash.digest("hex");
}
const p = () => platform.platformDb();
const resetsFor = async (id) => (await p().execute(`SELECT * FROM password_resets WHERE user_id=?`, [id])).rows;
const roleOf = async (id) => (await p().execute(`SELECT role, disabled FROM memberships WHERE workspace_id='ws_legacy' AND account_id=?`, [id])).rows[0];

(async () => {
  /* ── (c) no accounts at all: nothing is sent; /setup makes the house owner ── */
  let report = await run();
  assert.equal(report.skipped, null);
  assert.equal(report.steps.failed, 0);
  assert.equal(report.primary, "ok");
  assert.deepEqual(report.owner, { account: "none", membership: null, outcome: "no-accounts" });
  logged("owner: no accounts — use /setup");
  // Every module's tables reached both databases.
  const platformTables = Object.keys(await rowsOf(platformFile));
  for (const t of ["accounts", "password_resets", "workspace_invites", "workspace_provisioning", "billing_ledgers", "provider_pool", "higgsfield_generation_receipts", "higgsfield_consumer_connections"])
    assert.ok(platformTables.includes(t), t);
  const primaryTables = Object.keys(await rowsOf(primaryFile));
  for (const t of ["users", "generations", "generation_requests", "upload_sessions", "soul_identities", "workbench_projects", "astra_render_jobs", "dubbing_jobs"])
    assert.ok(primaryTables.includes(t), t);

  // A restored row that names another database is never opened.
  await p().execute(`INSERT INTO workspaces(id,slug,name,db_url,owner_id,created_at,updated_at) VALUES('ws_foreign','foreign','Foreign',?, 'usr_elsewhere',?,?)`, [`file:${foreignFile}`, Date.now(), Date.now()]);
  let before = await snapshot();
  assert.equal((await run()).owner.outcome, "no-accounts");
  assert.equal(await snapshot(), before, "a rerun with no accounts changed the databases");

  /* ── (b) no account, the house exists ── */
  const studio = await createFirstAdmin(STUDIO, "Studio", "Unique-studio-password-43");
  assert.ok(studio, "the house owner");
  before = await snapshot();
  report = await run();
  assert.deepEqual(report.owner, { account: "none", membership: null, outcome: "mail-not-configured" });
  logged("owner: no account; mail not configured — nothing changed");
  assert.equal(await platform.findAccountByEmail(OWNER), null);
  assert.equal(await snapshot(), before, "an unreachable account was made");

  process.env.RESEND_API_KEY = MAIL_KEY;
  process.env.MAIL_FROM = "Particl <invites@example.com>";
  report = await run(failing);
  assert.deepEqual(report.owner, { account: "created", membership: "added", outcome: "reset-mail-failed" });
  logged("owner: added to the house workspace as admin");
  logged("owner: account created in the house workspace; mail failed");
  const account = await platform.findAccountByEmail(OWNER);
  assert.equal(String(account.password_hash), "!", "no usable password until the reset");
  assert.deepEqual({ ...(await roleOf(account.id)) }, { role: "admin", disabled: 0 });
  assert.equal((await resetsFor(account.id)).length, 0, "an unsent reset is not kept");
  // No workspace or database was made: the house and the restored row, nothing else.
  assert.deepEqual((await p().execute(`SELECT id FROM workspaces ORDER BY id`)).rows.map((r) => r.id), ["ws_foreign", "ws_legacy"]);
  assert.equal(Number((await p().execute(`SELECT COUNT(*) AS n FROM credit_grants`)).rows[0].n), 0);

  /* ── (a) the account exists: one reset link, 24 hours ── */
  report = await run();
  assert.deepEqual(report.owner, { account: "existing", membership: "present", outcome: "reset-emailed" });
  logged("owner: account exists; reset link emailed");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, OWNER);
  const match = sent[0].text.match(/https:\/\/preview-branch\.example\.com\/reset\/([A-Za-z0-9_-]+)/);
  assert.ok(match, "the reset link points at this preview");
  const token = match[1];
  secrets.push(token);
  const [reset] = await resetsFor(account.id);
  assert.equal(reset.token_hash, tokenHash(token));
  assert.equal(reset.ip_hash, seed.PREVIEW_RESET_SOURCE);
  assert.equal((Number(reset.expires_at) - Number(reset.created_at)) / 3600_000, 24);

  before = await snapshot();
  assert.equal((await run()).owner.outcome, "reset-already-emailed");
  logged("owner: account exists; already emailed");
  assert.equal(sent.length, 1);
  assert.equal(await snapshot(), before, "a rerun changed the databases");

  // He sets his password with it; a used link is never replaced by another.
  await resetAccountPassword(token, "New-studio-password-44");
  assert.ok(verifyPassword("New-studio-password-44", String((await platform.findAccountByEmail(OWNER)).password_hash)));
  before = await snapshot();
  assert.equal((await run()).owner.outcome, "reset-already-emailed");
  assert.equal(sent.length, 1);
  assert.equal(await snapshot(), before, "a rerun after the reset changed the databases");

  // Restored without his membership: it is put back, once, and nothing is sent.
  await p().execute(`DELETE FROM memberships WHERE workspace_id='ws_legacy' AND account_id=?`, [account.id]);
  report = await run();
  assert.deepEqual(report.owner, { account: "existing", membership: "added", outcome: "reset-already-emailed" });
  assert.deepEqual({ ...(await roleOf(account.id)) }, { role: "admin", disabled: 0 });
  assert.equal(sent.length, 1);
  // The house owner is never demoted.
  assert.equal((await roleOf(studio.id)).role, "owner");

  /* ── only the two checked databases were ever opened ── */
  assert.ok(!fs.existsSync(foreignFile), "a database the guard did not check was opened");
  for (const file of fs.readdirSync(dir)) assert.ok(file.startsWith(PLATFORM) || file.startsWith(PRIMARY), `unexpected file ${path.basename(file)}`);

  // No log line carries an address, a code, a link, a token or a path.
  for (const line of lines) {
    assert.doesNotMatch(line, /@|https?:|\/reset\/|invite=|file:|libsql:/i, "log line");
    for (const secret of secrets) assert.ok(!line.includes(secret), "log line carries a secret");
  }
  for (const line of lines) console.log(line);
  console.log(JSON.stringify({ ok: true, runs, lines: lines.length }));
  process.exit(0);
})().catch((error) => {
  // Assertion messages name steps and tables; the values compared are fixtures.
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
