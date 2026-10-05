import type { BoardKindModule } from "../cards/types";

/*
 * Stream 11's Ads board (README § 1.1, § 3.3): rail Brand · Product · Hooks · Formats · Ads · Adapt · Deliver.
 * A stub seeded by stream 3 (lead decision 26): the rail over an empty canvas, no cards. Owned by stream 11 from its
 * first PR, which replaces this file (its rail, bands, card sets and empty board).
 */
export const adsBoard: BoardKindModule = {
  kind: "ads",
  rail: [
    { id: "brand", label: "Brand", icon: "M2 8.5V2.5h6L14 8.5 8.5 14zM5.2 5.2h.01" },
    { id: "product", label: "Product", icon: "M2 3h12v10H2zM2 10l4-3 3 3 2-2 3 3" },
    { id: "hooks", label: "Hooks", icon: "M3 4h10M3 8h10M3 12h7" },
    { id: "formats", label: "Formats", icon: "M2 4h12v8H2zM2 7h12M5 4v8" },
    { id: "ads", label: "Ads", icon: "M2 4h8v8H2zM10 7l4-2v6l-4-2" },
    { id: "adapt", label: "Adapt", icon: "M3 13V9M3 13h4M13 3v4M13 3H9M3 13l4-4M13 3L9 7" },
    { id: "deliver", label: "Deliver", icon: "M8 11V3M4 7l4-4 4 4M3 13h10" },
  ],
  bands: [["brand", "product"], ["hooks", "formats"], ["ads"], ["adapt"], ["deliver"], ["next"], ["made"]],
  sets: [],
};
