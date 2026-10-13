# Board sharing: admins, transfer, Can view / Can edit (plan, 13 Oct)

The owner's decisions on 13 Oct are in docs/redesign-plan.md. This plan was read from release/1 e9da19d0. The build starts after deploy #2.

## Today
- **Board ownership** is the hash in the board's project id: `prj_wb_` + hash(workspace, owner, draftId), in `lib/draftProject.ts` and `lib/workAccess.ts`. Each workspace has its own database.
- **Sharing (#667)** is the `teamShared` flag in the board JSON. `mayReachProject` gives the owner and the marked sample read and write, a shared board read only, and admins nothing extra.
- **What is live** is only the board's cards (Liveblocks Storage), plus presence.
  - There is no Yjs: the stack is `@liveblocks/client` and `@liveblocks/node` 3.24.2.
  - Room sign-in requires write access, so viewers get no room and don't see edits live.
  - The rest of the board (brief, script, stages) is each person's saved draft, revision-checked with a three-way merge.
  - Gap: when two people change the same single value, the merge silently keeps "mine".

## Part A: admin access and ownership transfer
- **Admin reach:** `mayReachProject` and `projectLister` let an admin of the same workspace reach any board, read and write.
  - `currentPerson` must also carry `owner`.
  - Admins get their own read paths (all boards, including boards of members who have left).
  - Every admin open or edit of a private board writes an audit line.
- **Transfer:** no re-keying. An additive override table, `workbench_board_owners(project_id, draft_owner, draft_id, owner, transferred_by, at)`, read through `boardOwnerOf()`. This is a migration, so it ships after the owner's backup.
  - Admin only, audited, with Undo.
  - Uploads on a board the viewer now owns open for them.
- **Screen:** a "Transfer boards to…" picker is a new element and goes through Claude Design.
- **Guard tests that move an admin from refused to allowed** (moved, never deleted; each needs the owner's word):
  - `privateCanvas.spec.ts:73-74`;
  - `privateShots.spec.ts:71-75`, `:353`, and u_admin in the refused lists;
  - #675's `uploadAccess.spec.ts:83-85` and `:151`.
  - Admin-in-another-workspace cases are added.

## Part B: Can view / Can edit
- **Mode:** `teamEdit` next to `teamShared` in the board JSON, so no migration. The share flags become server-owned: only the `team-share` action sets them.
- **Co-editing:**
  - Cards are already live for several writers.
  - The rest of the board stays as revision-checked saves to the owner's key, written by the actor.
  - After each save, a room broadcast tells the others to catch up.
  - Same-field conflicts surface as "X changed this too — yours kept · Undo", so nothing is overwritten silently.
  - Yjs and putting the whole board in Storage are left out of v1.
- **Server:** write reach becomes owner, sample, admin, or shared-and-editable. Viewers stay 403/404. Sharing settings, rename and delete stay owner or admin.
- **Room sign-in:**
  - Owner, editors and admins get FULL access; viewers get READ plus presence, which also makes the board live for viewers.
  - Liveblocks tokens can't be revoked early, so the room id rotates when sharing stops.
- **Defaults:** Business (`planOf(ws).group === "business"`) gets shared · can edit; everyone else gets private. The default is stamped at the first save. Business is only admin-labelled until checkout exists.
- **Screens:** "Share with team ▸ Can view / Can edit / Not shared" with a selected mark (Claude Design), and a who's-editing row (reuses Presence; Claude Design to confirm). The conflict notice reuses Toast with Undo.

## PRs (about 52 h of Sonnet lane time)
| # | PR | Size | Flags | After |
|---|---|---|---|---|
| 1 | Admin reach + audit + guard moves | M, 6h | NEEDS AKSHAY | deploy #2 |
| 2 | Admin rule for uploads | S, 3h | NEEDS AKSHAY | #675 |
| 3 | Act on a board stored under another key; server-owned share flags | M, 8h | NEEDS AKSHAY | 1 |
| 4 | Transfer (override table, boardOwnerOf, Undo) | M, 8h | migration, NEEDS AKSHAY | 2, 3 |
| 5 | Transfer screen + admin "All boards" | S–M, 4h | Claude Design | 4 |
| 6 | Share mode teamEdit + editor write reach | S, 4h | NEEDS AKSHAY | 3 |
| 7 | Room sign-in by access, live for viewers, room rotation | S, 3h | NEEDS AKSHAY | 6 |
| 8 | Co-edit catch-up + conflict notes with Undo | M, 8h | — | 6, 7 |
| 9 | Business default on first save | S, 3h | NEEDS AKSHAY | 6 |
| 10 | Share submenu, who's-editing row, words | M, 5h | Claude Design | 6 |

## Owner questions (recommendations)
1. Is an admin opening a private board audited, or visible to the member? Recommended: an audit line, no notification.
2. Can editors render and make client links? Recommended: rendering yes, through the same approval gate; client links stay with the owner and admins.
3. Do legacy Studio, Agency and Production plans count as Business for the default? Recommended: no, they default to private.
4. Where do admins see members' private boards? Recommended: in a separate "All boards" view, not in "Your boards".

## Owner's answers and order (13 Oct)
- The answers are recorded in docs/redesign-plan.md ("board sharing"):
  - admin opens: audit line plus a "Viewed by <admin>, <date>" line in the board's history;
  - editors render, client links stay with the owner and admins;
  - legacy plans default to private;
  - admins get a separate "All boards" view.
- All 10 PRs, one at a time, each with tests and an Opus privacy review, after deploy #3.
- PR 1 now also writes the "Viewed by" history line.

## Claude Design brief (new screen elements, before their PRs)
1. **Share with team ▸ Can view / Can edit / Not shared:** a submenu in the board's ⋯ menu and right-click menu, with a selected mark (PR 10; PR 6 ships the server side first).
2. **"Viewed by <admin>, <date>":** a line in the board's history, visible to the owner only (PR 1). Does the board's history surface exist in v14? If not, Design decides where it lives.
3. **Who's editing:** the row of editors on a shared board (PR 8 and 10), building on Presence.tsx, which the v14 design draws nothing for today.
4. **"Changed since you opened it":** the conflict notice with Undo, reusing Toast. Design confirms the words.
5. **Transfer boards to…:** a picker on the Team page when a member leaves (PR 5).
6. **All boards:** the admins' view of every board in the workspace, not on Home (PR 5).
7. **The view-only bar for an admin on someone's private board, with an Edit action (PR 1 and 3).**
Each must pass the one-design and UI-names guards. No new style sheet.
