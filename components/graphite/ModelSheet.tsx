"use client";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { BillingSource, ComposerModel } from "@/lib/workspace/composer";
import { modelChips, pickerSections, rowPrice, type Quoted } from "@/lib/workspace/model-picker";

/**
 * Gen's model sheet: search, Recent, and on every row what the engine does
 * (spec chips) and what it costs (lib/workspace/model-picker.ts › rowPrice),
 * so a model is chosen knowing its price rather than reading it off Generate.
 */
export function ModelSheet({ label, groups, billing, onBilling, offered, recent, selectedId, quoted, empty, loading, onPick, onClose }: {
  /** The listbox's name ("Video models"). */
  label: string;
  /** The catalogues this person may use; one hides the switch. */
  groups: readonly { id: BillingSource; label: string }[];
  billing: BillingSource;
  onBilling: (billing: BillingSource) => void;
  offered: readonly ComposerModel[];
  recent: readonly ComposerModel[];
  selectedId: string | null;
  quoted: Readonly<Record<string, Quoted>>;
  /** Why the list is empty (a refusal, or nothing offered for this output). */
  empty: string;
  /** The list is still being read. */
  loading: boolean;
  onPick: (model: ComposerModel) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const ids = useId();
  const { recent: lead, rest } = useMemo(() => pickerSections(offered, recent, query), [offered, recent, query]);

  /* A pointer keeps typing where it is; a phone keeps its keyboard down until the field is tapped. */
  useEffect(() => {
    if (window.matchMedia?.("(pointer: fine)").matches) search.current?.focus({ preventScroll: true });
    list.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, []);

  const options = () => Array.from(list.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);
  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = options();
    const at = all.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (e.key === "ArrowDown") next = Math.min(all.length - 1, at + 1);
    else if (e.key === "ArrowUp") {
      if (at <= 0) { e.preventDefault(); search.current?.focus(); return; }
      next = at - 1;
    } else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = all.length - 1;
    if (next < 0) return;
    e.preventDefault();
    all[next]?.focus();
  };
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); options()[0]?.focus(); return; }
    if (e.key === "Enter") {
      const first = lead[0] ?? rest[0];
      if (first) { e.preventDefault(); onPick(first); }
    }
  };

  const row = (m: ComposerModel) => {
    const price = rowPrice(m, quoted);
    const chips = modelChips(m);
    return (
      <button key={m.id} type="button" role="option" aria-selected={m.id === selectedId} className="gx-sheet-row gx-sheet-row--spec" data-model={m.id} onClick={() => onPick(m)}>
        <span className="gx-tool-tag" aria-hidden="true">{m.label.slice(0, 2).toUpperCase()}</span>
        <span className="gx-sheet-main">
          <span className="gx-model-name">{m.label}</span>
          {m.description ? <span className="gx-model-sub">{m.description}</span> : null}
          {chips.length ? (
            <span className="gx-sheet-specs" data-testid="gen-sheet-facts">
              {chips.map((c) => <span key={c.key} className="gx-spec" data-spec={c.key} title={c.title}>{c.text}</span>)}
            </span>
          ) : null}
        </span>
        <span className="gx-sheet-price" data-testid="gen-sheet-price" data-kind={price.kind} title={price.title}>
          {price.credits != null ? <b>{price.credits.toLocaleString("en-US")} cr</b> : null}
          <span>{price.detail}</span>
        </span>
        <span className="gx-sheet-tick" aria-hidden="true">{m.id === selectedId ? "✓" : ""}</span>
      </button>
    );
  };

  return (
    <div className="gx-sheet gx-sheet--models" role="dialog" aria-modal="true" aria-label="Choose a model" onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
      <div className="gx-sheet-head">
        <span className="gx-panel-title">Model</span>
        {groups.length > 1 ? (
          <div className="gx-seg gx-seg--sm" role="tablist" aria-label="Catalogue">
            {groups.map((g) => <button key={g.id} type="button" role="tab" className="gx-seg-btn" aria-selected={billing === g.id} onClick={() => { setQuery(""); onBilling(g.id); }}><span>{g.label}</span></button>)}
          </div>
        ) : <span className="gx-spacer" />}
        <button type="button" className="gx-hbtn" onClick={onClose}>Close</button>
        <div className="gx-sheet-find">
          <input ref={search} type="search" className="gx-field" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onSearchKey}
            placeholder={offered.length ? `Search ${offered.length} ${offered.length === 1 ? "model" : "models"}` : "Search models"} aria-label="Search models"
            aria-controls={`${ids}-list`} autoComplete="off" spellCheck={false} enterKeyHint="go" data-testid="gen-model-search" />
        </div>
      </div>
      {lead.length || rest.length ? (
        <div ref={list} id={`${ids}-list`} className="gx-sheet-list gx-scroll" role="listbox" aria-label={label} onKeyDown={onListKey}>
          {lead.length ? (
            <div role="group" aria-labelledby={`${ids}-recent`} className="gx-sheet-group" data-testid="gen-model-recent">
              <span id={`${ids}-recent`} className="gx-sheet-group-label" data-functional-label="">Recent</span>
              {lead.map(row)}
            </div>
          ) : null}
          <div role="group" aria-labelledby={lead.length ? `${ids}-all` : undefined} aria-label={lead.length ? undefined : label} className="gx-sheet-group" data-testid="gen-model-all">
            {lead.length ? <span id={`${ids}-all`} className="gx-sheet-group-label" data-functional-label="">All models</span> : null}
            {rest.map(row)}
          </div>
        </div>
      ) : (
        <div id={`${ids}-list`} className="gx-sheet-list gx-scroll">
          {!offered.length && loading ? (
            <div className="gx-sheet-loading" role="status" aria-busy="true" data-testid="gen-model-loading">
              {[0, 1, 2].map((i) => <span key={i} className="gx-sheet-skel" aria-hidden="true" />)}
              <span className="gx-empty">{empty}</span>
            </div>
          ) : !offered.length ? (
            <p className="gx-empty" role="status" data-testid="gen-model-empty">{empty}</p>
          ) : (
            <p className="gx-empty gx-sheet-none" role="status" data-testid="gen-model-none">
              <span>No model matches “{query.trim()}”.</span>
              <button type="button" className="gx-hbtn" onClick={() => { setQuery(""); search.current?.focus(); }}>Clear search</button>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
