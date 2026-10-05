import type { ComponentType } from "react";
import type { BoardCard } from "@/lib/board/types";
import type { BoardCtx, CardDef } from "../cards/types";

/*
 * Stream 5's Inspector (frame k): 340 px over the board's right edge, open only on a selection.
 * A stub seeded by stream 3 (lead decision 26): it renders nothing. Owned by stream 5 from its first PR.
 */
export type BoardInspectorProps = {
  ctx: BoardCtx;
  /** The selected card and its definition (its `Inspector` body, when it has one); null: nothing selected. */
  card: BoardCard | null;
  def: CardDef<unknown> | null;
  /** The docked Atomik panel's width: the Inspector's right edge sits there. */
  right: number;
  onClose: () => void;
};
export const BoardInspector: ComponentType<BoardInspectorProps> = () => null;
