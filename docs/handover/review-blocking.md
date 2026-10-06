# Review: 3D blocking (`production.blocking`), build/gaps-l2

Commit 7c84efe3, head de07896e (merges origin/release/1). Diff `origin/release/1...origin/build/gaps-l2`, 23 files. Reviewed read-only in worktree `work/rev-blocking`. The worktree's `node_modules` is a symlink to `work/board-everyone/node_modules`, which has the same lockfile.

**VERDICT: FAIL.** There are two medium findings that can stop a project from saving (M1, M2), and one medium on the branch-copy spec guard (M3). There are no high findings. The money, auth and name checks pass.

## Gates
- `npx tsc --noEmit`: clean.
- Unit specs `tests/unit/demo-gaps-l2-blocking.spec.ts` and `tests/unit/transcriptionRecovery.spec.ts`: 43 passed, 1 skipped. The skipped test is the branch-copy test, because BLOCKING_BRANCH_DB_URL is unset. The run used `env -u CREDIT_USD ENGINE_MOCK=1` and `PW_BASE_URL` set to a dummy address, because the config's webServer will not start Turbopack with a symlinked node_modules. Unit specs do not use the server.
- No runtime import cycle. `studio-schema` now imports `production/blocking`, which imports `rig-build` and `boards`. None of those reach `studio-schema` at runtime, so `blockingSchema` is always defined when the schema module loads.
- A throwaway probe (jiti, since deleted) confirmed M1 and L3.

## Checks 1–6, in brief
1. **Schema.** `blocking: blockingSchema.optional()` (lib/workbench/studio-schema.ts:217). It has no `.default()` and no transform, so an old body reads and parses exactly as before. The only change to the strict `productionSchema` is one new optional key, and no existing field's behaviour changes. `readDraft` (lib/workbench/records.ts:45-52) does no schema parse on read, so a body is never rewritten on read. The size bounds are a 200-entry cap (lib/production/blocking.ts:31), each scene bounded by `astraSceneSchema` (64 objects, 12 lights, 512 keyframes), and the 24 MB project JSON cap enforced by `readProjectBody`. A real entry is about 750 bytes; 201 entries came to 151 KB. However, a single invalid entry fails the parse of the whole project. See M1 and M2.
2. **Write paths.** The only server write is the existing PUT `/api/workbench/projects` (app/api/workbench/projects/route.ts:54-67). It runs `withTenant`, `requireSession`, and `workbenchScopeProblem`, which requires the X-Workbench-Scope header for this workspace and user. Each workspace has its own database (lib/db.ts:25-45), and rows are keyed by `owner=auth.user.id`. A member of workspace A cannot write workspace B's project. The save replaces the whole body under an optimistic revision check (records.ts:157-160). The client three-way merges on conflict (RigProvider.tsx:240 → `writeMergedDraft`, lib/workbench/merge.ts deep merge), so a concurrent save of script or shots is not dropped. The frame upload goes through `uploadFile(..., { scope: ctx.scope })` (BlockingOverlay.tsx:124) to the tenant-scoped `/api/uploads`. `validateStoredMedia` (records.ts:72-85) checks that `/api/uploads/<id>` exists in this tenant's database before saving. `addInput` refuses a missing or locked shot (lib/production/rig-build.ts:32-44). Note: `addInput` checks that the shot exists and is unlocked; workspace ownership is enforced at the save boundary above.
3. **Money.** Pass. "Remake Shot N · N cr" (ShotBlockingStrip.tsx:28-38, 49-50) only calls `shell.openMake(preset)`. In lib/shell/state.tsx:344-351, that call sends the preset to the composer and opens Make. Nothing is submitted, and Make re-prices the request. The button is disabled when no price is shown (`!price`) and in read-only, explore or offline mode. Add, Save and Open spend nothing: they are local state, a free upload and a draft save. "Prop from a photo · price pending" is `disabled`, has `data-spend="unpriced"` and no onClick (BlockingOverlay.tsx:192). Free buttons show "· free" through `<Price value={FREE}>` (lines 160, 206).
4. **Branch-copy spec.** Without `BLOCKING_BRANCH_WRITE=1` it is strictly read-only: one `SELECT project_id, body FROM workbench_projects` (spec:139). With the flag it inserts one row under a random key `branch-check:<uuid>` with owner `branch-check`. Its DELETE is `WHERE key = ? AND owner = 'branch-check'` (spec:161), so it can only delete that row. The key is the primary key, given `ON CONFLICT(key)`. There is no guard against a production URL. See M3.
5. **Names.** Pass for this diff. In the added lines, "Astra" and "astra" appear only in identifiers and import paths (`AstraScene`, `components/astra-blender/...`), never in rendered strings. Rendered copy: "3D blocking", "Opening the 3D view…", "Add from Shot N · free", "Use as reference for Shot N · free", "Remake Shot N · N cr", "Prop from a photo · price pending". `sceneFromShot` uses only beat-sheet names, falling back to "Ground", "Figure n" or "Prop n". There are no invented names, and the fixtures use neutral names (Runner, Guide, Lantern, Hillside). The e2e spec runs `noBannedNames` on the overlay and the phone record; that helper allows "Astra" only after "Topaz". **`tests/helpers/uiStrings.ts` is not changed by this diff**, so there is nothing to verify there. The only helper change is `gotoBoard` in tests/helpers/gaps-l2.ts. A string outside this diff is listed under Low (L6).
6. **Gates.** See above.

## Findings

### Medium

**M1. The 201st blocked shot, or any entry that fails the schema, makes every save of the whole project fail.**
- Evidence: lib/production/blocking.ts:31 `.refine((value) => Object.keys(value).length <= 200)` has no message. `withBlockingFrame` (blocking.ts:162-176) never validates the new entry or the count. The overlay validates only the scene (BlockingOverlay.tsx:116), not the record size, the key format or the move. It then calls `ctx.rig.apply(...)` and `void ctx.rig.save()`, and shows "Saved to Shot N…" before the save result is known (lines 130-133). On the server, `saveSchema` refuses the whole body with a 400 (route.ts:61-62). RigProvider keeps the edits unsaved, and every later autosave is refused the same way (RigProvider.tsx:265-271). There is no UI to remove a blocking entry, and `removeShots` does not clear `production.blocking[shotId]`, so entries for deleted shots still count toward the 200.
- Scenario: a feature project (PROJECT_LIMITS allows 1,500 shots and 4,000 nodes) blocks its 201st shot. The probe confirmed that 200 entries parse and 201 fail with `{"path":["production","blocking"],"message":"Invalid input"}`. The person sees "Saved…", then a save error reading "Invalid input". Every later edit to script, shots or anything else in that window is refused. A reload loses those edits, and blocking the shot again repeats the failure. The same lock-out follows from any other entry the server refuses, such as a node id outside `^[a-zA-Z0-9_-]{1,100}$`; node ids are only `z.string()` in the node schema.
- Fix:
  - (a) In `withBlockingFrame`, or in the overlay before `apply`, run `blockingSchema.safeParse` on the next record. Refuse in words, for example "This project already has 3D blocking on 200 shots", and change nothing.
  - (b) Give the refine a message so `saveProblem` can explain it.
  - (c) Either drop entries whose node is gone (on save or in `removeShots`), or raise the cap to match `PROJECT_LIMITS.shots` (1,500). At about 1 KB per entry that fits easily in 24 MB.
  - (d) Show the toast only after `await ctx.rig.save()` returns true.

**M2. A rollback after Thursday's train would stop every project that has blocking from saving.**
- Evidence: `productionSchema` is `.strict()` (studio-schema.ts:293). Builds without this commit do not know `blocking`, so they reject any project body that has it as an unrecognized key: "Check the project's production: it is not valid." Old clients send the body back unchanged, and `getAtomikProject` (lib/workbench/atomik-server.ts:263-264) returns 409 for the whole project.
- Scenario: the train ships, people save blocking, and a regression forces a rollback to the previous release/1 build. Every affected project then refuses all saves until the release is redeployed. This is the owner's "lock someone out" case, reached through rollback rather than through reading old bodies.
- Fix: choose one before the train, and write it in the train notes.
  - (a) Ship a tolerant read first: the previous build's schema accepts `production.blocking` as optional `z.unknown()`, so a rollback target exists.
  - (b) Write a rollback runbook step that strips `production.blocking` on rollback (a reviewed one-off, never a delete of the row).
  - (c) Put the UI behind a flag so nothing writes the field until the train has settled.

**M3. The branch-copy spec has no guard against a production database URL.**
- Evidence: tests/unit/demo-gaps-l2-blocking.spec.ts:135-137 accepts any `BLOCKING_BRANCH_DB_URL`. With `BLOCKING_BRANCH_WRITE=1` it INSERTs into `workbench_projects` (spec:155). The owner's condition is a branch copy, never production.
- Scenario: someone pastes the production libsql URL and token, for example from a shell profile that already has them. The run writes a row to production outside the train. If the process dies between the INSERT and the `finally` block, a stray `branch-check` row is left behind. It is invisible to users but is still a production write.
- Fix: refuse to run unless the URL differs from `TURSO_DATABASE_URL`, `DATABASE_URL` and every known production hostname. Also require an explicit marker, such as a URL host containing a branch name or a `BLOCKING_BRANCH_NAME` that must appear in the URL. Refuse writes when `NODE_ENV=production` or `VERCEL_ENV` is set.

### Low

- **L1. Saving after scrubbing or playing the move stores the moved camera as the start.** BlockingOverlay.tsx:90-95 moves the viewport camera along the move. `saveAsReference` reads `actions.getCamera()` (line 116) and saves that as `scene.camera`, together with the same `move`. After a save at t=0.5, reopening and pressing Play pushes another 1.2 m from the midpoint, so the start drifts with each save. The e2e spec does exactly this (scrub to 500, then save). Fix: save `scene.camera` (the start). If the frame should be the mid-move view, capture with the moved camera, then save the start pose.
- **L2. Concurrent saves of a frame to the same shot from two windows leave two blocking inputs on that shot.** `withBlockingFrame` removes only the previous frame input it knows of. The merge keeps both new media nodes because they have different ids, and `frameAssetId` takes "mine". The extra image then stays linked as a reference for the shot's paid renders, which are still priced at render. Fix: on load or derive, drop blocking-frame inputs whose asset is not the current `frameAssetId`, or mark them so they can be found.
- **L3. Beat-sheet names that are whitespace-only fail the scene schema.** `base()` uses `name.slice(0,100) || id` (blocking.ts:51), but `astraSceneSchema` trims names and requires at least one character. A character or location of `"   "` (allowed by `beats.characters: z.string().max(200)`) builds a scene that the save refuses with the raw message "Too small: expected string to have >=1 characters". The probe confirmed this. It is caught before upload, so it is safe, but the copy is poor. Fix: `name.trim().slice(0,100) || fallback`.
- **L4. Two viewport messages are wrong inside the overlay.** AstraViewport.tsx:129 says "…saving, and Blender exports remain available" (the overlay has no Blender export), and :303 says "Your scene is saved." (it is not saved until "Use as reference"). Fix: pass host copy for the `quiet` mode.
- **L5. The branch-copy spec under-delivers on what its comment claims.** It reports the `failed` count but never asserts it, and never compares a row's parse result against the release/1 schema. That is acceptable, because an absent optional key cannot change a strict parse. Separately, each workspace has its own database (lib/db.ts:25-45), so one branch copy covers one workspace only. Run it against a branch of each workspace database, or state that it covers one.
- **L6 (outside this diff).** lib/workbench/atomik-server.ts:275 returns the API error string "Astra uses GPT-6 Astra and the saved 3D scene…", which can reach a UI. It came in with release/1, not this commit, but it breaks the "GPT-6 Astra never in the UI" rule.
- **L7. The blocking record key regex is narrower than node ids and allows `__proto__`.** The scene schema rejects reserved ids; `blockingSchema`'s key does not. The impact is limited to the author's own project: the entry is dropped when serialized. Fix: add the same reserved-id refine, and accept the node id alphabet in use.
- **L8. Upload before apply leaves stray uploads on refusal.** BlockingOverlay.tsx:124-131 uploads the PNG before `rig.apply`, so a locked shot or full canvas leaves an unused upload in the Library. It is free and consistent with never-delete, but each save of the frame files a new asset by design.
- **L9. Only the author sees the blocking.** Blocking lives in the author's own draft (`owner` = user), while the frame input node is shared to the team canvas. Teammates see the reference input but no blocking strip. This is informational only, since the spec calls blocking per-draft.

## What passes the owner's conditions
- Additive and optional, with no default written: yes (studio-schema.ts:217, studio.ts:47 type only).
- Every existing body parses unchanged: yes, by construction, and the unit test asserts the rest of the project is identical (spec:106-117).
- No paid action without a press: yes. Every spending button shows its price: yes, and the unpriced button is disabled with "price pending".
- No "Astra" or "GPT-6 Astra" in this diff's UI: yes. No invented names: yes.
- Branch copy before production: the spec exists and is read-only by default, but has no production-URL guard (M3).

---

# Re-review, 6 Oct: the split into Part A and Part B

**Part A — PASS.** Branch `build/gaps-l2-schema` at 03d5b4f8, one commit on top of origin/release/1 (fa9956d0).
**Part B — PASS.** Branch `build/gaps-l2` at 1d6dea0a, which contains A (it merges 03d5b4f8 in 5e4d9a35).

There are no high or medium findings left in either part. The Low findings below are for the author and are not blockers.

I reviewed both heads read-only in fresh detached worktrees, `work/rev-blocking-a` and `work/rev-blocking-b`. Their `node_modules` is a symlink to `work/board-everyone/node_modules`, which has an identical lockfile. In each worktree I also ran the gitignored postinstall copy scripts (`scripts/copy-pdf-worker.mjs` and `scripts/copy-ocr-worker.mjs`), which write `public/vendor/*`. I did not commit, push or start a server. The probes were throwaway jiti scripts and have been deleted.

## Gates
- `npx tsc --noEmit`: clean on both A and B.
- **Full unit suite on both heads**, run with `env -u CREDIT_USD ENGINE_MOCK=1 PW_BASE_URL=http://localhost:4999 playwright test --project=unit --workers=1`:
  - A: 3,695 passed, 7 skipped, 1 failed.
  - B: 3,707 passed, 7 skipped, 1 failed.
  - The one failure on both heads is `screenplayOcr.spec.ts:238`, with `ENOENT public/vendor/tesseract-7.0.0/manifest.json`. That folder is gitignored and is created by `postinstall`; the fresh worktrees never ran it because node_modules is a symlink. After running the two copy scripts, `screenplayOcr.spec.ts` passed 8 of 8 on both heads.
  - **So the full suite is green on A and on B.** The 7 skips are the env-gated specs, including the branch-copy check (BLOCKING_BRANCH_DB_URL is unset).
- The names ratchet passes on B, with the atomik-server.ts allowance removed.

## (1) M1, M2 and M3
- **M1: fixed.** Re-probed against B:
  - `withBlockingFrame` now runs `blockingSchema` on the whole new record before returning, and throws a `RigBuildError` in plain words. The project is left untouched (lib/production/blocking.ts, end of file).
  - The limit is `PROJECT_LIMITS.shots`, which is 1,500 (blocking-schema.ts). The probe built 1,500 entries, which parse. The 1,501st is refused with "3D blocking is kept for up to 1,500 shots in one project." 201 entries are fine.
  - Entries for shots that no longer exist are dropped on each save. After deleting one shot, the next save succeeds and the count stays at 1,500.
  - An invalid move (seconds 0.1) is refused with "This 3D blocking is not valid, so it was not saved. Nothing was changed."
  - The overlay runs the same check before uploading (BlockingOverlay.tsx, `saveAsReference`, the call with `blocking-check`).
  - "Saved" is shown only when `await ctx.rig.save()` returns true. Otherwise the overlay says the project could not be saved yet and stays open. `rig.save` is `flush({force:true})`, which resolves false on any refused or retryable save (RigProvider.tsx:227-271). The upgraded refine has a message, and saveProblem shows it.
- **M2: fixed by the split and the rollback note.**
  - A accepts the field and writes nothing; it is only the schema, the type and tests.
  - A build with A but not B accepts bodies that B wrote. The probe ran A's `projectSchema` and `saveSchema` on a B-written body with 201 entries: it parses, and the field comes back byte-identical.
  - A rollback from B to A is therefore safe. A rollback past A needs the strip script, which is covered in (3).
- **M3: fixed.** `tests/helpers/blockingBranch.ts` runs before any client is created. Probes against `branchCopyProblem` and `branchWriteProblem`:
  - Refused: a URL without the `3d-blocking-test` marker (for example `libsql://<live-host>` or `libsql://<prod-tenant-host>`), any name containing "prod", and any URL equal to TURSO_DATABASE_URL, DATABASE_URL, PLATFORM_DATABASE_URL, WORKSPACE_DATABASE_URL or BLOCKING_PRODUCTION_NAMES.
  - Writes are refused when `VERCEL_ENV` is set (preview or production) or `NODE_ENV=production`.
  - The old unguarded test in `demo-gaps-l2-blocking.spec.ts` is gone. The check now asserts `failed === 0`.
  - One bypass remains (L-B1).

## (2) A alone is safe
- Nothing in A writes the field. Its diff is `lib/production/blocking-schema.ts`, one optional key in `studio-schema.ts`, one type in `studio.ts`, and tests. A search of A's lib, components and app finds no writer.
- Old bodies parse: `newProject`, `production: {}` and `blocking: undefined` all parse, and the rest of the project is identical (blocking-schema.spec.ts). `blocking: null` is refused, but nothing writes null.
- The field is optional with no default and no transform. A reserved key such as `__proto__` is caught on the raw object before zod builds the record.
- B's copies of `blocking-schema.ts`, `studio-schema.ts` and `blockingBranch.ts` are identical to A's, so the two parts cannot disagree.

## (3) The strip script, scripts/ops/strip-production-blocking.mjs (in B)
- Every requested property holds:
  - It is a dry run by default and prints counts only, with no names or ids.
  - It writes only when both `--apply` and `--owner-said-yes` are given. `--apply` alone exits 2.
  - Each write is one `UPDATE … SET body, revision+1 … WHERE key=? AND revision=?`. It removes only `production.blocking`, never deletes a row, and skips a row whose revision changed since it was read.
  - Its spec covers all of this on a throwaway file database: the counts, the half-flag refusal, that the body equals the input minus the field, the revision going 4 to 5, other rows untouched, and the row count unchanged.
- **Could it be pointed at production by mistake, and does it need the URL guard?** It must not get the branch-copy guard, because production is its legitimate target during a rollback past A. Pointing it at production by mistake is harmless while it is a dry run: it only reads and counts. The real safeguards for writing are the two flags and the owner's yes. Two Lows below would make that yes better informed: L-B2 (say which database and say the scenes are erased) and L-B3 (the order of steps).

## (4) The lows
- **L1: fixed.** The start pose is kept. `saveAsReference` saves `scene.camera` while the move is scrubbed or playing, and reads the viewport only at t=0. The capture is the frame on screen. `settle` takes an orbit by hand as the new start and rewinds t to 0. One harmless edge remains: an orbit at t>0 followed by Save within 250 ms saves the old start with the orbited frame.
- **L2: fixed.** Before adding the new frame, `withBlockingFrame` takes off every blocking-frame input on the shot, matched by the `3D blocking` category. `ShotBlockingStrip` also tidies extra inputs left by a two-window merge. The heuristic is too broad (L-B4).
- **L3: fixed.** `cleanName` trims names, and a blank name falls back to the default. The probe gave `["   ", "  Ann  "]` and a blank location, and the scene came out as `Ground | Figure 1 | Ann`. Scene errors now appear in plain words through `sceneProblem`.
- **L4: fixed.** In `quiet` mode the viewport no longer mentions Blender exports or claims "Your scene is saved."
- **L6: fixed.** The atomik-server strings no longer say "GPT-6 Astra" or "Astra". The new wording, "3D blocking", matches the name the shell already uses for the old 3D tool (lib/shell/tools-connections.ts:42, stage-redirects.ts:26). The ratchet entry was removed, and workbenchAtomik.spec.ts was updated. The added lines contain no "Astra" or "GPT" in any string.
- **L7: fixed.** `__proto__`, `prototype` and `constructor` are refused, and the key-format error is in words.
- **L8: fixed.** The shot, the canvas and the record are checked with a dry `withBlockingFrame` before `uploadFile`.

## New Low findings (no blockers)
- **L-B1. The branch-copy marker is accepted in the URL path, which libsql ignores.**
  - Where: tests/helpers/blockingBranch.ts `hostAndPath`. `libsql://<live-host>` passes the guard.
  - Why it matters: @libsql/client resolves `v2/pipeline` against the base URL, which drops a path with no trailing slash, so that URL reaches the live host. It needs someone to deliberately append the marker, so it is not an accident.
  - Fix: for `libsql:`, `https:` and `wss:` URLs, require the marker in the host only; keep the path rule for `file:`.
- **L-B2. The strip script permanently erases blocking scenes, against the owner's never-delete rule.**
  - What is lost: the scene, camera and move. The frames stay.
  - Why it matters: the owner's rule is that deletes hide or archive only, and this is a permanent erase. The run also prints counts only, with nothing that names which database the operator is on.
  - Fix: before the UPDATE, copy each removed field into an archive table in the same database, for example `workbench_blocking_archive(key, blocking, at)`, and add a restore mode. Print the database host, which is not secret, in both dry-run and apply output. Say in the rollback note that the scenes are erased unless archived, so the owner's yes is informed.
- **L-B3. The rollback note's order leaves a window in which open B windows can write blocking again.**
  - Where: blocking-rollback.md, "Back past A": strip first, then roll back.
  - Why it matters: while B is still live, an open window that edits blocking after the strip writes it back before the rollback.
  - Fix: roll back to A first, where nothing writes the field and A tolerates it. Then strip. Then roll back past A.
- **L-B4. The stale-input tidy can take off a reference a person added on purpose, without a press.**
  - The heuristic: `staleInputs` treats any input whose asset is filed under `3D blocking`, other than the shot's current frame, as stale. `ShotBlockingStrip` removes such inputs automatically through `apply` and `save` in a `useEffect`, and `withBlockingFrame` does the same on every save.
  - The scenario: a person drags Shot 2's blocking frame onto Shot 1 as an extra reference. The probe confirmed it is flagged stale, and Shot 1's inputs go from 2 to 1 with no press. The Library file stays.
  - Fix: mark the input nodes that a blocking save creates (a field on the node, or a list of node ids kept in the entry) and tidy only those.
- **L-B5 (carried over).** A three-way merge of two windows editing the same shot's scene could still produce a combined scene that the server refuses. This is the general merge risk shared with the old 3D scene, and is unlikely.

## Verdicts
- **Part A, build/gaps-l2-schema 03d5b4f8: PASS.**
- **Part B, build/gaps-l2 1d6dea0a: PASS.** Before Thursday, fix L-B1, and follow L-B3's step order in the rollback note. L-B2 is the owner's decision.

---

# Round 3: PARTIAL (paused on the coordinator's word, 6 Oct). No verdict.

**Heads:** A is build/gaps-l2-schema 06b279b9. B is build/gaps-l2 4d24cc2e.

I reviewed read-only in `W/rev-blocking-a` and `W/rev-blocking-b`, each detached at its new head with `git switch --detach`. I made no commits. No probe files are left in either worktree, and `git status` is clean in both.

I started no server and took no slot. I stopped my own full unit runs part-way through with TaskStop, not kill. The one other Playwright process still running (pid 68330) belongs to `work/gaps-l5`, not to this review.

## Checked, and what I found
- **(1) Your lows**
  - **L-B1 is fixed (code read only).** In A's `blockingBranch.ts`, `markerPlace` now looks for the marker in the host of a remote URL and in the path only for a `file:` URL. B has the same file. I did not re-run my URL probes this round.
  - **L-B4 is fixed (probed).** Every input a blocking save creates now has an id starting `blocking-input-` (blocking.ts, `withBlockingFrame` → `uid("blocking-input")`). The tidy and the save act only on those inputs.
    - A person's drop of another shot's blocking frame is no longer flagged stale. The shot's inputs stay at 2 after the tidy, and stay at 2 after a re-save.
    - A person re-adding the shot's own old frame is not flagged either.
  - **L-B2 is fixed (code read only).** The strip script now:
    - copies the value into `workbench_blocking_archive` in the same transaction as the removal; if the revision changed, it rolls back with no archive row;
    - restores only into a project that still exists and no longer holds the field, guarded by revision, and marks the archive row restored in the same transaction;
    - prints the host, never deletes a row, and still needs both flags to write.
  - **L-B3 is fixed.** The rollback note now says: roll back to A, then strip, then roll back past A, then restore once A is live again.
- **(2) scriptVersions cannot lock a project (probed on B)**
  - The schema trims what it is given: 15 entries of 900k characters parse, and 3 entries (2.7M characters) are kept.
  - A chain of six 1M-character "Use as script" replacements saves, keeping 3 versions and 3,000,000 characters.
  - Restore in one window against Use-as-script in another: the merge saves, newest first, inside the limits.
  - Both windows restoring the same version: the merge saves.
  - An entry over 1M characters is still refused, but nothing can write one, because a script is capped at 1M characters.
  - The fix is in place: `fitScriptVersions` in `mergeDraft` (draft-merge.ts) de-duplicates, orders newest first and trims, and Undo trims too.
  - `script-versions.ts`, `blocking-schema.ts` and `blockingBranch.ts` are identical in A and B.
- **(3) A round-trip:** I wrote a B body carrying both fields to scratch, but **did not run A's parse on it** before the pause. Last round, A parsed a B body holding blocking only.
- **(5) The tidy can no longer remove a person's own input:** yes, as shown under L-B4 above.

## New Low findings, from what I reached
- **L-C1. The 3,000,000 limit counts characters, not bytes.**
  - A worst-case estimate: 3M characters of random-word Devanagari is 8.1 MB of JSON, about 2.1 MB gzipped. Random-word Latin text is 3.0 MB, about 1.3 MB gzipped.
  - Add a 1M-character current script and a feature-sized project, and a non-Latin project could approach the 4 MB save limit (`PROJECT_WIRE_BYTES`). A save over that limit is refused.
  - Real scripts compress better and are far below 1M characters, so this is unlikely.
  - Fix: budget the list in UTF-8 bytes, for example 3 MB.
- **L-C2. Two windows restoring the same version keep the replaced script twice**, as two entries with the same text and different ids. This is cosmetic; de-duplicating on text in `fitScriptVersions` would fix it.
- **L-C3. A concurrent "Use as script" can lose its script.**
  - Scenario: one window restores an earlier script while another window uses a transcript as the script. In the merge, the restoring window's script stands (the merge keeps "mine" when both sides changed the same line).
  - Result: the other window's new script T2 is in neither the current script nor the earlier scripts. It survives only in the saved transcript.
  - This is the existing merge rule for the script field, but decision 11 is meant to keep replaced scripts.
  - Fix: when the merged script differs from either side's, keep that side's script as a version.
- **L-C4. `--restore` handles repeated archives of one project badly.**
  - It walks archive rows oldest first. If a project was stripped twice, the oldest value is restored, and the newer archived value is then skipped because the field is present.
  - Nothing is erased, since both rows stay in the archive, but the wrong value comes back.
  - Fix: restore the newest archive row per project and field.
- **L-C5. `--restore` does not validate the archived value against the schema of the build that is running.** Restoring while a build that lacks the field is live, or restoring a value that build would refuse, would lock the project. The rollback note says to restore only once A is live; a schema check in the script would enforce it.

## NOT done (pick up here)
- tsc on A and B.
- The full unit suite on A and B. I stopped both at about 660 of 3,709 (A) and 658 of 3,754 (B) tests, with **0 failures so far**. Before running, generate `public/vendor` with `node scripts/copy-ocr-worker.mjs && node scripts/copy-pdf-worker.mjs`, or `screenplayOcr.spec.ts:238` fails with a false ENOENT.
- The browser specs for blocking and transcribe on a fresh server with a slot. I did not start one.
- (3) Run A's `projectSchema` and `saveSchema` on a B body with both fields; the scratch body is at `scratchpad/b-both.json`.
- (4) Run the strip script itself: archive, restore, the skip on a changed revision, and the double-strip case on a throwaway file database. I have only read it.
- A full read of the rest of B since 1d6dea0a. Most of it is the release/1 merge (plan approval and others), which is out of scope. EarlierScripts and Restore read as free and show "· free".
- **Verdicts for A and B: none yet.** I found no high or medium so far.
