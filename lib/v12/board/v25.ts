import { HOUSE_WORKSPACE_ID } from "@/lib/houseWorkspace";

/**
 * Which boards draw the v25 parts (the stepper rail, the v25 card on Shots, the preview, Director mode) instead of the new interface's earlier ones.
 * Behind the new-interface switch (lib/newInterface.ts: off for every customer workspace, on for the house), and for now the house only: the house workspace,
 * or any workspace that opens the board with `?v25=1` (the browser tests, and the studio's own look at it from a listed workspace). A customer's board
 * keeps the earlier parts until the owner turns the v25 ones on for everyone. Pure: safe on the client.
 */
export function v25BoardOn(input: { newInterface: boolean; workspaceId?: string | null; param?: string | null }): boolean {
  return input.newInterface && (input.workspaceId === HOUSE_WORKSPACE_ID || input.param === "1");
}
