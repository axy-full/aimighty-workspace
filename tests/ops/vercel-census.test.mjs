import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import { census, main, parseArguments } from "../../scripts/ops/vercel-census.mjs";
import net from "node:net";
import tls from "node:tls";
import { verifyMediaReferences } from "../../scripts/ops/backup-lib.mjs";
import { parseArguments as parseCopyArguments, verifyR2Only } from "../../scripts/ops/blob-to-r2.mjs";
import { BLOB_ORIGIN, ENV, W, bytes, fakeBlob, fakeR2, fast } from "./helpers/storage-fakes.mjs";

// In-process only: an S3-compatible fake behind the real @aws-sdk/client-s3 command classes and an in-memory Blob SDK fake. Nothing here touches a real store or a
// real database, and no key is real.

async function privateRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "particl-vercel-census-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** One workspace (and one with a gateway key), with every kind of reference the census counts. */
async function databases(root) {
  const platformPath = join(root, "platform.db"),
    tenantPath = join(root, "tenant.db");
  const platform = createClient({ url: pathToFileURL(platformPath).href }),
    tenant = createClient({ url: pathToFileURL(tenantPath).href });
  await platform.executeMultiple(`CREATE TABLE workspaces(id TEXT PRIMARY KEY,db_url TEXT,legacy INTEGER,purged_at INTEGER,gateway_key_id TEXT);`);
  await platform.execute({ sql: "INSERT INTO workspaces VALUES('ws_fixture',?,0,NULL,'gk_secret_id'),('ws_other',?,0,NULL,NULL),('ws_blank',?,0,NULL,'')", args: [pathToFileURL(tenantPath).href, pathToFileURL(tenantPath).href, pathToFileURL(tenantPath).href] });
  await tenant.executeMultiple(`CREATE TABLE generations(id TEXT PRIMARY KEY,status TEXT,kind TEXT,stored_url TEXT,deleted INTEGER);
    CREATE TABLE uploads(id TEXT PRIMARY KEY,ext TEXT,stored_url TEXT,kind TEXT,derivative_url TEXT);
    CREATE TABLE consent_recordings(id TEXT PRIMARY KEY,ext TEXT,stored_url TEXT);
    CREATE TABLE astra_render_jobs(id TEXT PRIMARY KEY,settled INTEGER,source_json TEXT);
    INSERT INTO generations VALUES('g_r2','succeeded','image','x',0),('g_blob','succeeded','video','x',0),('g_none','succeeded','audio','x',0),('g_old','failed','video',NULL,0);
    INSERT INTO uploads VALUES('u_r2','png','${W}uploads/u_r2.png','image',NULL),
      ('u_abs','pdf','${BLOB_ORIGIN}${W}uploads/Acme%20Merger-Zz99.pdf','file',NULL),
      ('u_deriv','mp4','${W}uploads/u_deriv.mp4','video','${W}uploads/u_deriv-api.jpg'),
      ('u_deriv_lost','mp4','${W}uploads/u_deriv_lost.mp4','video','${W}uploads/u_deriv_lost-api.jpg');
    INSERT INTO consent_recordings VALUES('c_r2','m4a','${W}consents/c_r2.m4a'),('c_blob','webm','${W}consents/c_blob.webm');
    INSERT INTO astra_render_jobs VALUES('j1',0,'{"engine":"vercel-sandbox"}'),('j2',0,'{}'),('j3',0,'{"engine":"selfhost-blender"}'),('j4',1,'{}'),('j5',0,'not json'),('j6',0,'{"engine":"selfhost-other"}');`);
  platform.close();
  tenant.close();
  return {
    version: 1,
    databases: [
      { id: "platform", role: "platform", url: pathToFileURL(platformPath).href },
      { id: "tenant", role: "tenant", url: pathToFileURL(tenantPath).href, workspaceIds: ["ws_fixture", "ws_other", "ws_blank"] },
    ],
  };
}
const onR2 = () =>
  new Map([
    [`${W}generations/g_r2.png`, bytes("g_r2")],
    [`${W}uploads/u_r2.png`, bytes("u_r2")],
    [`${W}uploads/u_deriv.mp4`, bytes("u_deriv")],
    [`${W}uploads/u_deriv-api.jpg`, bytes("u_deriv_copy")],
    [`${W}consents/c_r2.m4a`, bytes("c_r2")],
    [`${W}elsewhere/not-referenced.bin`, bytes("elsewhere")],
  ]);
const onBlob = () =>
  new Map([
    [`${W}generations/g_blob.mp4`, bytes("g_blob")],
    [`${W}uploads/Acme Merger-Zz99.pdf`, bytes("named")],
    [`${W}uploads/u_deriv_lost.mp4`, bytes("lost_master")],
    [`${W}uploads/u_deriv_lost-api.jpg`, bytes("lost_copy")],
    [`${W}consents/c_blob.webm`, bytes("c_blob")],
    [`${W}orphans/old-one.png`, bytes("orphan one")],
    [`${W}orphans/old-two.png`, bytes("orphan two, a little longer")],
    [`${W}generations/g_r2.png`, bytes("g_r2")],
  ]);

test("the census counts by table and kind, only counts on screen, and writes nothing to either store", async (t) => {
  const root = await privateRoot(t);
  const config = await databases(root);
  const dir = join(root, "private");
  const r2 = fakeR2(onR2());
  const blob = fakeBlob(onBlob());
  const result = await census({ privateDir: dir, config, env: ENV, r2Client: r2.factory, blobSdk: blob, retryOptions: fast });
  assert.deepEqual(result.references, {
    "consent_recordings/consent": { referenced: 2, onR2: 1, onBlobOnly: 1, onNeither: 0 },
    "generations/audio": { referenced: 1, onR2: 0, onBlobOnly: 0, onNeither: 1 },
    "generations/image": { referenced: 1, onR2: 1, onBlobOnly: 0, onNeither: 0 },
    "generations/video": { referenced: 1, onR2: 0, onBlobOnly: 1, onNeither: 0 },
    "uploads.derivative_url/derivative": { referenced: 2, onR2: 1, onBlobOnly: 1, onNeither: 0 },
    "uploads/file": { referenced: 1, onR2: 0, onBlobOnly: 1, onNeither: 0 },
    "uploads/image": { referenced: 1, onR2: 1, onBlobOnly: 0, onNeither: 0 },
    "uploads/video": { referenced: 2, onR2: 1, onBlobOnly: 1, onNeither: 0 },
  });
  assert.deepEqual(result.totals, { referenced: 11, onR2: 5, onBlobOnly: 5, onNeither: 1 });
  assert.equal(result.r2Objects, 6);
  assert.equal(result.blobObjects, 8);
  assert.deepEqual(result.blobOrphans, { objects: 2, bytes: bytes("orphan one").length + bytes("orphan two, a little longer").length });
  assert.equal(result.workspacesWithGatewayKey, 1);
  assert.deepEqual(result.astraJobsNotSettled, { vercel: 3, selfhost: 1, unreadable: 1 }); // 'selfhost-other' is not the app's selfhost engine, so the app reads it as Vercel's
  // Read only: lists and nothing else on either store.
  assert.deepEqual([...new Set(r2.calls.map((c) => c.name))], ["ListObjectsV2Command"]);
  assert.deepEqual(blob.reads, []);
  // Counts only: no key, URL, file name, workspace id, token or key id on screen.
  const printed = JSON.stringify(result);
  for (const leak of ["Acme", "Merger", "%20", "ws_fixture", "ws_other", "vercel-storage", ".png", ".pdf", ".mp4", ENV.BLOB_READ_WRITE_TOKEN, "gk_secret_id", "orphans/", "u_r2", "g_none"]) assert.equal(printed.includes(leak), false, leak);
  // Row ids for what is on neither store, and the orphans' keys, go to a private report only.
  assert.match(result.report, /^vercel-census-report-/);
  assert.equal((await stat(join(dir, result.report))).mode & 0o777, 0o600);
  const report = JSON.parse(await readFile(join(dir, result.report), "utf8"));
  assert.deepEqual(report.onNeither, ["tenant/generations/g_none"]);
  assert.deepEqual(report.blobOrphanKeys.sort(), [`${W}orphans/old-one.png`, `${W}orphans/old-two.png`]);
  assert.deepEqual((await readdir(dir)).filter((n) => n.startsWith("census-")), [], "snapshots are removed afterwards");
});

test("the census needs the Blob token, takes exactly one source and is refused for a private directory inside the checkout", async (t) => {
  const root = await privateRoot(t);
  const config = await databases(root);
  const noBlob = { ...ENV };
  delete noBlob.BLOB_READ_WRITE_TOKEN;
  await assert.rejects(census({ privateDir: join(root, "p"), config, env: noBlob, r2Client: fakeR2().factory }), /BLOB_READ_WRITE_TOKEN is not set/);
  await assert.rejects(census({ privateDir: new URL("../../scripts", import.meta.url).pathname, config, env: ENV, r2Client: fakeR2().factory, blobSdk: fakeBlob() }), /outside the repository/);
  assert.throws(() => parseArguments([]), /exactly one of --live or --config/);
  assert.throws(() => parseArguments(["--live", "--config", "c.json", "--private-dir", "/x"]), /exactly one of --live or --config/);
  assert.throws(() => parseArguments(["--live", "--nope"]), /Unknown argument/);
  assert.deepEqual(parseArguments(["--live", "--private-dir", "/x"]), { live: true, privateDir: "/x" });
  assert.equal(await main([]), 1);
});

test("verify now also checks consent recordings and an upload's delivery copy", async (t) => {
  const root = await privateRoot(t);
  const config = await databases(root);
  const dir = join(root, "private");
  const objects = onR2();
  for (const [key, body] of onBlob()) objects.set(key, body);
  const whole = await verifyR2Only({ privateDir: dir, config, env: ENV, r2Client: fakeR2(objects).factory, blobSdk: fakeBlob(onBlob()), retryOptions: fast });
  // g_none (audio) is on neither: the only gap. Everything else, including the two kinds added, resolves on R2 alone.
  assert.equal(whole.ok, false);
  assert.match(whole.missingReferences, /\(1\): tenant\/generations\/g_none$/);
  const gone = new Map(objects);
  gone.delete(`${W}consents/c_blob.webm`);
  gone.delete(`${W}uploads/u_deriv_lost-api.jpg`);
  gone.set(`${W}generations/g_none.mp3`, bytes("g_none"));
  const gaps = await verifyR2Only({ privateDir: dir, config, env: ENV, r2Client: fakeR2(gone).factory, blobSdk: fakeBlob(onBlob()), retryOptions: fast });
  assert.equal(gaps.ok, false);
  assert.match(gaps.missingReferences, /\(2\): .*tenant\/uploads\.derivative_url\/u_deriv_lost/);
  assert.match(gaps.missingReferences, /tenant\/consent_recordings\/c_blob/);
  const printed = JSON.stringify(gaps);
  for (const leak of ["consents/", ".webm", "-api.jpg", "ws_fixture"]) assert.equal(printed.includes(leak), false, leak);
  gone.set(`${W}consents/c_blob.webm`, bytes("c_blob"));
  gone.set(`${W}uploads/u_deriv_lost-api.jpg`, bytes("lost_copy"));
  const clean = await verifyR2Only({ privateDir: dir, config, env: { ...ENV, BLOB_READ_WRITE_TOKEN: undefined }, r2Client: fakeR2(gone).factory, retryOptions: fast });
  assert.equal(clean.ok, true, JSON.stringify(clean));
  assert.equal(clean.references, 11);
});

test("verify --open reads every referenced object straight from R2, one byte, size checked, and never from Blob", async (t) => {
  const root = await privateRoot(t);
  const config = await databases(root);
  const dir = join(root, "private");
  const objects = onR2();
  for (const [key, body] of onBlob()) objects.set(key, body);
  objects.set(`${W}generations/g_none.mp3`, bytes("g_none"));
  const r2 = fakeR2(objects);
  const blob = fakeBlob(onBlob());
  const result = await verifyR2Only({ privateDir: dir, config, open: true, env: ENV, r2Client: r2.factory, blobSdk: blob, retryOptions: fast });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.opened, 11);
  assert.equal(result.openFailures, 0);
  assert.equal(result.openReport, undefined);
  assert.deepEqual(blob.reads, [], "no Blob read");
  const gets = r2.calls.filter((c) => c.name === "GetObjectCommand");
  assert.equal(gets.length, 11);
  assert.ok(gets.every((c) => c.range === "bytes=0-0"));
  assert.equal(new Set(gets.map((c) => c.key)).size, 11);
  assert.ok(!gets.some((c) => c.key.includes("not-referenced") || c.key.includes("orphans")), "only referenced objects are opened");
  // Without --open nothing is read.
  const plain = fakeR2(objects);
  const noOpen = await verifyR2Only({ privateDir: dir, config, env: ENV, r2Client: plain.factory, blobSdk: fakeBlob(onBlob()), retryOptions: fast });
  assert.equal(plain.calls.filter((c) => c.name === "GetObjectCommand").length, 0);
  assert.equal(noOpen.opened, undefined);
  assert.equal(noOpen.openFailures, undefined);
});

test("verify --open reports an object that will not open, or whose size is not the listing's, by row only; the keys go to the private report", async (t) => {
  const root = await privateRoot(t);
  const config = await databases(root);
  const dir = join(root, "private");
  const objects = onR2();
  for (const [key, body] of onBlob()) objects.set(key, body);
  objects.set(`${W}generations/g_none.mp3`, bytes("g_none"));
  const r2 = fakeR2(objects);
  r2.faults.set(`GetObjectCommand:${W}uploads/u_r2.png`, 403);
  r2.sizeLies.set(`${W}consents/c_r2.m4a`, 999);
  const result = await verifyR2Only({ privateDir: dir, config, open: true, env: { ...ENV, BLOB_READ_WRITE_TOKEN: undefined }, r2Client: r2.factory, retryOptions: fast });
  assert.equal(result.ok, false);
  assert.equal(result.opened, 11);
  assert.equal(result.openFailures, 2);
  const printed = JSON.stringify(result);
  for (const leak of ["u_r2.png", "c_r2.m4a", "uploads/", "consents/", "ws_fixture", "403"]) assert.equal(printed.includes(leak), false, leak);
  assert.equal((await stat(join(dir, result.openReport))).mode & 0o777, 0o600);
  const report = JSON.parse(await readFile(join(dir, result.openReport), "utf8"));
  assert.deepEqual(report.failures.map((f) => [f.reason, f.rows[0]]).sort(), [["size", "tenant/consent_recordings/c_r2"], ["unreadable", "tenant/uploads/u_r2"]]);
  // A missing object (404) is named as missing.
  r2.faults.clear();
  r2.sizeLies.clear();
  r2.faults.set(`GetObjectCommand:${W}uploads/u_r2.png`, 404);
  const missing = await verifyR2Only({ privateDir: dir, config, open: true, env: { ...ENV, BLOB_READ_WRITE_TOKEN: undefined }, r2Client: r2.factory, retryOptions: fast });
  assert.equal(missing.openFailures, 1);
  assert.equal(JSON.parse(await readFile(join(dir, missing.openReport), "utf8")).failures[0].reason, "missing");
});

test("--open belongs to --verify only, and is not in the parsed options unless given", () => {
  assert.equal(parseCopyArguments(["--verify", "--private-dir", "/x", "--live", "--open"]).open, true);
  assert.equal("open" in parseCopyArguments(["--verify", "--private-dir", "/x", "--live"]), false);
  assert.throws(() => parseCopyArguments(["--copy", "--private-dir", "/x", "--open"]), /--open works only with --verify/);
});

test("backup, restore and the recovery report are unchanged: without { extended: true } the two added kinds are not checked, and they are when it is passed", async (t) => {
  const root = await privateRoot(t);
  const config = await databases(root);
  const databaseList = config.databases.map((d) => ({ id: d.id, role: d.role, workspaceIds: d.workspaceIds ?? [], snapshot: new URL(d.url).pathname, inventory: { tables: [] } }));
  const { createClient: client } = await import("@libsql/client");
  for (const d of databaseList) {
    const db = client({ url: pathToFileURL(d.snapshot).href });
    d.inventory = { tables: (await db.execute("SELECT name FROM sqlite_master WHERE type='table'")).rows.map((r) => ({ name: String(r.name) })) };
    db.close();
  }
  // Everything the old checks look at is there; the delivery copy and the recordings are not (nor is g_none, so give it a file).
  const entries = [...new Map([...onR2(), ...onBlob()]).entries()].filter(([key]) => !key.includes("-api.jpg") && !key.includes("consents/")).map(([pathname, body]) => ({ store: "r2", pathname, size: body.length }));
  entries.push({ store: "r2", pathname: `${W}generations/g_none.mp3`, size: 1 });
  const seen = [];
  const plain = await verifyMediaReferences(databaseList, entries, "r2", { onReference: (r) => seen.push(r.table) });
  assert.equal(plain.references, 7, "the masters of generations and uploads only");
  assert.ok(!seen.some((table) => table === "uploads.derivative_url" || table === "consent_recordings"));
  // Extended, the same inventory is a failure that names the rows.
  await assert.rejects(verifyMediaReferences(databaseList, entries, "r2", { extended: true }), /tenant\/uploads\.derivative_url\/u_deriv.*tenant\/consent_recordings\/c_r2/s);
  // And for the local kind the extended checks are skipped either way (recordings live outside that layout).
  const local = await verifyMediaReferences(databaseList, entries.map((e) => ({ ...e, store: "local", pathname: e.pathname.replace(W, "") })), "local", { extended: true }).catch((e) => e.message);
  assert.ok(typeof local === "object" || !/consent_recordings|derivative/.test(local));
});

test("the network tripwire: no socket opens to anything but a local path, even for a library that bypasses a fetch stub", async () => {
  assert.throws(() => net.connect({ host: "example.invalid", port: 443 }), /Network blocked/);
  assert.throws(() => net.connect(80, "example.invalid"), /Network blocked/);
  assert.throws(() => tls.connect({ host: "example.invalid", port: 443 }), /Network blocked/);
  // A local (IPC) path is still allowed: the tripwire is for the network, not for a test's own pipes.
  const server = net.createServer();
  const path = join(await mkdtemp(join(tmpdir(), "particl-ipc-")), "s.sock");
  await new Promise((resolve) => server.listen(path, resolve));
  await new Promise((resolve, reject) => { const c = net.connect(path, resolve); c.on("error", reject); c.on("connect", () => c.destroy()); });
  server.close();
  assert.equal(ENV.R2_ENDPOINT, "https://127.0.0.1:9");
});
