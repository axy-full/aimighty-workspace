import { test, expect } from "@playwright/test";
import { Readable } from "node:stream";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Sandbox } from "@vercel/sandbox";
import { createAstraScene, type AstraObject } from "../../lib/astra-blender/scene";
import { renderAstraScene, validateAstraGlb, getAstraRenderStatus, cancelAstraRender, ASTRA_SANDBOX_INPUT_DIR, ASTRA_SANDBOX_OUTPUT_DIR, type AstraSandboxSdk, type AstraSandboxHandle, type AstraSandboxCreateOptions, type AstraSandboxCommand } from "../../lib/astra-blender/sandbox";

const ID = "astra-blender-00000000-0000-4000-8000-000000000000";
const SNAPSHOT = "snap_verified-test";
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDpkAAAAASUVORK5CYII=','base64');

function glb(document: unknown = { asset: { version: "2.0" } }) {
  const json = Buffer.from(JSON.stringify({ buffers: [{ byteLength: 4 }], ...(document as Record<string, unknown>) }));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 32);
  json.copy(padded);
  const header = Buffer.alloc(20);
  header.write("glTF"); header.writeUInt32LE(2, 4); header.writeUInt32LE(32 + padded.length, 8);
  header.writeUInt32LE(padded.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  const binary = Buffer.alloc(12); binary.writeUInt32LE(4); binary.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, padded, binary]);
}

function fake() {
  const calls: string[] = [];
  const created: AstraSandboxCreateOptions[] = [];
  const commands: AstraSandboxCommand[] = [];
  const writes: { path: string; content: string | Uint8Array }[] = [];
  const files = new Map<string, Buffer>([
    ["scene.blend", Buffer.from("BLENDER-v502test")], ["preview.png", png], ["scene.glb", glb()],
  ]);
  const handle: AstraSandboxHandle = {
    name: ID, status: "running",
    writeFiles: async values => { calls.push("write"); writes.push(...values); },
    runCommand: async command => { calls.push("run"); commands.push(command); return { exitCode: 0 }; },
    readFile: async ({ path }) => { calls.push(`read:${path}`); const data = files.get(path.split("/").at(-1)!); return data ? Readable.from([data]) : null; },
    stop: async () => { calls.push("stop"); return {}; },
  };
  const lookups: { name: string; resume: false; signal?: AbortSignal }[] = [];
  const sdk: AstraSandboxSdk = {
    create: async options => { calls.push("create"); created.push(options); return handle; },
    get: async options => { calls.push("get"); lookups.push(options); return handle; },
  };
  return { sdk, handle, calls, created, commands, writes, files, lookups };
}

function modelScene() {
  const scene = createAstraScene("empty");
  const object: AstraObject = { id: "model-1", name: "Imported model", type: "model", assetId: "asset-1", position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], visible: true, locked: false, material: { color: "#ffffff", metalness: 0, roughness: 0.5 }, keyframes: [] };
  scene.objects.push(object);
  return scene;
}

test("an unavailable runtime fails before creating a sandbox", async () => {
  const f = fake();
  await expect(renderAstraScene(createAstraScene(), {}, [], undefined, { sdk: f.sdk, snapshotId: "" })).rejects.toMatchObject({ code: "not_configured" });
  expect(f.calls).toEqual([]);
});

test("mock mode blocks the real SDK with a live snapshot while injected fakes remain usable", async () => {
  const previous = process.env.ENGINE_MOCK;
  const original = Sandbox.create;
  let realCalls = 0;
  Sandbox.create = async () => { realCalls++; throw new Error("Unexpected real Sandbox.create"); };
  process.env.ENGINE_MOCK = "1";
  try {
    await expect(renderAstraScene(createAstraScene(), {}, [], undefined, { snapshotId: SNAPSHOT })).rejects.toMatchObject({ code: "not_configured", message: "Native Blender compute is disabled while ENGINE_MOCK=1." });
    expect(realCalls).toBe(0);
    const f = fake();
    await renderAstraScene(createAstraScene(), {}, [], undefined, { sdk: f.sdk, snapshotId: SNAPSHOT });
    expect(f.calls).toContain("create");
    expect(realCalls).toBe(0);
  } finally {
    Sandbox.create = original;
    if (previous === undefined) delete process.env.ENGINE_MOCK;
    else process.env.ENGINE_MOCK = previous;
  }
});

test("native execution is checkpointed, offline, ephemeral and bounded", async () => {
  const f = fake();
  const artifacts = await renderAstraScene(createAstraScene("product"), {}, [], async id => { expect(id).toBe(ID); f.calls.push("checkpoint"); }, { sdk: f.sdk, snapshotId: SNAPSHOT });
  expect(f.calls.slice(0, 4)).toEqual(["create", "checkpoint", "write", "run"]);
  expect(f.created[0]).toMatchObject({ source: { type: "snapshot", snapshotId: SNAPSHOT }, resources: { vcpus: 2 }, networkPolicy: "deny-all", persistent: false, env: {}, ports: [], timeout: 180000 });
  expect(f.created[0]?.name).toMatch(/^astra-blender-[a-f0-9-]{36}$/);
  expect(f.commands).toHaveLength(1);
  expect(f.commands[0]).toMatchObject({ cmd: "/usr/bin/python3", args: ["/vercel/sandbox/astra/run.py"], timeoutMs: 165000 });
  const launcher = String(f.writes.find(file => file.path.endsWith("/run.py"))!.content);
  expect(launcher).toContain("--disable-autoexec");
  expect(launcher).toContain("--python-exit-code");
  expect(launcher).toContain("resource.RLIMIT_AS");
  expect(launcher).toContain("resource.RLIMIT_FSIZE");
  expect(launcher).toContain("os.execve");
  expect(launcher).not.toContain("os.environ");
  expect(f.writes.map(file => file.path)).toEqual(["/vercel/sandbox/astra/scene.py", "/vercel/sandbox/astra/run.py"]);
  expect(artifacts).toEqual({ blend: f.files.get("scene.blend"), preview: png, glb: f.files.get("scene.glb") });
  expect(f.calls.at(-1)).toBe("stop");
});

test("checkpoint failure prevents files and execution and stops the VM", async () => {
  const f = fake();
  await expect(renderAstraScene(createAstraScene(), {}, [], async () => { throw new Error("database checkpoint failed"); }, { sdk: f.sdk, snapshotId: SNAPSHOT })).rejects.toThrow("database checkpoint failed");
  expect(f.calls).toEqual(["create", "stop"]);
});

test("valid embedded GLB bytes are sent only to the matching safe input path", async () => {
  const f = fake(), path = `${ASTRA_SANDBOX_INPUT_DIR}/asset-1.glb`, data = glb();
  await renderAstraScene(modelScene(), { "asset-1": { path, kind: "model" } }, [{ path, data }], undefined, { sdk: f.sdk, snapshotId: SNAPSHOT });
  expect(f.writes.find(file => file.path === path)?.content).toBe(data);
});

test("path traversal, mismatched files and unreferenced data fail before paid creation", async () => {
  const scene = modelScene(), path = `${ASTRA_SANDBOX_INPUT_DIR}/asset-1.glb`, data = glb();
  const cases = [
    { bindings: { "asset-1": { path, kind: "model" as const } }, inputs: [] },
    { bindings: { "asset-1": { path: "/opt/astra-blender/blender", kind: "model" as const } }, inputs: [{ path: "/opt/astra-blender/blender", data }] },
    { bindings: { "asset-1": { path, kind: "model" as const } }, inputs: [{ path, data }, { path, data }] },
    { bindings: { "asset-1": { path, kind: "model" as const } }, inputs: [{ path, data }, { path: `${ASTRA_SANDBOX_INPUT_DIR}/unused.glb`, data }] },
    { bindings: { "asset-1": { path: `${ASTRA_SANDBOX_INPUT_DIR}/../escape.glb`, kind: "model" as const } }, inputs: [{ path: `${ASTRA_SANDBOX_INPUT_DIR}/../escape.glb`, data }] },
  ];
  for (const item of cases) {
    const f = fake();
    await expect(renderAstraScene(scene, item.bindings, item.inputs, undefined, { sdk: f.sdk, snapshotId: SNAPSHOT })).rejects.toMatchObject({ code: "invalid_input" });
    expect(f.calls).toEqual([]);
  }
});

test("GLB sniffing refuses external references, compression, invalid chunk lengths and large graphs", () => {
  expect(() => validateAstraGlb(glb())).not.toThrow();
  for (const document of [
    { asset: { version: "1.0" } },
    { asset: { version: "2.0" }, buffers: [{ uri: "/etc/passwd", byteLength: 1 }] },
    { asset: { version: "2.0" }, images: [{ uri: "https://example.com/a.png" }] },
    { asset: { version: "2.0" }, images: [{ uri: "data:image/png;base64,aA==" }] },
    { asset: { version: "2.0" }, extensionsUsed: ["KHR_draco_mesh_compression"] },
    { asset: { version: "2.0" }, nodes: Array.from({ length: 257 }, () => ({})) },
    { asset: { version: "2.0" }, accessors: [{ count: 9000000 }] },
    { asset: { version: "2.0" }, accessors: [{ count: -1 }] },
    { asset: { version: "2.0" }, buffers: "bad shape" },
  ]) expect(() => validateAstraGlb(glb(document))).toThrow();
  const invalidLength = glb(); invalidLength.writeUInt32LE(0xffffffff, 12);
  expect(() => validateAstraGlb(invalidLength)).toThrow();
  expect(() => validateAstraGlb(Buffer.from("glTF"))).toThrow();
});

test("execution, upload and artifact failures stop the existing VM without retries", async () => {
  for (const failure of ["write", "render", "missing", "bad-preview", "bad-blend"] as const) {
    const f = fake();
    if (failure === "write") f.handle.writeFiles = async () => { f.calls.push("write"); throw new Error("upload interrupted"); };
    if (failure === "render") f.handle.runCommand = async () => { f.calls.push("run"); return { exitCode: 137 }; };
    if (failure === "missing") f.files.delete("scene.blend");
    if (failure === "bad-preview") f.files.set("preview.png", Buffer.from("<html>not an image"));
    if (failure === "bad-blend") f.files.set("scene.blend", Buffer.from("wrong file"));
    await expect(renderAstraScene(createAstraScene(), {}, [], undefined, { sdk: f.sdk, snapshotId: SNAPSHOT })).rejects.toThrow();
    expect(f.calls.filter(call => call === "create")).toHaveLength(1);
    expect(f.calls.filter(call => call === "run").length).toBeLessThanOrEqual(1);
    expect(f.calls.at(-1)).toBe("stop");
  }
});

test("streamed artifact collection cuts off oversized output before Buffer concatenation", async () => {
  const f = fake();
  let emitted = 0;
  const chunk = Buffer.alloc(1024 * 1024);
  const stream = Readable.from((function* () { for (let i = 0; i < 300; i++) { emitted++; yield chunk; } })());
  f.handle.readFile = async ({ path }) => path === `${ASTRA_SANDBOX_OUTPUT_DIR}/scene.blend` ? stream : null;
  await expect(renderAstraScene(createAstraScene(), {}, [], undefined, { sdk: f.sdk, snapshotId: SNAPSHOT })).rejects.toMatchObject({ code: "invalid_output" });
  expect(emitted).toBeLessThan(260);
  expect(stream.destroyed).toBe(true);
  expect(f.calls.at(-1)).toBe("stop");
});

test("a pre-aborted request does not start a VM and a failed stop is explicit", async () => {
  const f = fake();
  const controller = new AbortController(); controller.abort();
  await expect(renderAstraScene(createAstraScene(), {}, [], undefined, { sdk: f.sdk, snapshotId: SNAPSHOT, signal: controller.signal })).rejects.toThrow();
  expect(f.calls).toEqual([]);
  f.handle.stop = async () => { f.calls.push("stop"); throw new Error("network interrupted"); };
  await expect(renderAstraScene(createAstraScene(), {}, [], undefined, { sdk: f.sdk, snapshotId: SNAPSHOT })).rejects.toMatchObject({ code: "stop_unconfirmed" });
});

test("status and cancellation retrieve the persisted identity without resuming a VM", async () => {
  const f = fake();
  expect(await getAstraRenderStatus(ID, { sdk: f.sdk })).toEqual({ runtimeId: ID, status: "running", usage:null });
  expect(await cancelAstraRender(ID, { sdk: f.sdk })).toEqual({ runtimeId: ID, stopped: true, usage:null });
  expect(f.lookups.every(lookup => lookup.name === ID && lookup.resume === false)).toBe(true);
  expect(f.calls).toEqual(["get", "get", "stop", "get"]);
  f.handle.status = "stopped";
  await cancelAstraRender(ID, { sdk: f.sdk });
  expect(f.calls.at(-1)).toBe("get");
  await expect(cancelAstraRender("another-project", { sdk: f.sdk })).rejects.toMatchObject({ code: "invalid_input" });
});

test("snapshot setup is explicit, checksum pinned and safe to invoke without --create", () => {
  const source = readFileSync("scripts/astra-blender-snapshot.mjs", "utf8");
  expect(source).toContain("blender-5.2.2.sha256");
  expect(source).toMatch(/BLENDER_SHA256 = "[a-f0-9]{64}"/);
  expect(source).toContain("hashlib.file_digest(source, 'sha256')");
  expect(source).toContain("networkPolicy: \"deny-all\"");
  expect(source).toContain("ASTRA_BLENDER_RUNTIME_CHECK_PASSED");
  const help = spawnSync(process.execPath, ["scripts/astra-blender-snapshot.mjs"], { encoding: "utf8", timeout: 10000 });
  expect(help.status, help.stderr).toBe(0);
  expect(help.stdout).toContain("No setup runs without --create");
  expect(help.stdout).not.toContain("ASTRA_BLENDER_SNAPSHOT_ID=");
});

test('reviewed native Python stays in the isolated wrapper with disabled blend auto-execution', async()=>{
  const {compileAstraNativeRuntime}=await import('../../lib/astra-blender/native-runtime');
  const program='import bpy\nbpy.context.scene.world.color = (0.3, 0.1, 0.4)';
  const script=compileAstraNativeRuntime(createAstraScene('product'),{schemaVersion:1,name:'Native',program,assetIds:[]},{});
  expect(script).not.toContain(program);
  expect(script).toContain("exec(compile(NATIVE['program']");
  expect(script).toContain('use_scripts=False');
  expect(script).toContain("scene.cycles.device = 'CPU'");
  const checked=spawnSync('python3',['-c','import ast,sys;ast.parse(sys.stdin.read())'],{input:script,encoding:'utf8'});
  expect(checked.status,checked.stderr).toBe(0);
});

test('invalid portable output is omitted while native and bounded preview remain available',async()=>{
  const f=fake();f.files.set('scene.glb',Buffer.from('not a GLB'));
  const artifacts=await renderAstraScene(createAstraScene('product'),{},[],undefined,{sdk:f.sdk,snapshotId:SNAPSHOT});
  expect(artifacts.blend).toBeDefined();expect(artifacts.preview).toBeDefined();expect(artifacts.glb).toBeUndefined();
});


test('the SDK adapter captures one Session and never uses auto-resuming Sandbox I/O',async()=>{
 const {astraSessionHandle}=await import('../../lib/astra-blender/sandbox');let calls=0;
 const stopped=async()=>{calls++;throw new Error('sandbox_stopped');};
 const session={status:'stopped',writeFiles:stopped,runCommand:stopped,readFile:stopped,stop:async()=>{calls++;}};
 const sandbox={name:ID,currentSession:()=>session,writeFiles:()=>{throw new Error('UNSAFE AUTO RESUME');},runCommand:()=>{throw new Error('UNSAFE AUTO RESUME');},readFile:()=>{throw new Error('UNSAFE AUTO RESUME');}};
 const handle=astraSessionHandle(sandbox as unknown as Parameters<typeof astraSessionHandle>[0]);
 await expect(handle.runCommand({cmd:'blender',args:[],timeoutMs:1})).rejects.toThrow('sandbox_stopped');
 await expect(handle.writeFiles([])).rejects.toThrow('sandbox_stopped');
 await expect(handle.readFile({path:'/output'})).rejects.toThrow('sandbox_stopped');
 expect(calls).toBe(3);
});
