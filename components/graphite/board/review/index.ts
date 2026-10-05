import type { ComponentType } from "react";
import type { BoardCtx } from "../cards/types";

/*
 * Stream 5's review mode (frame l): full screen over the board.
 * A stub seeded by stream 3 (lead decision 26): it renders nothing. Owned by stream 5 from its first PR.
 */
export type BoardReviewProps = { ctx: BoardCtx };
export const BoardReview: ComponentType<BoardReviewProps> = () => null;
