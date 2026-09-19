# Durable production pipelines

Pipelines are an additive workflow at `/pipelines`, linked from Studio with the current production. Existing recipes, legacy runs, private workbench drafts, and the standalone Gen interface keep their behavior.

## Context and ownership

A pipeline version names one existing production and one immutable `workbench_bibles` version. Compilation never reads or publishes a private draft. Prompts come from that publication's brief, script, direction, or an explicitly named node; visual references name published assets or completed upstream generation outputs. Authenticated media IDs are required. Arbitrary URLs, missing lineage, cycles, invalid media roles, and dangling output slots are rejected.

Each run belongs to the account that created it. Other members can use the shared published context to create their own runs, but cannot read, approve, select takes in, or change another account's run. Browser mutations use the document's captured account/workspace scope. Workers restore fresh account and membership state before admission; disabled members, deleted accounts, suspended workspaces, and API tokens cannot start pipeline work.

## Spend and recovery

Creating a version or run spends nothing. A ready image, video, or audio stage is quoted as a batch. The quote stores the exact normalized request, resolved source/storage identity, model parameters, rules, and current price server-side. The client receives a sanitized quote. Every approval compares the displayed fingerprint, run revision, input binding, and ten-minute expiry. There is no whole-run preauthorization or implicit paid continuation into an unquoted stage. Any future overall estimate is informational, not approval.

Approval atomically inserts permanent per-unit attempts with deterministic request keys. Concurrent or repeated approval returns the same attempts. The shared generation/audio admission layer independently checks the saved quote before its first reservation and dispatch. New prices or changed inputs require a new quote; they are never silently adopted.

A lost admission response keeps the original body and request key. A known generation ID remains attached even if the provider job fails or is cancelled. Only a deliberate fresh quote can create a new attempt for a failed/refused unit; succeeded siblings are retained. A response without an authoritative ID remains uncertain unless the admission service records a definite pre-job refusal. Retrying it does not purchase a replacement job. Provider submissions that remain uncertain without a usable handle require operational reconciliation.

Pause prevents subsequent ticks from admitting unstarted work. Already submitted generations may complete and their results are recorded. Resume continues only existing approved attempts. Cancellation prevents remaining submissions; changing a finished run or a downstream-bound take selection requires a new run.

## Persistence and execution

Additive tables are `pipeline_versions`, `pipeline_runs`, `pipeline_quotes`, `pipeline_attempts`, `pipeline_selections`, and `pipeline_wakeups`. All new rows and lookups include `workspace_id`; historical recipe/run tables are unchanged. Versions and attempts are immutable in identity. Mutations use compare-and-swap revisions, write transactions, and lease tokens with monotonically increasing epochs. Delayed worker results cannot checkpoint after a lease takeover. Wakeup sequence numbers preserve notifications posted during another worker's lease, and consumed wakeups are moved out of the due queue while processing.

The request's bounded `after()` lifetime starts approved work; the authenticated reconciliation cron drains persisted wakeups after syncing generation statuses. Each admitted unit is then handed off like any other render — natively to `/api/worker`, or to Inngest when a deployment opts in, or inline when neither is reachable (docs/native-dispatch.md). Provider work uses the existing durable generation request, reservation, dispatch, and settlement tables. The pipeline lease is orchestration ownership, not permission to repeat a paid provider call. Owner workspace exports include only their own sanitized pipeline versions and run state, with resolved child summaries; prepared provider data, collaborators’ private runs, and worker lease/wakeup controls are excluded. The media deletion guard retains sources referenced by versions and quotes, admitted outputs, selections, and timeline manifests.

## Supported limits and delivery

Version 1 supports 32 stages, 64 generation units, 12 visual inputs per stage, and 20 deliberate attempts per unit. The guided editor builds image options, explicit take review, video, optional speech/sound/music, and a delivery timeline. The API accepts the same bounded typed DAG, including multiple branches. Model aspect, resolution, duration, and audio capabilities are checked before quoting. Trained identity rendering, editing/upscaling-only models, and fixed image seeds are excluded from this executor.

Assembly prepares an editorial timeline manifest with frame counts, source in-points, exact selected generation IDs, and optional soundtrack. It is not an encoded movie. “Render final movie” transfers that timeline through the existing scoped ten-minute browser snapshot into `/workbench/movie`. The renderer validates actual source durations and supports MP4/WebM at 720p/1080p, up to three minutes and 200 MB of downloaded source media, with its existing codec/audio checks. Pipeline delivery aspects are 16:9, 9:16, 1:1, and 4:5. A manifest remains downloadable independently of browser encoding support.

## Verification

Focused tests exercise compilation boundaries; real SQLite version/approval races; source binding; pause, cancellation, and same-key recovery; known failed IDs; lease takeover; wakeup scheduling; selected take locking; fresh actor access; and media retention. The local browser workflow uses `ENGINE_MOCK=1`, real signup/publication/pipeline routes, individual stage approvals, persisted image/video/audio outputs, approval replay, reload, and movie handoff at the five required viewports. No paid provider calls are part of verification.
