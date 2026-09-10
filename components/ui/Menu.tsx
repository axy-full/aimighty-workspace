"use client";

import { useEffect, useRef, type ReactNode } from "react";
import Mono from "./Mono";

/**
 * The right-click menu (design/particl-v2/README.md §7; board 4b): 228px,
 * `--card` with a 1px edge at .18, radius 12, 6px padding; a mono header
 * (`SH04 · SHOT`, `8px 10px 6px`); items 36px, `0 10px`, radius 8, Outfit
 * 500 13.5px with the shortcut in mono at .08em on the right, `.08` on
 * hover, muted when disabled; hairlines with 4px around them; a submenu
 * indented 10px with 34px rows at 500 13px; a footnote at 400 12/1.4 muted.
 */
export type MenuItem =
  | { kind: "item"; label: string; keys?: string; disabled?: boolean; onSelect: () => void }
  | { kind: "sub"; label: string; open: boolean; onToggle: () => void; items: { label: string; note?: string; onSelect: () => void }[] }
  | { kind: "divider" }
  | { kind: "note"; text: string };

export default function Menu({ x, y, title, items, onClose }: { x: number; y: number; title: ReactNode; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("pointerdown", away); window.removeEventListener("keydown", key); };
  }, [onClose]);
  // Keep it on screen: flip left / up when it would spill past the viewport.
  const left = typeof window !== "undefined" && x + 228 + 8 > window.innerWidth ? x - 228 : x;
  const top = typeof window !== "undefined" && y + 320 > window.innerHeight ? Math.max(8, window.innerHeight - 330) : y;
  const row = "flex h-[36px] w-full items-center justify-between rounded-ctl bg-transparent px-[10px] text-left text-[13.5px] font-medium leading-none hover:bg-[rgba(245,246,248,.08)]";
  return (
    <div ref={ref} role="menu" style={{ left, top }}
      className="fixed z-[20] flex w-[228px] flex-col rounded-card border border-[rgba(245,246,248,.18)] bg-card p-[6px] text-ink">
      <Mono className="px-[10px] pb-[6px] pt-[8px]">{title}</Mono>
      {items.map((it, i) => {
        if (it.kind === "divider") return <span key={i} className="my-[4px] h-px bg-border" />;
        if (it.kind === "note") return <span key={i} className="px-[10px] pb-[8px] pt-[6px] text-[12px] leading-[1.4] text-ink-muted">{it.text}</span>;
        if (it.kind === "sub") return (
          <div key={i} className="flex flex-col">
            <button type="button" role="menuitem" onClick={it.onToggle} className={row}>
              {it.label}<span className="ui-mono tracking-normal text-ink-muted">▸</span>
            </button>
            {it.open && (
              <div className="flex flex-col py-[2px] pl-[10px]">
                {it.items.map((s, k) => (
                  <button key={`${k}-${s.label}`} type="button" role="menuitem" onClick={s.onSelect}
                    className="flex h-[34px] w-full items-center justify-between rounded-ctl px-[10px] text-left text-[13px] font-medium leading-none hover:bg-[rgba(245,246,248,.08)]">
                    {s.label}{s.note && <Mono cost>{s.note}</Mono>}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
        return (
          <button key={i} type="button" role="menuitem" disabled={it.disabled} onClick={it.onSelect}
            className={`${row} ${it.disabled ? "text-ink-muted" : "text-ink"}`}>
            {it.label}{it.keys && <Mono cost>{it.keys}</Mono>}
          </button>
        );
      })}
    </div>
  );
}
