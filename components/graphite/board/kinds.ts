import type { BoardKind } from "@/lib/board/types";
import { adsBoard } from "./ads";
import type { BoardKindModule } from "./cards/types";
import { socialBoard } from "./social";
import { studioBoard } from "./studio";

/** `?view=board` with `kind=` (README § 1.1): Studio is stream 3's; Ads and Social are stream 11's modules. */
export const BOARD_MODULES: Readonly<Record<BoardKind, BoardKindModule>> = { studio: studioBoard, ads: adsBoard, social: socialBoard };
