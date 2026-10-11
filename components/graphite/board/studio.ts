import { STUDIO_BANDS, STUDIO_RAIL } from "@/lib/board/regions";
import { STUDIO_SETS } from "./cards";
import type { BoardKindModule } from "./cards/types";

/** The Studio board (README § 1.1, § 3.1): rail Brief · Looks · Storyboard · Shots · Cast · Cut · Deliver. */
export const studioBoard: BoardKindModule = { kind: "studio", rail: STUDIO_RAIL, bands: STUDIO_BANDS, sets: STUDIO_SETS };
