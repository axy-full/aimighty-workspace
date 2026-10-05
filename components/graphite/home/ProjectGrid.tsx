"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import LazyMedia from "@/components/LazyMedia";
import type { ProjectSummary } from "@/lib/workspace/data";
import { LoadBanner } from "../TakeTile";
import { posterOf } from "../icons";
import { isStarterDraft, shownProjects } from "./home-model";
import { SAMPLE_BADGE, SAMPLE_ENTRY_ON, SAMPLE_LINE, sampleCard } from "./sample";
import { useProjectCards, useProjectCover, type ProjectCardModel } from "./use-project-cards";

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "—";

/** A card's picture: the project's newest take once the card nears the screen, else its swatch (gradients are allowed on swatches, README § 2). */
function Cover({ scope, id, name, children }: { scope: string; id: string | null; name: string; children?: React.ReactNode }) {
  const box = useRef<HTMLSpanElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el || !id) return;
    if (typeof IntersectionObserver === "undefined") { const t = setTimeout(() => setNear(true), 0); return () => clearTimeout(t); }
    const seen = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { setNear(true); seen.disconnect(); } }, { rootMargin: "240px" });
    seen.observe(el);
    return () => seen.disconnect();
  }, [id]);
  const cover = useProjectCover(scope, id ?? "", near && Boolean(id));
  const swatch = posterOf(name);
  return (
    <span className="gx-hm-cover" ref={box} style={cover ? undefined : ({ "--hm-from": swatch.from, "--hm-to": swatch.to } as CSSProperties)} data-cover={cover ? cover.kind : "swatch"}>
      {cover ? <LazyMedia url={cover.url} kind={cover.kind} alt="" name={cover.name} className="gx-lazy" /> : <span className="gx-hm-initials" aria-hidden="true">{initials(name)}</span>}
      {children}
    </span>
  );
}

function ProjectCard({ scope, card, disabled, onOpen }: { scope: string; card: ProjectCardModel; disabled: boolean; onOpen: (id: string) => void }) {
  return (
    <li className="gx-hm-cell">
      <button type="button" className="gx-hm-card" disabled={disabled} onClick={() => onOpen(card.id)} data-testid="home-project" data-project={card.id}>
        <Cover scope={scope} id={card.id} name={card.name} />
        <span className="gx-hm-card-body">
          <span className="gx-hm-card-name">{card.name}</span>
          {card.meta ? <span className="gx-hm-card-meta">{card.meta}</span> : null}
          {card.line ? (
            <span className="gx-hm-needs" data-tone={card.line.tone} data-testid="home-project-needs"><span className="gx-hm-dot" aria-hidden="true" />{card.line.text}</span>
          ) : null}
        </span>
      </button>
    </li>
  );
}

function SampleCard({ scope, projects, disabled, onOpen }: { scope: string; projects: readonly ProjectSummary[]; disabled: boolean; onOpen: () => void }) {
  const sample = sampleCard(projects);
  return (
    <li className="gx-hm-cell">
      <button type="button" className="gx-hm-card" disabled={disabled} onClick={onOpen} data-testid="home-sample">
        <Cover scope={scope} id={sample.id} name={sample.name}>
          <span className="gx-hm-badge">{SAMPLE_BADGE}</span>
        </Cover>
        <span className="gx-hm-card-body">
          <span className="gx-hm-card-name">{sample.name}</span>
          <span className="gx-hm-needs" data-tone="sample"><span className="gx-hm-dot" aria-hidden="true" />{SAMPLE_LINE}</span>
        </span>
      </button>
    </li>
  );
}

/**
 * Your projects (the master's Home): newest first, each card with its picture, when it was edited and
 * what is waiting in it; "+ New project"; the sample production last. With no projects yet, the box and
 * the templates above are the empty state and this section is left out.
 */
export function ProjectGrid({ scope, projects, status, error, onRetry, now, disabled, onOpen, onNew, onSample }: {
  scope: string;
  projects: readonly ProjectSummary[];
  status: "loading" | "ready" | "error";
  error: string | null;
  onRetry: () => void;
  now: number;
  disabled: boolean;
  onOpen: (id: string) => void;
  onNew: () => void;
  onSample: () => void;
}) {
  const [all, setAll] = useState(false);
  const own = SAMPLE_ENTRY_ON ? projects.filter((p) => !isStarterDraft(p.id)) : projects;
  const cards = useProjectCards(own, now);
  const { shown, hidden } = shownProjects(cards, all);
  const loading = status === "loading" && !cards.length;
  if (status === "ready" && !cards.length && !SAMPLE_ENTRY_ON) return null;
  return (
    <section className="gx-hm-section" aria-labelledby="gx-hm-projects" data-testid="home-projects">
      <div className="gx-hm-head">
        <h2 className="gx-hm-eyebrow" id="gx-hm-projects">Your projects</h2>
        <button type="button" className="gx-hm-link" disabled={disabled} onClick={onNew} data-testid="home-new-project">+ New project</button>
      </div>
      {status === "error" ? <LoadBanner banner={{ tone: "error", message: error || "Projects could not be loaded." }} onRetry={onRetry} testId="home-projects-error" /> : null}
      {loading ? (
        <ul className="gx-hm-grid" aria-busy="true" aria-label="Opening your projects">
          {[0, 1, 2].map((i) => <li key={i} className="gx-hm-cell"><span className="gx-hm-card" data-skeleton=""><span className="gx-hm-cover" /><span className="gx-hm-card-body"><span className="gx-hm-bar" /><span className="gx-hm-bar gx-hm-bar--short" /></span></span></li>)}
        </ul>
      ) : shown.length || SAMPLE_ENTRY_ON ? (
        <ul className="gx-hm-grid" aria-label="Your projects">
          {shown.map((card) => <ProjectCard key={card.id} scope={scope} card={card} disabled={disabled} onOpen={onOpen} />)}
          {SAMPLE_ENTRY_ON && status === "ready" ? <SampleCard scope={scope} projects={projects} disabled={disabled} onOpen={onSample} /> : null}
        </ul>
      ) : null}
      {hidden ? (
        <button type="button" className="gx-hm-link gx-hm-more" onClick={() => setAll(true)} data-testid="home-show-all">Show all · {cards.length.toLocaleString("en-US")}</button>
      ) : null}
    </section>
  );
}
