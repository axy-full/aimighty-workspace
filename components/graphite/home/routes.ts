import type { ScreenModule } from "@/lib/shell/screens";

/**
 * Home (stream 2): `?view=home`. Seeded by the shell (stream 1); stream 2 owns this file from here and flipped
 * `landed` in the PR that lands HomeView (integration: Home is built, so it is on).
 */
export const HOME_SCREEN: ScreenModule = {
  id: "home",
  landed: true,
  params: [],
  /* Old → new: the Studio overview, and the phone's old Home tile. */
  rows: [
    { from: "?suite=particl&page=brief&sp=stages", to: "?view=home" },
    { from: "?suite=particl&page=brief&sp=home", to: "?view=home" },
  ],
  /* New → today's page. */
  fallback: [{ from: "?view=home", to: "?suite=particl&page=brief&sp=stages" }],
};
