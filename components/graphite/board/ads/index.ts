import type { BoardCard } from "@/lib/board/types";
import { defineCard, type BoardKindModule, type CardSet } from "../cards/types";
import { AdsOverlay } from "./AdsOverlay";
import { adsCards, SIZES, type BrandData, type FormatsData, type HooksData, type ImageAdData, type ProductData, type ReferenceData, type ResultData, type UnavailableData } from "./ads-model";
import { BrandCard, ProductCard, ReferenceCard } from "./cards/StartCards";
import { FormatsCard, HooksCard } from "./cards/HookCards";
import { ImageAdCard, ResultCard, UnavailableCard } from "./cards/AdCards";
import { KindList } from "./KindList";
import { StartBoard } from "./StartBoard";

/*
 * Stream 11's Ads board (README § 1.1, § 3.3): rail Brand · Product · Hooks · Formats · Ads · Adapt · Deliver. The cards are
 * derived from the project's Business brief and Library (ads-model.ts) and sit at the layout's fixed places: no drag and no
 * Tidy for the demo (decision 32). The empty board is the start card (G1); Adapt and Deliver, and UGC with consent, read
 * "Not in Particl yet" (gap G3).
 */
const defs = [
  defineCard<BrandData>({ kind: "ads-brand", size: () => SIZES.brand, Card: BrandCard }),
  defineCard<ProductData>({ kind: "ads-product", size: () => SIZES.product, Card: ProductCard }),
  defineCard<ReferenceData>({ kind: "ads-reference", size: () => SIZES.reference, Card: ReferenceCard }),
  defineCard<HooksData>({ kind: "ads-hooks", size: () => SIZES.hooks, Card: HooksCard }),
  defineCard<FormatsData>({ kind: "ads-formats", size: () => SIZES.formats, Card: FormatsCard }),
  defineCard<ImageAdData>({ kind: "ads-image", size: () => SIZES.imageAd, Card: ImageAdCard }),
  defineCard<ResultData>({ kind: "ads-result", size: () => SIZES.result, Card: ResultCard }),
  defineCard<UnavailableData>({ kind: "ads-unavailable", size: () => SIZES.unavailable, Card: UnavailableCard }),
];

export const adsCardSet: CardSet = { id: "ads", defs, derive: (src): BoardCard[] => adsCards(src), List: KindList };

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
  bands: [["brand", "product"], ["hooks", "formats"], ["ads"], ["adapt", "deliver"], ["next"], ["made"]],
  sets: [adsCardSet],
  Empty: StartBoard,
  Overlay: AdsOverlay,
};
