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
const KEYRING = "unit-test-keyring-secret-preview-seed-01";
const MAIL_KEY = "re_unit_test_not_a_real_key";
const platformFile = path.join(dir, "particl-staging-platform-local.db");
const primaryFile = path.join(dir, "particl-mu191i1z5i3nsd-local.db");
const tenantsDir = path.join(dir, "tenants");
for (const name of ["TURSO_API_TOKEN", "TURSO_ORG", "TURSO_AUTH_TOKEN", "PLATFORM_AUTH_TOKEN", "RESEND_API_KEY", "MAIL_FROM", "APP_ORIGIN", "VERCEL_URL", "NODE_ENV"])
  delete process.env[name];
Object.assign(process.env, {
  PLATFORM_DATABASE_URL: `file:${platformFile}`,
  TURSO_DATABASE_URL: `file:${primaryFile}`,
  WORKSPACE_DB_DIRECTORY: tenantsDir,
  KEYRING_SECRET: KEYRING,
  SUPER_ADMIN_EMAIL: OWNER,
  ENGINE_MOCK: "1",
  VERCEL_ENV: "preview",
  VERCEL_BRANCH_URL: "preview-branch.example.com",
});

const seed = require(path.join(root, "scripts/ops/preview-seed.cjs")).loadPreviewSeed();
const platform = require(path.join(root, "lib/platform.ts"));
const { hashPassword } = require(path.join(root, "lib/auth.ts"));
const { billingStateFor } = require(path.join(root, "lib/billingLedger.ts"));

const config = { hosts: seed.PREVIEW_DATABASE_HOSTS, hostOf: (url) => path.basename(url, ".db") };
const lines = [];
const secrets = [OWNER, KEYRING, MAIL_KEY, dir];
const run = (send) => seed.runPreviewSeed({ config, log: (line) => lines.push(line), send });

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
const databases = () => [platformFile, primaryFile, ...(fs.existsSync(tenantsDir) ? fs.readdirSync(tenantsDir).filter((f) => f.endsWith(".db")).sort().map((f) => path.join(tenantsDir, f)) : [])];
async function snapshot() {
  const hash = createHash("sha256");
  for (const file of databases()) hash.update(file).update(JSON.stringify(await rowsOf(file)));
  return hash.digest("hex");
}
const invites = async () => (await platform.platformDb().execute(`SELECT * FROM signup_invites WHERE email=?`, [OWNER])).rows;

(async () => {
  /* ── no account, mail not configured ── */
  let report = await run();
  assert.deepEqual(
    { skipped: report.skipped, owner: report.owner, workspace: report.workspace, credits: report.credits, steps: report.steps.failed, tenants: report.tenants },
    { skipped: null, owner: "invite-mail-not-configured", workspace: null, credits: null, steps: 0, tenants: { ok: 1, failed: 0 } },
  );
  assert.ok(lines.includes("owner: no account (accounts: 0)"));
  assert.ok(lines.includes("invite: mail not configured — use /setup if the account count is 0"));
  const [invite] = await invites();
  assert.equal((await invites()).length, 1);
  assert.equal(invite.used_at, null);
  assert.equal(invite.sent_at, null);
  assert.equal((Number(invite.expires_at) - Number(invite.created_at)) / 3600_000, 24);
  secrets.push(String(invite.code));
  // Every module's tables reached both databases.
  const platformTables = Object.keys(await rowsOf(platformFile));
  for (const t of ["accounts", "signup_invites", "workspace_provisioning", "billing_ledgers", "provider_pool", "higgsfield_generation_receipts", "higgsfield_consumer_connections"])
    assert.ok(platformTables.includes(t), t);
  const primaryTables = Object.keys(await rowsOf(primaryFile));
  for (const t of ["generations", "generation_requests", "upload_sessions", "soul_identities", "workbench_projects", "astra_render_jobs", "dubbing_jobs"])
    assert.ok(primaryTables.includes(t), t);
  let before = await snapshot();
  await run();
  assert.ok(lines.includes("invite: reusing an open invitation"));
  assert.equal(await snapshot(), before, "a second run changed the databases");

  /* ── mail configured: a failed send logs only the step; a good one is sent once ── */
  process.env.RESEND_API_KEY = MAIL_KEY;
  process.env.MAIL_FROM = "Particl <invites@example.com>";
  report = await run(async () => {
    throw new Error(`Email not sent (422): ${OWNER} rejected`);
  });
  assert.equal(report.owner, "invite-mail-failed");
  assert.ok(lines.includes("invite: mail failed — use /setup if the account count is 0"));
  assert.equal((await invites())[0].sent_at, null);
  const sent = [];
  const send = async (msg) => {
    sent.push(msg);
  };
  assert.equal((await run(send)).owner, "invite-emailed");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, OWNER);
  assert.ok(sent[0].text.includes(`https://preview-branch.example.com/signup?invite=${invite.code}`));
  assert.ok(sent[0].text.includes("24 hours"));
  assert.ok(lines.includes("invite: emailed"));
  assert.notEqual((await invites())[0].sent_at, null);
  before = await snapshot();
  assert.equal((await run(send)).owner, "invite-already-emailed");
  assert.equal(sent.length, 1);
  assert.equal(await snapshot(), before, "a rerun after mailing changed the databases");
  delete process.env.RESEND_API_KEY;
  delete process.env.MAIL_FROM;

  /* ── the owner signed up: Preview workspace + one test grant ── */
  const account = await platform.createAccount(OWNER, "Owner", hashPassword("Unique-studio-password-43"));
  report = await run();
  assert.deepEqual(
    { owner: report.owner, workspace: report.workspace, credits: report.credits, tenants: report.tenants },
    { owner: "account", workspace: "created", credits: "granted", tenants: { ok: 2, failed: 0 } },
  );
  const p = platform.platformDb();
  const owned = (
    await p.execute(
      `SELECT w.id, w.name FROM workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE m.account_id=? AND m.role='owner' AND w.deleted_at IS NULL`,
      [account.id],
    )
  ).rows;
  assert.deepEqual(owned.map((r) => r.name), ["Preview"]);
  const wsId = String(owned[0].id);
  const grants = (await p.execute(`SELECT id, credits, kind FROM credit_grants WHERE workspace_id=?`, [wsId])).rows;
  assert.deepEqual(grants.map((g) => ({ ...g })), [{ id: seed.previewGrantId(wsId), credits: seed.PREVIEW_TEST_CREDITS, kind: "manual" }]);
  assert.equal((await billingStateFor(wsId)).credits.balance, seed.PREVIEW_TEST_CREDITS);

  // The owner's address reaches no workspace but his own Preview, and there only as its owner.
  for (const file of databases().slice(1)) {
    const rows = await rowsOf(file);
    const holding = Object.keys(rows).filter((t) => t !== "(schema)" && JSON.stringify(rows[t]).includes(OWNER));
    assert.deepEqual(holding, file.includes(wsId.replace(/^ws_/, "")) ? ["users"] : [], path.basename(file));
  }

  before = await snapshot();
  report = await run();
  assert.deepEqual({ owner: report.owner, workspace: report.workspace, credits: report.credits }, { owner: "account", workspace: "existing", credits: "already" });
  assert.equal(await snapshot(), before, "a rerun with the workspace in place changed the databases");

  // The grant's fixed id holds even if two writers race past the existence check.
  await platform.grantCreditsBatch([{ id: seed.previewGrantId(wsId), workspaceId: wsId, credits: seed.PREVIEW_TEST_CREDITS, note: "Preview test credits", by: null, kind: "manual" }]);
  assert.equal(Number((await p.execute(`SELECT COUNT(*) AS n FROM credit_grants WHERE workspace_id=?`, [wsId])).rows[0].n), 1);

  // No log line carries an address, a code, a link, a token or a path.
  for (const line of lines) {
    assert.doesNotMatch(line, /@|https?:|invite=|\/signup|file:|libsql:/i, "log line");
    for (const secret of secrets) assert.ok(!line.includes(secret), "log line carries a secret");
  }
  for (const line of lines) console.log(line);
  console.log(JSON.stringify({ ok: true, runs: 7, lines: lines.length }));
  process.exit(0);
})().catch((error) => {
  // Assertion messages name steps and tables; the values compared are fixtures.
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
