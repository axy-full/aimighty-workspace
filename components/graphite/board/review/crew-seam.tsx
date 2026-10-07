"use client";
import type { ComponentType } from "react";
import type { BoardCtx } from "../cards/types";

/*
 * The seam between Crew review's internal part (CrewTakeReview) and the client's side of it: the client link ("Copy client
 * link") and the client's own view, which are security work (their links, their sign-in-free page, their permissions) and are
 * not built here. Whatever registers a component with `setCrewClientSection` is drawn at the foot of the take review, under
 * Approve and Reject; until something does, the seam draws nothing and no button stands in its place. The panel as a whole
 * (agent/CrewReview.tsx) is where that work puts its own section today; this slot is for a part that needs the take on screen.
 */
let section: ComponentType<{ ctx: BoardCtx }> | null = null;
export const setCrewClientSection = (component: ComponentType<{ ctx: BoardCtx }> | null) => { section = component; };
export function CrewClientSeam({ ctx }: { ctx: BoardCtx }) {
  const Section = section;
  return Section ? <Section ctx={ctx} /> : null;
}
