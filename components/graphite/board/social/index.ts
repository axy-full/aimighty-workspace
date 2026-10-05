import type { BoardCard } from "@/lib/board/types";
import { defineCard, type BoardKindModule, type CardSet } from "../cards/types";
import { EffectsCard, SocialUnavailableCard, SourceCard } from "./cards";
import { SocialHistoryDrawer } from "./HistoryDrawer";
import { SIZES, socialCards, type EffectsData, type SourceData, type UnavailableData } from "./social-model";
import { StartSource } from "./StartSource";

/*
 * Stream 11's Social board (README § 1.1, § 3.3): rail Source · Clips · Hooks · Effects · Posts. What exists today is drawn: the
 * source video, Effects (Motion transfer and Object swap, which open in Make) and History. Clips, hook review, narrated video and
 * posts read "Not in Particl yet" (gap G3), with no price and no sample result.
 */
const defs = [
  defineCard<SourceData>({ kind: "social-source", size: () => SIZES.source, Card: SourceCard }),
  defineCard<EffectsData>({ kind: "social-effects", size: () => SIZES.effects, Card: EffectsCard }),
  defineCard<UnavailableData>({ kind: "social-unavailable", size: () => SIZES.unavailable, Card: SocialUnavailableCard }),
];

export const socialCardSet: CardSet = { id: "social", defs, derive: (src): BoardCard[] => socialCards(src) };

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
  sets: [socialCardSet],
  Empty: StartSource,
  HistoryDrawer: SocialHistoryDrawer,
};
