# Production platform release requirements

Updated 14 September 2026. Scope: independent subscribed production-house workspaces, preserving approved pricing and the current Particl/Atomik design. Stripe setup and payment-provider activation are explicitly deferred by the owner. This document records engineering acceptance evidence; it is not a claim of feature, security or scale parity with another company's private system.

The last released baseline is main `395e3298b6a0af1e67426252fbd1ab9c3503a4d7` (PR134), including the PR133 product release and the framework security patch. It includes separate Gen/Studio/workspace experiences, private workbench drafts, explicit shared publication, quotes and idempotent generation reservations, vision input, browser movie export, physical tenant databases and encrypted backup/restore tooling. Its CI passed 540 unit/bundle checks, 20 operations checks and 74 browser checks. Mock test evidence does not prove live generation performance.

## Current hardening increment

| Requirement | Failure prevented | Acceptance evidence required |
| --- | --- | --- |
| Captured account/workspace request scope | An old tab writing into a newly selected account or workspace | API requests for stale account and workspace are rejected before mutation; browser save/recovery and generation tests |
| Shared publish compare-and-swap and complete source lineage | One collaborator overwriting a newer publication; derived assets becoming unexportable | Two-author race preserves one published version; source/reference closure exported intact; missing/cyclic dependencies refused |
| Atomic staged upload reservations | Unlimited abandoned chunks and concurrent finalizations exceeding storage allowance | Concurrent reservation/finish/abort, deletion failure and expiry tests; cleanup retains bytes until removal |
| Authentication CSRF and atomic password reset | Cross-site login/session mutation; partly applied credential reset | Foreign-origin requests rejected; one reset transaction consumes token, updates credential and revokes sessions |
| Terminal generation settlement and recovery | Stuck concurrency slots, lost result persistence or extra paid submissions | Forced ledger outage/replay; persisted result recovery; permanent claims preserved; no double charge/refund |
| Durable dispatch intent and bounded worker concurrency | Accepted work lost between database commit and queue send | Lease competition, retries with identical event ID, suspension before provider submission |
| Internal accounting separated from customer projection | Repricing old jobs or revealing platform provider costs | Persisted cost snapshot tests for both credits and BYOK customers |
| Referenced media deletion safeguards | Approved boards or exports losing their source bytes | Delete returns conflict for active work/references and retains media |
| Durable reconciliation lease, fair cursor and failure status | Overlapping sweeps, tenant starvation and false healthy responses | Independent SQLite connections elect one owner; expired-owner fencing; cursor recovery; failed cleanup and stale heartbeat tests |
| Bounded tenant media measurement | Global Blob scans and missing non-legacy customer objects | Tenant-scoped object paths; bounded lookup count/time; failures recorded |
| Atomic security history | Successful access/key changes without a receipt, secret-bearing history, or cross-workspace activity access | Rollback on audit failure; append-only triggers; scoped pagination and responsive administrator activity view |
| Restricted diagnostics | Customer-triggered shared storage probes or secret-bearing errors | Platform-admin-only write/read/delete probe; public read-only response; fixed event fields and no request/exception payloads |

## Required operational evidence

- Provisioning: production and staging group-scoped credentials were created and configured in Vercel on 14 September 2026. Both disposable create/write/read/delete rehearsals passed and legacy-database access was denied. Script: `scripts/ops/provisioning-rehearsal.mjs`. The PR143 preview (`dpl_DcJiqZkBjkct7V7w6VBCxqXN26gJ`) also passed real staging login, account/database matching, separate tenant-database provisioning, stale account/workspace refusal before mutation and activity endpoint access. This used the synthetic staging account with no email, model calls or credit grants. Production onboarding remains a separate operational check. Existing customer databases were untouched.
- Worker: receipt bound to the exact deployment and environment; challenge written/read in the intended tenant database and private storage, byte integrity checked and cleanup verified. Presence of Inngest keys alone is insufficient.
- Recovery: enforced writer/worker/provisioning/purge quiescence, complete automatic source inventory, separate archive key escrow, scheduled encrypted capture, freshness failure detection and successful independent restore. The existing `quiesced` JSON assertion is not a maintenance switch.
- Generation: a bounded internal live rehearsal covering each launch engine and enabled input mode, task persistence, media retrieval, accounting, rejection/refund and timeout handling. Fixture success does not establish vendor latency, throughput, output quality or cost variance.
- Scale: reproducible isolated load scenarios for sign-in/session reads, workspace switches, draft writes/publish races, upload reservations, job dispatch/polling, ledger contention and media delivery. Record error rate and p50/p95/p99 latency; establish limits from results.
- Operations: structured error events, externally scheduled health checks, worker/reconciliation freshness, backup freshness, actionable incident instructions and a tested rollback procedure. A quiet log window is limited evidence, not proof of reliability.
- Security: authenticated tenant isolation and role matrix across APIs/media/shares, session and token revocation, signed callback validation, upload size/type/path checks, dependency review and backup/restore privacy. Current source now has transactionally appended workspace security history for sessions, password resets, team changes, vendor keys, API tokens and review links (see `docs/security-history.md`). Invitation/platform-administration audit coverage, independently retained audit archives and customer MFA/enterprise identity integration still require implementation and recovery policy. Independent penetration testing remains a separate validation activity.

## Pipeline/product completion still to assess and implement

The older `ark-video` folder contains useful reference designs and extra engine adapters, but not a complete production runtime. Its recipe catalog queues rows without a dependency executor. Do not copy adapter endpoints/prices without verifying current provider contracts, and do not bypass current credit reservations or permanent paid claims.

Remaining product acceptance work includes durable multi-stage recipe execution with per-stage quotes/approvals and recovery, private conflict recovery/import, discoverable versioned asset lineage shared across Studio and the asset library, and persistent delivery artifacts suitable for long-running production work. Current browser movie output is a real implementation but bounded to three minutes/200 MB; it does not establish large-project delivery, HDR or editor-conform support. Each expansion needs its own bounded implementation and end-to-end evidence.

## Release rule

For each increment, review the final diff, pass type/lint and relevant automated checks, verify the isolated preview, merge with exact-head CI, then verify the new production deployment and runtime errors. Never promote a mock staging deployment to production. Record implementation, test, deployment and unresolved operational evidence separately. Do not label the platform fully production-proven while those requirements remain open.

## Current verification checkpoint

The framework security patch shipped separately through PR134 (`dba760b623e92b8d8d126b9e939f2c0f90f5f33d`), with Next.js 16.3.5, fflate 0.8.3 and js-yaml 4.3.2. Exact-head core and browser CI passed before merge; production deployment `dpl_HaLhCVcpWrxzmTfM8ogrdRRiJAfs` is Ready on www.particl.app, reported mock:false/database:ok/storage:ok, and had no error logs in the checked ten-minute window. The installed Inngest app automatically synced to https://www.particl.app/api/inngest at 12:24:20 UTC; an exact-deployment worker execution receipt is still required. The frozen hardening source passed 630 unit checks, 25 operations checks, the isolated full account HTTP rehearsal, type checking, lint (zero errors) and a production build. Its first CI passed the core job but caught stale browser upload fixtures and a raw fixture-client lock; those tests were corrected without weakening application validation. All eight targeted browser flows then passed locally; the corrected commit still requires full exact-head CI.

The frozen local load scenario initially exposed multi-process SQLite lock errors. A local-only native 2-second busy timeout (no SQL retries or remote configuration changes) passed three repeated two-process runs with zero unexpected errors and all 12 invariants. This small local rehearsal is not evidence of remote Turso capacity or production latency. Native waiting can block the local event loop; persistent locks still fail. See `scripts/ops/load-rehearsal.md`.
