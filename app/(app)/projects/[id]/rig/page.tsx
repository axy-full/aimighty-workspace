"use client";

import { use } from "react";
import { usePageTitle } from "@/lib/usePageTitle";
import RunView from "@/components/RunView";

/**
 * Rig, on a phone: the run this production is on (brief 3, surface 1a).
 *
 * The nav entry opens the run rather than a list of them, because a producer
 * looking at a production wants what is happening in it now. Older runs are
 * reachable by id on the same screen.
 */
export default function RigPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  usePageTitle("Rig");
  return <RunView projectId={id} />;
}
