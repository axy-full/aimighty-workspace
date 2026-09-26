"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { downloadUrl, galleryOf, originalUrl, type PreviewItem } from "@/lib/preview";

const SELECTOR = "[data-preview-url]";
const LONG_PRESS_MS = 550;
const isField = (el: Element | null) => !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el as HTMLElement).isContentEditable);
const inLayer = (el: Element | null) => !!el?.closest("[data-preview-layer]");

/** Open the viewer from code (an inspector's "Preview" button, a menu item). */
export function openPreview(items: PreviewItem[], index = 0) {
  if (typeof window === "undefined" || !items.length) return;
  window.dispatchEvent(new CustomEvent("particl:preview", { detail: { items, index } }));
}

/**
 * The site's one previewer (owner, 25 September: every asset shown has a
 * preview). Mounted once in the root layout; it reads the `data-preview-*`
 * attributes (lib/preview) that LazyMedia and every asset surface carry, so a
 * surface gets a preview by showing its asset — no wiring per page.
 *
 * Ways in: the ⤢ button on hover, a double-click, Space on a focused tile,
 * a long-press on touch, or `openPreview()`. Inside: the full-size original
 * (image, video, audio, PDF pages, text), the neighbours with ← / →,
 * "Download original", Esc to close.
 */
export default function PreviewLayer() {
  const [open, setOpen] = useState<{ items: PreviewItem[]; index: number } | null>(null);
  const [hot, setHot] = useState<{ el: HTMLElement; top: number; left: number } | null>(null);
  const hotRef = useRef<HTMLElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  const show = useCallback((el: Element) => {
    returnFocus.current = document.activeElement as HTMLElement | null;
    setHot(null);
    setOpen(galleryOf(el));
  }, []);

  /* The hover button: one floating ⤢ over whichever asset the mouse is on. */
  const place = useCallback((el: HTMLElement | null) => {
    hotRef.current = el;
    if (!el || !el.isConnected) { setHot(null); return; }
    const r = el.getBoundingClientRect();
    if (r.width < 28 || r.height < 20 || r.bottom < 0 || r.top > window.innerHeight) { setHot(null); return; }
    setHot({ el, top: Math.max(4, r.top + 6), left: Math.min(window.innerWidth - 40, r.right - 34) });
  }, []);

  useEffect(() => {
    let leaveTimer: ReturnType<typeof setTimeout> | undefined;
    const over = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      const t = e.target as Element | null;
      if (t?.closest("[data-preview-button]")) { clearTimeout(leaveTimer); return; }
      const el = t?.closest<HTMLElement>(SELECTOR) ?? null;
      if (el && !inLayer(el)) { clearTimeout(leaveTimer); if (el !== hotRef.current) place(el); }
      else if (hotRef.current) { clearTimeout(leaveTimer); leaveTimer = setTimeout(() => place(null), 120); }
    };
    const reflow = () => { if (hotRef.current) place(hotRef.current); };
    const dbl = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (e.defaultPrevented || !t || isField(t) || inLayer(t)) return;
      const el = t.closest(SELECTOR);
      if (el) { e.preventDefault(); show(el); }
    };
    let opened = false;
    const keydown = (e: KeyboardEvent) => {
      if (e.key !== " " || e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      const a = document.activeElement;
      if (!a || a === document.body || isField(a) || inLayer(a)) return;
      const el = a.closest(SELECTOR) ?? a.querySelector(SELECTOR);
      if (!el) return;
      e.preventDefault(); opened = true; show(el);
    };
    /* A focused button activates on Space's keyup; the viewer took that Space. */
    const keyup = (e: KeyboardEvent) => { if (e.key === " " && opened) { e.preventDefault(); opened = false; } };
    /* Touch: a long-press previews; the tap that ends it does not also select. */
    let press: { timer: ReturnType<typeof setTimeout>; x: number; y: number; fired: boolean } | null = null;
    const down = (e: PointerEvent) => {
      if (e.pointerType === "mouse") return;
      const t = e.target as Element | null;
      const el = t && !isField(t) && !inLayer(t) ? t.closest(SELECTOR) : null;
      if (!el) return;
      const p = { x: e.clientX, y: e.clientY, fired: false, timer: setTimeout(() => { p.fired = true; show(el); }, LONG_PRESS_MS) };
      press = p;
    };
    const move = (e: PointerEvent) => { if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) { clearTimeout(press.timer); press = null; } };
    const up = () => { if (press && !press.fired) { clearTimeout(press.timer); press = null; } };
    const swallow = (e: Event) => { if (press?.fired) { e.preventDefault(); e.stopPropagation(); if (e.type === "click") press = null; } };
    const external = (e: Event) => {
      const d = (e as CustomEvent<{ items: PreviewItem[]; index: number }>).detail;
      if (d?.items?.length) { returnFocus.current = document.activeElement as HTMLElement | null; setOpen({ items: d.items, index: Math.max(0, Math.min(d.index, d.items.length - 1)) }); }
    };
    document.addEventListener("pointerover", over);
    window.addEventListener("scroll", reflow, true);
    window.addEventListener("resize", reflow);
    document.addEventListener("dblclick", dbl);
    window.addEventListener("keydown", keydown);
    window.addEventListener("keyup", keyup);
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", up, true);
    document.addEventListener("click", swallow, true);
    document.addEventListener("contextmenu", swallow, true);
    window.addEventListener("particl:preview", external);
    return () => {
      clearTimeout(leaveTimer);
      document.removeEventListener("pointerover", over);
      window.removeEventListener("scroll", reflow, true);
      window.removeEventListener("resize", reflow);
      document.removeEventListener("dblclick", dbl);
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("keyup", keyup);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", up, true);
      document.removeEventListener("click", swallow, true);
      document.removeEventListener("contextmenu", swallow, true);
      window.removeEventListener("particl:preview", external);
    };
  }, [place, show]);

  /* Focus goes back to what opened the preview once the viewer has left the
     page, and only if it is still resting on <body> (the viewer's Close
     button left with it). Checked after the unmount, not on a timer: on a
     slow machine a timer can run while the viewer is still mounted, or after
     a tile was focused in the meantime, and either way the wrong thing won. */
  const closing = useRef(false);
  const close = useCallback(() => {
    closing.current = true;
    setOpen(null);
  }, []);
  useEffect(() => {
    if (open || !closing.current) return;
    closing.current = false;
    const back = returnFocus.current;
    const now = document.activeElement;
    if (back?.isConnected && (!now || now === document.body)) back.focus?.();
  }, [open]);

  return (
    <>
      {hot && !open ? (
        <button type="button" className="pv-hover" data-preview-button="" data-preview-layer="" data-testid="preview-open"
          aria-label="Preview" title="Preview (double-click or Space)" style={{ top: hot.top, left: hot.left }}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); show(hot.el); }}
          onPointerLeave={() => setTimeout(() => { if (hotRef.current === hot.el) place(null); }, 150)}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M8.5 1.5h4v4M12.5 1.5L8 6M5.5 12.5h-4v-4M1.5 12.5L6 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      ) : null}
      {open ? <Viewer items={open.items} start={open.index} onClose={close} /> : null}
    </>
  );
}

function Viewer({ items, start, onClose }: { items: PreviewItem[]; start: number; onClose: () => void }) {
  const [index, setIndex] = useState(start);
  const item = items[index];
  const closeBtn = useRef<HTMLButtonElement>(null);
  const step = useCallback((d: number) => setIndex((i) => (i + d + items.length) % items.length), [items.length]);
  useLayoutEffect(() => { closeBtn.current?.focus(); }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
      else if (e.key === "ArrowRight" && items.length > 1 && !isField(document.activeElement)) { e.preventDefault(); step(1); }
      else if (e.key === "ArrowLeft" && items.length > 1 && !isField(document.activeElement)) { e.preventDefault(); step(-1); }
    };
    window.addEventListener("keydown", key, true);
    const prior = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", key, true); document.body.style.overflow = prior; };
  }, [items.length, onClose, step]);
  const name = item.name || "Preview";
  return createPortal(
    <div className="pv-veil" data-preview-layer="" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pv-frame" role="dialog" aria-modal="true" aria-label={`Preview: ${name}`} data-testid="preview-dialog" data-kind={item.kind}>
        <header className="pv-head">
          <span className="pv-name" data-testid="preview-name" title={name}>{name}</span>
          {items.length > 1 ? <span className="pv-count" data-testid="preview-count">{index + 1} / {items.length}</span> : null}
          <span className="pv-spacer" />
          <a className="pv-btn" href={downloadUrl(item.url)} download data-testid="preview-download">Download original</a>
          <button ref={closeBtn} type="button" className="pv-btn" onClick={onClose} data-testid="preview-close" aria-label="Close preview">Close</button>
        </header>
        <div className="pv-stage">
          <Content key={item.url} item={item} />
          {items.length > 1 ? (
            <>
              <button type="button" className="pv-step pv-step--prev" aria-label="Previous" data-testid="preview-prev" onClick={() => step(-1)}>‹</button>
              <button type="button" className="pv-step pv-step--next" aria-label="Next" data-testid="preview-next" onClick={() => step(1)}>›</button>
            </>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Content({ item }: { item: PreviewItem }) {
  const full = originalUrl(item.url);
  const [src, setSrc] = useState(full);
  if (item.kind === "image") {
    /* eslint-disable-next-line @next/next/no-img-element */
    return <img className="pv-media" data-testid="preview-image" src={src} alt={item.name ?? ""} onError={() => { if (src !== item.url) setSrc(item.url); }} />;
  }
  if (item.kind === "video") return <video className="pv-media" data-testid="preview-video" src={full} controls autoPlay playsInline />;
  if (item.kind === "audio") {
    return (
      <div className="pv-audio" data-testid="preview-audio">
        <span className="pv-glyph" aria-hidden="true">♪</span>
        <audio src={full} controls autoPlay />
      </div>
    );
  }
  if (item.kind === "document") return <DocumentView item={item} />;
  return (
    <div className="pv-file" data-testid="preview-file">
      <span className="pv-glyph" aria-hidden="true">▤</span>
      <p>{item.name ?? "This file"} has no picture to show here. Download the original to open it.</p>
    </div>
  );
}

const PDF_PAGES = 12;
const DOC_BYTES = 20 * 1024 * 1024;

/** A PDF drawn page by page in the browser (the server sends PDFs only as downloads); text shown as text. */
function DocumentView({ item }: { item: PreviewItem }) {
  const [state, setState] = useState<{ pages?: string[]; total?: number; text?: string; error?: string }>({});
  useEffect(() => {
    const abort = new AbortController();
    const urls: string[] = [];
    void (async () => {
      try {
        const res = await fetch(originalUrl(item.url), { signal: abort.signal });
        if (!res.ok) throw new Error("This document could not be read.");
        const blob = await res.blob();
        if (blob.size > DOC_BYTES) throw new Error("This document is too large to preview here. Download the original.");
        const head = new TextDecoder().decode(new Uint8Array(await blob.slice(0, 1024).arrayBuffer()));
        if (head.includes("%PDF-")) {
          const { withScreenplayPdf, renderScreenplayPage } = await import("@/lib/workbench/screenplay-pdf");
          const file = new File([blob], item.name || "document.pdf", { type: "application/pdf" });
          await withScreenplayPdf(file, abort.signal, 60_000, async (doc, _sha, signal) => {
            const shown = Math.min(doc.numPages, PDF_PAGES);
            for (let n = 1; n <= shown; n++) {
              const page = await doc.getPage(n);
              try { urls.push(URL.createObjectURL(await renderScreenplayPage(page, signal, 1.5))); }
              finally { page.cleanup(); }
              if (!abort.signal.aborted) setState({ pages: [...urls], total: doc.numPages });
            }
          });
        } else {
          const text = await blob.text();
          if (!abort.signal.aborted) setState({ text: text.slice(0, 400_000) });
        }
      } catch (error) {
        if (!abort.signal.aborted) setState({ error: error instanceof Error ? error.message : "This document could not be read." });
      }
    })();
    return () => { abort.abort(); urls.forEach((u) => URL.revokeObjectURL(u)); };
  }, [item.url, item.name]);
  if (state.error) return <div className="pv-file" data-testid="preview-document"><p>{state.error}</p></div>;
  if (state.text !== undefined) return <pre className="pv-text" data-testid="preview-document">{state.text}</pre>;
  if (!state.pages) return <div className="pv-file" data-testid="preview-document"><p>Reading the document…</p></div>;
  return (
    <div className="pv-pages" data-testid="preview-document">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {state.pages.map((u, i) => <img key={u} src={u} alt={`Page ${i + 1}`} className="pv-page" />)}
      {state.total && state.total > state.pages.length ? <p className="pv-more">{state.total - state.pages.length} more {state.total - state.pages.length === 1 ? "page" : "pages"} — download the original to read them all.</p> : null}
    </div>
  );
}
