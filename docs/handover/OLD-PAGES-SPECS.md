# Old-pages specs: decisions so far (private). Branch fix/r1-old-pages. PAUSED for handover.

Method: every old-shell spec is one of (a) delete, only UI that is gone and no money/tenancy/sign-in/approval assertion; (b) port to the route level or the new shell; (c) retarget to the new address. Not finished: see UNDECIDED.

## New specs
- tests/r1-port-paid-sends-workbench.spec.ts (6 tests, pass): paid send quoted, ceiling, one key, lost reply checked and followed, billed once; never-arrived key fenced; moved price sends nothing; key and scope isolation between workspaces; sound-effect route the same; stale captured scope refused for uploads/cast writes (another workspace, another account in one workspace). Replaces the money/tenancy core of gen, composer-audio, composer-batch, project-generation, remaining-paths (Shots grid test), legacy-lost-reply, paid-action (isolation part).
- tests/r1-port-credit-units-workbench.spec.ts (2 tests, pass): no vendor dollar in /api/productions, /api/projects, /api/analytics, /api/shots, /api/jobs, CSV. Replaces no-vendor-dollars. FINDING: GET /api/projects/:id returns the project's own capUsd for a credit workspace (a setting, no vendor figure; the old page never drew it). Left as is, excluded in the test, for the lead.
- tests/r1-old-pages-workbench.spec.ts (redirects, no-workspace screen, safe sign-in next): passing.
- tests/unit/r1OldRoutes, r1OldPagesLinks, safeNext: passing.

## Decided and done
- tests/workspace-security.spec.ts: PORTED (b), passing 1440 + 390. owner's two-step rule set at POST /api/workspaces/security instead of the old /team page; every 428/401/200 check on member data, tokens and workspace switching kept; the 'Set up sign-in link on the open page' assertion dropped (the new shell has no mid-session link)
- tests/management-scope.spec.ts: PORTED (b), passing. stale Settings/Team/token/sign-out writes now asserted at the routes (PATCH /api/workspaces, PATCH /api/team/:id, POST+DELETE /api/tokens, POST /api/auth/logout all 409 under a stale scope, for another workspace and for another account in the same workspace); dropped: unsent-text-kept-in-form and localStorage sentinel (UI only). Second test (no-workspace account resumes setup) unchanged
- tests/signin-retired-workbench.spec.ts: RETARGETED (c), passing. /usage now asserts Settings > Plan & credits > Usage has no connected-account tab
- tests/connect-tokens-workbench.spec.ts: RETARGETED (c), passing. /connect lands on Settings > Connections; token row reads credits
- tests/account-identity.spec.ts: EDITED. 5 tests unchanged and pass; the 'Team page says an invitation hit the mail limit' test dropped: the new Team section makes a one-time link and does not say whether the invitation was emailed (server mailLimited covered by unit identityAdmin.spec). GAP for the lead
- tests/workspace-edit-workbench.spec.ts: RETARGETED (c), NOT YET RUN. opens Edit & Sound over the board (cut-open-edit) instead of /workspace; phone-shell test dropped
- tests/entry-points-audit-workbench.spec.ts: RETARGETED (c), passing. one-hop addresses; /connect to Settings > Connections

## Decided, not yet applied (files still present; the helper skips them)
Decision DELETE with coverage by existing unit/new-shell specs (title-level mapping, not assertion-by-assertion):
- tests/astra-agent-workbench.spec.ts: 3D scene UI gone (3D blocking has no R1 screen). Money/recovery covered by unit astraBlenderAgent, atomikPendingRequest, astraBlenderRenderJobs
- tests/astra-blender-workbench.spec.ts: (a) viewport/scene UI, no money; lib covered by astraBlenderScene/Glb unit
- tests/astra-phone-floors-workbench.spec.ts: (a) old-shell floors
- tests/astra-render-workbench.spec.ts: unit astraBlenderRenderJobs (quote binding, one purchase, cross-owner, cancel refund, ambiguous create) + astraRenderRecovery
- tests/atomik-audit-workbench.spec.ts: treatmentSave unit (merge/stale), demo-s09-settings-workbench (member reads rules), atomikRailPricing/atomikStepSettle
- tests/atomik-key-steps-workbench.spec.ts: unit atomikKeySteps (1:1 titles)
- tests/atomik-late-render-workbench.spec.ts: unit atomikStepSettle (fenced late render)
- tests/atomik-no-account-workbench.spec.ts: unit atomikNoAccount
- tests/atomik-rail-pricing-workbench.spec.ts: unit atomikRailPricing; the rail is gone
- tests/atomik-skills-workbench.spec.ts: unit atomikSkills + demo-s08-skills-workbench
- tests/atomik-stale-stills-workbench.spec.ts: unit atomikVideoFrames
- tests/atomik-suite-workbench.spec.ts: unit atomikSuite + control room specs
- tests/atomik-threads-workbench.spec.ts: unit atomikThreads
- tests/paid-action.spec.ts: unit atomikPendingRequest, pendingGeneration, identityTraining, workbenchRequestScope, tenantRequestScope (all four tests go to the retired /atomik/ideas and /library) + the new port spec
- tests/gen.spec: unit generateSubmit, pendingGeneration, composerQuote + new port spec (stale-scope upload/cast test ported)
- tests/movie-export.spec: NOT a plain delete: MovieExport is mounted by the Deliver inspector; retarget the 4 encoding tests to Deliver (not started). The 3 hand-off tests (snapshot, account switch, signed-out sample) die with /workbench/movie; unit workbenchMovie covers the hand-off scope

Features that left with the Studio (components now dead, no new-shell equivalent): sequence colour grading (SequenceColor), asset bins and named cuts (AssetBins, EditVersions), Marketing Studio panel, canvas marquee selection, design review. Their specs (color, editorial, canvas-selection, marketing-studio) are (a) with the feature gone: for the owner to confirm.

## UNDECIDED (not yet looked at in depth)
Every other file in the lists below. Sweep results (which tests still pass) are partial: B list stopped after about 9 of 44 files, A list after about 10 of 53 (results in /private/tmp/claude-r1op-bresults.txt and claude-r1op-aresults.txt, per-test JSON in /private/tmp/r1op-ares-json). Unrun sweeps mean: do not delete a test that does not call the helper until it has been run.

### A: call tests/helpers/legacyShell.ts (skipped where they call it)
- tests/astra-agent-workbench.spec.ts
- tests/astra-blender-workbench.spec.ts
- tests/astra-phone-floors-workbench.spec.ts
- tests/astra-render-workbench.spec.ts
- tests/atomik-audit-workbench.spec.ts
- tests/atomik-key-steps-workbench.spec.ts
- tests/atomik-late-render-workbench.spec.ts
- tests/atomik-no-account-workbench.spec.ts
- tests/atomik-rail-pricing-workbench.spec.ts
- tests/atomik-skills-workbench.spec.ts
- tests/atomik-stale-stills-workbench.spec.ts
- tests/atomik-suite-workbench.spec.ts
- tests/atomik-threads-workbench.spec.ts
- tests/audit-other-ui-workbench.spec.ts
- tests/canvas-selection.spec.ts
- tests/cast-elements-workbench.spec.ts
- tests/cinema-controls-workbench.spec.ts
- tests/cinema-sound-workbench.spec.ts
- tests/color-workbench.spec.ts
- tests/customer.spec.ts
- tests/demo-autosave-before-atomik-workbench.spec.ts
- tests/desktop.spec.ts
- tests/development-workbench.spec.ts
- tests/edit-sound-c2-workbench.spec.ts
- tests/edit-sound-workbench.spec.ts
- tests/editorial-workbench.spec.ts
- tests/gen.spec.ts
- tests/grok-voice-pickers-workbench.spec.ts
- tests/legacy-lost-reply-workbench.spec.ts
- tests/marketing-entry-workbench.spec.ts
- tests/marketing-generation-workbench.spec.ts
- tests/marketing-studio-workbench.spec.ts
- tests/moleculr-marketing-workbench.spec.ts
- tests/moleculr-poster-workbench.spec.ts
- tests/moleculr-workbench.spec.ts
- tests/movie-export.spec.ts
- tests/ocr-workbench.spec.ts
- tests/paid-action.spec.ts
- tests/project-first-workbench.spec.ts
- tests/project-generation-workbench.spec.ts
- tests/reference-ad-analysis-workbench.spec.ts
- tests/reference-ad-workbench.spec.ts
- tests/rig-workbench.spec.ts
- tests/screenplay-workbench.spec.ts
- tests/soul-identity-workbench.spec.ts
- tests/sound-workbench.spec.ts
- tests/subatomik-workbench.spec.ts
- tests/suite-agent-workbench.spec.ts
- tests/suite-navigation-workbench.spec.ts
- tests/ui-floors-audit-workbench.spec.ts
- tests/video-frame-workbench.spec.ts
- tests/workbench.spec.ts
- tests/workspace-security.spec.ts

### B: navigate an address that now redirects without the helper (not run; some still pass)
- tests/account-identity.spec.ts
- tests/astra-gen.spec.ts
- tests/atomik-pages-audit-workbench.spec.ts
- tests/audit-money-workbench.spec.ts
- tests/composer-audio.spec.ts
- tests/composer-batch.spec.ts
- tests/connect-tokens-workbench.spec.ts
- tests/credit-value-workbench.spec.ts
- tests/entry-points-audit-workbench.spec.ts
- tests/gen-asset-library.spec.ts
- tests/hf-error-boundaries-workbench.spec.ts
- tests/hf-role-aware-connected-workbench.spec.ts
- tests/higgsfield-consumer-usage-workbench.spec.ts
- tests/higgsfield-verify-workbench.spec.ts
- tests/management-scope.spec.ts
- tests/marketing-site-workbench.spec.ts
- tests/mobile.spec.ts
- tests/no-vendor-dollars-workbench.spec.ts
- tests/pipelines.spec.ts
- tests/project-library-workbench.spec.ts
- tests/projects-legacy-pages-workbench.spec.ts
- tests/remaining-paths-lost-reply-workbench.spec.ts
- tests/rig-canvas-audit-workbench.spec.ts
- tests/rig-canvas-lost-reply-workbench.spec.ts
- tests/rig-canvas-unpriced-workbench.spec.ts
- tests/rig-held-discard-workbench.spec.ts
- tests/shot-builder-handoff-workbench.spec.ts
- tests/signin-retired-workbench.spec.ts
- tests/suites-draft-merge-workbench.spec.ts
- tests/suites-rig-board-workbench.spec.ts
- tests/suites-rig-phone-workbench.spec.ts
- tests/suites-team-canvas-workbench.spec.ts
- tests/topaz-gen.spec.ts
- tests/workspace-atomik-workbench.spec.ts
- tests/workspace-audit.spec.ts
- tests/workspace-cast-workbench.spec.ts
- tests/workspace-edit-workbench.spec.ts
- tests/workspace-generate-composer-workbench.spec.ts
- tests/workspace-mobile-credits-workbench.spec.ts
- tests/workspace-mobile-make-workbench.spec.ts
- tests/workspace-mobile-pages-workbench.spec.ts
- tests/workspace-mobile-shell-workbench.spec.ts
- tests/workspace-palette-workbench.spec.ts
- tests/workspace-shell-workbench.spec.ts
- tests/workspace-spec-pages-workbench.spec.ts
- tests/workspace-takes-workbench.spec.ts
