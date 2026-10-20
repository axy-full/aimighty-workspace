// Remotion worker smoke test. Run in the production app's terminal (it has
// REMOTION_WORKER_URLS and REMOTION_WORKER_SECRETS, comma lists in the same order,
// and can reach the workers). Costs nothing: a 2-second sample picture of our own
// (no media, no engine) rendered on every worker, a refusal check, then each session
// is deleted. Nothing is stored or billed.
//   node /tmp/remotion-smoke.mjs
import { randomUUID } from "node:crypto";

const list = (name) => (process.env[name] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
const workers = list("REMOTION_WORKER_URLS");
const secrets = list("REMOTION_WORKER_SECRETS");
if (!workers.length || secrets.length !== workers.length || secrets.some((secret) => secret.length < 32)) {
  console.log("Needs REMOTION_WORKER_URLS and REMOTION_WORKER_SECRETS: comma lists of the same length, each secret at least 32 characters.");
  process.exit(2);
}
const ROOT = "/vercel/sandbox/remotion";
const COMMAND = { cmd: "/usr/local/bin/node", args: ["/opt/remotion/cli.mjs"] };
const GOOD = { version: 1, composition: "fixture-clip", props: { aspect: "16:9", fps: 30, scale: 0.25, durationSeconds: 2, label: "SMOKE" }, output: { video: true, stills: [30] } };
const BAD = { version: 1, composition: "not-ours", props: {} };

async function call(base, secret, method, path, { json, body, auth = true } = {}) {
  const headers = auth ? { authorization: `Bearer ${secret}` } : {};
  if (json) headers["content-type"] = "application/json";
  const res = await fetch(base + path, { method, headers, body: json ? JSON.stringify(json) : body, signal: AbortSignal.timeout(200_000) });
  const bytes = Buffer.from(await res.arrayBuffer());
  let data = null;
  try { data = JSON.parse(bytes.toString("utf8")); } catch { /* a file */ }
  return { status: res.status, data, bytes };
}

async function smoke(base, secret) {
  const unauthenticated = await call(base, secret, "GET", "/v1/sessions", { auth: false });
  if (unauthenticated.status !== 401) throw new Error(`expected 401 without the secret, got ${unauthenticated.status}`);
  const name = `remotion-export-${randomUUID()}`;
  const created = await call(base, secret, "POST", "/v1/sessions", { json: { name } });
  if (created.status !== 201) throw new Error(`create answered ${created.status} ${JSON.stringify(created.data)}`);
  const session = `/v1/sessions/${name}`;
  const put = async (file, content) => {
    const res = await call(base, secret, "PUT", `${session}/files?path=${encodeURIComponent(`${ROOT}/${file}`)}`, { body: content });
    if (res.status !== 201) throw new Error(`upload ${file} answered ${res.status}`);
  };
  const run = (timeoutMs) => call(base, secret, "POST", `${session}/run`, { json: { ...COMMAND, timeoutMs } });
  try {
    // 1. A good export.
    await put("spec.json", JSON.stringify(GOOD));
    const started = Date.now();
    const done = await run(170_000);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (done.status !== 200 || done.data.exitCode !== 0) {
      console.log(done.data?.stderr?.slice(-3000) ?? "");
      throw new Error(`run answered ${done.status}, exit ${done.data?.exitCode} after ${seconds} s`);
    }
    const sizes = {};
    for (const [file, magic, offset] of [["export.mp4", "ftyp", 4], ["still-30.png", "\x89PNG", 0], ["result.json", "{", 0]]) {
      const got = await call(base, secret, "GET", `${session}/files?path=${encodeURIComponent(`${ROOT}/output/${file}`)}`);
      if (got.status !== 200 || got.bytes.subarray(offset, offset + magic.length).toString("latin1") !== magic) throw new Error(`${file}: ${got.status}`);
      sizes[file] = got.bytes.length;
    }
    // 2. The command refuses what it should: a spec for a template that is not ours exits 2.
    await put("spec.json", JSON.stringify(BAD));
    const refused = await run(60_000);
    if (refused.data?.exitCode !== 2) throw new Error(`a bad spec should exit 2, got ${refused.data?.exitCode}`);
    return { seconds, sizes };
  } finally {
    const stopped = await call(base, secret, "DELETE", session);
    console.log(`  usage: ${JSON.stringify(stopped.data)}`);
  }
}

let failed = 0;
for (const [index, base] of workers.entries()) {
  try {
    const { seconds, sizes } = await smoke(base.replace(/\/$/, ""), secrets[index]);
    console.log(`OK   ${base}: exported in ${seconds} s, outputs ${JSON.stringify(sizes)}, a bad spec was refused`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${base}: ${error.message}`);
  }
}
process.exit(failed ? 1 : 0);
