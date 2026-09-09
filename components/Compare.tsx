"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMoney } from "@/lib/price";
import { compareSet, compareColumns } from "@/lib/compare";
import type { Gen } from "@/components/GenCard";

/**
 * Two to four takes of one shot, side by side and in step (brief 2.1).
 *
 * One transport drives every clip: play, pause, scrub and loop together, so
 * the difference between takes is the only thing moving. Each tile carries
 * its version, what it cost and its state, and Pick and Approve are one tap
 * — this is the screen a producer holds on a phone, so the taps are big and
 * the grid is two across before it is four.
 */
export default function Compare({ takes, code, onClose, onChanged, onOpen }: {
  takes: Gen[];
  code: string;
  onClose: () => void;
  onChanged?: () => void;
  onOpen?: (id: string) => void;
}) {
  const money = useMoney();
  const set = useMemo(() => compareSet(takes), [takes]);
  const refs = useRef<(HTMLVideoElement | null)[]>([]);
  const [playing, setPlaying] = useState(true);
  const [at, setAt] = useState(0);
  const [span, setSpan] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [states, setStates] = useState<Record<string, string>>(
    () => Object.fromEntries(set.map((t) => [t.id, t.reviewState ?? ""])),
  );

  const each = useCallback((fn: (v: HTMLVideoElement) => void) => {
    refs.current.forEach((v) => { if (v) fn(v); });
  }, []);

  /* The transport: every clip takes its cue from the first one that can play. */
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const lead = refs.current.find(Boolean);
      if (lead) { setAt(lead.currentTime); if (lead.duration && Number.isFinite(lead.duration)) setSpan(lead.duration); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    if (playing) each((v) => { void v.play().catch(() => { /* it will join on loadeddata */ }); });
    else each((v) => v.pause());
  }, [playing, each, set.length]);

  /* Escape closes, space plays and pauses: this screen is watched, not typed in. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === " " || e.code === "Space") { e.preventDefault(); setPlaying((p) => !p); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function seek(to: number) {
    each((v) => { v.currentTime = to; });
    setAt(to);
  }

  async function mark(gen: Gen, next: "picked" | "approved") {
    const now = states[gen.id] === next ? "" : next;
    setBusy(gen.id);
    try {
      const res = await fetch(`/api/jobs/${gen.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewState: now }),
      });
      if (!res.ok) throw new Error(`The server answered ${res.status}.`);
      setStates((s) => ({ ...s, [gen.id]: now }));
      onChanged?.();
    } catch { /* the wall's own refresh will show what actually stuck */ }
    finally { setBusy(null); }
  }

  if (!set.length) return null;
  const cols = compareColumns(set.length);

  return (
    <div className="cmp" role="dialog" aria-label={`Compare takes of ${code}`}>
      <div className="cmp-head">
        <span className="mono-s">{code} · {set.length} TAKES · IN STEP</span>
        <button type="button" className="chip ml-auto" onClick={onClose}>Close</button>
      </div>

      <div className="cmp-grid" style={{ "--cmp-cols": cols } as React.CSSProperties}>
        {set.map((t, i) => {
          const state = states[t.id] ?? "";
          return (
            <div key={t.id} className={`cmp-cell ${state ? `is-${state}` : ""}`}>
              <div className="cmp-media">
                <video
                  ref={(el) => { refs.current[i] = el; }}
                  src={t.storedUrl ?? undefined}
                  muted playsInline loop preload="auto"
                  /* A clip that was still loading when the transport started
                     would sit at zero for ever: it joins as soon as it can. */
                  onLoadedData={(e) => { if (playing) void e.currentTarget.play().catch(() => {}); }}
                  onClick={() => onOpen?.(t.id)}
                />
                <span className="cmp-badge mono-s">v{t.version ?? 1}</span>
              </div>
              <div className="cmp-foot">
                <span className="mono-s">{state ? state.toUpperCase() : "DRAFT"} · {money.take(t)}</span>
                <span className="cmp-acts">
                  <button type="button" aria-pressed={state === "picked"}
                    className={`chip !py-1 ${state === "picked" ? "is-on" : ""}`} disabled={busy != null} onClick={() => mark(t, "picked")}>
                    {state === "picked" ? "Picked" : "Pick"}
                  </button>
                  <button type="button" aria-pressed={state === "approved"}
                    className={`chip !py-1 ${state === "approved" ? "is-on" : ""}`} disabled={busy != null} onClick={() => mark(t, "approved")}>
                    {state === "approved" ? "Approved" : "Approve"}
                  </button>
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="cmp-bar">
        <button type="button" className="chip" onClick={() => setPlaying((p) => !p)} aria-label={playing ? "Pause" : "Play"}>
          {playing ? "Pause" : "Play"}
        </button>
        <input className="cmp-scrub" type="range" min={0} max={Math.max(0.1, span)} step={0.05} value={Math.min(at, span || 0)}
          aria-label="Position in every take" onChange={(e) => seek(Number(e.target.value))} />
        <span className="mono-s">{at.toFixed(1)}s{span ? ` / ${span.toFixed(1)}s` : ""}</span>
      </div>
    </div>
  );
}
