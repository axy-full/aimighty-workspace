// Render worker smoke test. Run in the production app's terminal (it has
// ASTRA_WORKER_URLS and ASTRA_WORKER_SECRETS, comma lists in the same order,
// and can reach the workers). Costs nothing: a 128 px render of Blender's own
// default cube on every worker, then each session is deleted.
//   node /tmp/render-smoke.mjs
import { randomUUID } from "node:crypto";

const list = (name) => (process.env[name] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
const workers = list("ASTRA_WORKER_URLS");
const secrets = list("ASTRA_WORKER_SECRETS");
if (!workers.length || secrets.length !== workers.length || secrets.some((secret) => secret.length < 32)) {
  console.log("Needs ASTRA_WORKER_URLS and ASTRA_WORKER_SECRETS: comma lists of the same length, each secret at least 32 characters.");
  process.exit(2);
}
const ROOT = "/vercel/sandbox/astra";
const SCENE = `import bpy, pathlib, sys
out = pathlib.Path(sys.argv[sys.argv.index('--') + 1])
out.mkdir(parents=True, exist_ok=True)
assert bpy.app.version == (5, 2, 2), bpy.app.version
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 4
scene.render.resolution_x = 128
scene.render.resolution_y = 128
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = str(out / 'preview.png')
bpy.ops.wm.save_as_mainfile(filepath=str(out / 'scene.blend'), check_existing=False, compress=False)
bpy.ops.render.render(write_still=True)
bpy.ops.export_scene.gltf(filepath=str(out / 'scene.glb'), export_format='GLB')
print('SMOKE_SCENE_DONE')
`;
// The app's launcher (lib/astra-blender/sandbox.ts): rlimits, then Blender with a fixed environment.
const LAUNCHER = `import os, resource
resource.setrlimit(resource.RLIMIT_AS, (3584 * 1024 * 1024, 3584 * 1024 * 1024))
resource.setrlimit(resource.RLIMIT_FSIZE, (256 * 1024 * 1024, 256 * 1024 * 1024))
resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
resource.setrlimit(resource.RLIMIT_CPU, (330, 330))
os.execve('/opt/astra-blender/blender', ['/opt/astra-blender/blender', '--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--threads', '2', '--python', '${ROOT}/scene.py', '--', '${ROOT}/output'], {'PATH': '/usr/bin:/bin', 'OMP_NUM_THREADS': '2', 'OPENBLAS_NUM_THREADS': '2', 'BLENDER_USER_CONFIG': '/tmp/astra-blender-config'})
`;

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
  const name = `astra-blender-${randomUUID()}`;
  const created = await call(base, secret, "POST", "/v1/sessions", { json: { name } });
  if (created.status !== 201) throw new Error(`create answered ${created.status} ${JSON.stringify(created.data)}`);
  const session = `/v1/sessions/${name}`;
  try {
    for (const [file, content] of [["scene.py", SCENE], ["run.py", LAUNCHER]]) {
      const put = await call(base, secret, "PUT", `${session}/files?path=${encodeURIComponent(`${ROOT}/${file}`)}`, { body: content });
      if (put.status !== 201) throw new Error(`upload ${file} answered ${put.status}`);
    }
    const started = Date.now();
    const run = await call(base, secret, "POST", `${session}/run`, { json: { cmd: "/usr/bin/python3", args: ["run.py"], cwd: ROOT, timeoutMs: 170_000 } });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (run.status !== 200 || run.data.exitCode !== 0) {
      console.log(run.data?.stderr?.slice(-3000) ?? "");
      throw new Error(`run answered ${run.status}, exit ${run.data?.exitCode} after ${seconds} s`);
    }
    const sizes = {};
    for (const [file, magic] of [["scene.blend", "BLENDER"], ["preview.png", "\x89PNG"], ["scene.glb", "glTF"]]) {
      const got = await call(base, secret, "GET", `${session}/files?path=${encodeURIComponent(`${ROOT}/output/${file}`)}`);
      if (got.status !== 200 || got.bytes.subarray(0, magic.length).toString("latin1") !== magic) throw new Error(`${file}: ${got.status}`);
      sizes[file] = got.bytes.length;
    }
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
    console.log(`OK   ${base}: rendered in ${seconds} s, outputs ${JSON.stringify(sizes)}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${base}: ${error.message}`);
  }
}
process.exit(failed ? 1 : 0);
