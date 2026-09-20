"use client";
import { useEffect, useMemo } from "react";
import { useSession } from "@/lib/session";
import { useAtomik } from "@/lib/workspace/atomik-host";
import { mobileRowGroups, mobileRowIntro } from "@/lib/workspace/mobile-templates";
import type { SpecFacts } from "@/lib/workspace/spec-cards";
import { clearSpecFacts, publishSpecFacts } from "@/lib/workspace/spec-store";
import { useWorkspace } from "@/lib/workspace/state";
import { usePipelineRuns, useProjectBudget } from "../../spec/use-spec-data";
import type { MobilePageProps } from "../screens/registry";
import type { PageId } from "@/lib/workspace/types";

/**
 * Rows (05-mobile, template 4): grouped rows with a 36px mono lead chip tinted
 * by state, the name, the sub and a right-aligned value.
 *
 * The groups are the desktop spec page's own — `SPEC_GROUPS` /
 * lib/workspace/spec-cards.ts, read through `mobileRowGroups` — and so are the
 * facts behind them: the same pipeline runs and the same project budget
 * components/workspace/spec/use-spec-data.ts reads, and the same Atomik plan
 * state. The two surfaces therefore show one page in two shapes, and a card
 * added to the spec config appears here without another edit.
 *
 * It publishes those facts for the Inspector sheet exactly as the desktop page
 * does, so the sheet M-C fills reads the same object.
 */

const RUN_PAGES = new Set<PageId>(["agent", "runs", "recipes", "approvals"]);

export function RowsPage({ page, project }: MobilePageProps) {
  const ws = useWorkspace();
  const scope = useSession().requestScope ?? null;
  const productionId = project?.productionProjectId ?? null;
  const runs = usePipelineRuns(RUN_PAGES.has(page) ? productionId : null, scope);
  const budget = useProjectBudget(page === "budget" ? productionId : null, scope);
  const atomik = useAtomik();
  const run = atomik.runFor(page);
  const status = run?.status ?? null;
  const completed = Boolean(atomik.state.completed[page]);
  const price = atomik.plan(page)?.priceLabel ?? null;

  const facts = useMemo<SpecFacts>(
    () => ({ project, runs, budget, planRun: status ? { status } : null, planCompleted: completed, planPrice: price }),
    [project, runs, budget, status, completed, price],
  );
  useEffect(() => publishSpecFacts(page, facts), [page, facts]);
  useEffect(() => () => clearSpecFacts(page), [page]);

  const groups = useMemo(() => mobileRowGroups(page, facts), [page, facts]);
  const intro = mobileRowIntro(page);

  return (
    <div className="pxm-pad-x pxm-pad-top" data-template="rows" data-testid="mobile-rows">
      {intro ? <p className="pxm-lede pxm-rows-intro">{intro}</p> : null}
      {groups.map((group) => (
        <section className="pxm-group" key={group.title} aria-label={group.title}>
          <div className="pxm-group-head">
            <span className="pxm-kicker" data-functional-label="">{group.title}</span>
            {group.note ? <span className="pxm-group-note">{group.note}</span> : null}
          </div>
          {group.rows.map((row) => (
            <button
              key={row.id}
              type="button"
              className="pxm-spec-row"
              data-row={row.id}
              data-state={row.state}
              /* Every row is the same one card the desktop shows; opening it
                 opens the page's own detail, which is the Inspector sheet. */
              onClick={() => ws.setSheet("inspector")}
            >
              {/* Tinted by state in CSS (data-state), never dimmed below the
                  label floor: the tint is the chip, not the glyph. */}
              <span className="pxm-lead" data-functional-label="" aria-hidden="true">{row.lead}</span>
              <span className="pxm-grow">
                <span className="pxm-spec-name">{row.name}</span>
                <span className="pxm-spec-sub">{row.sub}</span>
              </span>
              <span className="pxm-spec-value" data-functional-label="">{row.value}</span>
            </button>
          ))}
        </section>
      ))}
      {!groups.length ? <p className="pxm-empty">This page has no groups on the phone yet.</p> : null}
    </div>
  );
}
