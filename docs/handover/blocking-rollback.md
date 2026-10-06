# 3D blocking: how Thursday's train goes, and how to roll back (private)

Why this exists: `productionSchema` is `.strict()`. A build that does not know `production.blocking` refuses any project body that holds it
("not valid"), and Atomik reads of such a project fail with a 409. So the field must be KNOWN to the running build before anything writes it,
and a rollback past that point must not leave projects with it.

## The split (two parts, in this order)
- **Part A, schema only**: branch `build/gaps-l2-schema`, made from release/1 with no UI. It is **every optional field this work adds, accepted on read and on write, written by nothing**:
  - `production.blocking` (3D blocking per shot): `lib/production/blocking-schema.ts`;
  - `scriptVersions` (the earlier scripts a replaced script is kept as): `lib/production/script-versions.ts`, whose schema trims a list to 10 entries and 3,000,000 characters instead of refusing it, so it can never make a save fail.
  Plus the one-line types in `lib/workbench/studio.ts`, the two optional keys in `lib/workbench/studio-schema.ts`, `tests/unit/blocking-schema.spec.ts`, `tests/unit/script-versions.spec.ts`, and the guarded branch-copy
  check `tests/unit/blocking-branch-copy.spec.ts` (+ `tests/helpers/blockingBranch.ts`). A build with only A accepts a body B wrote that carries both fields and returns them byte for byte (tested; also checked on a body
  B's own helpers wrote).
- **Part B, everything that writes them**: `build/gaps-l2`, which contains part A (merged in), so merging B after A has no conflicts. Cards, overlay, saved frame, phone view, Transcribe's "Use as script" and Earlier scripts,
  Cut-out, Line drawings, the three-way merge's tidy of the list, the rollback script and its tests.

## Thursday's train
1. Take the branch copy (owner's `3d-blocking-test` copy of a workspace database) and run the check on it (command at the top of `tests/unit/blocking-branch-copy.spec.ts`).
2. Merge **A**, deploy, let it settle. Nothing writes either field yet (production.blocking, scriptVersions), so there is nothing to undo, and this build now tolerates both.
3. Merge **B** (the rest of `build/gaps-l2`). From here people can save blocking and earlier scripts.
4. B's own safeguards: the record is checked with the same schema the server uses before it is applied (a refused record never reaches a save), the limit is
   1,500 entries (the project's shot maximum), entries for deleted shots are dropped as a save is made, and "Saved" is said only after the save went through.

## Rolling back (in this order)
1. **Roll back to A first** (the build with the schema, without B). Safe with no data step: A still accepts the field, the screens that write it are gone, and what was
   saved stays in the project (`production.blocking` and `scriptVersions`, plus the frame as an ordinary reference input). Nothing can write new blocking from here.
2. **Then strip**, only if the next step is a rollback past A. A build that does not know the field refuses every project that holds it, so the fields must be out of the
   stored bodies first (run it for each: `--field=blocking`, the default, and `--field=scriptVersions`). Script: `scripts/ops/strip-production-blocking.mjs`. It **never erases**: before a value is removed it is copied into the additive table
   `workbench_blocking_archive` in the same database (created if missing; no other schema change), in one transaction with the removal. It is a **dry run by default**, prints the
   database **host** (no secrets) and **counts only**, and writes only with `--apply --owner-said-yes`. It removes only the named field (`production.blocking`, or `scriptVersions`), bumps the revision by one (a window
   with an older copy meets a conflict and merges), never deletes a row, and leaves a row that changed since it was read (found on the next run). One database per run; each workspace
   has its own, so loop over the workspaces' databases.
   ```
   STRIP_BLOCKING_DB_URL=<libsql url> STRIP_BLOCKING_DB_TOKEN=<token> node scripts/ops/strip-production-blocking.mjs                        # host + counts only
   STRIP_BLOCKING_DB_URL=... STRIP_BLOCKING_DB_TOKEN=... node scripts/ops/strip-production-blocking.mjs --apply --owner-said-yes        # only on the owner's yes
   ```
   Check the host line against the database you mean to change before saying yes.
3. **Then roll back past A.**
4. **To bring blocking back later** (after A, or A and B, are live again): `--restore` puts every archived value back into the project that still exists and holds no blocking now
   (what a person made since is never overwritten); dry run first, then `--restore --apply --owner-said-yes`. The archive rows are kept and marked restored.

The frames filed from blocking stay as ordinary reference inputs and Library files (valid in every build). The tidy and a blocking save only ever remove the input nodes a blocking save
made (their ids start with `blocking-input-`); a reference a person added is never removed.

**Not run**: the script has only been run against throwaway local files (its unit test), never against a real database.

- Other copies: bible versions (`workbench_bibles`) hold only shared nodes and assets, not `production`; no other table stores a whole project body. Re-check with a
  search for `workbench_projects` before the train if the codebase moved.

## Earlier scripts (owner decision 11): the second field, same care
- `scriptVersions` is optional and bounded (at most 10 earlier scripts, 3,000,000 characters in all, newest first), kept when "Use as script" or a restore replaces the script. A build without its schema refuses a body that holds
  it, just as with blocking, so it is in part A.
- It never locks a project: the schema trims what it is given, every write path trims before it saves (`trimVersions`), and the three-way merge orders the merged list newest first, drops repeats and trims it. A script longer
  than the whole limit is kept as the current script and no version.
- The strip script takes `--field=scriptVersions` (default `--field=blocking`): same archive-before-remove, same dry run and two-flag write, same `--restore`. Each archived copy records its field, and a restore only
  touches the field it is run with. Roll back to part A first, then strip each field you need, then roll back past A.

## Open (L9)
Blocking lives in the author's own project draft; the frame input is on the shared team canvas, so a teammate sees the reference input but not the blocking strip.
