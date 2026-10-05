import type { ScreenModule } from "@/lib/shell/screens";

/**
 * The control room (stream 8): Approvals, Activity (the old Runs page), Memory and Skills, at their own URLs
 * (`?suite=atomik&page=approvals|runs`, `&page=agent&sp=memory|saved-skills`). Seeded by the shell (stream 1);
 * stream 8 owns this file; ControlRoom landed with PR 8.1 (Approvals) and 8.2 (Activity). Those four addresses do
 * not change, so the only row is Workspace's old Dashboard, which became Activity.
 */
export const CONTROL_ROOM_SCREEN: ScreenModule = {
  id: "control-room",
  landed: true,
  params: [],
  rows: [{ from: "?view=workspace&tab=dashboard", to: "?suite=atomik&page=runs" }],
  fallback: [],
};
