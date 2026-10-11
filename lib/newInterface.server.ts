import { newInterfaceOn } from "./newInterface";

/** The switch for a session's workspace: on for every workspace (lib/newInterface.ts), so nothing is read. */
export async function newInterfaceFor(workspace: { id: string } | null | undefined): Promise<boolean> {
  return newInterfaceOn(workspace);
}
