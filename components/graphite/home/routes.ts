import type { ScreenModule } from "@/lib/shell/screens";

/**
 * Home (stream 2): `?view=home`. Seeded by the shell (stream 1); stream 2 owns this file from here and flips
 * `landed` in the PR that lands HomeView. Until then the address opens today's Studio overview.
 */
export const HOME_SCREEN: ScreenModule = {
  id: "home",
  landed: false,
  params: [],
  /* Old → new: the Studio overview, and the phone's old Home tile. */
  rows: [
    { from: "?suite=particl&page=brief&sp=stages", to: "?view=home" },
    { from: "?suite=particl&page=brief&sp=home", to: "?view=home" },
  ],
  /* New → today's page. */
  fallback: [{ from: "?view=home", to: "?suite=particl&page=brief&sp=stages" }],
};
