import { randomUUID } from "node:crypto";
import { Sandbox } from "@vercel/sandbox";
import { Readable } from "node:stream";
import { engineMock } from "../mock";
import { parseAstraScene, type AstraScene } from "./scene";
import { compileAstraBlender, ASTRA_BLENDER_RUNTIME_LIMITS, ASTRA_BLENDER_OUTPUTS, type AstraAssetBindings } from "./blender-export";
import { compileAstraNativeRuntime, type AstraNativeBindings } from "./native-runtime";
import { astraNativeSchema, type AstraNativeSource } from "./native";
import { astraTextureDimensions, ASTRA_GLB_BYTES, validateAstraGlb as validateGlbContainer } from "./glb";

export const ASTRA_SANDBOX_INPUT_DIR = "/vercel/sandbox/astra/input";
export const ASTRA_SANDBOX_OUTPUT_DIR = "/vercel/sandbox/astra/output";
export const ASTRA_BLENDER_VERSION = "5.2.2";
const ROOT = "/vercel/sandbox/astra";
const MAX_INPUT_BYTES = 100 * 1024 * 1024;
export const ASTRA_MAX_OUTPUT_BYTES = 320 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 32 * 1024 * 1024;
const RENDER_TIMEOUT_MS = 165_000;
const runtimeName = /^astra-blender-[a-f0-9-]{36}$/;

export type AstraRenderInput = { path: string; data: Buffer };
export type AstraRenderArtifacts = { blend: Buffer; preview: Buffer; glb?: Buffer };
export type AstraSandboxCreateOptions = NonNullable<Parameters<typeof Sandbox.create>[0]>;
export type AstraSandboxCommand = { cmd: string; args: string[]; cwd?: string; timeoutMs: number; signal?: AbortSignal };
/** A narrow injectable boundary; tests never construct a paid VM. */
export type AstraSandboxHandle = {
  name: string;
  status: string;
  totalActiveCpuDurationMs?: number;
  totalDurationMs?: number;
  totalEgressBytes?: number;
  writeFiles(files: { path: string; content: string | Uint8Array }[], options?: { signal?: AbortSignal }): Promise<void>;
  runCommand(command: AstraSandboxCommand): Promise<{ exitCode: number }>;
  readFile(file: { path: string }, options?: { signal?: AbortSignal }): Promise<NodeJS.ReadableStream | null>;
  stop(options?: { signal?: AbortSignal }): Promise<unknown>;
};
export type AstraSandboxSdk = {
  create(options: AstraSandboxCreateOptions): Promise<AstraSandboxHandle>;
  get(options: { name: string; resume: false; signal?: AbortSignal }): Promise<AstraSandboxHandle>;
};
export type AstraRuntimeUsage = {activeCpuMs:number;durationMs:number;egressBytes:number};
export type AstraRenderCallbacks = {
  onArtifacts?: (artifacts:AstraRenderArtifacts)=>Promise<void>;
  onStopped?: (usage:AstraRuntimeUsage|null)=>Promise<void>;
};
export type AstraSandboxDependencies = AstraRenderCallbacks & { sdk?: AstraSandboxSdk; snapshotId?: string; signal?: AbortSignal; runtimeId?:string };
/** Sandbox convenience I/O auto-resumes stopped VMs in SDK 3.3. Capture a
 * Session once and use its methods so cancellation/timeout can never purchase
 * another session under an already-claimed job. Metadata lookups remain read-only. */
export function astraSessionHandle(sandbox: Sandbox): AstraSandboxHandle {
  const session = sandbox.currentSession();
  return {
    name: sandbox.name,
    get status() { return session.status; },
    get totalActiveCpuDurationMs() { return sandbox.totalActiveCpuDurationMs; },
    get totalDurationMs() { return sandbox.totalDurationMs; },
    get totalEgressBytes() { return sandbox.totalEgressBytes; },
    writeFiles: (files, options) => session.writeFiles(files, options),
    runCommand: command => session.runCommand(command),
    readFile: (file, options) => session.readFile(file, options),
    stop: options => session.stop(options),
  };
}
const sdk: AstraSandboxSdk = {
  create: async options => {
    if (engineMock()) throw new AstraRuntimeError("Native Blender compute is disabled while ENGINE_MOCK=1.", "not_configured");
    return astraSessionHandle(await Sandbox.create(options));
  },
  get: async options => astraSessionHandle(await Sandbox.get(options)),
};

export class AstraRuntimeError extends Error {
  constructor(message: string, public code: "not_configured" | "invalid_input" | "render_failed" | "invalid_output" | "not_running" | "stop_unconfirmed") {
    super(message);
    this.name = "AstraRuntimeError";
  }
}

export function astraRuntimeStatus() {
  const configured = /^snap_[A-Za-z0-9_-]{3,160}$/.test(process.env.ASTRA_BLENDER_SNAPSHOT_ID ?? "");
  return {
    configured,
    reason: configured ? null : "Native Blender rendering is not connected. A Blender runtime snapshot must be configured.",
    blenderVersion: ASTRA_BLENDER_VERSION,
    timeoutMs: ASTRA_BLENDER_RUNTIME_LIMITS.timeoutMs,
    vcpus: 2,
    memoryMb: 4096,
  };
}

export function configuredAstraRuntime(): boolean { return astraRuntimeStatus().configured; }

function credentials() {
  const { VERCEL_TOKEN: token, VERCEL_TEAM_ID: teamId, VERCEL_PROJECT_ID: projectId } = process.env;
  // These authenticate the control-plane request; they never enter VM env.
  return token && teamId && projectId ? { token, teamId, projectId } : {};
}

/** Validate GLB before purchasing a sandbox or asking the native importer to read it. */
export function validateAstraGlb(data: Buffer): void {
  try { validateGlbContainer(data); }
  catch (error) { throw new AstraRuntimeError(error instanceof Error ? error.message : "Use a valid GLB 2 model with embedded resources.", "invalid_input"); }
}

function imageSignature(data: Buffer, path: string): boolean {
  if (/\.png$/i.test(path)) return data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (/\.jpe?g$/i.test(path)) return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (/\.webp$/i.test(path)) return data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP";
  if (/\.bmp$/i.test(path)) return data.toString("ascii", 0, 2) === "BM";
  if (/\.tiff?$/i.test(path)) return ["49492a00", "4d4d002a"].includes(data.subarray(0, 4).toString("hex"));
  return false;
}

export function prepareAstraInputs(scene: AstraScene, bindings: AstraNativeBindings, inputs: AstraRenderInput[], native?:AstraNativeSource) {
  if (!Array.isArray(inputs) || inputs.length > 64) throw new AstraRuntimeError("Too many Blender input files.", "invalid_input");
  const paths = new Map<string, Buffer>();
  let bytes = 0;
  for (const input of inputs) {
    if (!new RegExp(`^${ASTRA_SANDBOX_INPUT_DIR}/[A-Za-z0-9][A-Za-z0-9_-]{0,99}\\.(?:glb|png|jpg|jpeg|webp|tif|tiff|bmp|blend)$`, "i").test(input.path) || paths.has(input.path) || !Buffer.isBuffer(input.data) || !input.data.length || input.data.length > ASTRA_BLENDER_RUNTIME_LIMITS.assetBytes)
      throw new AstraRuntimeError("Use distinct bounded renderer files inside the input directory.", "invalid_input");
    bytes += input.data.length;
    if (bytes > MAX_INPUT_BYTES) throw new AstraRuntimeError("Blender inputs exceed 100 MiB.", "invalid_input");
    paths.set(input.path, input.data);
  }
  const used = new Set<string>();
  const references = [...scene.objects.filter(object=>object.assetId).map(object=>({assetId:object.assetId!,type:object.type})), ...(native?native.assetIds.map(assetId=>({assetId,type:bindings[assetId]?.kind})):[]), ...(native?.baseBlendAssetId?[{assetId:native.baseBlendAssetId,type:'blend'}]:[])];
  for (const object of references) {
    const binding = Object.hasOwn(bindings, object.assetId) ? bindings[object.assetId] : null;
    const content = binding && paths.get(binding.path);
    if (!binding || binding.kind !== object.type || !content) throw new AstraRuntimeError("A scene asset has no matching renderer input.", "invalid_input");
    if (object.type === "model") validateAstraGlb(content);
    else if (object.type === "blend") { if(content.toString("ascii",0,7)!=="BLENDER")throw new AstraRuntimeError("Use an uncompressed native .blend file.","invalid_input"); }
    else if (!imageSignature(content, binding.path)) throw new AstraRuntimeError("An image input does not match its file type.", "invalid_input");
    used.add(binding.path);
  }
  if (used.size !== paths.size) throw new AstraRuntimeError("Unreferenced files cannot be sent to the renderer.", "invalid_input");
}

const LAUNCHER = `import os, resource
resource.setrlimit(resource.RLIMIT_AS, (3584 * 1024 * 1024, 3584 * 1024 * 1024))
resource.setrlimit(resource.RLIMIT_FSIZE, (256 * 1024 * 1024, 256 * 1024 * 1024))
resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
resource.setrlimit(resource.RLIMIT_CPU, (330, 330))
os.execve('/opt/astra-blender/blender', ['/opt/astra-blender/blender', '--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--threads', '2', '--python', '${ROOT}/scene.py', '--', '${ASTRA_SANDBOX_OUTPUT_DIR}'], {'PATH': '/usr/bin:/bin', 'OMP_NUM_THREADS': '2', 'OPENBLAS_NUM_THREADS': '2', 'BLENDER_USER_CONFIG': '/tmp/astra-blender-config'})
`;

async function readBounded(sandbox: AstraSandboxHandle, filename: string, limit: number, signal?: AbortSignal): Promise<Buffer> {
  const stream = await sandbox.readFile({ path: `${ASTRA_SANDBOX_OUTPUT_DIR}/${filename}` }, { signal });
  if (!stream) throw new AstraRuntimeError(`Blender did not produce ${filename}.`, "invalid_output");
  const readable = stream as Readable;
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of readable) {
      signal?.throwIfAborted();
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > limit) throw new AstraRuntimeError("Blender output exceeded its collection limit.", "invalid_output");
      chunks.push(buffer);
    }
  } catch (error) { readable.destroy(); throw error; }
  if (!bytes) throw new AstraRuntimeError(`Blender produced an empty ${filename}.`, "invalid_output");
  return Buffer.concat(chunks, bytes);
}

/** The caller owns durable job identity and must never retry an ambiguous run. */
export async function renderAstraScene(sceneValue: AstraScene, bindings: AstraAssetBindings, inputs: AstraRenderInput[], onCreated?: (runtimeId: string) => Promise<void>, dependencies: AstraSandboxDependencies = {}): Promise<AstraRenderArtifacts> {
  const scene = parseAstraScene(sceneValue);
  prepareAstraInputs(scene, bindings, inputs);
  const program = compileAstraBlender(scene, bindings, { exportGlb: true });
  return executeAstraProgram(program,inputs,onCreated,dependencies);
}

export async function renderAstraNative(sceneValue:AstraScene,nativeValue:AstraNativeSource,bindings:AstraNativeBindings,inputs:AstraRenderInput[],onCreated?:(id:string)=>Promise<void>,dependencies:AstraSandboxDependencies={}):Promise<AstraRenderArtifacts>{
  const scene=parseAstraScene(sceneValue),native=astraNativeSchema.parse(nativeValue);
  prepareAstraInputs(scene,bindings,inputs,native);
  return executeAstraProgram(compileAstraNativeRuntime(scene,native,bindings),inputs,onCreated,dependencies);
}

async function executeAstraProgram(program:string,inputs:AstraRenderInput[],onCreated:((id:string)=>Promise<void>)|undefined,dependencies:AstraSandboxDependencies):Promise<AstraRenderArtifacts>{
  const snapshotId = dependencies.snapshotId ?? process.env.ASTRA_BLENDER_SNAPSHOT_ID;
  if (!snapshotId || !/^snap_[A-Za-z0-9_-]{3,160}$/.test(snapshotId)) throw new AstraRuntimeError(astraRuntimeStatus().reason ?? "A Blender runtime snapshot must be configured.", "not_configured");
  const signal = dependencies.signal ? AbortSignal.any([dependencies.signal, AbortSignal.timeout(ASTRA_BLENDER_RUNTIME_LIMITS.timeoutMs)]) : AbortSignal.timeout(ASTRA_BLENDER_RUNTIME_LIMITS.timeoutMs);
  signal.throwIfAborted();
  if(dependencies.runtimeId && !runtimeName.test(dependencies.runtimeId)) throw new AstraRuntimeError("Invalid runtime name.","invalid_input");
  const instance = await (dependencies.sdk ?? sdk).create({
    ...credentials(), name: dependencies.runtimeId ?? `astra-blender-${randomUUID()}`, source: { type: "snapshot", snapshotId },
    region: "iad1", timeout: ASTRA_BLENDER_RUNTIME_LIMITS.timeoutMs, resources: { vcpus: 2 }, networkPolicy: "deny-all",
    env: {}, ports: [], persistent: false, signal,
  });
  let failed = false;
  try {
    // Persist BEFORE files or command submission. A failed checkpoint stops the VM.
    await onCreated?.(instance.name);
    signal.throwIfAborted();
    await instance.writeFiles([
      { path: `${ROOT}/scene.py`, content: program }, { path: `${ROOT}/run.py`, content: LAUNCHER },
      ...inputs.map(input => ({ path: input.path, content: input.data })),
    ], { signal });
    const result = await instance.runCommand({ cmd: "/usr/bin/python3", args: [`${ROOT}/run.py`], cwd: ROOT, timeoutMs: RENDER_TIMEOUT_MS, signal });
    if (result.exitCode !== 0) throw new AstraRuntimeError("Blender could not finish within this scene's runtime limits. This attempt will not restart automatically.", "render_failed");
    const blend = await readBounded(instance, ASTRA_BLENDER_OUTPUTS.blend, ASTRA_BLENDER_RUNTIME_LIMITS.artifactBytes, signal);
    if (blend.toString("ascii", 0, 7) !== "BLENDER") throw new AstraRuntimeError("The native scene file is invalid.", "invalid_output");
    const preview = await readBounded(instance, ASTRA_BLENDER_OUTPUTS.preview, MAX_PREVIEW_BYTES, signal);
    if (!imageSignature(preview, "preview.png")) throw new AstraRuntimeError("The rendered preview is invalid.", "invalid_output");
    try { const dimensions=astraTextureDimensions(preview,'image/png'); if(dimensions.width>2048||dimensions.height>2048)throw new Error('Preview dimensions exceed the limit.'); }
    catch{throw new AstraRuntimeError("The rendered preview exceeds its image bounds.","invalid_output");}
    const remaining = ASTRA_MAX_OUTPUT_BYTES - blend.length - preview.length;
    let glb:Buffer|undefined;
    try {
      const candidate=await readBounded(instance,ASTRA_BLENDER_OUTPUTS.glb,Math.min(remaining,ASTRA_GLB_BYTES),signal);
      validateGlbContainer(candidate);
      glb=candidate;
    } catch { signal.throwIfAborted(); /* A full native scene may not have a supported portable GLB representation. */ }
    const artifacts = { blend, preview, ...(glb?{glb}:{}) };
    await dependencies.onArtifacts?.(artifacts);
    return artifacts;
  } catch (error) { failed = true; throw error; }
  finally {
    try {
      await instance.stop({ signal: AbortSignal.timeout(10_000) });
      if(dependencies.onStopped){
        const stopped=await (dependencies.sdk??sdk).get({...credentials(),name:instance.name,resume:false,signal:AbortSignal.timeout(10_000)});
        await dependencies.onStopped(runtimeUsage(stopped));
      }
    }
    catch { if (!failed) throw new AstraRuntimeError("Blender completed, but runtime shutdown could not be confirmed. The persisted runtime needs reconciliation.", "stop_unconfirmed"); }
  }
}

/** Read/cancel only; never resumes or purchases a replacement for a stopped run. */
export async function getAstraRenderStatus(id: string, dependencies: Pick<AstraSandboxDependencies, "sdk" | "signal"> = {}) {
  if (!runtimeName.test(id)) throw new AstraRuntimeError("Invalid Blender runtime identity.", "invalid_input");
  const instance = await (dependencies.sdk ?? sdk).get({ ...credentials(), name: id, resume: false, signal: dependencies.signal });
  return { runtimeId: instance.name, status: instance.status, usage:runtimeUsage(instance) };
}

export async function cancelAstraRender(id: string, dependencies: Pick<AstraSandboxDependencies, "sdk" | "signal"> = {}) {
  if (!runtimeName.test(id)) throw new AstraRuntimeError("Invalid Blender runtime identity.", "invalid_input");
  const instance = await (dependencies.sdk ?? sdk).get({ ...credentials(), name: id, resume: false, signal: dependencies.signal });
  if (!["stopped", "failed", "aborted"].includes(instance.status)) await instance.stop({ signal: dependencies.signal ?? AbortSignal.timeout(10_000) });
  const final=await (dependencies.sdk??sdk).get({...credentials(),name:id,resume:false,signal:dependencies.signal??AbortSignal.timeout(10000)});
  return { runtimeId: instance.name, stopped: true, usage:runtimeUsage(final) };
}

export function runtimeUsage(instance:Pick<AstraSandboxHandle,'totalActiveCpuDurationMs'|'totalDurationMs'|'totalEgressBytes'>):AstraRuntimeUsage|null {
 const values=[instance.totalActiveCpuDurationMs,instance.totalDurationMs,instance.totalEgressBytes];
 if(values.some(value=>typeof value!=="number"||!Number.isFinite(value)||value<0))return null;
 return {activeCpuMs:values[0]!,durationMs:values[1]!,egressBytes:values[2]!};
}
