// Remotion worker measurement. Run in the production app's terminal (REMOTION_WORKER_URLS and
// REMOTION_WORKER_SECRETS, as for the smoke test). Costs nothing: no engine, no money, nothing stored.
// It makes its own 28 s 1080p source on the worker, then times the real export on it: that source
// with captions plus a 2 s end card = 30 s of 1080p. Prints wall time and CPU time per worker; the
// advisor reads peak memory from `docker stats` while it runs (README, Limits).
//   node /tmp/remotion-measure.mjs
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
const SOURCE = { aspect: "16:9", fps: 30, scale: 1, durationSeconds: 28, label: "MEASURE" };
const CUES = Array.from({ length: 14 }, (_, i) => ({ startMs: i * 2000 + 200, endMs: i * 2000 + 1800, text: `Caption number ${i + 1} on the measurement cut` }));

async function call(base, secret, method, path, { json, body } = {}) {
  const headers = { authorization: `Bearer ${secret}` };
  if (json) headers["content-type"] = "application/json";
  const res = await fetch(base + path, { method, headers, body: json ? JSON.stringify(json) : body, signal: AbortSignal.timeout(960_000) });
  const bytes = Buffer.from(await res.arrayBuffer());
  let data = null;
  try { data = JSON.parse(bytes.toString("utf8")); } catch { /* a file */ }
  return { status: res.status, data, bytes };
}

async function session(base, secret, work) {
  const name = `remotion-export-${randomUUID()}`;
  const created = await call(base, secret, "POST", "/v1/sessions", { json: { name } });
  if (created.status !== 201) throw new Error(`create answered ${created.status} ${JSON.stringify(created.data)}`);
  const path = `/v1/sessions/${name}`;
  try { return await work(path); } finally {
    const stopped = await call(base, secret, "DELETE", path);
    console.log(`  usage: ${JSON.stringify(stopped.data)}`);
  }
}
const put = async (base, secret, path, file, content) => {
  const res = await call(base, secret, "PUT", `${path}/files?path=${encodeURIComponent(`${ROOT}/${file}`)}`, { body: content });
  if (res.status !== 201) throw new Error(`upload ${file} answered ${res.status}`);
};
const run = (base, secret, path) => call(base, secret, "POST", `${path}/run`, { json: { ...COMMAND, timeoutMs: 900_000 } });

async function measure(base, secret) {
  // 1. The source: our own sample picture, 28 s at 1920x1080.
  const source = await session(base, secret, async (path) => {
    await put(base, secret, path, "spec.json", JSON.stringify({ version: 1, composition: "fixture-clip", props: SOURCE }));
    const made = await run(base, secret, path);
    if (made.data?.exitCode !== 0) throw new Error(`making the source failed (exit ${made.data?.exitCode}): ${made.data?.stderr?.slice(-1500)}`);
    const got = await call(base, secret, "GET", `${path}/files?path=${encodeURIComponent(`${ROOT}/output/export.mp4`)}`);
    if (got.status !== 200) throw new Error(`reading the source answered ${got.status}`);
    return got.bytes;
  });
  // 2. The measurement: that source, captioned, plus an end card.
  const spec = {
    version: 1,
    composition: "final",
    props: {
      aspect: "16:9",
      fps: 30,
      scale: 1,
      clips: [{ source: { file: "source.mp4", durationSeconds: 28, width: 1920, height: 1080, hasAudio: false }, cues: CUES, reframe: { mode: "fill", focusX: 0.5, focusY: 0.5 } }],
      captionStyle: "karaoke",
      end: { headline: "Measurement", callToAction: "Done", line: "30 s at 1080p", durationSeconds: 2 },
    },
  };
  return session(base, secret, async (path) => {
    await put(base, secret, path, "input/source.mp4", source);
    await put(base, secret, path, "spec.json", JSON.stringify(spec));
    const started = Date.now();
    const done = await run(base, secret, path);
    const seconds = (Date.now() - started) / 1000;
    if (done.data?.exitCode !== 0) throw new Error(`the export failed (exit ${done.data?.exitCode}) after ${seconds.toFixed(1)} s: ${done.data?.stderr?.slice(-1500)}`);
    const out = await call(base, secret, "GET", `${path}/files?path=${encodeURIComponent(`${ROOT}/output/export.mp4`)}`);
    return { seconds, bytes: out.bytes.length };
  });
}

let failed = 0;
for (const [index, base] of workers.entries()) {
  try {
    const { seconds, bytes } = await measure(base.replace(/\/$/, ""), secrets[index]);
    console.log(`OK   ${base}: 30 s 1080p export took ${seconds.toFixed(1)} s wall, output ${(bytes / 1048576).toFixed(1)} MiB (read activeCpuMs above; peak memory from docker stats)`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${base}: ${error.message}`);
  }
}
process.exit(failed ? 1 : 0);
