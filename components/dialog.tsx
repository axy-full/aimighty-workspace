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
      className="fixed inset-0 z-[95] grid place-items-center bg-black/55 p-5"
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
        className="w-[min(92vw,360px)] rounded-[14px] border border-line bg-panel2 p-4 shadow-[var(--shadow)]"
      >
        <p className="ptitle text-[14px] text-bone">{current.title}</p>
        {current.message && (
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-dim">{current.message}</p>
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
        <div className="mt-4 flex justify-end gap-2">
          {current.kind !== "alert" && (
            <button onClick={cancel} className="chip !py-2 px-4 !text-dim">Cancel</button>
          )}
          <button
            onClick={confirm} autoFocus={current.kind !== "prompt"}
            className={`h-[34px] rounded-[10px] px-4 text-[12.5px] font-semibold text-white ${
              current.danger ? "bg-red" : current.kind === "alert" ? "bg-chip2 !text-bone" : "bg-red"
            }`}
          >
            {current.confirmLabel ?? "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}
