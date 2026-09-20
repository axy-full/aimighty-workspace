"use client";
import { useMemo, useState } from "react";
import { useDraftEditor } from "@/lib/workspace/draft-editor";
import { marketingSections, mobileRowIntro, toggleSection, type MarketingSectionState } from "@/lib/workspace/mobile-templates";
import type { MobilePageProps } from "../screens/registry";

/**
 * Accordion (05-mobile, template 5): Marketing Studio's seven sections, one
 * open at a time, each expanding to its own field rows.
 *
 * The seven are lib/suites.ts `MOLECULR_SECTIONS` — the same seven the desktop
 * flow shows — and every value is read from the Marketing brief saved on the
 * draft (`marketingSections`). A field the brief does not hold reads "—": the
 * phone never fills a campaign in for you.
 *
 * Nothing paid runs from here. Marketing's variants are priced and dispatched by
 * the page's Atomik plan at its gate, which is the pinned primary.
 */

const DOT: Record<MarketingSectionState, string> = {
  done: "var(--pxw-green)",
  active: "var(--pxw-blue-ink)",
  idle: "var(--pxw-neutral-state)",
};
const STATE_LABEL: Record<MarketingSectionState, string> = { done: "Complete", active: "In progress", idle: "Not started" };

export function AccordionPage({ page, project: shellProject, scope }: MobilePageProps) {
  const draft = useDraftEditor(scope, shellProject?.id ?? null);
  const project = draft.project ?? shellProject;
  const sections = useMemo(() => marketingSections(project), [project]);
  const [open, setOpen] = useState<string | null>(sections[0]?.id ?? null);

  if (!shellProject) return <p className="pxm-empty pxm-pad-x">Open a project to see its marketing studio.</p>;
  return (
    <div className="pxm-pad-x pxm-pad-top" data-template="accordion" data-testid="mobile-accordion">
      <p className="pxm-lede pxm-rows-intro">{mobileRowIntro(page)}</p>
      {sections.map((section) => {
        const expanded = open === section.id;
        return (
          <div className="pxm-acc" key={section.id} data-section={section.id} data-open={expanded ? "" : undefined}>
            <button
              type="button"
              className="pxm-acc-head"
              aria-expanded={expanded}
              aria-controls={`pxm-acc-${section.id}`}
              onClick={() => setOpen((current) => toggleSection(current, section.id))}
            >
              <span className="pxm-dot9" style={{ background: DOT[section.state] }} aria-hidden="true" />
              <span className="pxm-grow">
                <span className="pxm-acc-title">{section.title}</span>
                <span className="pxm-acc-sub">{section.sub}</span>
              </span>
              <span className="pxm-acc-state">{STATE_LABEL[section.state]}</span>
              <span className="pxm-acc-caret" aria-hidden="true">{expanded ? "▾" : "›"}</span>
            </button>
            <div className="pxm-acc-body" id={`pxm-acc-${section.id}`} hidden={!expanded}>
              {section.rows.map((row) => (
                <div className="pxm-acc-row" key={row.name}>
                  <span className="pxm-grow">
                    <span className="pxm-acc-row-name">{row.name}</span>
                    <span className="pxm-acc-row-sub">{row.sub}</span>
                  </span>
                  <span className="pxm-acc-row-value" data-functional-label="">{row.value}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
