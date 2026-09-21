"use client";
import { useMemo, useState } from "react";
import LazyMedia from "@/components/LazyMedia";
import { libraryCount, libraryFor } from "@/lib/workspace/pages";
import { useWorkspace } from "@/lib/workspace/state";
import type { LibraryEntry } from "@/lib/workspace/library";
import { useShell } from "@/lib/shell/state";

export type AssetFilter = "All" | "Images" | "Video" | "Audio" | "Uploads";
const FILTERS: AssetFilter[] = ["All", "Images", "Video", "Audio", "Uploads"];
/** A render is NEW for ten minutes after it lands. */
const FRESH_MS = 10 * 60_000;

export function tagOf(name: string) {
  return name.split(/[\s/]+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "··";
}

export function filterAssets(items: LibraryEntry[], filter: AssetFilter, query: string): LibraryEntry[] {
  const q = query.trim().toLowerCase();
  return items.filter((item) => {
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
export function Library({ items, ready, overlay, now }: { items: LibraryEntry[]; ready: boolean; overlay: boolean; now: number }) {
  const shell = useShell();
  const { state, dispatch } = useWorkspace();
  const [filter, setFilter] = useState<AssetFilter>("All");
  const [query, setQuery] = useState("");
  const groups = libraryFor(shell.page.legacy.page);
  const tools = libraryCount(groups);
  const shown = useMemo(() => filterAssets(items, filter, query), [items, filter, query]);
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
{shell.view === "gen" ? null : (
            <div className="gx-seg gx-seg--fill" role="tablist" aria-label="Library view">
        {(["tools", "assets"] as const).map((tab) => (
          <button key={tab} type="button" role="tab" className="gx-seg-btn" aria-selected={shell.libTab === tab} onClick={() => shell.setLibTab(tab)}>
            <span>{tab === "tools" ? "Tools" : "Assets"}</span>
            <span className="gx-seg-count">{(tab === "tools" ? tools : items.length).toLocaleString("en-US")}</span>
          </button>
        ))}
      </div>
      )}
      {shell.libTab === "tools" ? (
        <div className="gx-tools gx-scroll">
          {groups.length ? groups.map((group) => (
            <div className="gx-tool-group" key={group.title}>
              <div className="gx-tool-group-head"><span className="gx-eyebrow">{group.title}</span><span className="gx-eyebrow">{group.items.length}</span></div>
              {group.items.map((item) => (
                <button key={item.name} type="button" className="gx-tool" data-tool={item.name}
                  onClick={() => { dispatch({ type: "patch", patch: { selKind: "page", selId: state.page } }); shell.openInspector(); }}>
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
            {FILTERS.map((f) => <button key={f} type="button" className="gx-chip" aria-pressed={filter === f} onClick={() => setFilter(f)}>{f}</button>)}
          </div>
          <div className="gx-assets gx-scroll" data-testid="library-assets">
            {shown.map((entry) => {
              const fresh = entry.take.kind === "GEN" && now - entry.take.createdAt < FRESH_MS;
              return (
                <div className="gx-asset" key={entry.take.id} data-selected={state.selKind === "take" && state.selId === entry.take.id}>
                  <button type="button" className="gx-asset-thumb" title={entry.take.name} draggable data-ctx={`asset:${entry.take.id}`}
                    onDragStart={(e) => { e.dataTransfer.setData("text/plain", entry.take.id); e.dataTransfer.effectAllowed = "copy"; }}
                    onClick={() => open(entry)}>
                    {entry.url && (entry.media === "image" || entry.media === "video") ? <LazyMedia url={entry.url} kind={entry.media} alt="" /> : null}
                    <span className="gx-badge">{entry.media === "video" ? "VIDEO" : entry.media === "audio" ? "AUDIO" : entry.media === "image" ? "IMAGE" : "FILE"}</span>
                    {fresh ? <span className="gx-badge gx-badge--new">NEW</span> : null}
                  </button>
                  <div className="gx-asset-row">
                    <span className="gx-asset-name">{entry.take.name}</span>
                    {/* `+` sends the asset into Gen as a reference. The composer that accepts one is build step 2; until it lands the button says so rather than doing something else. */}
                    <button type="button" className="gx-asset-add" aria-label={`Use ${entry.take.name} as reference`} title="Use as reference — arrives with the new Gen composer" disabled>+</button>
                  </div>
                </div>
              );
            })}
            {!shown.length ? <p className="gx-empty" style={{ gridColumn: "1 / -1" }}>{!ready ? "Reading this project…" : items.length ? "Nothing matches." : "Nothing made or uploaded in this project yet."}</p> : null}
          </div>
          <p className="gx-lib-foot">Everything this project has made or uploaded, on every page.</p>
        </>
      )}
    </aside>
  );
}
