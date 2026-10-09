"use client";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useShell } from "@/lib/shell/state";
import { writeAssetDrag } from "@/lib/drop";
import type { Project } from "@/lib/workbench/studio";
import type { ProjectLibrary } from "@/lib/workspace/library";
import type { ProjectSummary } from "@/lib/workspace/data";
import { STUB_KINDS, castKindsOf, TRAY_HINT, TRAY_KINDS, TRAY_SOURCES, filterTray, masonry, trayItems, type CastKind, type TrayItem } from "@/lib/v12/library";
import { requestMention } from "@/lib/v12/mention";
import { inField, useTrayLibrary, useTrayState } from "@/lib/v12/useLibraryTray";
import { Kbd, Menu, Segment, Tooltip, useOverlay, type MenuItem } from "@/components/v12/ui";
import "./library.css";

/**
 * The Library tray (docs/redesign/inventory.md § 5.10; prototype `?view=board&drawer=Library`): 360 px from the left,
 * under the header, opened by the bottom-left "Library L" button or the L key, closed by L, × or Esc (last in the Esc
 * order). It replaces today's board Library drawer for a workspace with the new interface on.
 *
 * What is wired and what is a stub (lib/v12/library.ts has where each part's data comes from):
 *  - Search: the library route's own `q`, on the server, scoped to this workspace and the board browsed.
 *  - The library picker (the prototype's brand button): there is no brand in the Library today; each board has its own
 *    library, so the picker chooses which board's library to browse.
 *  - Uploaded / Generated: where each item lives. Kinds: Characters, Locations and Props from the open board's cards;
 *    Everything made; Products and Mandatories are stubs (no such kind exists yet).
 *  - Drag: the one asset payload every drop target reads (lib/drop.ts), so a tile drops on the board's canvas, on a
 *    shot, and on Make, as today's drawer's tiles do.
 *  - Click: hands the tile to the bar as an @mention (lib/v12/mention.ts). Until the new bar listens, a click selects
 *    the take, as a click on today's Library tile does.
 *  - Expand: Make's Recent, today's library wall (there is no Library page).
 */
export function LibraryTray({ project, projects, library }: { project: Project | null; projects: readonly ProjectSummary[]; library: ProjectLibrary }) {
  const shell = useShell();
  const tray = useTrayState();
  const button = useRef<HTMLButtonElement>(null);
  const onBoard = shell.screen === "board" || shell.screen === "board-ads" || shell.screen === "board-social";

  /* L toggles the tray, anywhere in the new frame, never while typing; it runs before the board's own keys. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || inField(event.target)) return;
      if (event.key.toLowerCase() !== "l") return;
      event.preventDefault();
      tray.setOpen((was) => !was);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [tray]);
  useOverlay("drawer", tray.open, () => tray.setOpen(false));

  return (
    <>
      {tray.open ? <Tray project={project} projects={projects} library={library} tray={tray} onBoard={onBoard} onClose={() => { tray.setOpen(false); button.current?.focus(); }} /> : null}
      {shell.make ? null : (
        <Tooltip name="Library" shortcut="L" side="top">
          <button ref={button} type="button" className="v12-lib-btn" data-open={tray.open || undefined} aria-pressed={tray.open} aria-label="Library"
            data-testid="v12-library-button" onClick={() => tray.setOpen((was) => !was)}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 3h12v10H2zM2 7h12M6 7v6" /></svg>
            Library<Kbd keys="L" />
          </button>
        </Tooltip>
      )}
    </>
  );
}

type TrayControl = ReturnType<typeof useTrayState>;

function Tray({ project, projects, library, tray, onBoard, onClose }: {
  project: Project | null; projects: readonly ProjectSummary[]; library: ProjectLibrary; tray: TrayControl; onBoard: boolean; onClose: () => void;
}) {
  const shell = useShell();
  const [query, setQuery] = useState("");
  const [browsing, setBrowsing] = useState<string | null>(project?.id ?? null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const picker = useRef<HTMLButtonElement>(null);
  /* The open board, until another is picked. */
  const libraryOf = browsing ?? project?.id ?? null;
  const read = useTrayLibrary(libraryOf, query, {
    projectId: project?.id ?? null, entries: library.items, status: library.state.status, error: library.state.error, retry: () => void library.refresh(),
  });
  /* Characters, Locations and Props: what the open board's reference cards say their files are. */
  const castKinds = useMemo(() => (project && libraryOf === project.id ? castKindsOf(project) : new Map<string, CastKind>()), [project, libraryOf]);
  const items = useMemo(() => trayItems(read.entries, (id) => castKinds.get(id) ?? null), [read.entries, castKinds]);
  const shown = filterTray(items, tray.source, tray.kind);
  const columns = masonry(shown);
  const browsingName = projects.find((p) => p.id === libraryOf)?.name ?? project?.name ?? "This board";
  const pickItems: MenuItem[] = projects.map((p) => ({ id: p.id, label: p.id === libraryOf ? `${p.name} ✓` : p.name, onSelect: () => setBrowsing(p.id) }));

  const pick = (item: TrayItem) => {
    if (!requestMention({ id: item.id, name: item.name })) shell.selectAsset(item.id, { reason: "pick" });
  };
  const drag = (event: DragEvent, item: TrayItem) => writeAssetDrag(event.dataTransfer, item.id, { name: item.name, url: item.url ?? undefined, kind: item.media ?? undefined });

  return (
    <aside className="v12-lib" data-on-board={onBoard || undefined} aria-label="Library" data-testid="v12-library">
      <div className="v12-lib-head">
        <strong className="v12-lib-title">Library</strong>
        <span className="v12-lib-head-acts">
          <Tooltip name="Expand" line="Open the full Library page">
            <button type="button" className="v12-lib-expand" onClick={() => shell.openMake("recent")} data-testid="v12-library-expand">Expand</button>
          </Tooltip>
          <Tooltip name="Close" shortcut="L">
            <button type="button" className="v12-lib-close" aria-label="Close the Library" onClick={onClose} data-testid="v12-library-close">×</button>
          </Tooltip>
        </span>
      </div>
      <div className="v12-lib-search">
        <input aria-label="Search the library" placeholder="Search the library" value={query} onChange={(e) => setQuery(e.target.value)} className="v12-lib-input" data-testid="v12-library-search" />
        <Tooltip name="Library" line="The board whose library you are browsing.">
          <button ref={picker} type="button" className="v12-lib-brand" aria-haspopup="menu" aria-expanded={pickerOpen} onClick={() => setPickerOpen((v) => !v)} data-testid="v12-library-picker">
            <span className="v12-lib-brand-name">{browsingName}</span> ▾
          </button>
        </Tooltip>
        <Menu open={pickerOpen} onClose={() => setPickerOpen(false)} anchor={picker} label="Browse a board's library" items={pickItems} align="start" width={240} />
      </div>
      <div className="v12-lib-seg">
        <Segment label="Source" size="sm" value={tray.source} onChange={tray.setSource}
          options={TRAY_SOURCES.map((id) => ({ id, label: id, tooltip: id === "Uploaded" ? { name: "Uploaded", line: "A real file you added" } : id === "Generated" ? { name: "Generated", line: "Made in Particl" } : undefined }))} />
      </div>
      <div className="v12-lib-chips" role="group" aria-label="Kind">
        {TRAY_KINDS.map((kind) => (
          <button key={kind} type="button" className="v12-lib-chip" aria-pressed={tray.kind === kind} onClick={() => tray.setKind(kind)} data-testid="v12-library-kind">{kind}</button>
        ))}
      </div>
      <div className="v12-lib-grid" data-testid="v12-library-grid">
        {read.status === "error" ? (
          <p className="v12-lib-empty" role="alert">{read.error ?? "The Library could not be read."} <button type="button" className="v12-lib-link" onClick={read.retry}>Try again</button></p>
        ) : read.status === "loading" ? (
          <p className="v12-lib-empty">Reading the Library…</p>
        ) : STUB_KINDS.includes(tray.kind) ? (
          <p className="v12-lib-empty" data-testid="v12-library-stub">{tray.kind} are not a kind in the Library yet.</p>
        ) : !shown.length ? (
          <p className="v12-lib-empty">{query.trim() ? `Nothing in ${browsingName} matches “${query.trim()}”.` : items.length ? "Nothing here with these filters." : "Nothing in this library yet."}</p>
        ) : (
          <div className="v12-lib-cols">
            {columns.map((col, c) => (
              <div key={c} className="v12-lib-col">
                {col.map((item) => (
                  <Tooltip key={item.id} name={`${item.name} · ${item.kindLine}`} line="Drag onto the board, the bar or a board tile; click to @mention it." side="right">
                    <button type="button" className="v12-lib-tile" draggable onDragStart={(e) => drag(e, item)} onClick={() => pick(item)}
                      data-testid="v12-library-tile" data-source={item.source} data-id={item.id}>
                      <span className="v12-lib-pic" style={{ aspectRatio: item.aspect }}>
                        {item.url && item.media === "image" ? (
                          /* eslint-disable-next-line @next/next/no-img-element */
                          <img src={item.url} alt="" loading="lazy" decoding="async" draggable={false} />
                        ) : item.url && item.media === "video" ? (
                          <video src={`${item.url}#t=0.1`} muted playsInline preload="metadata" />
                        ) : <span className="v12-lib-glyph" aria-hidden="true">{item.media === "audio" ? "♪" : "▤"}</span>}
                        <span className="v12-lib-badge" data-source={item.source} title={item.source === "Uploaded" ? "Uploaded — a real file you added" : "Generated — made in Particl"}
                          aria-label={item.source}>{item.source === "Uploaded" ? "↑" : "✦"}</span>
                      </span>
                      <span className="v12-lib-cap">
                        <span className="v12-lib-name">{item.name}</span>
                        <span className="v12-lib-kind">{item.kindLine}</span>
                      </span>
                    </button>
                  </Tooltip>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="v12-lib-hint">{onBoard ? TRAY_HINT.board : TRAY_HINT.other}</div>
    </aside>
  );
}
