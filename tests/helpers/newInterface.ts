import type { APIRequestContext } from "@playwright/test";
import { signInLocally } from "./workbenchLocal";

/**
 * Release 1 has no switch: every workspace sees every screen. This keeps the name the specs of the demo streams already
 * use: a signed-in local session, nothing else.
 */
export async function signInWithNewInterface(api: APIRequestContext, name = "Workbench Tester") {
  return signInLocally(api, name);
}
