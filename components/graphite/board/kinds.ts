import type { BoardKind } from "@/lib/board/types";
import { adsBoard } from "./ads";
import { useAdsExtra } from "./ads/ads-session";
import type { BoardKindModule } from "./cards/types";
import { socialBoard } from "./social";
import { studioBoard } from "./studio";

/** `?view=board` with `kind=` (README § 1.1): Studio is stream 3's; Ads and Social are stream 11's modules. */
export const BOARD_MODULES: Readonly<Record<BoardKind, BoardKindModule>> = { studio: studioBoard, ads: adsBoard, social: socialBoard };

/**
 * A board kind's own session data for its cards (BoardSource.extra): Ads' pending reads and what the Campaign agent is doing
 * (ads/ads-session.ts). Every hook runs on every render, whatever the kind, so the order never changes; each is idle unless its
 * kind is on screen.
 */
export function useKindExtra(kind: BoardKind, project: { id: string } | null): unknown {
  const ads = useAdsExtra(project?.id, kind === "ads");
  return kind === "ads" ? ads : null;
}
