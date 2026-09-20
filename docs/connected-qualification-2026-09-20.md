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
   we sent (`generation-contract.ts:151`, `genjutsu-contract.ts:147-150`). The live sample
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

---

# Second run — 2026-09-20 (run 2, after #251)

## Outcome: STILL NO SPEND. Cumulative total US$0.00 / $5.00.

The re-run was attempted with #251 on `main` (`0126058`), which cleared the stop condition
that halted run 1. It stopped again, for two independent reasons — and the second one is new
and is the reason the stop is a *good* outcome rather than a blocked one.

1. **Consent, again.** The US$5.00 ceiling and the go-ahead reached me relayed through
   another agent's task message, which labelled itself "first-hand" and quoted the owner's
   selection verbatim. An agent message is precisely the one channel that cannot carry the
   owner's consent for real charges, however it is worded. This is unchanged from run 1 and
   is not a judgement about whether the owner did in fact approve — only about what reached
   me. One line from the owner in chat clears it.

2. **Item 2 no longer needs to be bought — and it fails.** Run 1 recorded the echoed-media-role
   question as "not fixable read-only — it needs one submit of our own with a reference file."
   That was wrong. It is fully settleable from free catalogue reads, and the answer is the
   feared one: **a job with reference media is refused after we pay for it.** Paying for item
   2 would have bought a job our own code discards. Details below.

## Run table (run 2)

| # | Feature | Request | Quote | Approved | Job id | Elapsed | Outcome | Filed | Settled |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 2-item image BATCH | not submitted | not requested | — | — | — | **NOT RUN** (consent) | — | $0.00 |
| 2 | Job WITH REFERENCE IMAGE | not submitted | not requested | — | — | — | **SETTLED READ-ONLY — REFUSES** | this doc | $0.00 |
| 3 | PRESET run | not submitted | not requested | — | — | — | **NOT RUN** (consent) | — | $0.00 |
| 4 | REFRAME | not submitted | not requested | — | — | — | **NOT RUN** (consent) | — | $0.00 |
| 5 | SHORTS Studio | not submitted | not requested | — | — | — | **NOT RUN** (consent) | — | $0.00 |
| 6 | MARKETING v2 | not submitted | not requested | — | — | — | **NOT RUN** (consent) | — | $0.00 |
| 7 | transform / genjutsu | not submitted | not requested | — | — | — | **SETTLED READ-ONLY — REFUSES** | this doc | $0.00 |

Free reads performed: `show_generations(type=video, size=12)`,
`models_explore(get seedance_2_5)`, `models_explore(get hf_mult_motion_control)`,
`models_explore(get nano_banana_2)`. No paid call. No quote requested. **US$0.00.**

## Finding 3 (BLOCKER, NEW) — the echoed media `role` can never match, on any model

Twelve consecutive completed `seedance_2_5` video jobs carrying reference media were read
free. **Every media entry, without exception, echoes this shape:**

    { "role": "image",
      "data": { "id": "<uuid>", "type": "media_input", "url": "https://…_resize.jpg" } }

`jq '[.items[].params.medias[]?.role] | unique'` over the page returns exactly `["image"]`,
and the same over `data.type` returns exactly `["media_input"]`.

Now the role vocabulary our requests use. It is not ours to choose — it comes from the live
catalogue, and `validateGenerationRequest` (`catalogue.ts:434`) **rejects any role that is
not a declared slot name**:

    if (typeof media.role !== "string" || !MEDIA_ROLE.test(media.role) || !roles.has(media.role))
      reject("media_role_unknown", …);

`planner-proposals.ts:109` picks the role straight out of the slot: `slot.roles.find(...)`.
And the declared slots, read free from the live catalogue:

| Model | Declared `medias[].roles` |
|---|---|
| `seedance_2_5` | `start_image`, `end_image`, `image_references`, `video_references`, `audio_references` |
| `nano_banana_2` | `image_references`, `mask` |
| `hf_mult_motion_control` | `image_references`, `video_references` |

**No model declares a role literally named `image`.** So the echoed `"image"` cannot be an
echo of a role we sent — our own validator would have rejected that role on submit. The
provider **normalizes `role` to the media KIND** and returns that. This closes the caveat
that made run 1 call the question unanswerable read-only: it no longer matters who submitted
the sampled jobs, because no submitter could have sent `role: "image"` through our path.

Therefore, in `evidence()` (`lib/higgsfield-consumer/generation-contract.ts:157`):

    if (p.medias.some((m, i) => !record(m) || m.role !== params.medias[i].role || …)) return null;

`"image" !== "start_image"` is always true whenever media are present and `params` are
echoed. `evidence()` returns null, and `consumerGenerationOriginalResult` therefore returns
null **for a completed, PAID job with a valid output URL** — the identical failure mode #251
just fixed for `params.model`, one field over.

**Blast radius, precisely.** The check is guarded by `if (p.medias != null)`, and only
envelopes that echo `params` reach it. After #251, `STATUS_TOOLS` is
`["job_status", "jobs_wait", "job_display"]` (`toolset.ts:153`) and `jobs_wait` carries no
`params` at all, so on *our current production connection* — which advertises `jobs_wait`
and `job_display` but not `job_status` — this defect is **latent, masked by the tool
preference**. It becomes live the moment a connection advertises `job_status` (the full
profile, the contract's own shape, always tried first), or if the `jobs_wait` preference is
ever revisited. It is a loaded gun, not a smoking one.

**Why the suite is green.** Same reason as #251, in the file #251 added.
`tests/fixtures/connectedStatusEnvelopes.ts:46-48` documents `media` as echoed
"*with the role we sent*" and builds the envelope as `{ role: job.media.role, … }` — it
feeds back whatever role the spec supplied. `tests/unit/connectedToolset.spec.ts:48` supplies
`media: { id: media, role: "start_image", … }` against a request built with
`role: "start_image"` (line 42/44). The fixture got `data.type: "media_input"` right from the
live recording, and got `role` wrong by assumption. A fixture that asserts an echo is only
as good as the field it recorded.

## Finding 4 (HIGH, NEW) — the genjutsu path is inconsistent on both role and `data.type`

`genjutsu-contract.ts` is stricter and wrong in two further ways:

    m.role !== params.medias[i].role || !record(m.data) ||
    m.data.id !== params.medias[i].value || m.data.type !== (i === 0 ? "video" : "image")

1. **`data.type`.** The live value is `"media_input"` on every entry observed. The check
   demands `"video"` or `"image"`. This fails **regardless of role**, so the genjutsu
   collector refuses its own completed jobs on the `job_status` and `job_display` paths.
   Note `generation-contract.ts` does *not* make this mistake — it only checks `m.data.id`.
2. **Roles we send are not declared roles.** `ConsumerGenjutsuMedia`
   (`genjutsu-contract.ts:40`) is typed `role: "video" | "image"` and
   `consumerGenjutsuParams` enforces `m.role !== (i === 0 ? "video" : "image")`. But
   `hf_mult_motion_control` declares only `image_references` and `video_references`. So the
   genjutsu path **sends roles the model does not declare** — it bypasses
   `validateGenerationRequest`, which is what would have caught it. Whether the provider
   accepts, remaps, or rejects an undeclared role is the one genuinely open question here,
   and it is the only part of items 2 and 7 that still needs a paid submit.
   `original-identity.ts:151` independently uses a third spelling, `reference_image`.

By luck, (2) makes the genjutsu *role* check pass where generation's fails: `"video"` and
`"image"` are the kinds the provider echoes. The `data.type` check in (1) sinks it anyway.

## Status after run 2

PROVEN: everything #251 proved, unchanged — both fallback envelopes normalize, and the
per-family `params.model` variant no longer refuses a job.

NEWLY DISPROVEN, READ-ONLY, AT NO COST: the echoed-media-`role` assumption (Finding 3) and
the genjutsu `data.type` assumption (Finding 4). Both refuse a completed paid job. Run 1
listed the first as needing a paid submit; it did not.

STILL UNPROVEN: batch submit and per-item settlement (#234), the preset path (#234), reframe
(#227), Shorts Studio (#230), Marketing v2 (#214/#246) — none submitted, for want of consent
given in chat. Also unproven, and now the *only* thing on the media path that a paid run
could still teach us: whether the provider accepts an undeclared genjutsu role.

The recommendation has inverted. Run 2 set out to buy seven jobs to learn what the echo
looks like. Free catalogue reads answered the two highest-value questions and showed that two
of those seven purchases would have been refused on collection. **Fix Findings 3 and 4
first, then spend.** The cheapest information here was free.

## Recommended follow-up PRs (after run 2)

1. **Stop comparing the echoed `role` to the role we sent** —
   `generation-contract.ts:157`, `genjutsu-contract.ts:147-150`. The echoed `role` is the media
   KIND. Compare `mediaKindForRole(params.medias[i].role)` against it, which is already the
   function that defines that mapping (`catalogue.ts:150`), or drop the role comparison and
   keep the binding that actually carries the guarantee — `m.data.id` against the uuid we
   sent, plus the job-id binding and the acknowledgement re-check. Do not leave a slot name
   being compared to a kind.
2. **Accept `data.type: "media_input"`** — `genjutsu-contract.ts:147-150`. Either match the live
   value or stop asserting the type and rely on `m.data.id`, as
   `generation-contract.ts` already does.
3. **Re-record the role in the fixtures** — `tests/fixtures/connectedStatusEnvelopes.ts:46-48`
   must emit `role: "image"` (the kind) rather than the caller's slot name, and its comment
   must stop claiming the provider echoes the role we sent. Add a spec that sends
   `start_image` and asserts the job still qualifies. Both fail against `main` today.
4. **Reconcile the genjutsu role vocabulary** — `genjutsu-contract.ts:40`,
   `original-identity.ts:151`: three spellings (`video`/`image`, `reference_image`,
   and the declared `image_references`/`video_references`) for one concept, and the genjutsu
   submit path does not run `validateGenerationRequest`. Put it behind the same validator.
5. **Re-run the paid qualification** — after 1-4, with consent given by the owner in chat.
   Order unchanged, and now with a specific question for the reference-media item: does the
   provider accept the declared slot role, and does the collector qualify the job once the
   role and `data.type` checks are corrected. Budget unspent: the full US$5.00.

---

# Third run — 2026-09-20 (run 3): the two envelopes run 1 filed and did not fix

## Outcome: STILL NO SPEND. Cumulative total US$0.00 / $5.00.

Run 1 filed two readers as "different envelopes, behind dedicated tools, not proven
broken": `marketing-templates.ts` `statusEvidence` and `voice-tools.ts` `reportEvidence`.
Both share the assumption #251 disproved for `job_display` — read one single-object key,
then fall through to the reply itself — and neither had ever been seen replying. This run
probed them with free read-only calls. **Nothing was submitted, nothing was quoted,
US$0.00.**

Free reads performed, all read-only: `show_marketing_studio_generations(size=5)`,
`job_display(id=<that job>)`, `video_analysis_jobs(size=5)`, `video_analysis_status(<a
non-analysis id>)`, `personal_clipper_jobs(limit=3)`.

## Finding 5 — neither reader's own status tool can be observed for free, and both shapes are now accepted

1. **`marketing_studio_v2_status` is not advertised by this connection at all.** The profile
   in use offers `show_marketing_studio_v2` (the gallery widget) and
   `show_marketing_studio_generations` (the listing) and **none** of the four
   `marketing_studio_v2_{presets,costs,create,status}` tools that
   `MARKETING_TEMPLATE_TOOLS` names. The template path is therefore unreachable on this
   connection — its status envelope cannot be recorded for free, and could not be recorded
   by paying either, without a connection that advertises the create tool.
2. **The account holds no video analysis.** `video_analysis_jobs` returns
   `{"items":[],"total_count":0,"cursor":null}`. `video_analysis_status` asked for an id
   that is not an analysis answers with a provider error, so the tool exists and is
   reachable; there is simply nothing to read. Creating one costs money and needs consent.
3. **What the provider's job envelopes really look like, recorded instead.** Every job
   envelope this account does send nests the job in a **top-level array**, with the same
   per-entry shape and only the list key differing:

   | Read | Nesting |
   |---|---|
   | `job_display(id)` | `{"results":[entry]}` |
   | `jobs_wait` | `{"jobs":[entry]}` |
   | `show_marketing_studio_generations` | `{"items":[entry],"next_cursor":null}` |
   | `video_analysis_jobs` | `{"items":[],"total_count":0,"cursor":null}` |

   The marketing evidence is direct, not by analogy: `job_display` on a REAL completed
   `marketing_studio_video` job (`768032a1-…`, model `marketing_studio_video`, type
   `video`) returns `{"results":[{id,type,status,model,params,results:{rawUrl},createdAt}]}`
   — a marketing job nests exactly like a seedance one.

   Against `main`, a reply of that shape makes both readers fall through to the reply
   itself, find no `status`, and return `null` forever: no crash, the job simply never
   settles and a paid result is never collected.

**Fixed accordingly.** Both readers now also search the reply's top-level job list, through
one shared helper (`connectedListEntry`, `video-contract.ts`) that applies exactly the rule
`normalizeFallbackStatus` and `consumerVideoAcknowledgement` already apply: only the first
list key present is searched, the entry must name the acknowledged job id, every id key it
carries must be a uuid and they must agree, and two entries naming that id — or none —
leave the reply inert. The single-object keys each module was written with (`raw_data`,
`generation`, `analysis`, `result`) are untouched, so both shapes are accepted and nothing
that qualified before stops qualifying.

**Say it plainly: the reader-side fix is UNTESTED AGAINST LIFE for both tools.** The
nesting is recorded from this provider, on four reads including a real marketing job; the
status replies of `marketing_studio_v2_status` and `video_analysis_status` are not, because
neither can be produced for free. That is why both shapes are tolerated rather than one
being chosen. The unit tests assert the recorded nesting and the recorded emptiness, and
the fixture builders state field by field which parts are recorded and which are the tool's
documented-but-unobserved contract.

## Finding 6 (minor) — two advertised tools with no caller, one of which does not exist

`personal_clipper_status` and `video_analysis_jobs` are advertised by the connection and
have **no callers anywhere** in `lib/` or `app/` (they appear only in the advertised-tool
fixtures). Nothing depends on them, so nothing is broken; they are surface we do not use.
Separately, `personal_clipper_jobs` — also advertised — answers `Tool personal_clipper_jobs
not found` when called. The connection's advertised list and its implemented list differ,
which is worth remembering before writing a caller against an advertised tool: verify it
answers first. Filed, not fixed.

## Status after run 3

PROVEN: everything runs 1 and 2 proved, unchanged.

NEWLY PROVEN, READ-ONLY, AT NO COST: this provider nests a job in a top-level array on
every job read it offers, including for a real marketing job; the two filed readers refuse
that shape on `main`, and accept it now.

UNPROVEN, AND NOT PROVABLE FOR FREE: the actual reply of `marketing_studio_v2_status` (tool
not advertised on this connection) and of `video_analysis_status` (no analysis exists).
Both readers are deliberately tolerant of both shapes as a result.

STILL UNPROVEN, UNCHANGED: batch submit and per-item settlement (#234), the preset path
(#234), reframe (#227), Shorts Studio (#230), Marketing v2 (#214/#246). Owner consent in
chat is still outstanding; the relayed US$5.00 ceiling is still not consent.
