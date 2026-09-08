"use client";

import { use, useState } from "react";
import { usePageTitle } from "@/lib/usePageTitle";
import { useIsMobile } from "@/lib/useMobile";
import RunView from "@/components/RunView";
import StageLayer from "@/components/StageLayer";
import AssetLayer from "@/components/AssetLayer";

/**
 * Rig (brief 3).
 *
 * The handoff is explicit that the desktop surfaces are two layers of ONE
 * screen behind an `Assets | Stages | Runs` switcher, not two screens. So the
 * switcher lives here and the layers are components.
 *
 * On a phone there is no canvas — the stage layer is a 1440-wide surface and
 * the handoff allows it to be hidden below 1180 — so the phone opens straight
 * on the run, which is the surface written for it.
 */
type Layer = "assets" | "stages" | "runs";

export default function RigPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const mobile = useIsMobile();
  usePageTitle("Rig");
  const [layer, setLayer] = useState<Layer>("runs");

  if (mobile) return <RunView projectId={id} />;

  return (
    <div className="rig-screen">
      <div className="rig-switch" role="tablist" aria-label="Rig layers">
        {([["assets", "Assets"], ["stages", "Stages"], ["runs", "Runs"]] as [Layer, string][]).map(([k, label]) => (
          <button
            key={k} role="tab" aria-selected={layer === k}
            className={`rig-switch-tab${layer === k ? " is-on" : ""}`}
            onClick={() => setLayer(k)}
          >{label}</button>
        ))}
      </div>
      {layer === "runs" ? <RunView projectId={id} /> : null}
      {layer === "stages" ? <StageLayer projectId={id} /> : null}
      {layer === "assets" ? <AssetLayer projectId={id} /> : null}
    </div>
  );
}
