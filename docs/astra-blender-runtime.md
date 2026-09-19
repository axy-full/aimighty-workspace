# Astra blender native runtime

Astra blender edits a validated scene document in metres, with Z up and XYZ Euler rotations in degrees. The fixed compiler turns that document into native Blender geometry, materials, lights, camera and linear transform animation. Scene mode compiles data only. Native mode also supports a reviewed GPT-6 Astra Python program, applied to the saved project before an explicit render request. This program executes only inside the isolated VM.

The interface offers scene editing, templates, Astra proposals, reviewed native bpy source, portable export and durable cloud rendering. Cloud rendering requires both a verified snapshot and an explicit regional compute rate card. The application does not provision either automatically.

The local scene editor, templates and portable export do not require a cloud Blender runtime. Native cloud rendering requires a verified, prebuilt Vercel Sandbox snapshot. A missing `ASTRA_BLENDER_SNAPSHOT_ID` produces an explicit unavailable state; render requests never install software or build snapshots automatically.

## Create the runtime once

Run this command explicitly from the project directory using an authorized Vercel account:

```sh
node scripts/astra-blender-snapshot.mjs --create
```

This command creates a paid setup sandbox and a stored snapshot. Running the script without `--create` only prints usage. Unit tests use a fake SDK and make no paid calls. Operator provisioning is a separate, explicitly invoked operation.

The installed SDK is `@vercel/sandbox` 3.3.0. It supports Vercel OIDC credentials on deployed functions. For a local operator, provide `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID`. These authenticate the control plane; the script does not place them in the VM environment. See the [Sandbox SDK reference](https://vercel.com/docs/vercel-sandbox/sdk-reference).

The setup script downloads the official Linux x64 archive for **Blender 5.2.2** from the [Blender release directory](https://download.blender.org/release/Blender5.2/) and verifies its SHA256 before extraction:

```text
84098912789dc450e95697c4184fb8a90acbe5111c2ba4aede3fecb57806a168
```

This value was checked against [Blender's published checksum list](https://download.blender.org/release/Blender5.2/blender-5.2.2.sha256) on 2026-09-18. Updating the binary requires an intentional version/checksum change and a new snapshot.

The binary is installed at `/opt/astra-blender/blender`. Setup installs Linux shared-library dependencies, disables network access, and checks a native CPU render, `.blend` save, GLB export/import and Blender 5 layered animation APIs. It creates the snapshot only if all checks pass. The resulting snapshot has no expiry configured; delete obsolete snapshots when rotating the runtime.

If Blender's CDN refuses cloud egress (HTTP 403), download the **same official archive** locally and use `--create --archive-file /absolute/path/blender-5.2.2-linux-x64.tar.xz`. The script checks the pinned SHA256 before creating a VM, transfers those verified bytes, and verifies again inside the VM before extraction. It never substitutes an unverified mirror binary.

On 2026-09-18, explicit provisioning successfully verified the archive and ran the offline CPU PNG render, native save, GLB round trip and animation API smoke test. The setup sandbox was stopped after snapshot creation. The deployment must still be published with the configured environment before its interface can use that runtime.

Set the printed value in the deployment environment:

```text
ASTRA_BLENDER_SNAPSHOT_ID=snap_...
ASTRA_BLENDER_RATE_CARD={"cpuUsdPerHour":0.128,"memoryUsdPerGbHour":0.0212,"egressUsdPerGb":0.15,"createUsd":0.0000006}
```

Redeploy after changing the environment. `astraRuntimeStatus()` reports configuration, not a fresh connection test or a verified live render.

The sample rate card uses the published `iad1` rates checked on 2026-09-18. Reconfirm the deployment's actual contract when rotating rates. Memory has a one-minute minimum; creation and reported transfer are included. Snapshot storage is a separate ongoing operator expense. See [Vercel Sandbox pricing](https://vercel.com/docs/sandbox/pricing).

## Durable rendering API

`/api/workbench/astra-blender/render` runs inside the normal authenticated tenant and Workbench scope. Its body accepts source identities, never URLs or Python code:

- `POST {projectId,requestId,source:'scene'|'native',sourceDigest,quoteOnly:true}` returns the quote and runtime availability.
- Submit the same identity with `quoteOnly:false`, the returned `quoteDigest`, and reviewed `maxCredits`. A new job returns 202; an identical request returns its existing job. Reusing an identity for changed input returns 409.
- `GET ?projectId=...&requestId=...` recovers an ambiguous submission; omit requestId for recent jobs.
- `PATCH {projectId,jobId,action:'cancel'}` requests cancellation of that project's job.

The quote digest binds the saved scene, native source, selected media, rate card and snapshot in a fifteen-minute window. Jobs retain this immutable source. A later draft edit cannot change an accepted render. Admission reserves workspace credits, project/token budgets, concurrency and the maximum 320 MiB output storage. Source originals remain deletion-protected while a job is unresolved.

Jobs run on the app's native worker (`/api/worker`; Inngest only when a deployment opts in — docs/native-dispatch.md) and the recovery cron, with a bounded Next `after` fallback when dispatch is unavailable. The permanent queued-to-starting claim writes the unique sandbox name **before** calling create. Neither duplicate delivery nor recovery can cross that claim again. A lost create response is uncertain: recovery only retrieves the existing name with `resume:false`, and never purchases a replacement VM. Execution and file I/O use the captured SDK `Session` methods: the higher-level `Sandbox` convenience methods can auto-resume stopped VMs and are deliberately excluded from the production execution adapter.

Polling can recover an accepted but unstarted job even when the dispatcher is unavailable: its continuation allows one fallback render when at least 210 seconds remain. Shorter cron windows defer explicitly. After 30 minutes of dispatch failure without any runtime claim, that still-queued job is cancelled and its compute reservation released. Maintenance draining also handles native render identities directly.

The worker stores `.blend`, PNG and available GLB outputs before stopping the VM, records their deterministic storage identities, then merges assets into the latest saved project without overwriting scene edits. Storage reservations become regular upload bytes atomically. Interrupted registration can finish from the stored receipts. A terminated VM cannot recover artifacts that were never collected.

Admission requires three free project asset slots within the 500-asset limit. If concurrent edits fill those slots before output registration, the project stays valid and all completed files remain registered in the Library and available through the job's downloads. The job explains why its outputs could not be attached to the project.

Final billing uses SDK CPU milliseconds, wall duration for 4 GB memory (one-minute minimum), creation and reported egress. Missing or over-ceiling telemetry leaves the reviewed reservation held with an explicit uncertain status. The approved ceiling assumes 180 seconds, two fully active CPUs and 512 MiB transfer. Snapshot storage and platform Blob retention are separate infrastructure expenses. No final vendor cost is invented for a lost receipt.

## Low-level server integration

Use the following exports from `lib/astra-blender/sandbox.ts`:

```ts
renderAstraScene(scene, bindings, inputs, onCreated?, dependencies?);
renderAstraNative(scene, source, bindings, inputs, onCreated?, dependencies?);
astraRuntimeStatus();
configuredAstraRuntime();
getAstraRenderStatus(runtimeId);
cancelAstraRender(runtimeId);
validateAstraGlb(buffer);
```

`bindings` maps canonical saved asset IDs to `{ path, kind: 'model' | 'image' }`. `inputs` contains `{ path, data: Buffer }`. Paths must match exactly and be direct children of `ASTRA_SANDBOX_INPUT_DIR` (`/vercel/sandbox/astra/input`), with a safe filename and a supported extension. The caller resolves project ownership and downloads the selected originals before invoking this function. Do not accept renderer paths, arbitrary source URLs or asset IDs outside the authenticated saved project from a browser or a model.

`onCreated(runtimeId)` is awaited before file transfer or command submission. The durable job service additionally supplies its pre-persisted name through `dependencies.runtimeId`. In SDK 3.3 the identity used for retrieval is the sandbox **name**, such as `astra-blender-<uuid>`; it is not a legacy session ID. Status and cancellation retrieve this name with `resume: false`. Authorize it against the requesting workspace and job before exposing either operation.

The result is `{ blend: Buffer, preview: Buffer, glb?: Buffer }`. The `onArtifacts` dependency callback is awaited before VM shutdown, and `onStopped` records final telemetry. The durable service handles quota, authenticated storage and asset registration before completion. The preview is one PNG at the timeline start; keyframes are preserved in the native scene and GLB. This does not render the full animation as a video.

The caller owns job idempotency, compute accounting, admission/concurrency limits and the distinction between a definite failure and an uncertain request. This library never retries a native render. An interrupted request may have created or finished a VM; reconcile the recorded runtime, do not automatically start another. The VM is ephemeral and its files are discarded on stop, so artifact recovery is limited to what the surrounding job successfully collected. `getAstraRenderStatus` does not claim artifacts exist or collect them, and no helper resumes a stopped VM.

## Runtime limits

Each render starts from the configured snapshot with `persistent: false`, no public ports, no environment secrets and a `deny-all` egress policy. The fixed launcher replaces its environment before starting Blender with `--background --factory-startup --disable-autoexec --python-exit-code 1 --threads 2`. Scene mode runs only the fixed compiler. Native mode intentionally executes reviewed bpy source with full Blender Python access inside that VM; it does not pretend that keyword filtering can sandbox Python. Neither mode receives workspace credentials or arbitrary remote source URLs.

`ENGINE_MOCK=1` blocks the production adapter before `Sandbox.create`, even when a live snapshot is configured. Tests may explicitly inject a fake SDK. The separately invoked setup script remains an operator action.

| Resource | Limit |
| --- | --- |
| VM | 2 vCPUs, 4096 MB RAM, 180 seconds |
| Blender process | 165-second command deadline, 3584 MiB address-space limit |
| Process CPU / open files | 330 CPU seconds / 256 descriptors |
| Input files | 64 files, 50 MiB each (GLB: 32 MiB), 100 MiB combined |
| Scene | 64 objects, 12 lights, 512 total keys, 32 keys per object |
| Timeline | At most 1800 frames, 1–60 fps |
| Preview | 64–2048 pixels per dimension, 1–128 samples |
| Imported geometry | 256 objects per GLB, 1024 total objects, 1M vertices and polygons |
| Textures | 8192 pixels per dimension, 16M pixels each, 32M total pixels |
| Native output / portable GLB | 256 MiB `.blend`; 32 MiB GLB compatible with the shared preview validator |
| PNG output | 32 MiB |
| Combined output collection | 320 MiB |

Portable GLB is omitted when unsupported, invalid or over its preview resource bounds; native `.blend` and PNG remain the primary outputs. All artifacts are collected using bounded streams. Cleanup attempts to stop the VM on success and failure; an unconfirmed stop after a successful render is an explicit reconciliation error. The independent VM deadline still applies if the caller disappears.

GLB 2 is the only imported model format. Resources must be embedded; GLB files containing any image or buffer URI are rejected, including data URIs. Draco and Meshopt compression are unsupported. These restrictions prevent the native importer from resolving external resources and keep resource checks predictable. Raster inputs support PNG, JPEG, WebP, TIFF and BMP. Native mode additionally accepts one uncompressed, saved project `.blend` as its base, loaded with automatic scripts disabled. The reviewed program receives an `ASSETS` map of explicitly bound input paths. The API does not accept external scripts, arbitrary executables or URL inputs.

In scene mode, imported GLB geometry/materials are retained beneath the declarative object transform. Embedded camera/light objects and source animations are removed; the saved scene's camera, lights and keys are authoritative. Image planes use the actual source image, mapped onto a unit XY plane. Set scale explicitly for its aspect ratio. Text remains editable in `.blend` and is converted to a mesh only for GLB export.

Native decoders can allocate memory before a texture or geometry count can be inspected. The isolated VM and process limits remain necessary even with validated declarative input. Native bpy can create rigs, modifiers, geometry/shader nodes and other Blender data. The `.blend` preserves that data; GLB and Three.js cannot represent every native feature. Cloud jobs currently render one PNG still, not full video/animation sequences, and do not provide a streamed interactive Blender desktop. Native rendering runs with CPU Cycles; the interactive Three.js view is a fast preview and will not precisely match Cycles lighting or materials.

## Portable Blender export

The server can package `render.py`, the validated scene document and an `assets/` directory in a ZIP using:

```ts
compileAstraBlender(scene, bindings, { portableAssets: true, exportGlb: true });
```

The compiler still requires trusted absolute asset bindings, but the generated program resolves their distinct safe basenames inside the adjacent `assets/` directory. Package the exact source bytes with those basenames. Relative path escapes and symlinks resolving outside that directory are rejected. Primitive-only scenes need no assets directory.

After extracting the ZIP, run Blender 5.2.2 locally with an absolute output directory:

```sh
blender --background --factory-startup --disable-autoexec --python-exit-code 1 --python render.py -- /absolute/path/to/output
```

The program produces `scene.blend`, `preview.png` and `scene.glb`. Portable execution is a user-run Blender command; the Vercel VM/process isolation described above applies only to the hosted runner.

## Verification

```sh
PW_BASE_URL=http://localhost:4550 npx playwright test --project=unit tests/unit/astraBlenderScene.spec.ts tests/unit/astraBlenderSandbox.spec.ts
```

Tests use an injectable fake SDK, exercise failure cleanup and byte limits, reject poisoned scene data and unsafe asset references, verify the fixed program's Python syntax, and prove setup has no effect without `--create`. These unit tests make no native-render claim; the separate real-runtime verification is recorded below.


## Verified implementation behavior

On 2026-09-18, the actual native compiler and bounded launcher ran against the configured Blender 5.2.2 snapshot. The representative program added a bevel modifier, edited material nodes, retained declarative animation and added an armature. A separate Blender process in the same VM reopened the saved `.blend` and asserted all four features survived. Collection produced a visually inspected 256×256 PNG (73,314 bytes), `.blend` (659,065 bytes), and validated GLB (26,008 bytes). SDK telemetry reported 6,221 active CPU milliseconds, 8,289 wall milliseconds and 198,365 egress bytes. The runtime was stopped.

This check caught Blender 5's default compressed save behavior; the compiler now explicitly writes `compress=False`, matching the uncompressed input and output contract. Importing arbitrary compressed `.blend` files is not enabled. Native outputs may be up to 256 MiB, while a later base-scene import remains limited to 50 MiB; larger originals can be downloaded and edited locally. Unit tests use fake VMs and temporary databases for duplicate submissions, funding/quota refusal, scope isolation, stale source quotes, cancellation, ambiguous starts, missing telemetry, stored-output registration recovery, project asset limits, mock-mode blocking and SDK no-resume behavior. These tests do not call an AI provider or purchase compute.
