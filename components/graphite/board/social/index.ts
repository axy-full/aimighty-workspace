import type { BoardKindModule } from "../cards/types";

/*
 * Stream 11's Social board (README § 1.1, § 3.3): rail Source · Clips · Hooks · Effects · Posts.
 * A stub seeded by stream 3 (lead decision 26): the rail over an empty canvas, no cards. Owned by stream 11 from its
 * first PR, which replaces this file (its rail, bands, card sets and empty board).
 */
export const socialBoard: BoardKindModule = {
  kind: "social",
  rail: [
    { id: "source", label: "Source", icon: "M2 4h8v8H2zM10 7l4-2v6l-4-2" },
    { id: "clips", label: "Clips", icon: "M2 4h12v8H2zM2 7h12M5 4v8" },
    { id: "hooks", label: "Hooks", icon: "M3 4h10M3 8h10M3 12h7" },
    { id: "effects", label: "Effects", icon: "M8 2l1.5 4.5L14 8l-4.5 1.5L8 14l-1.5-4.5L2 8l4.5-1.5z" },
    { id: "posts", label: "Posts", icon: "M8 11V3M4 7l4-4 4 4M3 13h10" },
  ],
  bands: [["source"], ["clips"], ["hooks", "effects"], ["posts"], ["next"], ["made"]],
  sets: [],
};
