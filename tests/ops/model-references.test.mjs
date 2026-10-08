import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import { DROPPED_MODEL_IDS, main, modelReferences } from "../../scripts/ops/model-references.mjs";

// file: databases only; nothing leaves the process.

const KEYRING = "fixture-keyring-secret-of-32-characters-at-least";
// The app's own format (lib/keyring.ts seal), as tests/ops/blob-to-r2.test.mjs builds it.
function seal(plain, secret = KEYRING) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}
// Values that must never reach the output.
const SECRET_PROMPT = "PROMPT-a-lighthouse-keeper-sentinel",
  SECRET_TITLE = "TITLE-private-chat-sentinel",
  SECRET_EMAIL = "person-sentinel@example.test",
  SECRET_NAME = "NAME-workspace-sentinel",
  TOKEN = "fixture-tenant-token-value-AAA";

async function databases(root) {
  const href = (name) => pathToFileURL(join(root, name)).href;
  const platform = createClient({ url: href("platform.db") }),
    tenant = createClient({ url: href("tenant.db") }),
    other = createClient({ url: href("other.db") });
  await platform.executeMultiple(`CREATE TABLE workspaces(id TEXT PRIMARY KEY,name TEXT,db_url TEXT NOT NULL,db_token_enc TEXT,legacy INTEGER NOT NULL DEFAULT 0,purged_at INTEGER);
    CREATE TABLE workspace_provisioning(request_id TEXT PRIMARY KEY,workspace_id TEXT,db_url TEXT,db_token_enc TEXT);
    CREATE TABLE platform_layer(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL,updated_by TEXT);
    CREATE TABLE meter_events(id TEXT PRIMARY KEY,workspace_id TEXT,model TEXT NOT NULL,created_by TEXT);
    CREATE TABLE atomik_chats(id TEXT PRIMARY KEY,title TEXT,model TEXT NOT NULL DEFAULT 'auto',created_by TEXT,deleted INTEGER NOT NULL DEFAULT 0);`);
  await platform.execute({
    sql: "INSERT INTO workspaces VALUES('ws_legacy',?,'unused',NULL,1,NULL),('ws_tenant',?,?,?,0,NULL),('ws_other',?,?,NULL,0,NULL)",
    args: [SECRET_NAME, SECRET_NAME, href("tenant.db"), seal(TOKEN), SECRET_NAME, href("other.db")],
  });
  await platform.execute({
    sql: "INSERT INTO platform_layer VALUES('models',?,1,?),('caps',?,1,NULL)",
    args: [JSON.stringify({ video: "v", image: "i", text: { enhance: "anthropic/claude-3-haiku", idea: "anthropic/claude-opus-5", shot: "anthropic/claude-opus-5" } }), SECRET_EMAIL, JSON.stringify({ note: "openai/gpt-5.5-pro" })],
  });
  await platform.execute({ sql: "INSERT INTO meter_events VALUES('m1','ws_tenant','openai/gpt-5.5-pro',?),('m2','ws_tenant','openai/gpt-5.5',?)", args: [SECRET_EMAIL, SECRET_EMAIL] });
  // A legacy workspace keeps its tables in the platform database.
  await platform.execute({ sql: "INSERT INTO atomik_chats VALUES('c1',?,'openai/o3-pro',?,0)", args: [SECRET_TITLE, SECRET_EMAIL] });

  await tenant.executeMultiple(`CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_by TEXT,updated_at INTEGER);
    CREATE TABLE atomik_chats(id TEXT PRIMARY KEY,title TEXT,model TEXT NOT NULL DEFAULT 'auto',created_by TEXT,deleted INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE ideas(id TEXT PRIMARY KEY,logline TEXT,model TEXT);
    CREATE TABLE workbench_projects(key TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE TABLE atomik_messages(id TEXT PRIMARY KEY,text TEXT,model TEXT NOT NULL DEFAULT '');`);
  await tenant.execute({ sql: "INSERT INTO settings VALUES('atomikEngines',?,?,1),('namingTemplate',?,?,1)", args: [JSON.stringify(["openai/gpt-5.5-pro"]), SECRET_EMAIL, "{model}", SECRET_EMAIL] });
  await tenant.execute({
    sql: "INSERT INTO atomik_chats VALUES('a',?,'openai/gpt-5.5-pro',?,0),('b',?,'openai/gpt-5.5-pro',?,0),('c',?,'openai/gpt-5.5-pro',?,1),('d',?,'openai/gpt-5.5',?,0),('e',?,'anthropic/claude-opus-5-fast',?,0)",
    args: Array(5).fill(0).flatMap(() => [SECRET_TITLE, SECRET_EMAIL]),
  });
  // A longer id that contains a dropped one is not a match.
  await tenant.execute({ sql: "INSERT INTO ideas VALUES('i1',?,'openai/gpt-5-pro'),('i2',?,'openai/gpt-5-pro-plus'),('i3',?,NULL)", args: [SECRET_PROMPT, SECRET_PROMPT, SECRET_PROMPT] });
  await tenant.execute({
    sql: "INSERT INTO workbench_projects VALUES('k',?)",
    args: [JSON.stringify({ name: SECRET_NAME, brief: SECRET_PROMPT, plans: [{ model: "anthropic/claude-3-haiku", request: SECRET_PROMPT }, { model: "anthropic/claude-3-haiku" }] })],
  });
  await tenant.execute({ sql: "INSERT INTO atomik_messages VALUES('x',?,'openai/gpt-oss-20b')", args: [SECRET_PROMPT] });
  // A workspace database without the newer tables.
  await other.executeMultiple(`CREATE TABLE atomik_chats(id TEXT PRIMARY KEY,title TEXT,model TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0);
    INSERT INTO atomik_chats VALUES('z','t','anthropic/claude-sonnet-4.6',0);`);
  for (const db of [platform, tenant, other]) db.close();
  return { PLATFORM_DATABASE_URL: href("platform.db"), TURSO_DATABASE_URL: href("platform.db"), KEYRING_SECRET: KEYRING };
}

const fingerprint = async (root) => {
  const out = {};
  for (const name of ["platform.db", "tenant.db", "other.db"]) {
    const path = join(root, name);
    out[name] = [createHash("sha256").update(await readFile(path)).digest("hex"), (await stat(path)).mtimeMs];
  }
  return out;
};

test("counts every saved reference per dropped id and per place, reads snapshots only, and prints no value", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "particl-model-references-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = await databases(root);
  const before = await fingerprint(root);

  const report = await modelReferences(env);
  assert.equal(report.readOnly, true);
  assert.equal(report.databases, 3);
  assert.equal(report.workspaces, 3);
  assert.deepEqual(report.byModel, {
    ...Object.fromEntries(DROPPED_MODEL_IDS.map((id) => [id, 0])),
    "anthropic/claude-3-haiku": 2, // platform routing, one project body (one row, two plans)
    "openai/gpt-5.5-pro": 4, // a meter row, the settings row, two live chats (the deleted one is not counted)
    "openai/o3-pro": 1, // the legacy workspace's chat
    "anthropic/claude-opus-5-fast": 1,
    "openai/gpt-5-pro": 1, // not the longer id that contains it
    "openai/gpt-oss-20b": 1,
  });
  assert.deepEqual(report.byPlace, {
    "platform_layer[models].text": { use: "choice", rows: 1 },
    "meter_events.model": { use: "history", rows: 1 },
    "atomik_chats.model": { use: "choice", rows: 4 },
    "settings[atomikEngines]": { use: "choice", rows: 1 },
    "ideas.model": { use: "choice", rows: 1 },
    "workbench_projects.body (plans[].model)": { use: "history", rows: 1 },
    "atomik_messages.model": { use: "history", rows: 1 },
  });
  assert.equal(report.savedChoices, 7);
  assert.deepEqual(report.perDatabase.map((d) => [d.database, d.workspaceIds]), [
    ["platform", ["ws_legacy"]],
    ["tenant-1", ["ws_tenant"]],
  ]);
  assert.deepEqual(report.perDatabase[0].found.find((f) => f.place === "atomik_chats.model"), { place: "atomik_chats.model", use: "choice", model: "openai/o3-pro", rows: 1 });

  // Read-only: the sources are byte for byte what they were.
  assert.deepEqual(await fingerprint(root), before);

  // The printed report holds counts, ids of models and workspaces, and place names: never a value.
  const printed = [];
  const log = console.log;
  console.log = (line) => printed.push(String(line));
  let code;
  try {
    code = await main(env);
  } finally {
    console.log = log;
  }
  assert.equal(code, 0);
  const text = printed.join("\n");
  assert.deepEqual(JSON.parse(text).byModel, report.byModel);
  for (const leak of [SECRET_PROMPT, SECRET_TITLE, SECRET_EMAIL, SECRET_NAME, TOKEN, KEYRING, "tenant.db", "other.db", root, "{model}", "gpt-5-pro-plus"])
    assert.equal(text.includes(leak), false, leak);
});

test("a wrong environment stops with the reason and no value", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "particl-model-references-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = await databases(root);
  const errors = [];
  const error = console.error;
  console.error = (line) => errors.push(String(line));
  try {
    assert.equal(await main({}), 1);
    assert.equal(await main({ ...env, KEYRING_SECRET: "the-secret-the-deployment-really-used" }), 1);
  } finally {
    console.error = error;
  }
  assert.match(errors[0], /needs PLATFORM_DATABASE_URL/);
  assert.match(errors[1], /workspace ws_tenant/);
  for (const line of errors) for (const leak of [TOKEN, KEYRING, "tenant.db"]) assert.equal(line.includes(leak), false, leak);
});
