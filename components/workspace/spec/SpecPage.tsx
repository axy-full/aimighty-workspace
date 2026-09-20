"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "@/lib/workbench/studio";
import { useSession } from "@/lib/session";
import { pageDef } from "@/lib/workspace/pages";
import { useAtomik } from "@/lib/workspace/atomik-host";
import {
  CARD_STATE,
  cardChips,
  cardFooter,
  cardState,
  groupNote,
  specFor,
  type SpecFacts,
} from "@/lib/workspace/spec-cards";
import { clearSpecFacts, publishSpecFacts } from "@/lib/workspace/spec-store";
import type { PageId } from "@/lib/workspace/types";
import type { PageBodyProps } from "../pages/registry";
import { Kicker, Segmented } from "../ui";
import { FOCUS, SpecTool } from "./SpecTool";
import { usePipelineRuns, useProjectBudget } from "./use-spec-data";

const RUN_PAGES = new Set<PageId>(["agent", "runs", "recipes", "approvals"]);

/**
 * The spec-card template (03, "Spec-card template"): intro, groups of cards,
 * then the page's existing working tool. A card that belongs to a tool opens
 * it; every card's state is counted from the project, its runs or the page's
 * Atomik plan — READY when nothing backs it.
 */
export function SpecPage({ page, project }: PageBodyProps) {
  const spec = specFor(page)!;
  const session = useSession();
  const scope = session.requestScope ?? null;

  /* A tool that edits the draft reports its newer copy up, so cards and the
     Inspector count what is on screen rather than the shell's first read. */
  const [edited, setEdited] = useState<Project | null>(null);
  const live = edited && edited.id === project?.id ? edited : project;

  const productionId = live?.productionProjectId ?? null;
  const runs = usePipelineRuns(RUN_PAGES.has(page) ? productionId : null, scope);
  const budget = useProjectBudget(page === "budget" ? productionId : null, scope);

  /* The page's Atomik plan runs on the shell's host (one engine per project). */
  const atomik = useAtomik();
  const run = atomik.runFor(page);
  const status = run?.status ?? null;
  const completed = Boolean(atomik.state.completed[page]);
  const price = atomik.plan(page)?.priceLabel ?? null;

  const facts = useMemo<SpecFacts>(() => ({
    project: live,
    runs,
    budget,
    planRun: status ? { status } : null,
    planCompleted: completed,
    planPrice: price,
  }), [live, runs, budget, status, completed, price]);

  useEffect(() => publishSpecFacts(page, facts), [page, facts]);
  useEffect(() => () => clearSpecFacts(page), [page]);

  const [tool, setTool] = useState<string | null>(spec.tools[0]?.id ?? null);
  const [picked, setPicked] = useState<string | null>(null);
  const work = useRef<HTMLElement>(null);
  const toolLabel = (id?: string) => spec.tools.find((t) => t.id === id)?.label ?? "";
  const open = (card: string, id: string) => {
    setPicked(card);
    setTool(id);
    requestAnimationFrame(() => {
      const section = FOCUS[page] ? work.current?.querySelector(`[data-subatomik-section="${FOCUS[page]}"]`) : null;
      (section ?? work.current)?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  };

  const title = pageDef(page).title;
  return (
    <div className="pxw-spec" data-page-body={page} data-testid="spec-page">
      <p className="pxw-spec-intro">{spec.intro}</p>
      {spec.groups.map((group) => {
        const note = groupNote(group, facts);
        return (
          <section className="pxw-spec-group" key={group.title} aria-label={group.title}>
            <div className="pxw-spec-group-head">
              <Kicker>{group.title}</Kicker>
              {note ? <span className="pxw-spec-note">{note}</span> : null}
            </div>
            <div className="pxw-spec-grid">
              {group.cards.map((card) => {
                const s = cardState(card, facts);
                const body = (
                  <>
                    <span className="pxw-spec-card-title">{card.name}</span>
                    <span className="pxw-spec-card-desc">{card.desc}</span>
                    <span className="pxw-spec-chips">
                      {cardChips(card, facts).map((chip, i) => (
                        <span className="pxw-spec-chip" key={chip + i}>{chip}</span>
                      ))}
                    </span>
                    <span className="pxw-spec-card-foot">
                      <span className="pxw-dot" style={{ background: CARD_STATE[s].color }} aria-hidden="true" />
                      <span className="pxw-spec-card-state" data-state={s}>{cardFooter(card, s)}</span>
                    </span>
                  </>
                );
                return card.tool && spec.tools.some((t) => t.id === card.tool) ? (
                  <button
                    key={card.name}
                    type="button"
                    className="pxw-spec-card"
                    data-card={card.name}
                    data-tool={card.tool}
                    aria-current={picked === card.name ? "true" : undefined}
                    title={`Open ${toolLabel(card.tool)}`}
                    onClick={() => open(card.name, card.tool!)}
                  >
                    {body}
                  </button>
                ) : (
                  <div key={card.name} className="pxw-spec-card" data-card={card.name}>
                    {body}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
      {tool ? (
        <section className="pxw-spec-work" ref={work} aria-label={`${title} working area`} data-testid="spec-work" data-tool={tool}>
          <div className="pxw-spec-work-head">
            <Kicker>Working area</Kicker>
            {spec.tools.length > 1 ? (
              <Segmented
                label={`${title} tools`}
                value={tool}
                onChange={(id) => {
                  setPicked(null);
                  setTool(id);
                }}
                options={spec.tools.map((t) => ({ id: t.id, label: t.label }))}
              />
            ) : (
              <span className="pxw-spec-work-name">{spec.tools[0].label}</span>
            )}
          </div>
          <div className="pxw-spec-work-body pxw-embed">
            <SpecTool page={page} tool={tool} project={project} scope={scope} onProject={setEdited} />
          </div>
        </section>
      ) : null}
    </div>
  );
}
