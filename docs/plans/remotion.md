# Remotion: exports rendered on our own server (plan, 13 Oct 2026)

**Status (13 Oct, owner):** the licence is CONFIRMED in writing by Remotion (13 Oct 2026; the owner holds the email). The SERVER SIDE starts now in a third lane, with no screens until Claude Design. Everything sits behind a switch, OFF in production, until the screens exist and the owner has tested it. NEEDS AKSHAY.

## Owner decisions (13 Oct 13:55, verbatim in docs/redesign-plan.md)
- **Licence.** Remotion is adopted on the **Free License**: SensAI is 3 people in total, and the owner is confirming this in writing with hi@remotion.dev.
  - **At 4 people the Company License must be bought before the next release** (recorded in CLAUDE.md).
  - Rendering is self-hosted on our droplet only: no Remotion Lambda, no AWS.
  - Only our own templates are rendered. Users never upload Remotion projects or code.
- **Price.** Remotion exports are **free** to customers: 0 cr, and the button reads "Free", for as long as Remotion charges us nothing.
  - Paid engine steps inside an export (a voice-over, a regenerated shot) are priced as usual, through the normal price path and approval gate.
  - If the licence ever costs us, the owner sets the new price. **Never add one in code.**
- **Protect the server instead of charging.** Renders run on a separate render worker with its own CPU/memory limits, through a queue, with a fair per-workspace limit. A real 30 s 1080p export is measured on our server, and the limits are set from it.
- **First uses:** captions on a cut, title and end cards, 16:9 ↔ 9:16 versions, 6/15/30 s cutdowns, and the final MP4. **Later:** "Export to Premiere / Resolve" (XML + media) and the multi-track timeline (V1–V3, Dialogue/VO, Music, SFX, Captions).
- **Screens:** every new screen element (the Export button, caption styles, the format picker, the timeline) goes to **Claude Design first**. The server parts need no design.

## Design of the system
Modelled on the self-hosted Astra render worker (`ops/render-worker/`, `docs/astra-blender-runtime.md` › "Self-hosted render worker").

**The worker (`ops/remotion-worker/`)**
- One container image: Node 22 (Debian bookworm slim, pinned by digest), Remotion's renderer (`@remotion/renderer`, pinned), its headless Chrome (downloaded and pinned at build), and ffmpeg (Remotion's bundled one).
- Our own composition bundle (`remotion/` in the repo: captions, title/end cards, reframe 16:9↔9:16, cutdowns, final assembly) is **built into the image at build time**. The worker never loads code at runtime.
- It runs as a non-root user (uid 10001) with a healthcheck.
- **Resources (starting point, to be set from the measurement):**
  - **CPU:** 3 vCPU.
  - **Memory:** 6–8 GB.
  - **Parallel frames:** Remotion `concurrency` 2–3.
  - **GPU:** none.
  - **One export at a time per worker.** One worker to start; a second only if the queue shows a need.
- **Network:** the same isolation as the Astra worker, with no internet and no public port. The app sends inputs (the cut's media, already resolved from our storage) as files in the session, and reads the MP4 back, exactly as with Astra. Option (c), the relay, or (a) from `ops/render-worker/README.md`, whichever the owner chose for Astra. The egress gate is the same hard gate.
- **Protocol:** the Astra worker's (create session → write files → run the fixed export command with a JSON spec → read outputs → stop), on port 8790. Bearer secret per worker. Deadlines per call and per run (a 30 s 1080p export plus a margin, set from the measurement).

**The app side**
- **The export tool in the registry (rule 11).** Make, a board card, Atomik, a skill and MCP all call the same tool. Price: "Free" (0 cr) for the Remotion part, plus the normal price of any paid engine step inside it, which goes through the usual quote and approval.
- **Jobs on the native worker** (`/api/worker`, docs/native-dispatch.md), like Astra renders: idempotent request key, durable job row, recovery cron, cancellation, and outputs stored in the workspace's own storage prefix (tenant isolation, rule 2).
- **Fair queue.** A new table `export_jobs` (a migration, so it ships after the owner's backup):
  - at most **N exports running per workspace** (start: 1);
  - at most **M exports per workspace per hour** (start: 6);
  - one global running slot per worker.
  - A queued job shows "Export queued — 2 ahead of you". Limits are a platform setting, not a price.
- **No billing rows for the free part.** Paid steps inside an export bill through their own existing paths. The export never reserves or charges credits for itself, and a refused or failed export says "Nothing billed".

## Measure first (before any limit is final)
1. Build the worker image and deploy it (steps below).
2. On the worker, run the measurement export: a 30 s 1080p cut with captions and an end card, using our own sample media (no engine calls, no money).
3. Record wall time, peak memory and CPU, at concurrency 1, 2 and 3.
4. Set the CPU/memory limits, the concurrency, the per-run deadline and the per-workspace limits from the numbers. Write them into this file.

### Measured on this droplet (15 Oct 2026, CPU only, outside Docker, no engine calls)
Owner, 15 Oct 22:15: "Measure one real 30 s 1080p export (time, cost) first." Run by lane D with the real export command (`node build/cli.mjs`, composition `final`, PR #697's compositions) through `heavy.sh` at `nice -n 19`, one at a time. The cut: 1920x1080, 30 fps, 30.0 s: a 2 s title card, three 8 s clips with karaoke captions, a 4 s end card, a 30 s music track. The sample is the repo's 10 s fixture clip scaled to 1080p (softer than real footage, so it encodes a little cheaper). Remotion 4.0.530, its Chrome Headless Shell, H.264 CRF 20 with AAC. The host was busy (load average 7 to 14 on 8 vCPU), so wall times are what nice 19 gets on a loaded server; CPU seconds do not move with load and are the figure to plan from.

| Run | Concurrency | Wall | CPU s (user+sys) | Avg cores | Peak RSS, all processes summed | Largest process | Output |
|---|---|---|---|---|---|---|---|
| H.264 | 1 | 270 s | 215 | 0.80 | 1.76 GiB | 704 MiB | 26.0 MB |
| H.264 | 2 | 183 s | 213 | 1.16 | 1.78 GiB | 704 MiB | 26.0 MB |
| H.264 | 3 | 163 s | 218 | 1.34 | 1.73 GiB | 705 MiB | 26.0 MB |
| ProRes 422 (standard) | 2 | 203 s | 337 | 1.66 | 1.23 GiB | 206 MiB | 485 MB |
| ProRes 422 HQ | 2 | 211 s | 368 | 1.74 | 1.22 GiB | 218 MiB | 716 MB |

Six more H.264 runs (three overlapping another run for about 10 minutes, so their wall times are inflated) gave 207 to 214 CPU s each: CPU cost is the same at any concurrency, only wall time falls. RSS is summed over every process, so shared pages count more than once; it stays near 1.8 GiB at any concurrency.

- **Reading it.** An H.264 export of a 30 s 1080p cut is about 212 CPU s (about 7 CPU minutes per finished minute). On the worker's 3 vCPU with nothing else running that is an estimated 70 s plus about 10 s start-up (not measured: the server was never quiet). ProRes costs about 1.6x the CPU of H.264 and is 19x to 28x larger.
- **Cost, with the assumption.** Droplet 8 vCPU / 32 GB at about US$192 a month (docs/scale-out-runbook.md section 7, shared CPU; the owner can give the exact plan), which is US$0.0329 per vCPU-hour. H.264, 30 s: US$0.0019 (US$0.0039 per finished minute). ProRes 422: US$0.0031 (US$0.0062 per minute); HQ: US$0.0034 (US$0.0067). By wall-time share of the droplet on the 3-vCPU worker: about US$0.003 per H.264 export. R2 storage about US$0.015 per GB-month, downloads free: 26 MB H.264 is US$0.0004 a month, 485 MB ProRes US$0.0073, 716 MB ProRes HQ US$0.0107. Exports are free to customers (0 cr).
- **ProRes.** Remotion's option is `proResProfile`; the profile name for ProRes 422 is `standard` (HQ is the default if the name is not recognised). Remotion's own ffmpeg has `prores_ks`. The cli and renderer hard-code H.264, so ProRes needs a spec field (PR in the Slice 1 list). A 485 to 716 MB output does not fit the worker's 1 GB session tmpfs beside the inputs.
- **DNxHR.** Not timed: the ffmpeg pinned inside Remotion has no DNxHD encoder, so DNxHR needs a different ffmpeg in the image (a licence and image-size question for the owner's lawyer). **H.265 stays off** (libx265 is present in that ffmpeg; owner: until the lawyer answers).
- **Chrome download.** The first runs downloaded Chrome Headless Shell (92 MB, from remotion.media) into the scratch folder, because a session folder has no `package.json` to hold it. Later runs set `REMOTION_BROWSER_EXECUTABLE` to the copy already on disk. The worker image installs it at build time, so the sealed worker never downloads anything.
- **Not yet set from these numbers:** the worker CPU and memory limits (the plan's 3 vCPU / 6 to 8 GB starting point has room: memory peaks near 1.8 GiB), the concurrency (2 is a good default), the per-run deadline, and the per-workspace limits.

## PRs (in order; each small, with tests; NEEDS AKSHAY)
1. **`remotion/` compositions plus unit and render tests** (no app wiring). Mocked inputs. Snapshot frames at fixed times.
2. **`ops/remotion-worker/`**: Dockerfile, server, compose, smoke, README with the click list, tests with a fake renderer. No app wiring.
3. **App: the export tool and job service** (registry tool, admission at 0 cr for the Remotion part, the `export_jobs` migration, queue limits, recovery, storage). Mocked worker in tests. Opus money and privacy review.
4. **Screens (after Claude Design):** the Export button, the format picker, caption styles, the queue line. One PR per element.
5. **Later:** Premiere/Resolve XML export, and the multi-track timeline (its own design round).

## Coolify steps for the owner (the worker)
Nothing here costs money. Mirrors `ops/render-worker/README.md` › "Setup click list".
1. **Networking:** the same option as the Astra worker (recommended (c), the relay, or (a)). The advisor applies the server or compose part as written there.
2. **Secret:** on your own machine, `openssl rand -hex 32` once per worker. Keep it in your password manager as "remotion worker 1".
3. **Create the stack in Coolify.** In the production app's project: **+ New › Docker Compose** (from the GitHub repository), branch `release/1` (or `main` once merged).
   - **Base Directory:** `/ops/remotion-worker`.
   - **Docker Compose Location:** `/compose.yaml`.
   - **Domains:** none. No ports published.
   - **Connect To Predefined Network:** as the chosen option says (off for (a), on for (c)).
4. **Resource limits on the stack:** set in `compose.yaml` (`cpus: 3`, `mem_limit: 8g`). Check them on the service's page after deploy. Change them only through a compose PR, never by hand.
5. **Environment on the stack:** `REMOTION_WORKER_SECRET` = the secret. Runtime only: leave **Build Variable** unticked.
6. **Deploy.** The first build downloads Chrome and ffmpeg (a few hundred MB) and renders a 2-second test clip at build time. Wait until the service shows **healthy**.
7. **Egress gate:** run Verify step 1 from `ops/render-worker/README.md` in the worker's terminal. **Stop if anything resolves or is reached.**
8. **Production app:** set `REMOTION_WORKER_URLS` (the worker's internal URL, read from the stack's page) and `REMOTION_WORKER_SECRETS` (the same secret), both runtime only. Redeploy the app (for (a), the advisor reconnects it to the internal network).
9. **Smoke and measure:** run the no-cost smoke (a 2-second clip) from the app's terminal, then the 30 s 1080p measurement (above). Send the numbers to the lead, who sets the limits in a small PR.

## Risks and open points
- **Licence terms:** the plan assumes the Free License covers a company of up to 3 people and self-hosted server-side rendering. The owner's written confirmation from Remotion settles it. If it doesn't, stop before PR 2.
- **Chrome in a no-egress container:** fonts and images must be bundled or passed in as files. Compositions may not fetch anything (enforced by the egress gate and by tests).
- **The droplet is also production:** the worker's CPU/memory limits are what protect the app. They are never raised without measuring.

## Build now (owner, 13 Oct): server side only, third lane
- **The switch:** `REMOTION_EXPORTS` (env, runtime). Unset or off means the export tool isn't offered, its route answers 404, and no job is admitted. It's off in production until the owner turns it on after testing.
- **Job states:** the same as other renders. In queue (with the position, "2 ahead of you"), then Rendering, then Saving, then Ready or Failed ("Nothing billed").
- **Order of PRs:** compositions (1), the worker (2), then the app's export tool and the fair queue (3). Each has mocked tests. Then one real timing test on our server: a 30 s 1080p export run under heavy.sh, CPU only, outside Docker (the lanes never touch Docker), with the result written into "Measure first" to set the limits. The worker's own limits are measured again after the owner deploys it.

## Licence key (owner, 13 Oct ~16:10): option D
No licence key is passed and nothing is sent to Remotion. The worker stays sealed. Remotion is pinned to 4.x (exactly 4.0.530 today), and any 5.x upgrade is flagged to the owner first. Tests assert that no key is passed and that the usage endpoint is never called. Limits as decided: 3 CPU / 8 GB, concurrency 2, 1 running and 6 per hour per workspace.
