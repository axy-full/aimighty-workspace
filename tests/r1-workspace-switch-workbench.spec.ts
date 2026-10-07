import { test } from "@playwright/test";

/*
 * Port of "workspace switch drains saves and a refused switch retains editing" (tests/customer.spec.ts, old shell).
 * TENANCY guard. Release 1's switch (avatar menu "Switch to <workspace>", components/graphite/SettingsMenu.tsx switchTo;
 * Workspace > General, components/graphite/WorkspaceView.tsx change) POSTs /api/workspaces/switch at once and then
 * navigates: it does not wait for the board's pending save (rig.save(), RigProvider.tsx), so check (a) cannot pass today.
 * Owner question: approve the fix (await the board's save before the switch POST, and keep the board editable on a refusal).
 * Steps to assert once fixed, at 1440x900 (and 390x844, the avatar menu exists there):
 *  (a) hold PUT/PATCH of the draft, edit the project name twice, open avatar menu, choose Switch; no switch request
 *      before the save is released; release; save(final edit) is recorded before the switch.
 *  (b) answer the switch 503 "Workspace switching is temporarily unavailable."; the message shows, the board stays
 *      editable and the next edit saves.
 */
test.fixme("workspace switch waits for the pending save, and a refused switch keeps the board editable", async () => {});
