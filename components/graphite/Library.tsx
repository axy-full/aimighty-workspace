"use client";
import { useMemo, useState } from "react";
import { PRODUCTION_TOOLS, focusSection, libraryHasTools, openSpecCard } from "@/lib/shell/production-tools";
import LazyMedia from "@/components/LazyMedia";
import { entryPreview, previewAttrs } from "@/lib/preview";
import { libraryCount, libraryFor } from "@/lib/workspace/pages";
import { useWorkspace } from "@/lib/workspace/state";
import { useProjectLibrary, type LibraryEntry } from "@/lib/workspace/library";
import { useSession } from "@/lib/session";
import { LibraryMore } from "./LibraryMore";
import type { Project } from "@/lib/workbench/studio";
import { usePublishedProject } from "@/lib/workspace/spec-store";
import { useShell } from "@/lib/shell/state";
import { DEPT_COLORS, Glyph, KIND_DOT } from "./icons";
import { VirtualItems } from "@/components/workspace/VirtualItems";

export type AssetFilter = "All" | "Images" | "Video" | "Audio" | "Uploads" | "Cast" | "Elements";
const FILTERS: AssetFilter[] = ["All", "Images", "Video", "Audio", "Uploads", "Cast", "Elements"];
/** A render is NEW for ten minutes after it lands. */
const FRESH_MS = 10 * 60_000;

export function tagOf(name: string) {
  return name.split(/[\s/]+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "··";
}

const ELEMENT_CATEGORIES = new Set(["Element", "Environment", "Prop", "Look"]);
/** Which library entries the project files as Cast or Elements, by the asset category it gave them. */
export function castCategories(project: Project | null): Map<string, "Cast" | "Elements"> {
  const out = new Map<string, "Cast" | "Elements">();
  for (const asset of project?.assets ?? []) {
    const kind = asset.category === "Character" ? "Cast" : ELEMENT_CATEGORIES.has(asset.category) ? "Elements" : null;
    if (!kind) continue;
    for (const id of [asset.id, asset.generationId, asset.uploadId]) if (id) out.set(id, kind);
  }
  return out;
}

export function filterAssets(items: LibraryEntry[], filter: AssetFilter, query: string, filed: Map<string, "Cast" | "Elements"> = new Map()): LibraryEntry[] {
  const q = query.trim().toLowerCase();
  return items.filter((item) => {
    if ((filter === "Cast" || filter === "Elements") && filed.get(item.take.sourceId) !== filter) return false;
    if (filter === "Images" && item.media !== "image") return false;
    if (filter === "Video" && item.media !== "video") return false;
    if (filter === "Audio" && item.media !== "audio") return false;
    if (filter === "Uploads" && item.take.kind !== "UPLOAD") return false;
    return !q || item.take.name.toLowerCase().includes(q);
  });
}

/**
 * Left, 280px (an overlay below 1280). Tools = the page's cards, each a
 * button; Assets = everything the project has made or uploaded, on every
 * page, every tile draggable (`text/plain` = asset id).
 */
export function Library({ project = null, items, ready, error = null, onRetry, overlay, now, onUseAsReference, cutId }: { project?: Project | null; items: LibraryEntry[]; ready: boolean; error?: string | null; onRetry?: () => void; overlay: boolean; now: number; onUseAsReference: (id: string) => void; cutId: string | null }) {
  const shell = useShell();
  const { state, dispatch } = useWorkspace();
  const [filter, setFilter] = useState<AssetFilter>("All");
  const [query, setQuery] = useState("");
  const production = shell.view === "suite" && shell.suite.id === "studio" ? PRODUCTION_TOOLS[shell.page.id] : undefined;
  const groups = production ? production.map((group) => ({ title: group.title, items: group.items })) : libraryFor(shell.page.legacy.page);
  const tools = libraryCount(groups);
  /* A Production stage's live draft files new Cast and Elements before the shell's copy is re-read. */
  const live = usePublishedProject();
  const source = live && project && live.id === project.id ? live : project;
  const filed = useMemo(() => castCategories(source), [source]);
  const shown = useMemo(() => filterAssets(items, filter, query, filed), [items, filter, query, filed]);
  /* The shell's own library store (one per scope and project): its next page, and a later read that failed. */
  const library = useProjectLibrary(useSession().requestScope ?? "", project?.id ?? null);
  const open = (entry: LibraryEntry) => {
    dispatch({ type: "patch", patch: { selKind: "take", selId: entry.take.id } });
    shell.openInspector();
  };
  return (
    <aside className={`gx-panel gx-library${overlay ? " gx-panel--overlay" : ""}`} aria-label="Library" data-testid="library">
      <div className="gx-panel-head">
        <span className="gx-panel-title">Library</span>
        <span className="gx-panel-count">{shell.libTab === "tools" ? `${tools.toLocaleString("en-US")} ${tools === 1 ? "tool" : "tools"}` : `${items.length.toLocaleString("en-US")} ${items.length === 1 ? "asset" : "assets"}`}</span>
        {overlay ? <button type="button" className="gx-hbtn gx-panel-close" onClick={shell.closePanels} data-testid="close-library">Close</button> : null}
      </div>
{!libraryHasTools(shell.view, shell.suite.id, shell.page.id) ? null : (
            <div className="gx-seg gx-seg--fill" role="tablist" aria-label="Library view">
        {(["tools", "assets"] as const).map((tab) => (
          <button key={tab} type="button" role="tab" className="gx-seg-btn" aria-selected={shell.libTab === tab} onClick={() => shell.setLibTab(tab)}>
            <Glyph name={tab === "tools" ? "wrench" : "stack"} size={13} className="gx-glyph" />
            <span>{tab === "tools" ? "Tools" : "Assets"}</span>
            <span className="gx-seg-count">{(tab === "tools" ? tools : items.length).toLocaleString("en-US")}</span>
          </button>
        ))}
      </div>
      )}
      {shell.libTab === "tools" ? (
        <div className="gx-tools gx-scroll">
          {groups.length ? groups.map((group, gi) => (
            <div className="gx-tool-group" key={group.title} style={{ "--dept": DEPT_COLORS[gi % DEPT_COLORS.length] } as React.CSSProperties} data-testid="tool-group">
              <div className="gx-tool-group-head"><span className="gx-eyebrow">{group.title}</span><span className="gx-eyebrow">{group.items.length}</span></div>
              {group.items.map((item) => (
                <button key={item.name} type="button" className="gx-tool" data-tool={item.name}
                  onClick={() => {
                    const section = "section" in item ? (item as { section: string }).section : null;
                    if (section) { if (overlay) shell.closePanels(); if (["prompt", "inputs", "versions"].includes(section) && shell.page.id === "rig") shell.openInspector(); focusSection(section); return; }
                    /* A card with a tool opens that tool on the page; a plan card's action is the page's plan, in the Inspector. */
                    if (openSpecCard(item.name)) { if (overlay) shell.closePanels(); return; }
                    dispatch({ type: "patch", patch: { selKind: "page", selId: state.page } }); shell.openInspector();
                  }}>
                  <span className="gx-tool-tag" aria-hidden="true">{tagOf(item.name)}</span>
                  <span className="gx-tool-text"><span className="gx-tool-name">{item.name}</span><span className="gx-tool-sub">{item.sub}</span></span>
                </button>
              ))}
            </div>
          )) : <p className="gx-empty">This page has no tools of its own. Assets are on the next tab.</p>}
        </div>
      ) : (
        <>
          <input className="gx-field" aria-label="Search assets" placeholder="Search this project" value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="gx-chips" role="group" aria-label="Asset kind">
            {FILTERS.map((f) => <button key={f} type="button" className="gx-chip" data-kind={f} style={{ "--kind": KIND_DOT[f] } as React.CSSProperties} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f}</button>)}
          </div>
          <VirtualItems
            className="gx-assets gx-scroll" attrs={{ "data-testid": "library-assets" }}
            items={shown} getKey={(entry) => entry.take.id} layout={{ columns: 2 }} gap={10} estimateRowHeight={130} scroll="self"
            after={<>
              {!shown.length ? (error && !ready
                ? <div className="gx-empty" role="alert" style={{ gridColumn: "1 / -1" }} data-testid="library-error"><p className="gx-gen-error">{error}</p>{onRetry ? <button type="button" className="gx-hbtn" onClick={onRetry}>Retry</button> : null}</div>
                : <p className="gx-empty" style={{ gridColumn: "1 / -1" }}>{!ready ? "Reading this project…" : items.length ? "Nothing matches." : "Nothing made or uploaded in this project yet."}</p>) : null}
              {/* Past the first page: a later read that failed, and Load more (the first read's failure is said above). */}
              {project && !(error && !ready) ? <LibraryMore library={library} /> : null}
            </>}
            renderItem={(entry) => {
              const fresh = entry.take.kind === "GEN" && now - entry.take.createdAt < FRESH_MS;
              return (
                <div className="gx-asset" key={entry.take.id} data-selected={state.selKind === "take" && state.selId === entry.take.id} data-cut={cutId === entry.take.id || undefined} data-asset={entry.take.id}>
                  <button type="button" className="gx-asset-thumb" title={entry.take.name} draggable data-ctx={`asset:${entry.take.id}`} {...previewAttrs(entryPreview(entry))}
                    onDragStart={(e) => { e.dataTransfer.setData("text/plain", entry.take.id); e.dataTransfer.effectAllowed = "copyMove"; }}
                    onClick={() => open(entry)}>
                    {entry.url && (entry.media === "image" || entry.media === "video") ? <LazyMedia url={entry.url} kind={entry.media} alt="" name={entry.take.name} /> : null}
                    <span className="gx-badge">{entry.media === "video" ? "VIDEO" : entry.media === "audio" ? "AUDIO" : entry.media === "image" ? "IMAGE" : "FILE"}</span>
                    {fresh ? <span className="gx-badge gx-badge--new">NEW</span> : null}
                  </button>
                  <div className="gx-asset-row">
                    <span className="gx-asset-name">{entry.take.name}</span>
                    {/* `+` sends the asset into the composer as a reference; the toast names the role. */}
                    <button type="button" className="gx-asset-add" aria-label={`Use ${entry.take.name} as reference`} title={entry.media === "image" || entry.media === "video" ? "Use as reference" : "References are images and videos."}
                      disabled={!(entry.media === "image" || entry.media === "video")} onClick={() => onUseAsReference(entry.take.id)}>+</button>
                  </div>
                </div>
              );
            }}
          />
          <p className="gx-lib-foot">Everything this project has made or uploaded, on every page.</p>
        </>
      )}
    </aside>
  );
}
