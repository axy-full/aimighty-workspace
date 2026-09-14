"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Which model does the thinking.
 *
 * The server offers only verified Supercomputer thinking models which are
 * connected through the gateway. Each row carries a cost BAND rather than
 * a rate. "Low cost" answers the question people actually have; "$2.00 per
 * million output tokens" does not, unless they already know how many
 * tokens a conversation takes, which nobody does.
 */

export type PlannerModel = {
  id: string; name: string; owner: string;
  description: string; band: string; price: string;
};

export default function ModelMenu({ value, models, onPick, disabled }: {
  value: string;
  models: { featured: PlannerModel[]; rest: PlannerModel[] };
  onPick: (id: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const wrap = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => search.current?.focus(), 30);
    const away = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const all = useMemo(() => [...models.featured, ...models.rest], [models]);
  const current = value === "auto" ? null : all.find((m) => m.id === value);

  const hits = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return null;
    return all.filter((m) =>
      m.id.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle)
    ).slice(0, 40);
  }, [q, all]);

  return (
    <div ref={wrap} className="relative">
      <button type="button" disabled={disabled}
        onClick={() => { setQ(""); setOpen((v) => !v); }}
        className={`chip-ctl ${open ? "is-open" : ""}`}
        title="Which model does the thinking">
        {current ? current.name : value === "auto" ? "Auto" : "Choose model"}
        <span className="chip-caret" aria-hidden>⌄</span>
      </button>

      {open && (
        <div className="atomik-models pop-surface" role="menu">
          <input ref={search} value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search models" className="atomik-search" />

          <div className="atomik-models-body">
            {!hits && (
              <>
                <Row
                  m={{
                    id: "auto", name: "Auto", owner: "", band: "",
                    description: "Selects from the supported, connected thinking models",
                    price: "",
                  }}
                  on={value === "auto"}
                  onPick={() => { setOpen(false); onPick("auto"); }}
                />
                <p className="atomik-models-head">Featured</p>
                {models.featured.map((m) => (
                  <Row key={m.id} m={m} on={m.id === value}
                    onPick={() => { setOpen(false); onPick(m.id); }} />
                ))}
                {models.rest.length > 0 && (
                  <p className="atomik-models-note">
                    {models.rest.length} more — search to find them.
                  </p>
                )}
              </>
            )}
            {hits && hits.length === 0 && (
              <p className="atomik-models-note">Nothing matching “{q}”.</p>
            )}
            {hits && hits.map((m) => (
              <Row key={m.id} m={m} on={m.id === value}
                onPick={() => { setOpen(false); onPick(m.id); }} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ m, on, onPick }: { m: PlannerModel; on: boolean; onPick: () => void }) {
  return (
    <button type="button" onClick={onPick} role="menuitemradio" aria-checked={on}
      className={`atomik-model ${on ? "is-on" : ""}`}>
      <span className="min-w-0 flex-1">
        <span className="atomik-model-name">
          {m.name}
          {m.band && <span className={`atomik-band band-${m.band.split(" ")[0].toLowerCase()}`}>{m.band}</span>}
        </span>
        {m.description && <span className="atomik-model-note">{m.description}</span>}
      </span>
      {on && (
        <svg viewBox="0 0 14 14" aria-hidden className="h-3.5 w-3.5 shrink-0 text-blue">
          <path d="M2 7.5 5.5 11 12 3.5" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}
