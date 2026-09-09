"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useProject } from "@/lib/projectContext";
import { byScope, SCOPE_LABEL } from "@/lib/shortcuts";
import {
  type Cmd, actionCommands, routeCommands, productionCommands,
  shotCommands, castCommands, takeCommands, search, flatten,
} from "@/lib/palette";

/**
 * ⌘K, and the `?` overlay that makes the rest of the keyboard discoverable.
 *
 * Mounted as a sibling of DialogHost in the app layout, which is the only
 * place that sees both providers and sits outside `.shell` — outside the
 * backdrop-filter containing block that has already broken fixed positioning
 * once in the composer island. The cost of being outside `.shell` is that
 * Shell's `.theme-light` no longer reaches us, so Atomik's paper ground has
 * to be re-applied here by hand. That is the `light` class below; without it
 * the palette renders dark over a white page.
 *
 * MOBILE (SOW §12, which says a surface with no declared mobile behaviour
 * ships broken): there is deliberately no touch entry point. ⌘K presumes a
 * hardware keyboard, and §3 rule 7 puts navigating an index on the desktop
 * side of the line. It still lays out full-bleed at 360px if a keyboard is
 * attached, and it never focuses the field on a touch surface — the iOS
 * keyboard shoving the viewport up is the failure RequestAccess documents.
 *
 * SPENDING: nothing here spends. See lib/palette.ts.
 *
 * The split below is not decoration. This outer component holds only `open`
 * and `help` and the key layer; everything the palette is *doing* — the
 * query, the cursor, the fetched rows — lives in <Palette>, which exists
 * only while it is open. Resetting that state on close is then not something
 * anyone has to remember: it unmounts.
 */

/** A key event that lands in a text field is the user typing, not a shortcut. */
function typing(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable === true;
}

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [help, setHelp] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        // A blocking confirm is a question. Don't open on top of it.
        if (!open && document.querySelector("[data-dialog]")) return;
        setOpen((v) => !v);
        return;
      }
      if (open || help) return;
      if (typing(e.target)) return;           // "?" and "/" are characters first
      if (e.key === "?") { e.preventDefault(); setHelp(true); return; }
      if (e.key === "/") { e.preventDefault(); setOpen(true); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, help]);

  /* Esc, in capture, and only while we are up — so it closes this without
     also reaching the Esc handlers stacked underneath. */
  useEffect(() => {
    if (!open && !help) return;
    function onEsc(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false); setHelp(false);
    }
    document.addEventListener("keydown", onEsc, true);
    return () => document.removeEventListener("keydown", onEsc, true);
  }, [open, help]);

  const toHelp = useCallback(() => { setOpen(false); setHelp(true); }, []);

  return (
    <>
      {open && <Palette onClose={() => setOpen(false)} onHelp={toHelp} />}
      {help && <Help onClose={() => setHelp(false)} />}
    </>
  );
}

/* ---- the palette proper --------------------------------------------- */

type Shot = { id: string; code: string; title: string; projectId?: string | null; scene?: string };
type Cast = { id: string; name: string; kind?: string; description?: string };
type Take = { id: string; prompt?: string; shotCode?: string | null; model?: string };

function Palette({ onClose, onHelp }: { onClose: () => void; onHelp: () => void }) {
  const [q, setQ] = useState("");
  /* The cursor carries the query it belongs to, so a new query resets it by
     being a different query — no effect, nothing to keep in sync. */
  const [cur, setCur] = useState({ q: "", i: 0 });
  const [shots, setShots] = useState<Shot[]>([]);
  const [cast, setCast] = useState<Cast[]>([]);
  const [takes, setTakes] = useState<Take[]>([]);

  const router = useRouter();
  const path = usePathname();
  const { projects, selection, setSelection } = useProject();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const light = path?.startsWith("/atomik") ?? false;

  /* Focus in, focus back out. The nearest thing to a focus trap this repo
     has: there is exactly one focusable inside, so holding focus on it is
     the trap. */
  useEffect(() => {
    const restoreTo = document.activeElement as HTMLElement | null;
    const touch = typeof matchMedia !== "undefined" && matchMedia("(hover: none)").matches;
    if (!touch) inputRef.current?.focus();
    return () => { try { restoreTo?.focus(); } catch { /* gone */ } };
  }, []);

  /* What is in the workspace. Fetched on open, once per production, and
     scoped by withTenant + requireUser on the server — a signed-out visitor
     gets 401s here and a palette of routes, which is the right amount. */
  useEffect(() => {
    let dead = false;
    const p = selection && selection !== "all" && selection !== "unfiled"
      ? `?projectId=${encodeURIComponent(selection)}` : "";
    (async () => {
      const [s, c] = await Promise.all([
        fetch(`/api/shots${p}`).then((r) => (r.ok ? r.json() : { shots: [] })).catch(() => ({ shots: [] })),
        fetch(`/api/cast${p}`).then((r) => (r.ok ? r.json() : { cast: [] })).catch(() => ({ cast: [] })),
      ]);
      if (dead) return;
      setShots(s.shots ?? []); setCast(c.cast ?? []);
    })();
    return () => { dead = true; };
  }, [selection]);

  /* Takes are the one thing the server searches (`q` on /api/jobs is the only
     server-side search parameter in the API), so they are fetched per query
     rather than held in memory. Debounced, and the previous flight aborted:
     without that a slow early keystroke lands after a fast later one and the
     list shows results for a query the field no longer contains. */
  const needle = q.trim();
  useEffect(() => {
    if (needle.length < 2) return;
    const ac = new AbortController();
    const t = setTimeout(() => {
      fetch(`/api/jobs?q=${encodeURIComponent(needle)}&limit=8&sync=0`, { signal: ac.signal })
        .then((r) => (r.ok ? r.json() : { generations: [] }))
        .then((d) => setTakes(d.generations ?? []))
        .catch(() => { /* aborted or offline */ });
    }, 180);
    return () => { clearTimeout(t); ac.abort(); };
  }, [needle]);

  const nameOf = useCallback(
    (id: string | null | undefined) => projects.find((p) => p.id === id)?.name,
    [projects],
  );

  const all = useMemo<Cmd[]>(() => [
    ...actionCommands(), ...routeCommands(), ...productionCommands(projects),
    ...shotCommands(shots, nameOf), ...castCommands(cast),
    /* Held takes are for the query that fetched them. Showing the previous
       query's while a new one is in flight is worse than showing none. */
    ...takeCommands(needle.length < 2 ? [] : takes),
  ], [projects, shots, cast, takes, needle, nameOf]);

  const groups = useMemo(() => search(all, q), [all, q]);
  const rows = useMemo(() => flatten(groups), [groups]);
  const at = cur.q === q ? Math.min(cur.i, Math.max(0, rows.length - 1)) : 0;

  const run = useCallback((cmd: Cmd) => {
    if (cmd.act === "help") { onHelp(); return; }
    if (cmd.act === "select" && cmd.arg) setSelection(cmd.arg);
    onClose();
    if (cmd.href) router.push(cmd.href);
  }, [router, setSelection, onClose, onHelp]);

  function move(d: number) {
    setCur({ q, i: Math.max(0, Math.min(at + d, rows.length - 1)) });
  }

  function onFieldKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Enter") { e.preventDefault(); if (rows[at]) run(rows[at]); }
    else if (e.key === "Tab") { e.preventDefault(); }
  }

  /* Keep the cursor visible without scrolling the page behind us.
     At the top of the list, scroll to the top rather than to the row: the
     first row sits under its section heading, and scrolling it into view
     put "Actions" above the fold on every open — the list then looked like
     it began with an unlabelled row. */
  useEffect(() => {
    if (at === 0) { listRef.current?.scrollTo({ top: 0 }); return; }
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [at, groups]);

  return (
    <div className={`cmdk-scrim${light ? " theme-light" : ""}`} onMouseDown={onClose}>
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Command palette"
           onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef} className="cmdk-field" value={q}
          onChange={(e) => setQ(e.target.value)} onKeyDown={onFieldKey}
          placeholder="Production, shot, cast member or screen"
          role="combobox" aria-expanded aria-controls="cmdk-list" aria-autocomplete="list"
          aria-activedescendant={rows[at] ? `cmdk-${rows[at].id}` : undefined}
          autoComplete="off" spellCheck={false} enterKeyHint="go"
        />
        <div className="cmdk-list" id="cmdk-list" role="listbox" aria-label="Results" ref={listRef}>
          {groups.length === 0 && <p className="cmdk-none">Nothing matches that.</p>}
          {groups.map((g) => (
            <div key={g.group} className="cmdk-group" role="group" aria-label={g.group}>
              <h3>{g.group}</h3>
              {g.items.map(({ cmd, at: marks }) => (
                <button
                  key={cmd.id} id={`cmdk-${cmd.id}`} type="button" role="option"
                  aria-selected={rows[at]?.id === cmd.id} className="cmdk-row"
                  onMouseMove={() => setCur({ q, i: rows.findIndex((r) => r.id === cmd.id) })}
                  onClick={() => run(cmd)}
                >
                  <span className="cmdk-label">{mark(cmd.label, marks)}</span>
                  {cmd.hint && <span className="cmdk-hint">{cmd.hint}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
        <footer className="cmdk-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>esc</kbd> close</span>
          <span className="cmdk-foot-end"><kbd>?</kbd> all shortcuts</span>
        </footer>
      </div>
    </div>
  );
}

/* ---- the ? overlay: the whole registry, grouped ---------------------- */

function Help({ onClose }: { onClose: () => void }) {
  const path = usePathname();
  const light = path?.startsWith("/atomik") ?? false;
  return (
    <div className={`cmdk-scrim${light ? " theme-light" : ""}`} onMouseDown={onClose}>
      <div className="cmdk cmdk-help" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts"
           onMouseDown={(e) => e.stopPropagation()}>
        <header className="cmdk-help-head">
          <h2>Keyboard</h2>
          <button type="button" className="cmdk-x" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="cmdk-help-body">
          {byScope().map((g) => (
            <section key={g.scope}>
              <h3>{SCOPE_LABEL[g.scope]}</h3>
              <dl>
                {g.items.map((s) => (
                  <div key={s.id}>
                    <dt>{s.keys.split(" ").map((k, i) => <kbd key={i}>{k}</kbd>)}</dt>
                    <dd>{s.label}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Highlight the characters the matcher actually matched. */
function mark(text: string, at: number[]) {
  if (!at.length) return text;
  const hot = new Set(at);
  const out: React.ReactNode[] = [];
  let run = "", isHot = hot.has(0);
  for (let i = 0; i < text.length; i++) {
    const h = hot.has(i);
    if (h !== isHot) { out.push(isHot ? <b key={i}>{run}</b> : run); run = ""; isHot = h; }
    run += text[i];
  }
  out.push(isHot ? <b key="last">{run}</b> : run);
  return out;
}
