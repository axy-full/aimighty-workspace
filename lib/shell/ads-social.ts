import type { ScreenModule } from "./screens";

/**
 * The Ads and Social boards (stream 11): the board's entry with `kind=ads|social`. Seeded by the shell (stream 1);
 * stream 11 owns this file from here and flips each `landed` in the PR that lands that kind. A kind counts as
 * landed only once the board itself (lib/board/routes.ts) has too.
 */
export const ADS_SCREEN: ScreenModule = {
  id: "board-ads",
  landed: false,
  params: ["frame", "card"],
  rows: [
    { from: "?suite=moleculr&page=marketing&sp=dtc", to: "?view=board&kind=ads&frame=2&card=image-ad" },
    { from: "?suite=moleculr&page=marketing&sp=setup", to: "?view=board&kind=ads&frame=1" },
    { from: "?suite=moleculr&page=marketing&sp=brand", to: "?view=board&kind=ads&frame=1&card=brand" },
    { from: "?suite=moleculr&page=marketing&sp=product", to: "?view=board&kind=ads&frame=1&card=product" },
    { from: "?suite=moleculr&page=marketing&sp=reference", to: "?view=board&kind=ads&frame=1&card=reference" },
    { from: "?suite=moleculr&page=marketing&sp=format", to: "?view=board&kind=ads&frame=2&card=formats" },
    { from: "?suite=moleculr&page=marketing&sp=hooks", to: "?view=board&kind=ads&frame=2&card=hooks" },
    { from: "?suite=moleculr&page=marketing&sp=design", to: "?view=board&kind=ads&frame=3" },
  ],
  fallback: [
    { from: "?view=board&kind=ads&frame=1", to: "?suite=moleculr&page=marketing&sp=setup" },
    { from: "?view=board&kind=ads&frame=2", to: "?suite=moleculr&page=marketing&sp=dtc" },
    { from: "?view=board&kind=ads&frame=3", to: "?suite=moleculr&page=marketing&sp=design" },
    { from: "?view=board&kind=ads", to: "?suite=moleculr&page=marketing&sp=dtc" },
  ],
};

export const SOCIAL_SCREEN: ScreenModule = {
  id: "board-social",
  landed: false,
  params: ["frame", "card"],
  rows: [],
  fallback: [{ from: "?view=board&kind=social", to: "?suite=subatomik&page=history" }],
};
