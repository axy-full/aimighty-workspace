import type { ScreenModule } from "@/lib/shell/screens";
import { PHONE_PARAMS } from "./phone-model";

/**
 * The phone's entry in stream 1's screen registry (lib/shell/screens.ts): the params the shell keeps for it,
 * with the switch on only. The phone routes every address itself once it is mounted (phone-model.ts ›
 * readPhone), so it adds no redirect rows. A screen the build has not drawn opens Home (phone-model.ts ›
 * DRAWN_SCREENS), never an empty screen.
 */
export const PHONE_SCREEN: ScreenModule = {
  id: "phone",
  landed: true,
  params: PHONE_PARAMS,
  rows: [],
  fallback: [],
};
