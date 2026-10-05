import type { ScreenModule } from "@/lib/shell/screens";
import { PHONE_PARAMS } from "./phone-model";

/**
 * The phone's entry in stream 1's screen registry (lib/shell/screens.ts): the params the shell keeps for it,
 * with the switch on only. The phone routes every address itself once it is mounted (phone-model.ts ›
 * readPhone), so it adds no redirect rows. `landed` turns true in the PR that completes the phone's set,
 * not before: until then nobody is shown a phone screen that leads nowhere.
 */
export const PHONE_SCREEN: ScreenModule = {
  id: "phone",
  landed: false,
  params: PHONE_PARAMS,
  rows: [],
  fallback: [],
};
