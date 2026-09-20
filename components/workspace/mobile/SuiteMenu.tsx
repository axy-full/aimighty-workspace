"use client";
import { formatCount } from "@/lib/workspace/format";
import { PAGES, SUITES } from "@/lib/workspace/pages";
import { useWorkspace } from "@/lib/workspace/state";

/**
 * The suite dropdown the title opens on Projects (05-mobile, "Header"). Four
 * rooms over the same project: switching a suite never changes the project,
 * so this only moves which room the Projects and Stages screens describe.
 */
export function SuiteMenu({ onClose }: { onClose: () => void }) {
  const ws = useWorkspace();
  const { state } = ws;
  return (
    <div className="pxm-menu-host" data-testid="mobile-suite-menu">
      <button type="button" className="pxm-menu-scrim" aria-label="Close" onClick={onClose} />
      <div className="pxm-menu" role="dialog" aria-label="Suites">
        <div className="pxm-menu-head">
          <div className="pxm-kicker" data-functional-label="">SUITE</div>
          <div className="pxm-menu-sub">Four rooms over the same project.</div>
        </div>
        <div className="pxm-menu-list">
          {SUITES.map((suite) => {
            const on = suite.id === state.suite;
            const pages = PAGES[suite.id].length;
            return (
              <button
                key={suite.id}
                type="button"
                className="pxm-menu-row"
                data-suite={suite.id}
                data-on={on ? "" : undefined}
                aria-current={on ? "true" : undefined}
                onClick={() => {
                  ws.switchSuite(suite.id);
                  onClose();
                }}
              >
                <span className="pxm-dot9" style={{ background: suite.dot }} aria-hidden="true" />
                <span className="pxm-grow">
                  <span className="pxm-menu-name">{suite.name}</span>
                  <span className="pxm-menu-desc">{suite.desc}</span>
                </span>
                <span className="pxm-menu-count" data-functional-label="">{formatCount(pages)} {pages === 1 ? "page" : "pages"}</span>
                {on ? <span className="pxm-menu-check" aria-hidden="true">✓</span> : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
