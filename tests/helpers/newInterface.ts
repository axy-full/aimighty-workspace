import type { APIRequestContext } from "@playwright/test";
import { setNewInterfaceOff, signInLocally } from "./workbenchLocal";

/**
 * A signed-in local session. The name predates the redesign switch and is kept for the demo streams' specs: their
 * session sees today's screens.
 */
export async function signInWithNewInterface(api: APIRequestContext, name = "Workbench Tester") {
  return signInLocally(api, name);
}

/**
 * A signed-in local session whose fresh workspace sees the interface being built from design/particl-prototype-12
 * (lib/newInterface.ts): signInLocally lists every workspace it makes as off (so the specs of today's screens keep them), and this
 * lifts that for the new one, as the platform owner would from /admin. Local servers only (signInLocally checks).
 */
export async function signInToRedesign(api: APIRequestContext, name = "Redesign Tester") {
  const signed = await signInLocally(api, name);
  await setNewInterfaceOff(signed.workspace.id, false);
  return signed;
}
