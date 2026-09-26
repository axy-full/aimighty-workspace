"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Mono from "./Mono";
import Sheet from "./Sheet";
import { usePhone } from "@/lib/usePhone";

/**
 * The context menu (design/particl-v2/README.md §7; board 4b) — 228px,
 * `--card`, a .18 rule, radius 12, 6px padding, a mono title, 36px rows at
 * 500 13.5 with the shortcut in mono, a hairline, a submenu that opens in
 * place with 34px rows — and, below 768 (design/particl-v2-mobile, M3),
 * the same items as a sheet: 48px rows, the submenu as a second sheet.
 * Choosing an item closes the menu, on a desk as on a phone.
 */
export type MenuItem =
  | { kind: "item"; label: string; keys?: string; disabled?: boolean; onSelect: () => void }
  | { kind: "sub"; label: string; open: boolean; onToggle: () => void; items: { label: string; note?: string; onSelect: () => void }[] }
  | { kind: "divider" }
  | { kind: "note"; text: string };

export default function Menu({ x, y, title, items, onClose }: { x: number; y: number; title: ReactNode; items: MenuItem[]; onClose: () => void }) {
  const phone = usePhone();
  return phone ? <MenuSheet title={title} items={items} onClose={onClose} /> : <MenuDesktop x={x} y={y} title={title} items={items} onClose={onClose} />;
}

function MenuDesktop({ x, y, title, items, onClose }: { x: number; y: number; title: ReactNode; items: MenuItem[]; onClose: () => void }) {
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
                  <button key={`${k}-${s.label}`} type="button" role="menuitem" onClick={() => { s.onSelect(); onClose(); }}
                    className="flex h-[34px] w-full items-center justify-between rounded-ctl px-[10px] text-left text-[13px] font-medium leading-none hover:bg-[rgba(245,246,248,.08)]">
                    {s.label}{s.note && <Mono cost>{s.note}</Mono>}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
        return (
          <button key={i} type="button" role="menuitem" disabled={it.disabled} onClick={() => { it.onSelect(); onClose(); }}
            className={`${row} ${it.disabled ? "text-ink-muted" : "text-ink"}`}>
            {it.label}{it.keys && <Mono cost>{it.keys}</Mono>}
          </button>
        );
      })}
    </div>
  );
}

/** The same menu as a sheet on a phone (M3): 48px rows; a submenu opens as a second sheet. */
function MenuSheet({ title, items, onClose }: { title: ReactNode; items: MenuItem[]; onClose: () => void }) {
  const [sub, setSub] = useState<Extract<MenuItem, { kind: "sub" }> | null>(null);
  const row = "flex h-[48px] w-full items-center justify-between rounded-ctl px-[12px] text-left text-[14px] font-medium leading-none";
  return (
    <>
      <Sheet open onClose={onClose} label={typeof title === "string" ? title : "Menu"} size="auto" title={typeof title === "string" ? title : undefined}>
        <div role="menu" className="flex flex-col">
          {items.map((it, i) => {
            if (it.kind === "divider") return <span key={i} className="my-[4px] h-px bg-border" />;
            if (it.kind === "note") return <span key={i} className="px-[12px] pb-[8px] pt-[6px] text-[12.5px] leading-[1.4] text-ink-muted">{it.text}</span>;
            if (it.kind === "sub") return (
              <button key={i} type="button" role="menuitem" onClick={() => setSub(it)} className={`${row} text-ink`}>
                {it.label}<span className="ui-mono tracking-normal text-ink-muted">▸</span>
              </button>
            );
            return (
              <button key={i} type="button" role="menuitem" disabled={it.disabled} onClick={() => { it.onSelect(); onClose(); }}
                className={`${row} ${it.disabled ? "text-ink-muted" : "text-ink"}`}>
                {it.label}{it.keys && <Mono cost>{it.keys}</Mono>}
              </button>
            );
          })}
        </div>
      </Sheet>
      {sub && (
        <Sheet open onClose={() => setSub(null)} label={sub.label} size="auto" title={sub.label}>
          <div role="menu" className="flex flex-col">
            {sub.items.map((s, k) => (
              <button key={`${k}-${s.label}`} type="button" role="menuitem" onClick={() => { s.onSelect(); setSub(null); onClose(); }} className={`${row} text-ink`}>
                {s.label}{s.note && <Mono cost>{s.note}</Mono>}
              </button>
            ))}
            {!sub.items.length && <span className="px-[12px] py-[8px] text-[12.5px] text-ink-muted">Nothing to choose here.</span>}
          </div>
        </Sheet>
      )}
    </>
  );
}
