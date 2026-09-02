"use client";

import { useEffect, useRef, useState } from "react";

/**
 * In-app dialogs. iOS home-screen web apps (the mode the team installs for
 * push) have a history of suppressing window.prompt/confirm/alert — and the
 * native ones look foreign anyway. These render themed, promise-based
 * replacements. If the host isn't mounted (auth pages), they fall back to
 * the browser natives.
 */

type Spec = {
  id?: number;
  kind: "alert" | "confirm" | "prompt";
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  danger?: boolean;
  resolve: (v: string | boolean | null) => void;
};

let pushDialog: ((d: Spec) => void) | null = null;

export function appAlert(title: string, message?: string): Promise<void> {
  if (!pushDialog) { window.alert(message ? `${title}\n\n${message}` : title); return Promise.resolve(); }
  return new Promise((res) =>
    pushDialog!({ kind: "alert", title, message, confirmLabel: "OK", resolve: () => res() })
  );
}

export function appConfirm(
  title: string,
  message?: string,
  opts: { confirmLabel?: string; danger?: boolean } = {}
): Promise<boolean> {
  if (!pushDialog) return Promise.resolve(window.confirm(message ? `${title}\n\n${message}` : title));
  return new Promise((res) =>
    pushDialog!({
      kind: "confirm", title, message,
      confirmLabel: opts.confirmLabel ?? "Confirm", danger: opts.danger,
      resolve: (v) => res(Boolean(v)),
    })
  );
}

export function appPrompt(
  title: string, defaultValue = "", placeholder?: string
): Promise<string | null> {
  if (!pushDialog) return Promise.resolve(window.prompt(title, defaultValue));
  return new Promise((res) =>
    pushDialog!({
      kind: "prompt", title, defaultValue, placeholder, confirmLabel: "Save",
      resolve: (v) => res(typeof v === "string" ? v : null),
    })
  );
}

let dialogSeq = 0;

export default function DialogHost() {
  const [queue, setQueue] = useState<Spec[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const downOnBackdrop = useRef(false);
  const current = queue[0] ?? null;

  useEffect(() => {
    pushDialog = (d) => setQueue((q) => [...q, { ...d, id: ++dialogSeq }]);
    return () => { pushDialog = null; };
  }, []);

  // Escape must work wherever focus happens to be — a React onKeyDown on the
  // overlay only fires while focus is inside it.
  const currentId = current?.id;
  useEffect(() => {
    if (currentId == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setQueue((q) => {
          const [head, ...rest] = q;
          head?.resolve(head.kind === "prompt" ? null : head.kind === "confirm" ? false : true);
          return rest;
        });
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [currentId]);

  if (!current) return null;

  function settle(v: string | boolean | null) {
    current!.resolve(v);
    setQueue((q) => q.slice(1));
  }
  const cancel = () =>
    settle(current.kind === "prompt" ? null : current.kind === "confirm" ? false : true);
  const confirm = () =>
    settle(current.kind === "prompt" ? inputRef.current?.value ?? "" : true);

  return (
    <div
      className="fixed inset-0 z-[95] grid place-items-center bg-scrim p-5 backdrop-blur-[2px]"
      // Dismiss only a true backdrop click — not a drag that ends outside the
      // card — and never let it reach the page's own click-away listeners.
      onPointerDown={(e) => { downOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        e.stopPropagation();
        if (downOnBackdrop.current && e.target === e.currentTarget) cancel();
      }}
    >
      <div
        key={current.id}
        role="dialog" aria-modal="true" aria-label={current.title}
        onClick={(e) => e.stopPropagation()}
        className="w-[min(92vw,340px)] rounded-[18px] bg-panel p-5 shadow-[var(--shadow-pop)]"
      >
        <p className="text-center text-[17px] font-semibold tracking-[-0.01em]">{current.title}</p>
        {current.message && (
          <p className="mt-1.5 text-center text-[14px] leading-relaxed text-dim">{current.message}</p>
        )}
        {current.kind === "prompt" && (
          <input
            ref={inputRef}
            autoFocus
            className="ctl mt-3"
            defaultValue={current.defaultValue}
            placeholder={current.placeholder}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); confirm(); } }}
          />
        )}
        <div className="mt-5 flex gap-2">
          {current.kind !== "alert" && (
            <button onClick={cancel} className="chip flex-1 justify-center !py-2.5 !text-[15px] !text-dim">Cancel</button>
          )}
          <button
            onClick={confirm} autoFocus={current.kind !== "prompt"}
            className={`flex-1 rounded-full py-2.5 text-[15px] font-semibold text-white ${
              current.danger ? "bg-lift" : current.kind === "alert" ? "bg-blue" : "bg-blue"
            }`}
          >
            {current.confirmLabel ?? "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}
