"use client";
import { IconGenerate, IconLibrary, IconProjects, IconSparkle, IconStudio } from "@/components/Icons";
import { DOCK_TABS, dockActive, type DockTabId } from "@/lib/workspace/mobile";
import { useWorkspace } from "@/lib/workspace/state";

/**
 * The 60px dock (05-mobile, "Dock, 5 tabs"): Projects · Stages · Make ·
 * Atomik · Library. The first three switch screens; Atomik and Library open
 * sheets and read active while their sheet is up. Atomik carries the amber
 * badge when a gate is waiting. Search is in the header, not here.
 *
 * Icons are components/Icons.tsx verbatim, sized to 22px by the stylesheet
 * (the set takes no size prop, which is why the design's 22px is CSS).
 */
const DOCK_ICONS: Record<DockTabId, (props: { className?: string }) => React.JSX.Element> = {
  projects: IconProjects,
  stages: IconStudio,
  make: IconGenerate,
  atomik: IconSparkle,
  library: IconLibrary,
};

export function MobileDock({ gateWaiting }: { gateWaiting: boolean }) {
  const ws = useWorkspace();
  const { state } = ws;
  return (
    <nav className="pxm-dock" aria-label="Sections" data-testid="mobile-dock">
      {DOCK_TABS.map((tab) => {
        const on = dockActive(tab, state.mobile, state.sheet);
        const Icon = DOCK_ICONS[tab.id];
        const badge = tab.id === "atomik" && gateWaiting;
        return (
          <button
            key={tab.id}
            type="button"
            className="pxm-tab"
            data-tab={tab.id}
            data-on={on ? "" : undefined}
            aria-current={on ? "true" : undefined}
            onClick={() => ("sheet" in tab ? ws.setSheet(state.sheet === tab.sheet ? null : tab.sheet) : ws.setLevel(tab.level))}
          >
            <span className="pxm-tab-bar" aria-hidden="true" />
            <span className="pxm-tab-icon" aria-hidden="true"><Icon /></span>
            <span className="pxm-tab-label">{tab.label}</span>
            {badge ? <span className="pxm-tab-badge" data-testid="mobile-gate-badge" aria-label="One approval waiting">1</span> : null}
          </button>
        );
      })}
    </nav>
  );
}
