"use client";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { ComposerType } from "@/lib/workspace/composer";
import {
  FILM_CHIPS, chipOptions, chipValue, chipsFor, dropToken, extraRows, hashToken, isPicked, optionMatches, pickOption, vocabularyMatches,
  type FilmChip, type FilmChipKey, type FilmHit, type FilmOption, type FilmSetup,
} from "@/lib/workspace/film-vocabulary";
import { useScopedFetch } from "@/lib/useScopedFetch";

/**
 * Gen's film vocabulary (lib/workspace/film-vocabulary.ts): six chips under
 * Direction, each Auto until picked; a chip opens a grid where every entry
 * shows its loop (the platform's neutral previews, GET /api/platform/previews)
 * or, where the bank makes none, a drawing of what it does. `#` in the words
 * opens the same bank as a typeahead.
 */

const PREVIEW_PATH = "/api/platform/previews/";
type Previews = { state: "idle" | "ready" | "error"; urls: Record<string, string> };

export function FilmChips({ scope, type, setup, onChange }: {
  scope: string; type: ComposerType; setup: FilmSetup; onChange: (setup: FilmSetup) => void;
}) {
  const chips = chipsFor(type);
  const extras = extraRows(setup, type);
  const [open, setOpen] = useState<FilmChipKey | null>(null);
  const buttons = useRef<Partial<Record<FilmChipKey, HTMLButtonElement | null>>>({});
  const scopedFetch = useScopedFetch(scope);
  /* The loops are read once, when the Camera grid first opens (only moves and techniques have them). */
  const [previews, setPreviews] = useState<Previews>({ state: "idle", urls: {} });
  const wantsPreviews = open === "camera" && previews.state === "idle";
  useEffect(() => {
    if (!wantsPreviews) return;
    let live = true;
    void scopedFetch("/api/platform/previews", { cache: "no-store" })
      .then(async (r) => { if (!r.ok) throw new Error("unread"); return (await r.json()) as { previews?: Record<string, unknown> }; })
      .then((json) => {
        if (!live) return;
        /* Only this app's own platform clips, never a URL from anywhere else. */
        const urls = Object.fromEntries(Object.entries(json.previews ?? {}).filter((pair): pair is [string, string] => typeof pair[1] === "string" && pair[1].startsWith(PREVIEW_PATH)));
        setPreviews({ state: "ready", urls });
      })
      .catch(() => { if (live) setPreviews({ state: "error", urls: {} }); });
    return () => { live = false; };
  }, [wantsPreviews, scopedFetch]);
  if (!chips.length) return null;

  const close = () => { const key = open; setOpen(null); if (key) buttons.current[key]?.focus({ preventScroll: true }); };
  const chip = open ? FILM_CHIPS.find((c) => c.key === open) ?? null : null;
  return (
    <div className="gx-fv" data-testid="gen-film">
      <div className="gx-fv-chips" role="group" aria-label="Film vocabulary">
        {chips.map((c) => {
          const value = chipValue(c, setup);
          return (
            <button key={c.key} ref={(el) => { buttons.current[c.key] = el; }} type="button" className="gx-fv-chip" data-set={value.set || undefined}
              aria-haspopup="dialog" aria-expanded={open === c.key} aria-label={`${c.label}: ${value.text}`} title={`${c.label}: ${value.text}`}
              onClick={() => setOpen(c.key)} data-testid={`gen-film-${c.key}`}>
              <span className="gx-fv-chip-label" aria-hidden="true">{c.label}</span>
              <span className="gx-fv-chip-value" aria-hidden="true">{value.text}</span>
            </button>
          );
        })}
      </div>
      {extras.length ? (
        <ul className="gx-fv-extras" aria-label="Also in the setup" data-testid="gen-film-extras">
          {extras.map((x) => (
            <li key={x.row}>
              <span title={x.label}>{x.value}</span>
              <button type="button" className="gx-ref-x" aria-label={`Remove ${x.label}: ${x.value}`} onClick={() => { const next = { ...setup }; delete next[x.row]; onChange(next); }}>×</button>
            </li>
          ))}
        </ul>
      ) : null}
      {chip ? createPortal(
        <div className="gx-veil" onClick={close} data-testid="gen-film-veil">
          <FilmSheet chip={chip} setup={setup} previews={chip.key === "camera" ? previews : null}
            onRetry={() => setPreviews({ state: "idle", urls: {} })}
            onPick={(o) => { onChange(pickOption(setup, chip, o)); close(); }} onClose={close} />
        </div>,
        document.querySelector(".gx") ?? document.body,
      ) : null}
    </div>
  );
}

function FilmSheet({ chip, setup, previews, onPick, onClose, onRetry }: {
  chip: FilmChip; setup: FilmSetup;
  /** The loops, for Camera; null elsewhere (the bank makes loops for moves and techniques only). */
  previews: Previews | null;
  onPick: (option: FilmOption | null) => void; onClose: () => void; onRetry: () => void;
}) {
  const [query, setQuery] = useState("");
  const dialog = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const options = useMemo(() => chipOptions(chip), [chip]);
  const shown = useMemo(() => options.filter((o) => optionMatches(o, query)), [options, query]);
  const searchable = options.length > 12;
  const value = chipValue(chip, setup);
  const groups = chip.key === "camera"
    ? [{ key: "move", label: "Moves", items: shown.filter((o) => o.row === "move") }, { key: "technique", label: "Techniques", items: shown.filter((o) => o.row === "technique") }]
    : [{ key: chip.rows[0], label: null, items: shown }];

  /* A pointer types into the search where there is one; otherwise the picked entry (or Auto) takes focus, in view. */
  useEffect(() => {
    if (searchable && window.matchMedia?.("(pointer: fine)").matches) { search.current?.focus({ preventScroll: true }); return; }
    const tile = list.current?.querySelector<HTMLElement>('.gx-fv-tile[aria-pressed="true"]') ?? list.current?.querySelector<HTMLElement>(".gx-fv-tile");
    tile?.focus({ preventScroll: true });
    tile?.scrollIntoView({ block: "nearest" });
  }, [searchable]);
  /* Escape closes it wherever focus is (a button that goes away, like Try again, leaves it on the page). */
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      closeRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const tiles = () => Array.from(list.current?.querySelectorAll<HTMLElement>(".gx-fv-tile") ?? []);
  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = tiles();
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    let next = -1;
    if (e.key === "ArrowRight") next = Math.min(all.length - 1, at + 1);
    else if (e.key === "ArrowLeft") next = Math.max(0, at - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = all.length - 1;
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const here = all[at].getBoundingClientRect();
      const down = e.key === "ArrowDown";
      const rows = all.map((el, i) => ({ i, r: el.getBoundingClientRect() })).filter(({ r }) => (down ? r.top > here.top + 4 : r.top < here.top - 4));
      if (!rows.length) { if (!down && searchable) { e.preventDefault(); search.current?.focus(); } return; }
      const row = down ? Math.min(...rows.map((x) => x.r.top)) : Math.max(...rows.map((x) => x.r.top));
      const cx = here.left + here.width / 2;
      next = rows.filter((x) => Math.abs(x.r.top - row) < 4).sort((a, b) => Math.abs(a.r.left + a.r.width / 2 - cx) - Math.abs(b.r.left + b.r.width / 2 - cx))[0].i;
    }
    if (next < 0) return;
    e.preventDefault();
    all[next]?.focus({ preventScroll: true });
    all[next]?.scrollIntoView({ block: "nearest" });
  };

  const tile = (o: FilmOption) => {
    const url = previews?.urls[o.previewKey ?? ""] ?? null;
    return <FilmTile key={`${o.row}:${o.value}`} option={o} picked={isPicked(setup, o)} url={url} loading={Boolean(previews && previews.state === "idle" && o.previewKey)} onPick={() => onPick(o)} />;
  };
  const auto = (
    <button type="button" className="gx-fv-tile" aria-pressed={!value.set} onClick={() => onPick(null)} data-option="auto" data-testid="gen-film-auto">
      <span className="gx-fv-media" data-preview="glyph"><Glyph row="auto" value="auto" /></span>
      <span className="gx-fv-name">Auto</span>
      <span className="gx-fv-aka">Engine decides</span>
    </button>
  );

  return (
    <div ref={dialog} tabIndex={-1} className="gx-sheet gx-sheet--vocab" role="dialog" aria-modal="true" aria-label={chip.label} onClick={(e) => e.stopPropagation()}
      data-testid="gen-film-sheet" data-chip={chip.key}>
      <div className="gx-sheet-head">
        <span className="gx-panel-title">{chip.label}</span>
        <span className="gx-fv-now" data-set={value.set || undefined} data-testid="gen-film-now">{value.text}</span>
        {previews?.state === "error" ? (
          <span className="gx-fv-note" role="status" data-testid="gen-film-previews-error">
            Loops unavailable <button type="button" className="cw-link" onClick={() => { dialog.current?.focus({ preventScroll: true }); onRetry(); }}>Try again</button>
          </span>
        ) : null}
        <span className="gx-spacer" />
        <button type="button" className="gx-hbtn" onClick={onClose} data-testid="gen-film-close">Close</button>
        {searchable ? (
          <div className="gx-sheet-find">
            <input ref={search} type="search" className="gx-field" value={query} onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") { e.preventDefault(); tiles()[query ? 0 : 1]?.focus(); }
                if (e.key === "Enter" && !e.nativeEvent.isComposing && query.trim() && shown[0]) { e.preventDefault(); onPick(shown[0]); }
              }}
              placeholder={`Search ${options.length} ${chip.key === "camera" ? "moves" : "entries"}`} aria-label={`Search ${chip.label.toLowerCase()}`}
              autoComplete="off" spellCheck={false} enterKeyHint="go" data-testid="gen-film-search" />
          </div>
        ) : null}
      </div>
      <div ref={list} className="gx-sheet-list gx-fv-list gx-scroll" onKeyDown={onGridKey} data-testid="gen-film-list">
        {groups.map((g, i) => (g.items.length || (i === 0 && !query) ? (
          <div key={g.key} role="group" aria-label={g.label ?? chip.label} className="gx-fv-group">
            {g.label ? <span className="gx-sheet-group-label" data-functional-label="">{g.label}</span> : null}
            <div className="gx-fv-grid">
              {i === 0 && !query ? auto : null}
              {g.items.map(tile)}
            </div>
          </div>
        ) : null))}
        {query && !shown.length ? (
          <p className="gx-empty gx-sheet-none" role="status" data-testid="gen-film-none">
            <span>Nothing matches “{query.trim()}”.</span>
            <button type="button" className="gx-hbtn" onClick={() => { setQuery(""); search.current?.focus(); }}>Clear search</button>
          </p>
        ) : null}
      </div>
    </div>
  );
}

function FilmTile({ option, picked, url, loading, onPick }: { option: FilmOption; picked: boolean; url: string | null; loading: boolean; onPick: () => void }) {
  const [hover, setHover] = useState(false);
  const [failed, setFailed] = useState(false);
  const loop = url && !failed ? url : null;
  return (
    <button type="button" className="gx-fv-tile" aria-pressed={picked} onClick={onPick} title={option.phrase}
      onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)} onFocus={() => setHover(true)} onBlur={() => setHover(false)}
      data-option={`${option.row}:${option.value}`}>
      <span className="gx-fv-media" data-preview={loop ? "loop" : loading ? "loading" : "glyph"}>
        <Glyph row={option.row} value={option.value} />
        {loop ? <PreviewLoop url={loop} active={hover} onFail={() => setFailed(true)} /> : null}
      </span>
      <span className="gx-fv-name">{option.label}</span>
      {option.aka ? <span className="gx-fv-aka">{option.aka}</span> : null}
    </button>
  );
}

/**
 * One neutral loop: muted, `preload="none"` so nothing loads until it plays,
 * and it plays only while it is in view (or, with reduced motion asked for,
 * only while it is hovered or focused). Until its first frame it is
 * invisible, so the drawing beneath stands in.
 */
function PreviewLoop({ url, active, onFail }: { url: string; active: boolean; onFail: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [visible, setVisible] = useState(false);
  const [ready, setReady] = useState(false);
  /* The grid opens on a click, so this only ever runs in the browser. */
  const [still] = useState(() => Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches));
  useEffect(() => {
    const el = video.current;
    if (!el || typeof IntersectionObserver !== "function") return;
    const seen = new IntersectionObserver(([entry]) => setVisible(Boolean(entry?.isIntersecting)), { threshold: 0.5 });
    seen.observe(el);
    return () => seen.disconnect();
  }, []);
  const playing = active || (visible && !still);
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    if (playing) void el.play().catch(() => {});
    else el.pause();
  }, [playing]);
  return (
    <video ref={video} src={url} muted loop playsInline preload="none" aria-hidden="true" tabIndex={-1} disablePictureInPicture
      data-ready={ready || undefined} data-playing={playing || undefined} onLoadedData={() => setReady(true)} onError={onFail} />
  );
}

/* ── # in the words ──────────────────────────────────────────────────────── */

/**
 * The Direction box's typeahead: `#` opens the bank (camera moves first on
 * video), arrows move, Enter or Tab picks, Escape closes. A pick sets its chip
 * and takes the `#word` out of the words.
 */
export function useFilmTypeahead({ type, prompt, setup, textarea, onPrompt, onSetup }: {
  type: ComposerType; prompt: string; setup: FilmSetup; textarea: RefObject<HTMLTextAreaElement | null>;
  onPrompt: (prompt: string) => void; onSetup: (setup: FilmSetup) => void;
}) {
  const listId = useId();
  const [caret, setCaret] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [active, setActive] = useState<{ query: string; index: number }>({ query: "", index: 0 });
  const [said, setSaid] = useState("");
  const pendingCaret = useRef<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const token = caret !== null && type !== "audio" ? hashToken(prompt, caret) : null;
  const tokenKey = token ? `${token.start}:${token.query}` : null;
  const open = Boolean(token) && tokenKey !== dismissed;
  const hits: FilmHit[] = open && token ? vocabularyMatches(token.query, type) : [];
  const index = token && active.query === token.query ? Math.min(active.index, Math.max(0, hits.length - 1)) : 0;

  /* As it opens, the list's first row comes into view if it is not (on a phone, clear of the tab bar: its
     scroll margin). A list whose first rows already show is left where it is, so the words do not move. */
  const openedAt = open && token ? token.start : null;
  useEffect(() => {
    const el = box.current;
    if (openedAt === null || !el) return;
    const top = el.getBoundingClientRect().top;
    const margin = Number.parseFloat(getComputedStyle(el).scrollMarginBottom) || 0;
    if (top + Math.min(el.offsetHeight, 56) > innerHeight - margin) el.scrollIntoView({ block: "nearest" });
  }, [openedAt]);
  /* The active entry stays in view (on a phone the list is one scrolling row). */
  useEffect(() => {
    const row = openedAt !== null ? document.getElementById(`${listId}-${index}`) : null;
    const list = row?.parentElement;
    if (!row || !list) return;
    /* Within the list only: the page itself does not move for an arrow key. */
    if (row.offsetLeft < list.scrollLeft || row.offsetLeft + row.offsetWidth > list.scrollLeft + list.clientWidth) list.scrollLeft = row.offsetLeft - 6;
    if (row.offsetTop < list.scrollTop || row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop - 4;
  }, [openedAt, index, listId]);

  /* After a pick the caret goes back where the #word was, once the words have re-rendered. */
  useLayoutEffect(() => {
    const at = pendingCaret.current;
    const el = textarea.current;
    if (at === null || !el) return;
    pendingCaret.current = null;
    el.focus({ preventScroll: true });
    el.setSelectionRange(at, at);
  }, [prompt, textarea]);

  const pick = (hit: FilmHit) => {
    if (!token) return;
    const dropped = dropToken(prompt, token);
    const chip = FILM_CHIPS.find((c) => c.key === hit.chip)!;
    if (!isPicked(setup, hit)) onSetup(pickOption(setup, chip, hit));
    pendingCaret.current = dropped.caret;
    setCaret(dropped.caret);
    onPrompt(dropped.text);
    setSaid(`${hit.chipLabel}: ${hit.label}`);
  };

  const track = (el: HTMLTextAreaElement) => setCaret(el.selectionStart === el.selectionEnd ? el.selectionStart : null);
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || !token || e.nativeEvent.isComposing) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setDismissed(tokenKey); return; }
    if (!hits.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive({ query: token.query, index: (index + step + hits.length) % hits.length });
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      pick(hits[index]);
    }
  };

  const list: ReactNode = (
    <>
      {open && token ? (
        <div ref={box} className="gx-fv-hash" data-testid="gen-hash">
          {hits.length ? (
            <div id={listId} role="listbox" aria-label="Film vocabulary" className="gx-fv-hash-list">
              {hits.map((h, i) => (
                <div key={`${h.row}:${h.value}`} id={`${listId}-${i}`} role="option" aria-selected={i === index} tabIndex={-1} className="gx-fv-hash-row"
                  data-option={`${h.row}:${h.value}`} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(h)}
                  onKeyDown={(e) => { if (e.key === "Enter") pick(h); }}>
                  <span className="gx-fv-hash-chip">{h.chipLabel}</span>
                  <span className="gx-fv-hash-name">{h.label}</span>
                  {h.aka ? <span className="gx-fv-hash-aka">{h.aka}</span> : null}
                </div>
              ))}
            </div>
          ) : <p className="gx-fv-hash-none" role="status" data-testid="gen-hash-none">Nothing called #{token.query}</p>}
        </div>
      ) : null}
      <span className="sr-only" role="status">{said}</span>
    </>
  );

  return {
    list,
    /** Spread on the textarea; `track` also runs from its onChange. */
    inputProps: {
      onKeyDown,
      onSelect: (e: { currentTarget: HTMLTextAreaElement }) => track(e.currentTarget),
      onBlur: () => setCaret(null),
      "aria-autocomplete": "list" as const,
      "aria-controls": open && hits.length ? listId : undefined,
      "aria-activedescendant": open && hits.length ? `${listId}-${index}` : undefined,
    },
    track,
  };
}

/* ── Drawings, where the bank has no loop ────────────────────────────────── */

/** An arrow from one point to another, with its head. */
function arrow(x1: number, y1: number, x2: number, y2: number, head = 6): string {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const p = (d: number) => `${(x2 - head * Math.cos(a + d)).toFixed(1)} ${(y2 - head * Math.sin(a + d)).toFixed(1)}`;
  return `M${x1} ${y1}L${x2} ${y2}M${p(-0.5)}L${x2} ${y2}L${p(0.5)}`;
}

/** Only the arrowhead, for a curve that ends heading from the first point to the second. */
const head = (x1: number, y1: number, x2: number, y2: number) => arrow(x1, y1, x2, y2).replace(/^M[^M]+/, "");

/** A standing figure, head at the origin, feet at y=90. */
function Figure({ x, y, s, dim }: { x: number; y: number; s: number; dim?: boolean }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`} className={dim ? "gx-fv-g-dim" : "gx-fv-g-fig"}>
      <circle cx="0" cy="0" r="8" />
      <path d="M-16 15Q-15 11-9 10H9Q15 11 16 15L17 46H11L10 90H2L0 54L-2 90H-10L-11 46H-17Z" />
      {dim ? null : <g className="gx-fv-g-eye"><circle cx="-3" cy="-1" r="1.2" /><circle cx="3" cy="-1" r="1.2" /></g>}
    </g>
  );
}

const SHOT: Record<string, { s: number; y: number }> = {
  evs: { s: 0.26, y: 54 }, ws: { s: 0.68, y: 18 }, mls: { s: 1.05, y: 20 }, ms: { s: 1.45, y: 24 }, mcu: { s: 2.1, y: 30 }, cu: { s: 3.3, y: 40 }, ecu: { s: 7.5, y: 46 },
};
const CAMERA_AT: Record<string, [number, number]> = { eye: [34, 30], low: [34, 80], high: [34, 6], ground: [30, 83], top: [112, 6] };
const LENS_HALF_ANGLE: Record<string, number> = { "14": 52, "24": 37, "35": 27, "50": 20, "85": 12, "135": 7.5 };
/* How each move is drawn: travel is a straight arrow, rotation a curved one, a zoom the frame itself closing or opening. */
const MOTION: Record<string, string> = {
  static: "static", push: "in", chase: "in", followbehind: "in", pull: "out", lead: "out", zoomin: "zoomin", crash: "zoomin", zoomout: "zoomout",
  flythrough: "depth", fpv: "depth",
  truckright: "right", track: "right", lowtrack: "right", steadicam: "glide", truckleft: "left",
  pan: "panright", whippan: "panright", panleft: "panleft", tilt: "tiltup", tiltdown: "tiltdown",
  pedup: "up", peddown: "down", crane: "craneup", cranedown: "cranedown", aerial: "cranedown",
  orbit: "orbit", arc: "orbit", bullettime: "orbit", handheld: "wave", snorricam: "wave", topdown: "top", motioncontrol: "path", oner: "path",
  dollyzoom: "zolly", rackfocus: "focus",
};
type Palette = [sky: string, horizon: string, sun: string, hill: string, near: string, overlay?: "grain" | "scan"];
const LOOK: Record<string, Palette> = {
  clean: ["#5F9ED6", "#D3E6F4", "#FFF4CC", "#3E6B45", "#274530"],
  "16mm": ["#8FA596", "#E6D6B0", "#FFE5A3", "#5B6B3F", "#3B462A", "grain"],
  "35mm": ["#557FB0", "#F2C28A", "#FFD383", "#3C5A3A", "#233722"],
  vhs: ["#6B58A8", "#E28AB2", "#FFE08A", "#2E5B5B", "#1C383B", "scan"],
  bleach: ["#7D878C", "#D9DCDC", "#FFFFFF", "#353A35", "#141614"],
  teal: ["#0E5961", "#3BA3A0", "#FF9A3C", "#0E3A40", "#072328"],
  bw: ["#4A4A4A", "#CFCFCF", "#FFFFFF", "#2E2E2E", "#111111"],
  muted: ["#78878F", "#BAC0BF", "#E6E0CE", "#56645A", "#3B443E"],
};

/** A drawing of what an entry does, in the tile's 16:9: framing, where the camera sits, the lens's field, the light, the look, the move. */
function Glyph({ row, value }: { row: string; value: string }) {
  const id = `g${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return <svg viewBox="0 0 160 90" preserveAspectRatio="xMidYMid slice" aria-hidden="true" className="gx-fv-glyph">{glyphBody(row, value, id)}</svg>;
}

function glyphBody(row: string, value: string, id: string): ReactNode {
  if (row === "auto") {
    return <>
      <rect x="22" y="14" width="116" height="62" rx="6" className="gx-fv-g-frame" strokeDasharray="5 5" />
      <path d="M80 30L84 41L95 45L84 49L80 60L76 49L65 45L76 41Z" className="gx-fv-g-accfill" />
    </>;
  }
  if (row === "shot") {
    const at = SHOT[value];
    if (at) return <>
      {value === "evs" ? <path d="M0 78L40 66L78 72L118 60L160 70V90H0Z" className="gx-fv-g-ground" /> : null}
      <Figure x={80} y={at.y} s={at.s} />
    </>;
    if (value === "ots") return <><Figure x={108} y={28} s={1.35} /><Figure x={34} y={56} s={3.2} dim /></>;
    if (value === "pov") return <><path d="M0 50H160" className="gx-fv-g-line" /><path d="M36 90L76 50M124 90L84 50" className="gx-fv-g-line" /><Figure x={80} y={38} s={0.14} /></>;
    return <>
      <path d="M62 6H98V84H62Z" className="gx-fv-g-ground" />
      <circle cx="80" cy="45" r="26" className="gx-fv-g-fig" />
      <circle cx="80" cy="45" r="21" className="gx-fv-g-face" />
      <path d="M80 45V30M80 45L91 51" className="gx-fv-g-acc" />
    </>;
  }
  if (row === "angle") {
    if (value === "dutch") return <g transform="rotate(-12 80 45)"><rect x="24" y="12" width="112" height="66" rx="4" className="gx-fv-g-frame" /><Figure x={80} y={22} s={0.62} /></g>;
    const [cx, cy] = CAMERA_AT[value] ?? CAMERA_AT.eye;
    const head: [number, number] = [112, 30];
    const aim = Math.atan2(head[1] - cy, head[0] - cx) * 180 / Math.PI;
    return <>
      <path d="M0 86H160" className="gx-fv-g-line" />
      <Figure x={112} y={30} s={0.62} />
      <path d={`M${cx} ${cy}L${head[0]} ${head[1]}`} className="gx-fv-g-acc" strokeDasharray="3 4" />
      <g transform={`translate(${cx} ${cy}) rotate(${aim.toFixed(1)})`} className="gx-fv-g-cam"><rect x="-9" y="-6" width="14" height="12" rx="2" /><path d="M5 -4L12 -7V7L5 4Z" /></g>
    </>;
  }
  if (row === "lens") {
    if (value === "macro") return <>
      {[0, 72, 144, 216, 288].map((r) => <ellipse key={r} cx="80" cy="30" rx="9" ry="16" transform={`rotate(${r} 80 45)`} className="gx-fv-g-fig" />)}
      <circle cx="80" cy="45" r="8" className="gx-fv-g-accfill" />
      <circle cx="80" cy="45" r="38" className="gx-fv-g-acc" />
    </>;
    if (value === "anamorphic") return <>
      {[[40, 30], [70, 58], [104, 34], [128, 60]].map(([x, y]) => <ellipse key={x} cx={x} cy={y} rx="7" ry="13" className="gx-fv-g-bokeh" />)}
      <path d="M8 45H152" className="gx-fv-g-flare" />
    </>;
    const half = (LENS_HALF_ANGLE[value] ?? 20) * Math.PI / 180;
    const reach = Math.tan(half) * 132;
    return <>
      <path d={`M20 45L152 ${(45 - reach).toFixed(1)}V${(45 + reach).toFixed(1)}Z`} className="gx-fv-g-wedge" />
      <g transform="translate(20 45)" className="gx-fv-g-cam"><rect x="-12" y="-7" width="14" height="14" rx="2" /><path d="M2 -5L7 -7V7L2 5Z" /></g>
    </>;
  }
  if (row === "light") return lightGlyph(value, id);
  if (row === "look") {
    const [sky, horizon, sun, hill, near, overlay] = LOOK[value] ?? LOOK.clean;
    return <>
      <defs>
        <linearGradient id={`${id}s`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={sky} /><stop offset="1" stopColor={horizon} /></linearGradient>
        {overlay === "grain" ? <filter id={`${id}g`}><feTurbulence type="fractalNoise" baseFrequency="1.4" numOctaves="1" /><feColorMatrix values="0 0 0 0 0.5 0 0 0 0 0.5 0 0 0 0 0.5 0 0 0 0.35 0" /></filter> : null}
      </defs>
      <rect width="160" height="90" fill={`url(#${id}s)`} />
      <circle cx="112" cy="40" r="11" fill={sun} />
      <path d="M0 62L34 50L70 58L110 46L160 58V90H0Z" fill={hill} />
      <path d="M0 76L50 68L96 76L160 70V90H0Z" fill={near} />
      {overlay === "grain" ? <rect width="160" height="90" filter={`url(#${id}g)`} /> : null}
      {overlay === "scan" ? <path d={Array.from({ length: 30 }, (_, i) => `M0 ${i * 3 + 1}H160`).join("")} className="gx-fv-g-scan" /> : null}
    </>;
  }
  /* A move or technique with no loop published: the frame, and the move drawn on it. */
  const kind = MOTION[value] ?? "static";
  const frame = <rect x="22" y="12" width="116" height="66" rx="5" className="gx-fv-g-frame" />;
  const subject = <circle cx="80" cy="45" r="7" className="gx-fv-g-fig" />;
  const d = (path: string) => <path d={path} className="gx-fv-g-acc" />;
  switch (kind) {
    case "in": return <>{frame}{subject}{d([arrow(30, 18, 52, 31), arrow(130, 18, 108, 31), arrow(30, 72, 52, 59), arrow(130, 72, 108, 59)].join(""))}</>;
    case "out": return <>{frame}{subject}{d([arrow(56, 33, 32, 20), arrow(104, 33, 128, 20), arrow(56, 57, 32, 70), arrow(104, 57, 128, 70)].join(""))}</>;
    case "depth": return <>{frame}{d("M22 78L68 48M138 78L92 48M22 12L68 42M138 12L92 42")}{d(arrow(80, 70, 80, 50))}</>;
    case "zoomin": return <>{frame}{subject}<rect x="48" y="27" width="64" height="36" rx="3" className="gx-fv-g-acc" />{d("M30 20h10M30 20v8M130 20h-10M130 20v8M30 70h10M30 70v-8M130 70h-10M130 70v-8")}</>;
    case "zoomout": return <>{frame}{subject}<rect x="48" y="27" width="64" height="36" rx="3" className="gx-fv-g-frame" strokeDasharray="3 3" />{d([arrow(50, 29, 34, 19), arrow(110, 29, 126, 19), arrow(50, 61, 34, 71), arrow(110, 61, 126, 71)].join(""))}</>;
    case "right": return <>{frame}{subject}{d(arrow(44, 64, 116, 64))}</>;
    case "left": return <>{frame}{subject}{d(arrow(116, 64, 44, 64))}</>;
    case "glide": return <>{frame}{subject}{d(`M40 66C62 56 88 72 112 62${head(100, 67, 112, 62)}`)}</>;
    case "panright": return <>{frame}{subject}{d(`M44 30Q80 14 116 30${head(108, 26, 116, 30)}`)}</>;
    case "panleft": return <>{frame}{subject}{d(`M116 30Q80 14 44 30${head(52, 26, 44, 30)}`)}</>;
    case "tiltup": return <>{frame}{subject}{d(`M114 66Q128 45 114 24${head(118, 31, 114, 24)}`)}</>;
    case "tiltdown": return <>{frame}{subject}{d(`M114 24Q128 45 114 66${head(118, 59, 114, 66)}`)}</>;
    case "up": return <>{frame}{subject}{d(arrow(122, 66, 122, 24))}</>;
    case "down": return <>{frame}{subject}{d(arrow(122, 24, 122, 66))}</>;
    case "craneup": return <>{frame}{subject}{d(`M44 68Q52 30 104 22${head(96, 22, 104, 22)}`)}</>;
    case "cranedown": return <>{frame}{subject}{d(`M44 22Q52 60 104 68${head(96, 68, 104, 68)}`)}</>;
    case "orbit": return <>{frame}{subject}<ellipse cx="80" cy="45" rx="44" ry="14" className="gx-fv-g-acc" strokeDasharray="4 4" />{d(arrow(112, 55, 124, 49))}</>;
    case "wave": return <>{frame}{subject}{d("M34 64q8-8 16 0t16 0t16 0t16 0t16 0t14 0")}</>;
    case "top": return <>{frame}<circle cx="80" cy="45" r="22" className="gx-fv-g-acc" /><circle cx="80" cy="45" r="12" className="gx-fv-g-acc" />{subject}</>;
    case "path": return <>{frame}<path d="M32 66C56 20 92 70 128 24" className="gx-fv-g-acc" strokeDasharray="5 4" />{[[32, 66], [80, 45], [128, 24]].map(([x, y]) => <circle key={x} cx={x} cy={y} r="3.5" className="gx-fv-g-accfill" />)}</>;
    case "zolly": return <>{frame}{subject}{d([arrow(32, 45, 58, 45), arrow(128, 45, 102, 45)].join(""))}<rect x="46" y="26" width="68" height="38" rx="3" className="gx-fv-g-frame" strokeDasharray="3 3" /></>;
    case "focus": return <>{frame}<circle cx="58" cy="50" r="14" className="gx-fv-g-blur" /><circle cx="104" cy="40" r="11" className="gx-fv-g-fig" />{d(arrow(70, 40, 90, 40))}</>;
    default: return <>{frame}<path d="M80 30V60M65 45H95" className="gx-fv-g-line" /><path d="M80 78L66 90M80 78L94 90M80 78V90" className="gx-fv-g-line" /></>;
  }
}

function lightGlyph(value: string, id: string): ReactNode {
  const sphere = (fill: string, extra?: ReactNode) => <>{extra}<circle cx="80" cy="47" r="24" fill={fill} /></>;
  const grad = (stops: [number, string][], x1 = 0, y1 = 0, x2 = 1, y2 = 0, key = "l") => (
    <linearGradient id={`${id}${key}`} x1={x1} y1={y1} x2={x2} y2={y2}>{stops.map(([o, c], i) => <stop key={i} offset={o} stopColor={c} />)}</linearGradient>
  );
  const radial = (stops: [number, string][], cx: number, cy: number, r: number, key = "r") => (
    <radialGradient id={`${id}${key}`} cx={cx} cy={cy} r={r}>{stops.map(([o, c], i) => <stop key={i} offset={o} stopColor={c} />)}</radialGradient>
  );
  const bg = (fill: string) => <rect width="160" height="90" fill={fill} />;
  switch (value) {
    case "natural": return <><defs>{grad([[0, "#EDE7D8"], [1, "#6C6A66"]], 0, 0, 1, 1)}</defs>{bg("#3A3D44")}{sphere(`url(#${id}l)`)}</>;
    case "soft": return <><defs>{radial([[0, "#F4F1EA"], [0.7, "#8F8C88"], [1, "#55534F"]], 0.35, 0.35, 0.9)}</defs>{bg("#2C2D31")}{sphere(`url(#${id}r)`)}</>;
    case "hard": return <><defs>{grad([[0, "#FFF6E6"], [0.5, "#E9DDC8"], [0.5, "#0E0E10"], [1, "#0E0E10"]])}</defs>{bg("#1D1E22")}{sphere(`url(#${id}l)`)}</>;
    case "practical": return <><defs>{grad([[0, "#FFC56E"], [1, "#2A2018"]])}{radial([[0, "rgba(255,190,100,.8)"], [1, "rgba(255,190,100,0)"]], 0.5, 0.5, 0.5)}</defs>{bg("#17140F")}<circle cx="30" cy="30" r="22" fill={`url(#${id}r)`} /><circle cx="30" cy="30" r="5" fill="#FFE2A8" />{sphere(`url(#${id}l)`)}</>;
    case "neon": return <><defs>{grad([[0, "#FF3FB4"], [0.5, "#3A1F4A"], [1, "#2BD4FF"]])}</defs>{bg("#120D1C")}<rect x="8" y="16" width="6" height="58" rx="3" fill="#FF3FB4" /><rect x="146" y="16" width="6" height="58" rx="3" fill="#2BD4FF" />{sphere(`url(#${id}l)`)}</>;
    case "rim": return <>{bg("#0B0B0D")}<circle cx="80" cy="47" r="25" fill="none" stroke="#F4EBDD" strokeWidth="2.5" /><circle cx="80" cy="47" r="23.5" fill="#141417" /></>;
    case "back": return <><defs>{radial([[0, "#FFF4DA"], [0.35, "rgba(255,230,180,.6)"], [1, "rgba(255,230,180,0)"]], 0.5, 0.5, 0.5)}</defs>{bg("#16161A")}<circle cx="80" cy="45" r="46" fill={`url(#${id}r)`} />{sphere("#0C0C0E")}</>;
    case "chiaro": return <><defs>{grad([[0, "#E8C9A0"], [0.55, "#8A6A48"], [0.56, "#050505"], [1, "#050505"]])}</defs>{bg("#050506")}{sphere(`url(#${id}l)`)}</>;
    case "candle": return <><defs>{grad([[0, "#FFB35C"], [1, "#1A0F08"]], 0, 1, 0, 0)}{radial([[0, "rgba(255,150,60,.55)"], [1, "rgba(255,150,60,0)"]], 0.5, 0.9, 0.6)}</defs>{bg("#0E0906")}<rect width="160" height="90" fill={`url(#${id}r)`} /><path d="M80 90Q74 80 80 72Q86 80 80 90Z" fill="#FFD27A" />{sphere(`url(#${id}l)`)}</>;
    case "mixed": return <><defs>{grad([[0, "#FFB066"], [0.5, "#6E6272"], [1, "#5AA8FF"]])}</defs>{bg("#1A1B22")}{sphere(`url(#${id}l)`)}</>;
    default: return <>{bg("#2A2B30")}{sphere("#7C7B78")}</>;
  }
}
