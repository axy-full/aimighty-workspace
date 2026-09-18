"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * The bottom toast (design/particl-v2/README.md §7; board 4b): every action
 * on the grid narrates here — `SH11 moved to Saltwater · 2 takes and 38 cr
 * went with it` — above the suite navigation, centred: ink on ground, radius
 * 12, `12px 16px`, Outfit 500 13.5px, and when the action can be undone a
 * 30px `Undo` pill (1px at .25 of ground) 14px after the words. It stays
 * six seconds; a new one replaces it.
 */
type Toast = { id: number; text: string; undo?: () => void };
type Ctx = { show: (text: string, undo?: () => void) => void };
const ToastCtx = createContext<Ctx>({ show: () => {} });

export function ToastHost({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);
  const show = useCallback((text: string, undo?: () => void) => {
    seq.current += 1;
    setToast({ id: seq.current, text, undo });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 6000);
  }, []);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return (
    <ToastCtx.Provider value={{ show }}>
      {children}
      {toast && (
        <div role="status" style={{ bottom: "calc(76px + env(safe-area-inset-bottom, 0px))" }} className="fixed left-1/2 z-[20] flex max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-[14px] whitespace-normal rounded-card bg-ink px-[16px] py-[12px] text-[13.5px] font-medium leading-snug text-ground">
          {toast.text}
          {toast.undo && (
            <button type="button" onClick={() => { toast.undo?.(); setToast(null); }}
              className="h-[30px] shrink-0 rounded-pill border border-[rgba(11,13,17,.25)] bg-transparent px-[12px] text-[13px] font-medium leading-none text-ground">
              Undo
            </button>
          )}
        </div>
      )}
    </ToastCtx.Provider>
  );
}

export function useToast(): Ctx["show"] {
  return useContext(ToastCtx).show;
}
