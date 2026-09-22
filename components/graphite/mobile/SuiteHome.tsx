"use client";
import { useEffect, useState } from "react";
import { displayModelName } from "@/lib/models";
import { AD_MODES, INITIAL_ADS } from "@/lib/shell/business";
import { useShell } from "@/lib/shell/state";
import { assetsRowLabel, stageCards, suiteTiles } from "@/lib/shell/studio-home";
import { INITIAL_VIRAL } from "@/lib/shell/viral";
import { useScopedFetch } from "@/lib/useScopedFetch";
import type { Project } from "@/lib/workbench/studio";
import type { LibraryEntry } from "@/lib/workspace/library";
import { useWorkspace } from "@/lib/workspace/state";
import { Glyph, SUITE_LOOK } from "../icons";

const VIDEO_ENGINE = "dreamina-seedance-2-5-260628";

/**
 * The phone's Home (GLASS_SPEC §3 › "Where to?"): the project's name as the
 * eyebrow, the display title, six suite tiles with a live fact each, and one
 * Assets row. Nothing else — the stage grid lives behind the Studio tile,
 * the takes behind Assets. Every figure is the project's own.
 */
export function SuiteHome({ project, items }: { project: Project | null; items: LibraryEntry[] }) {
  const shell = useShell();
  const { state } = useWorkspace();
  const scoped = useScopedFetch();
  /* The roster is one free read per project; the count is keyed to the project it answered for. */
  const [roster, setRoster] = useState<{ projectId: string; seats: number } | null>(null);
  const projectId = project?.id ?? null;
  useEffect(() => {
    if (!projectId) return;
    let live = true;
    scoped(`/api/crew/members?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((json: { members?: unknown[] } | null) => { if (live) setRoster({ projectId, seats: Array.isArray(json?.members) ? json.members.length : 0 }); })
      .catch(() => { if (live) setRoster({ projectId, seats: 0 }); });
    return () => { live = false; };
  }, [projectId, scoped]);
  const seats = roster && roster.projectId === projectId ? roster.seats : null;
  const tiles = suiteTiles(stageCards(project, items), {
    rendering: state.gen ? 1 : 0,
    videoEngine: displayModelName(VIDEO_ENGINE),
    adMode: AD_MODES.find(([id]) => id === INITIAL_ADS.mode)?.[1] ?? "UGC",
    adSeconds: INITIAL_ADS.duration,
    viralResolution: INITIAL_VIRAL.resolution,
    awaiting: state.run && state.run.status === "waiting" && !state.run.approved ? 1 : 0,
    seats,
  });
  const go = (id: (typeof tiles)[number]["id"]) => {
    if (id === "studio") shell.goSuite("studio", "stages");
    else if (id === "gen") shell.goGen();
    else if (id === "crew") shell.goCrew();
    else shell.goSuite(id);
  };
  return (
    <div className="gx-where gx-enter" data-testid="suite-home">
      <span className="gx-home-eyebrow" data-testid="home-project">{project?.name ?? "No project"}</span>
      <h1 className="gx-h1 gx-where-title" data-testid="page-title">Where to?</h1>
      <div className="gx-where-grid" role="list" aria-label="Suites">
        {tiles.map((t) => (
          <button key={t.id} type="button" role="listitem" className="gx-where-tile" style={{ "--tile": t.color } as React.CSSProperties} onClick={() => go(t.id)} data-testid={`home-suite-${t.id}`}>
            <span className="gx-where-glow" aria-hidden="true" />
            <span className="gx-where-ic" aria-hidden="true"><Glyph name={SUITE_LOOK[t.id]?.glyph ?? "spark"} size={22} /></span>
            <span className="gx-where-name">{t.label}</span>
            <span className="gx-where-line">{t.line}</span>
            <span className="gx-where-fact gx-mono" data-testid={`home-fact-${t.id}`}>{t.fact}</span>
          </button>
        ))}
      </div>
      <button type="button" className="gx-where-assets" onClick={() => shell.openLibrary("assets")} data-testid="home-assets">
        <Glyph name="stack" size={18} className="gx-glyph" />
        <span className="gx-where-assets-name">Assets</span>
        <span className="gx-where-assets-n">{assetsRowLabel(items, project?.name ?? null)}</span>
        <Glyph name="chev" size={16} className="gx-glyph" />
      </button>
    </div>
  );
}
