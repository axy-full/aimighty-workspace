# Independent money review: PR #544 (S12.4, nothing paid on the sample production)

- Reviewer: fresh independent reviewer (Claude), 2026-10-06.
- Branch `fix/sample-no-spend` at `6a7844db583a22ab7b9c2647659ba9fe5e99797d`. Money change = commit `198be177`
  (`lib/demo/spend-guard.server.ts`, three hooks in `lib/generationAdmission.ts`, `lib/audioAdmission.ts`, `lib/generationRequests.ts`,
  and `tests/unit/demo-s12-no-spend.spec.ts`).
- Compared against `origin/release/1` at `fa9956d0` (which already carries #543's `lib/demo/*` unchanged, but not the guard).
- Worktrees used: `W/review-544` (PR head) and `W/review-544-r1` (release/1 plus the PR's money commit applied, byte-identical
  to `git merge-tree` of the PR onto release/1). Both removed at the end.

## VERDICT: PASS

No high or medium finding. Six low findings below; none lets a job filed on the sample reach a provider.

## Gates

| Gate | Result |
|---|---|
| Full unit, PR head (`ENGINE_MOCK=1 PW_BASE_URL=http://localhost:4999 playwright --project=unit --workers=1`) | 3329 passed, 3 skipped, 0 failed (10.0m); log /private/tmp/review-544-unit.log |
| Full unit, PR merged onto release/1 (includes the probes) | 3708 passed, 6 skipped, 0 failed (9.5m); log /private/tmp/review-544-r1-unit.log |
| `tsc --noEmit -p .` on the release/1 merge | 0 errors |
| `git merge-tree --write-tree HEAD origin/release/1` | clean (exit 0, tree `332b34d0`); #543 alone also merges clean |
| Probes `S/demo/review-544-probes/review-544-probes.spec.ts` (10) + PR spec (6) + S12 mark/route specs | all pass on PR head and on the release/1 merge (29/29) |

## (1) Every paid door on release/1, and whether the guard covers it

Every paid door ends in `reserveGenerationSpend` (`lib/generationRequests.ts`), whose new check refuses an event whose
`projectId` (or `options.projectId`) is the sample or whose `shotId` is one of the sample's shots. Admission doors are also
refused earlier, before any row is written or held. release/1 added no new reservation caller; every new paid action rides an
existing door.

| Door (release/1) | How it is tied to a production | Covered |
|---|---|---|
| `POST /api/generate` → `executeGenerationAdmission` (video, still, transforms, finals, Product image, Soul render; release/1's **Upscale** `lib/shell/upscale.ts`, **Cut-out** `lib/workspace/cutout.ts`, **Line drawings** `storyboard/use-lines.ts`, **Motion transfer / Object swap** `lib/shell/viral.ts`, storyboard frames) | `body.projectId` / `body.shotId`; a final's are read from its draft first | Yes: admission guard (generationAdmission.ts:423) before any write or hold, then the reservation guard. Probes P1, P2, P6 |
| `POST /api/audio` → `executeAudioAdmission` | `body.projectId` / `body.shotId` | Yes: audioAdmission.ts:229, before hold or write |
| Pipeline `admitPrepared` (Atomik key steps, Rig agent steps, **plan approval**: `rig-agent-runs.ts:148`) | the prepared request's project/shot | Yes (claim present). PR test "quote … pipeline's admission … refused" |
| Held release (person's press, or credits arriving) `lib/held.ts:320` | the held row's project and shot | Yes, stays held. Probe P8 |
| `POST /api/audio/transcribe` → `lib/transcription.ts:233` (**Transcribe**) | `input.projectId` if sent (the board's Transcribe sends it) | Yes when filed; answers **402** not 409 (L2). Unfiled: known edge |
| Dubbing `lib/dubbing.ts:218` | project/shot | Yes; leaves a failed row (L3) |
| `POST /api/identities/[id]/render` | `body.projectId ?? identity.projectId` | Yes; leaves failed rows (L3) |
| Identity training `lib/identities.ts:391`, Soul training `lib/soulIdentities.ts:734` | identity's project / draft's production | Yes when it has one; no project = known edge |
| Atomik workbench jobs, Development (writer, storyboard artist), Rig agent planning, Crew rounds, Astra Blender renders | the server-read draft's `productionProjectId` (a `sample-` copy keeps the sample's id: `open.server.ts`, and `saveDraft` refuses a change of project) | Yes |
| Paid text: Atomik chat (`chat.projectId`), shots/draft, treatment/scene (projectId required), memory read (optional) | as named | Yes when filed |
| Paid text with no production: `POST /api/prompt/enhance`, `atomik/ideas/draft` | none | No (L1) |
| Higgsfield connected-account routes | n/a | Unreachable: 410 on release/1 (`lib/higgsfield-consumer/retired.ts`) |
| Quotes: `/api/generate/quote`, audio `quoteOnly`, transcription `quoteOnly`, `prepareAdmission` | n/a | Still answer (probe P5, PR quote test) |

**Rebasing for the new paid paths: nothing is needed.** The guard lives in the two admission functions and in the one
reservation function, and release/1's new actions all route through them. The merge is clean and the merged tree passes.

## (2) Bypass attempts

- A shot of the sample under another project's id, or the sample's id with another project's shot. Generation answers
  409 with the sample's line. Audio refuses the mismatch first (400 "That shot belongs to another production."). Nothing is
  written either way (P1).
- A final whose request names another project. The draft's own project and shot replace the request's before the check (P2).
- A missing projectId. Refused through the shot when there is one (the PR's test). With neither field, the job is filed
  nowhere, so it is not on the sample (L1, P10).
- A copied draft (`sample-` prefix). The guard keys on the production, not the draft id. A copy keeps the sample's production,
  and `saveDraft` refuses a change of project. New nodes in a copy map to new shots under the sample's project, so they are
  refused too.
- A forged header. A foreign `X-Workbench-Scope` is refused before admission. Other headers change nothing, and the refusal
  reads the tenant's own `settings` and `shots` rows (P9).
- A race with mark or undo. The mark is read fresh, with no cache, on every admission and every reservation: marking takes
  effect on the next request, and so does undo (P7). One small window remains (L5).
- A take held before the mark. It never starts once marked, whether a person releases it or credits arrive in the
  background pass, and it stays held (P8).

## (3) Fail closed

- If the database can't be read, the guard throws. `withGenerationRequest` answers "The request was interrupted before a job
  was created. Nothing was charged" (409), and nothing is written, reserved or sent. The reservation throws too (P3).
- A stored row this code can't parse reads as no sample (L4).

## (4) Quotes and free reads

The generate quote route, audio `quoteOnly` and pipeline preparation all answer on the sample with a price (P5 and the PR's
test). The guard only reads.

## (5) No data deleted or changed

Refusals leave `settings` (the mark), `projects`, `shots` and `generations` byte-identical (P6). Undo keeps the row, hidden,
never deleted (P7). The only rows written on a refusal come from the doors in L3, and that is how those doors already
handled any refusal.

## (6) Do the PR's tests prove (1)–(4)?

Mostly. Its "mixed" assertion is weak, and it lacks fail-closed, held-release, finals and quote-route cases (L6). The probes
fill those gaps.

## Findings (all LOW)

1. **L1, unfiled paid doors can't be tied to the sample.** This is wider than the stated known edge.
   - `app/api/prompt/enhance/route.ts` (the Make composer's Enhance; `lib/shell/use-enhancer.ts:36` sends no projectId),
     `app/api/atomik/ideas/draft/route.ts`, memory read without a projectId, transcription without a projectId, an identity
     with no project, and an Atomik chat with no project all reserve with `projectId: null`.
   - Scenario: a person on the sample uses Enhance in Make. It is charged to their own workspace at the normal price and
     filed nowhere. Nothing is filed on the sample.
   - Only #543's UI gate (board cards) and the wallet stand in front of these. Make's Enhance is not gated on the sample.
   - Proving test: P10 (unfiled is admitted); read the code for Enhance.
   - Suggested fix (owner's call): send the open production's id with Enhance and Ideas, or disable them on the sample.
2. **L2, the Transcribe refusal says 402.** `lib/transcription.ts:235` maps every `SpendReservationError` except a paused
   ledger to 402. A sample refusal reaches the client as 402 "payment required" with the sample's line, not 409. Nothing is
   charged (`charged: 0`), but a client may read 402 as "top up". Proven by reading the code.
3. **L3, some doors write rows before they reserve, so a refused job leaves a failed row in the sample's library.**
   - Identity render (`app/api/identities/[id]/render/route.ts` writes rows at about line 80; on refusal it marks them
     `failed` with the sample's line).
   - Dubbing (`lib/dubbing.ts:200-227`, a failed generation and a dubbing job).
   - The queued job rows of Atomik, Development and Astra Blender.
   - Nothing is spent and nothing is deleted. It contradicts the PR's "nothing … written" only for these doors, and they
     can't be reached from the sample's gated board controls.
4. **L4, a mark this code can't parse fails open.**
   - `parseSampleMark` returns null for invalid JSON or a version other than 1, and `spend-guard.server.ts:16-17` then allows.
   - Only `writeMark` writes the key, and `PATCH /api/settings` can't, so today it can only happen through a hand-edited row
     or a future `version: 2` mark read by older code during a rolling deploy.
   - Proving test: P4.
   - Suggested fix: refuse when a row exists but doesn't parse, unless it is hidden.
5. **L5, a mark that lands mid-reservation can let one job through.**
   - The reservation guard reads the workspace database before `billingTransaction`, outside the write. A mark committed in
     those milliseconds admits that one job.
   - Jobs already reserved when the mark lands finish and settle as before. That is by design: the mark isn't retroactive.
   - Proven by reading the code.
6. **L6, gaps in the PR's own tests.**
   - The "mixed" case asserts only `>= 400`, where it should check 409 and the sample's line.
   - There is no fail-closed case, no held-release-after-mark case, no `finalOf` case, and no quote-route or audio
     `quoteOnly` case.
   - The non-admission doors are tested only through a bare `reserveGenerationSpend`.
   - P1–P9 cover all of these.

## Probes

`S/demo/review-544-probes/review-544-probes.spec.ts` (P1–P10). To run it, copy it into `tests/unit/` and run the unit
project. All pass on the PR head and on the PR merged onto release/1. The network is forbidden throughout; no generation, no
paid call, no production call.
