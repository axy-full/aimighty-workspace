"use client";
import { crumbFor } from "@/lib/workspace/pages";
import { useWorkspace } from "@/lib/workspace/state";
import { Kicker } from "./ui";

/** 32px. Project › crumb, a mono kicker, and any reason an action is unavailable. */
export function Breadcrumb({ projectName, reason }: { projectName: string; reason: string | null }) {
  const { state } = useWorkspace();
  const { crumb, kicker } = crumbFor(state);
  return (
    <div className="pxw-crumbs" data-row="crumbs">
      <span className="pxw-crumb-root">{projectName}</span>
      <span className="pxw-crumb-sep" aria-hidden="true">›</span>
      <span className="pxw-crumb">{crumb}</span>
      <Kicker>{kicker}</Kicker>
      {reason ? <span className="pxw-crumb-reason" id="pxw-action-reason" role="status">{reason}</span> : null}
    </div>
  );
}
