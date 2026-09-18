#!/usr/bin/env node
/** Explicit operator setup only. Importing this module never creates a VM. */
import { pathToFileURL } from "node:url";
import { Sandbox } from "@vercel/sandbox";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, readFile } from "node:fs/promises";

export const BLENDER_VERSION = "5.2.2";
export const BLENDER_ARCHIVE = `blender-${BLENDER_VERSION}-linux-x64.tar.xz`;
export const BLENDER_ARCHIVE_URL = `https://download.blender.org/release/Blender5.2/${BLENDER_ARCHIVE}`;
// Official blender-5.2.2.sha256, retrieved 2026-09-18; deliberately immutable.
export const BLENDER_SHA256 = "84098912789dc450e95697c4184fb8a90acbe5111c2ba4aede3fecb57806a168";

const INSTALL_DEPENDENCIES = `set -eu
if command -v dnf >/dev/null 2>&1; then
  dnf install -y python3 tar xz curl libX11 libXi libXfixes libXrender libXrandr libXcursor libXinerama libSM libICE libxkbcommon libgomp mesa-libGL mesa-libEGL
elif command -v apt-get >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 tar xz-utils curl ca-certificates libx11-6 libxi6 libxfixes3 libxrender1 libxrandr2 libxcursor1 libxinerama1 libsm6 libice6 libxkbcommon0 libgomp1 libgl1 libegl1
else
  echo 'Unsupported sandbox package manager' >&2
  exit 1
fi`;

const VERIFY_CHECKSUM = `import hashlib, pathlib
archive = pathlib.Path('/tmp/astra-blender.tar.xz')
if archive.stat().st_size > 600 * 1024 * 1024:
    raise ValueError('Unexpected Blender archive size')
with archive.open('rb') as source:
    digest = hashlib.file_digest(source, 'sha256').hexdigest()
if digest != '${BLENDER_SHA256}':
    raise ValueError('Official Blender archive checksum did not match the pinned checksum')
print('Verified Blender ${BLENDER_VERSION} SHA256')
`;

const SMOKE_CHECK = `import bpy, pathlib
assert bpy.app.version == (5, 2, 2), 'Wrong Blender runtime version'
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 1
scene.render.resolution_x = 64
scene.render.resolution_y = 64
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = '/tmp/astra-runtime-check.png'
cube = bpy.data.objects['Cube']
action = bpy.data.actions.new('Runtime check')
slot = action.slots.new(cube.id_type, cube.name)
strip = action.layers.new('Transforms').strips.new(type='KEYFRAME')
channels = strip.channelbag(slot, ensure=True)
curve = channels.fcurves.new(data_path='location', index=0)
curve.keyframe_points.add(2)
curve.keyframe_points[0].co = (1, 0)
curve.keyframe_points[1].co = (10, 1)
for key in curve.keyframe_points: key.interpolation = 'LINEAR'
animation = cube.animation_data_create()
animation.action = action
animation.action_slot = slot
scene.frame_set(1)
bpy.ops.wm.save_as_mainfile(filepath='/tmp/astra-runtime-check.blend')
bpy.ops.render.render(write_still=True)
bpy.ops.export_scene.gltf(filepath='/tmp/astra-runtime-check.glb', export_format='GLB')
bpy.ops.import_scene.gltf(filepath='/tmp/astra-runtime-check.glb', import_pack_images=True)
for suffix in ('blend', 'png', 'glb'):
    artifact = pathlib.Path('/tmp/astra-runtime-check.' + suffix)
    assert artifact.is_file() and artifact.stat().st_size > 0
print('ASTRA_BLENDER_RUNTIME_CHECK_PASSED')
`;

function credentials() {
  const { VERCEL_TOKEN: token, VERCEL_TEAM_ID: teamId, VERCEL_PROJECT_ID: projectId } = process.env;
  return token && teamId && projectId ? { token, teamId, projectId } : {};
}

export async function createBlenderSnapshot(archiveFile) {
  if (archiveFile) {
    const info = await stat(archiveFile);
    if (!info.isFile() || info.size > 600 * 1024 * 1024) throw new Error('Invalid bounded local Blender archive.');
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(archiveFile)) digest.update(chunk);
    if (digest.digest('hex') !== BLENDER_SHA256) throw new Error('Local archive does not match the pinned official Blender checksum. No VM was created.');
  }
  const sandbox = await Sandbox.create({
    ...credentials(), image: "vercel/sandbox/universal", timeout: 600_000,
    region: "iad1", resources: { vcpus: 2 }, networkPolicy: "allow-all", env: {}, ports: [], persistent: false,
  });
  console.log(`Setup sandbox: ${sandbox.name}`);
  const run = async (command) => {
    const result = await sandbox.runCommand(command);
    if (result.exitCode !== 0) {
      const diagnostic = (await result.stderr()).slice(-3000);
      throw new Error(`Runtime setup step failed (${command.cmd}, exit ${result.exitCode}). Sandbox ${sandbox.name}. ${diagnostic}`);
    }
    return result;
  };
  try {
    await run({ cmd: "/bin/sh", args: ["-c", INSTALL_DEPENDENCIES], sudo: true, timeoutMs: 180_000 });
    if (archiveFile) await sandbox.writeFiles([{path:"/tmp/astra-blender.tar.xz",content:await readFile(archiveFile)}]);
    else await run({ cmd: "curl", args: ["--fail", "--location", "--proto", "=https", "--tlsv1.2", "--max-time", "180", "--max-filesize", "629145600", "--output", "/tmp/astra-blender.tar.xz", BLENDER_ARCHIVE_URL], timeoutMs: 185_000 });
    await run({ cmd: "python3", args: ["-c", VERIFY_CHECKSUM], timeoutMs: 30_000 });
    await run({ cmd: "mkdir", args: ["-p", "/opt/astra-blender"], sudo: true, timeoutMs: 10_000 });
    await run({ cmd: "tar", args: ["--extract", "--xz", "--file", "/tmp/astra-blender.tar.xz", "--directory", "/opt/astra-blender", "--strip-components", "1", "--no-same-owner"], sudo: true, timeoutMs: 90_000 });
    await sandbox.update({ networkPolicy: "deny-all" });
    await sandbox.writeFiles([{ path: "/tmp/astra-runtime-check.py", content: SMOKE_CHECK }]);
    const smoke = await run({ cmd: "/opt/astra-blender/blender", args: ["--background", "--factory-startup", "--disable-autoexec", "--python-exit-code", "1", "--threads", "2", "--python", "/tmp/astra-runtime-check.py"], timeoutMs: 120_000 });
    if (!(await smoke.stdout()).includes("ASTRA_BLENDER_RUNTIME_CHECK_PASSED")) throw new Error("Blender's offline runtime check was not completed.");
    await run({ cmd: "rm", args: ["-f", "/tmp/astra-blender.tar.xz", "/tmp/astra-runtime-check.py", "/tmp/astra-runtime-check.blend", "/tmp/astra-runtime-check.png", "/tmp/astra-runtime-check.glb"], timeoutMs: 10_000 });
    const snapshot = await sandbox.snapshot({ expiration: 0 });
    return { snapshotId: snapshot.snapshotId, blenderVersion: BLENDER_VERSION, archiveSha256: BLENDER_SHA256 };
  } finally {
    await sandbox.stop().catch(() => {});
  }
}

async function main() {
  if (process.argv[2] !== "--create" || !(process.argv.length === 3 || process.argv.length === 5 && process.argv[3] === "--archive-file")) {
    console.log("Usage: node scripts/astra-blender-snapshot.mjs --create [--archive-file /absolute/verified-archive.tar.xz]\nCreates a paid, disposable setup sandbox and a reusable Blender snapshot. No setup runs without --create.");
    return;
  }
  const result = await createBlenderSnapshot(process.argv[4]);
  console.log(`Blender ${result.blenderVersion} verified and snapshotted.\nASTRA_BLENDER_SNAPSHOT_ID=${result.snapshotId}\nArchive SHA256: ${result.archiveSha256}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : "Blender snapshot setup failed."); process.exitCode = 1; });
}
