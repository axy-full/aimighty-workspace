"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "@/lib/workbench/studio";
import { useAtomik } from "@/lib/workspace/atomik-host";
import { pageDef } from "@/lib/workspace/pages";
import { cardChips, cardFooter, cardState, groupNote, specFor, type SpecCard, type SpecFacts, type SpecGroup } from "@/lib/workspace/spec-cards";
import { clearSpecFacts, publishSpecFacts } from "@/lib/workspace/spec-store";
import type { PageId } from "@/lib/workspace/types";
import { SpecTool } from "@/components/workspace/spec/SpecTool";
import { usePipelineRuns, useProjectBudget } from "@/components/workspace/spec/use-spec-data";
import { DEPT_COLORS } from "./icons";

/**
 * Owner's rule (22 September): a card that has neither an agentic nor an API
 * workflow behind it is not shown — it opens a tool, or an Atomik plan
 * performs it, or it goes. A group left empty goes with it.
 */
export const workflowCard = (card: SpecCard) => Boolean(card.tool || card.plan);
export function workflowGroups(groups: readonly SpecGroup[]): SpecGroup[] {
  return groups.map((group) => ({ ...group, cards: group.cards.filter(workflowCard) })).filter((group) => group.cards.length > 0);
}

/** The Studio stages this view owns: the ones FINAL_SPEC's six steps left on the spec-card template. */
export const STAGE_VIEW_PAGES: readonly PageId[] = ["brief", "boards", "astra", "deliver"];
const RUN_PAGES = new Set<PageId>(["agent", "runs", "recipes", "approvals"]);
const DOT: Record<string, "done" | "progress" | "waiting" | "ready"> = { COMPLETE: "done", ACTIVE: "progress", WAITING: "waiting", READY: "ready" };

/**
 * Brief & Script, Boards, Astra 3D and Deliver in the shell's own idiom
 * (Particl Suites.dc.html › the stage pages): the intro, the five facts, the
 * groups as framed cards in the department colours with a status dot each,
 * and the stage's working tool mounted beneath — the existing Brief, Boards,
 * Astra and Deliver tools, untouched. Every count is the project's own, the
 * same `spec-cards` rules the previous template used.
 */
export function StageView({ page, project, scope }: { page: PageId; project: Project | null; scope: string }) {
  const spec = specFor(page)!;
  /* A tool that edits the draft reports its newer copy up, so cards count what is on screen. */
  const [edited, setEdited] = useState<Project | null>(null);
  const live = edited && edited.id === project?.id ? edited : project;
  const productionId = live?.productionProjectId ?? null;
  const runs = usePipelineRuns(RUN_PAGES.has(page) ? productionId : null, scope);
  const budget = useProjectBudget(page === "budget" ? productionId : null, scope);
  const atomik = useAtomik();
  const run = atomik.runFor(page);
  const status = run?.status ?? null;
  const completed = Boolean(atomik.state.completed[page]);
  const price = atomik.plan(page)?.priceLabel ?? null;
  const facts = useMemo<SpecFacts>(() => ({ project: live, runs, budget, planRun: status ? { status } : null, planCompleted: completed, planPrice: price }), [live, runs, budget, status, completed, price]);
  useEffect(() => publishSpecFacts(page, facts), [page, facts]);
  useEffect(() => () => clearSpecFacts(page), [page]);

  const [tool, setTool] = useState<string | null>(spec.tools[0]?.id ?? null);
  const [picked, setPicked] = useState<string | null>(null);
  const work = useRef<HTMLElement>(null);
  const open = (card: string, id: string) => {
    setPicked(card);
    setTool(id);
    requestAnimationFrame(() => work.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };
  const title = pageDef(page).title;
  return (
    <div className="gx-stage-view gx-enter" data-testid="stage-view" data-page={page}>
      <p className="gx-stage-intro">{spec.intro}</p>
      <dl className="gx-facts gx-stage-facts" data-testid="stage-facts">
        {spec.facts(facts).map(([k, v]) => <div key={k}><dt>{k}</dt><dd title={v}>{v}</dd></div>)}
      </dl>
      {workflowGroups(spec.groups).map((group, gi) => {
        const note = groupNote(group, facts);
        return (
          <section className="gx-stage-group" key={group.title} aria-label={group.title} style={{ "--dept": DEPT_COLORS[gi % DEPT_COLORS.length] } as React.CSSProperties} data-testid="stage-group">
            <div className="gx-stage-group-head">
              <span className="gx-eyebrow">{group.title}</span>
              {note ? <span className="gx-hint">{note}</span> : null}
              <span className="gx-eyebrow gx-stage-count">{group.cards.length}</span>
            </div>
            <div className="gx-stage-grid">
              {group.cards.map((card) => {
                const s = cardState(card, facts);
                const opens = Boolean(card.tool && spec.tools.some((t) => t.id === card.tool));
                const body = (
                  <>
                    <span className="gx-stage-card-head"><span className="gx-stage-card-title">{card.name}</span><span className="gx-home-dot" data-state={DOT[s]} aria-hidden="true" /></span>
                    <span className="gx-stage-card-desc">{card.desc}</span>
                    <span className="gx-stage-chips">{cardChips(card, facts).map((chip, i) => <span className="gx-chip gx-chip--static" key={chip + i}>{chip}</span>)}</span>
                    <span className="gx-stage-card-foot" data-state={s}>{cardFooter(card, s)}{opens ? <span aria-hidden="true"> ›</span> : null}</span>
                  </>
                );
                return opens ? (
                  <button key={card.name} type="button" className="gx-stage-card" data-card={card.name} data-tool={card.tool} aria-current={picked === card.name ? "true" : undefined} title={`Open ${spec.tools.find((t) => t.id === card.tool)?.label ?? ""}`} onClick={() => open(card.name, card.tool!)}>{body}</button>
                ) : (
                  <div key={card.name} className="gx-stage-card" data-card={card.name}>{body}</div>
                );
              })}
            </div>
          </section>
        );
      })}
      {tool ? (
        <section className="gx-stage-work" ref={work} aria-label={`${title} working area`} data-testid="stage-work" data-tool={tool}>
          <div className="gx-stage-group-head">
            <span className="gx-eyebrow">Working area</span>
            {spec.tools.length > 1 ? (
              <div className="gx-seg gx-seg--sm" role="tablist" aria-label={`${title} tools`}>
                {spec.tools.map((t) => (
                  <button key={t.id} type="button" role="tab" className="gx-seg-btn" aria-selected={tool === t.id} onClick={() => { setPicked(null); setTool(t.id); }}><span>{t.label}</span></button>
                ))}
              </div>
            ) : <span className="gx-hint">{spec.tools[0].label}</span>}
          </div>
          <div className="pxw gx-legacy pxw-embed gx-stage-tool">
            <SpecTool page={page} tool={tool} project={project} scope={scope} onProject={setEdited} />
          </div>
        </section>
      ) : null}
    </div>
  );
}
