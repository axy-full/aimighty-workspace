# Connected-account qualification — 2026-09-20

> **Status as committed.** Findings 1 and 2 are FIXED in the pull request that
> commits this document (`fix/connected-status-fallback`). This report is kept
> verbatim as the record of the halted run and of what is still unproven; the
> "Status" and "Recommended follow-up PRs" sections at the end state what the
> fix changes and what a re-run still has to prove. Spend is still
> **US$0.00** — the fix was proven against envelopes recorded read-only, not
> against a job we paid for.

## Outcome: NO SPEND. Halted at the read-only stage.

Two independent reasons, either sufficient on its own:

1. **Consent.** The US$5.00 ceiling and the approval to spend reached me relayed through
   another agent's task message, not from the owner in chat. A relayed approval is not
   owner consent for real charges on a connected account, so no paid submit was made.
2. **Stop condition triggered.** Read-only probing found a defect that leaves a completed,
   paid job uncollectable on the tool profile currently in play. The brief says to report
   and stop spending on exactly this. It was found before any money moved.

Spend to date: **US$0.00 / $0.00 of $5.00.** No job submitted, no quote approved.

## Run table

| # | Feature | Request | Quote | Approved | Job id | Elapsed | Outcome | Filed | Settled |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Connected BATCH (2x image) | not submitted | not requested | — | — | — | **NOT RUN** (consent + halt) | — | $0.00 |
| 2 | PRESET run | not submitted | not requested | — | — | — | **NOT RUN** | — | $0.00 |
| 3 | STATUS FALLBACK | read-only, as briefed | free | — | e7023b04-46af-46d7-b809-950e3e6a4d93 | ~2s | **RUN — FAILED** | this doc | $0.00 |
| 4 | REFRAME | not submitted | not requested | — | — | — | **NOT RUN** | — | $0.00 |
| 5 | SHORTS Studio | not submitted | not requested | — | — | — | **NOT RUN** | — | $0.00 |
| 6 | MARKETING v2 | not submitted | not requested | — | — | — | **NOT RUN** | — | $0.00 |
| 7 | IDENTITY | not submitted | not requested | — | — | — | **NOT RUN** | — | $0.00 |

Free reads performed: `balance` (1468.53 credits, plan `team`), `list_workspaces`
(ZigZag Films `73834e6d-…` selected, 1468.53 credits; Aimighty Studio `c0b07af1-…`,
146.74, member), `show_generations(type=video, size=6)`, `job_display`, `jobs_wait`.

## Finding 1 (BLOCKER — FIXED) — the `job_display` fallback can never qualify any job

The connection used for this probe advertises `job_display` and `jobs_wait` and **not**
`job_status` — the 91-tool profile that `lib/higgsfield-consumer/toolset.ts:6-8` describes.
That is the profile the fallback exists for.

Live `job_display` reply (shape only):

    { "results": [ { "id": "<uuid>", "type": "video", "status": "completed",
                     "model": "seedance_2_5", "params": {...},
                     "results": { "rawUrl": "...", "thumbnailUrl": "..." },
                     "createdAt": 1789675148.4 } ] }

The job entry is an element of a top-level **`results` array**.
`normalizeFallbackStatus` (`lib/higgsfield-consumer/toolset.ts:199-201`) looks only at:

    const candidate = [raw.generation, raw.job, raw].find((v) => record(v) && idOf(v) !== null);

- `raw.generation` — absent
- `raw.job` — absent
- `raw` — `idOf(raw)` is null (no `id`/`job_id`/`jobId` at the top level)

No candidate, so `entry` stays undefined and the function returns the inert
`{ status_source: "job_display", recognised: false }`. `consumerGenerationOriginalResult`
can never see a `generation`, so a **completed job with a valid output URL is never
collected**. The `jobs_wait` branch at `toolset.ts:203` already searches `raw.results`;
the `job_display` branch does not.

Compounding: `resolveStatusTool` (`toolset.ts:150`, order from `STATUS_TOOLS` at
`toolset.ts:140`) prefers `job_display` over `jobs_wait`. On the 91-tool profile it picks
the broken read and never falls through to the working one. `tests/unit/connectedToolset.spec.ts:120`
asserts that preference, so the ordering is intentional, not a slip.

Why the suite is green: the fixture at `tests/unit/connectedToolset.spec.ts:129` is flat —
`{ id: jobId, status: "completed", model, type, results: { rawUrl } }` — the job fields at
the top level. The live provider does not send that shape. The fixture is wrong, and it
masks the defect.

`jobs_wait` normalizes correctly against the live shape:

    { "jobs": [ { "index": 0, "job_id": "<uuid>", "status": "completed", "type": "video",
                  "model": "seedance_2_5", "result_url": "...", "thumbnail_url": "..." } ],
      "summary": {...}, "all_terminal": true }

`idOf` matches on `job_id`; `resultUrl` picks up `entry.result_url`; `thumbnail_url` is not
a recognised key so it does not poison the single-URL check; `all_terminal: true` correctly
suppresses `poll_after_seconds`. This is the only fallback that works live today.

## Finding 2 (HIGH — FIXED) — echoed `params.model` rejects every job

The live entry carries a top-level `model: "seedance_2_5"` **and** a nested
`params.model: "default"` — the nested one is a variant selector, not the model id.
`generation-contract.ts:141` compares the nested value against our model id:

    if ("model" in p && p.model !== params.model) return null;

`ConsumerGenerationParams.model` (`generation-contract.ts:63`) is the model id. If the
provider echoes `params.model: "default"` for jobs we submit too, `evidence()` returns null
and the job never qualifies — **on the `job_status` path as well, not just the fallback**.
Unconfirmed at the time of the halt: this sample was submitted from the Higgsfield web UI,
so the echo for our own submissions may differ.

**Corroborated read-only on 2026-09-20 (no spend).** A free `show_generations(type=image)`
read returned four completed `nano_banana_2` entries in the SAME per-entry shape as
`job_display`'s `results` elements, and not one of them carries a nested `params.model` at
all — their params carry `input_images`, `resolution`, `batch_size` and an extra
`results.minUrl`. So a nested `model` is a **per-family** provider field, present for the
seedance family as the variant word `"default"` and absent for the nano_banana family. It
is never the model id on any family observed. `model` is also a RESERVED_PARAMETER
(`catalogue.ts:80`) that a request can never set itself, so the value coming back is the
provider's own canonical params rather than an echo of ours. That is enough to fix the
check without a paid submit.

Note the interaction: `toolset.ts` copies `entry.params` into `generation.params`, so fixing
Finding 1 alone would hand `params.model: "default"` straight into `evidence()` and fail
again. Both need the same PR. `jobs_wait` omits `params` entirely and so sidesteps it.

## Status

**As of the fix PR (`fix/connected-status-fallback`), against the same US$0.00 of spend:**

PROVEN (read-only): both fallback envelopes, as the live account actually sends them, are
now normalized into an envelope the collectors qualify — `jobs_wait` and `job_display`,
completed and in progress — and the echoed per-family `params.model` variant no longer
refuses a job. Proven by unit tests asserting against envelopes recorded verbatim from the
live account (`tests/fixtures/connectedStatusEnvelopes.ts`), eleven of which fail against
`origin/main`.

DISPROVEN, NOW FIXED: the `job_display` status fallback (Finding 1) and the nested
`params.model` comparison (Finding 2). `STATUS_TOOLS` now prefers `jobs_wait` over
`job_display`, so a connection advertising both takes the read whose live envelope is
verified end to end.

STILL PARTLY PROVEN: everything above is verified against a job **we did not submit**. The
provider's echo for our own submissions is still unobserved. Two specific things a paid
re-run must check, both of which would still fail a job today:
1. **Echoed media roles.** `evidence()` requires `params.medias[i].role` to equal the role
   we sent (`generation-contract.ts:151`, `genjutsu-contract.ts:139`). The live sample
   echoes `role: "image"`; our requests send catalogue roles such as `start_image`. If the
   provider normalizes roles, a job with reference media never qualifies. Not fixable
   read-only — it needs one submit of our own with a reference file.
2. **Echoed prompt on the genjutsu path.** `genjutsu-contract.ts:113-115` *hard-requires*
   `g.params.prompt` to be present and identical. The fallback envelope only carries
   `params` when the entry does; the seedance sample echoed the prompt verbatim, but no
   genjutsu (`hf_mult_motion_control`) entry has been observed.

UNPROVEN, UNCHANGED: batch submit/settlement (#234), preset path (#234), reframe (#227),
Shorts Studio (#230), Marketing v2 (#214/#246), identity — none were run, for the two
reasons at the top. Owner consent in chat is still outstanding; the relayed US$5.00
ceiling is still not consent.

FILED, NOT FIXED (different envelopes, behind dedicated tools, not proven broken):
`marketing-templates.ts:366` (`statusEvidence`) and `voice-tools.ts:283` (`reportEvidence`)
read `value.<key>` then fall through to `value` with no top-level-array search. Their tools
(`marketing_studio_v2_status`, `video_analysis_status`) have not been observed returning a
`results` array, but they share the assumption this PR just disproved for `job_display`. A
reply of that shape would make them return null forever — no crash, the job simply never
settles.

## Recommended follow-up PRs

Items 1-4 are DONE in `fix/connected-status-fallback`; item 5 is the remaining work.

1. ~~**Fix the `job_display` fallback**~~ — `toolset.ts:199-201`: search the top-level
   `results`/`jobs` array as the `jobs_wait` branch does, matching the single entry whose
   `idOf` equals the acknowledged id. Replace the flat fixture at
   `connectedToolset.spec.ts:129` with the live envelope recorded above, and add the live
   `jobs_wait` envelope as a second fixture.
2. ~~**Decide the `params.model` contract**~~ — `generation-contract.ts:141`: either ignore a
   nested `params.model` (compare only the top-level `generation.model`, which is already
   checked at `generation-contract.ts:138`) or compare it against an allowed variant set.
   Do not leave it comparing a variant string to a model id.
3. ~~**Reconsider the status-tool preference**~~ — `toolset.ts:140`: prefer the read whose
   envelope we can actually normalize. Until PR 1 lands, ordering `jobs_wait` ahead of
   `job_display` restores collection on the 91-tool profile by itself, and is the smaller
   change to ship first.
4. ~~**Record live envelopes as fixtures**~~ — a checked-in file of real `job_display` /
   `jobs_wait` / batch-ack replies, so unit tests stop inventing shapes.
5. **Re-run this qualification** — now unblocked on the code side, and still blocked on
   consent. The stop condition that halted it is cleared: a finished job read through
   either fallback is collectable, and the variant echo no longer refuses one. What a
   re-run must still establish, in this order and with owner consent given in chat:
   the 2-item image batch (a model whose params carry no nested `model`, the simplest
   case), then one job WITH a reference file to settle the echoed-role question above,
   then the genjutsu path to settle the echoed-prompt question. Anything that fails on
   the echo rather than on the generation is a contract bug, not a spend to repeat.
