import type { ScreenModule } from "./screens";

/**
 * The Ads and Social boards (stream 11): the board's entry with `kind=ads|social`. Seeded by the shell (stream 1);
 * stream 11 owns this file from here and flips each `landed` in the PR that lands that kind. A kind counts as
 * landed only once the board itself (lib/board/routes.ts) has too.
 */
export const ADS_SCREEN: ScreenModule = {
  id: "board-ads",
  landed: true,
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
  landed: true,
  params: ["frame", "card"],
  rows: [],
  fallback: [{ from: "?view=board&kind=social", to: "?suite=subatomik&page=history" }],
};

/*
 * Where each board opens (README § 1.1, § 3.3). Pure; the board reads these, nothing here fetches.
 *
 * `frame=` is the design's frame number: Ads 1 is Brand, product and reference, 2 is Hooks, formats and ads,
 * 3 is the poster Designer over the board; Social 1 is the source and clips, 2 is hooks, effects and posts.
 * `card=` names one card, and the board glides to it, selects it and opens its panel.
 */
export type AdsCardId = "brand" | "product" | "reference" | "hooks" | "formats" | "image-ad";
export type AdsRegionId = "brand" | "product" | "hooks" | "formats" | "ads" | "adapt" | "deliver";
export type SocialRegionId = "source" | "clips" | "hooks" | "effects" | "posts";
export type SocialCardId = "source" | "effects";

export const ADS_FRAME_REGION: Readonly<Record<string, AdsRegionId>> = { "1": "brand", "2": "hooks" };
export const SOCIAL_FRAME_REGION: Readonly<Record<string, SocialRegionId>> = { "1": "source", "2": "hooks" };
/** The region a card sits in, which the board opens at for `card=`. */
export const ADS_CARD_REGION: Readonly<Record<AdsCardId, AdsRegionId>> = {
  brand: "brand", product: "product", reference: "product", hooks: "hooks", formats: "formats", "image-ad": "ads",
};
export const SOCIAL_CARD_REGION: Readonly<Record<SocialCardId, SocialRegionId>> = { source: "source", effects: "effects" };

/** The board card id for a `card=` value on a kind, or null. Ads cards are `ads:<id>`, Social's `social:<id>`. */
export function boardCardId(kind: string, card: string | null | undefined): string | null {
  if (!card) return null;
  if (kind === "ads" && Object.hasOwn(ADS_CARD_REGION, card)) return `ads:${card}`;
  if (kind === "social" && Object.hasOwn(SOCIAL_CARD_REGION, card)) return `social:${card}`;
  return null;
}

/** The region a `frame=` or `card=` opens the board at, for an Ads or Social board; null for any other kind or value. */
export function adsSocialRegion(kind: string, frame: string | null | undefined, card: string | null | undefined): string | null {
  if (kind === "ads") {
    if (card && Object.hasOwn(ADS_CARD_REGION, card)) return ADS_CARD_REGION[card as AdsCardId];
    return frame && Object.hasOwn(ADS_FRAME_REGION, frame) ? ADS_FRAME_REGION[frame] : null;
  }
  if (kind === "social") {
    if (card && Object.hasOwn(SOCIAL_CARD_REGION, card)) return SOCIAL_CARD_REGION[card as SocialCardId];
    return frame && Object.hasOwn(SOCIAL_FRAME_REGION, frame) ? SOCIAL_FRAME_REGION[frame] : null;
  }
  return null;
}

/** Whether the address asks for the poster Designer over the Ads board (`frame=3`). */
export const wantsDesigner = (kind: string, frame: string | null | undefined): boolean => kind === "ads" && frame === "3";
