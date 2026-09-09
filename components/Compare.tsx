"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMoney } from "@/lib/price";
import { compareSet, compareColumns } from "@/lib/compare";
import { groupSpan, clockIndex, tileTarget, needsCorrection, readout } from "@/lib/transport";
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

  /** Which takes have run out while the longest is still playing. */
  const [ended, setEnded] = useState<boolean[]>([]);
  /* Which tile is the clock. Held in state rather than worked out at render
     time, because that would mean reading refs during a render. Only the
     clock's own end wraps the group — a shorter take reaching its end must
     not drag everyone back to zero. */
  const [clockAt, setClockAt] = useState(-1);

  /* The transport, and the whole point of this screen: one clock, and every
     other clip CORRECTED to it rather than merely told to play.

     The clock is the longest take — see lib/transport.ts. Reading position
     off real media time means a stall holds the group together instead of
     racing ahead; taking it off the LONGEST means the reading stays true
     past the point where a shorter take has ended. */
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const vids = refs.current;
      const durations = vids.map((v) => (v && Number.isFinite(v.duration) ? v.duration : null));
      const span = groupSpan(durations);
      const ci = clockIndex(durations);
      const clock = ci >= 0 ? vids[ci] : null;

      if (clock && span > 0) {
        const pos = clock.currentTime;
        setAt(pos);
        setSpan(span);
        setClockAt(ci);

        const out: boolean[] = [];
        vids.forEach((v, i) => {
          if (!v) { out[i] = false; return; }
          const { time, ended: done } = tileTarget(pos, durations[i]);
          out[i] = done;
          if (i !== ci && needsCorrection(v.currentTime, time)) v.currentTime = time;
          // A take that has run out holds its last frame; it must not loop
          // back to an unrelated moment while the others are still running.
          if (done && !v.paused) v.pause();
        });
        setEnded(out);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    if (playing) {
      each((v) => {
        // Don't restart a take that has already run out — the clock's wrap does that.
        if (v.duration && Number.isFinite(v.duration) && v.currentTime >= v.duration - 0.05) return;
        void v.play().catch(() => { /* it will join on loadeddata */ });
      });
    } else each((v) => v.pause());
  }, [playing, each, set.length]);

  /* The group loops as one. `loop` used to sit on every tile, so each clip
     wrapped on its own length and the grid drifted apart by design. */
  const wrap = useCallback(() => {
    each((v) => { try { v.currentTime = 0; } catch { /* not seekable yet */ } });
    if (playing) each((v) => { void v.play().catch(() => {}); });
  }, [each, playing]);

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
    refs.current.forEach((v) => {
      if (!v) return;
      const { time } = tileTarget(to, Number.isFinite(v.duration) ? v.duration : null);
      try { v.currentTime = time; } catch { /* not seekable yet */ }
    });
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
                  muted playsInline preload="auto"
                  /* No `loop` here on purpose. It used to sit on every tile,
                     so each clip wrapped on its OWN length and the grid came
                     apart the moment two takes differed. The group wraps
                     together, on the longest take. */
                  onLoadedData={(e) => {
                    /* A clip still loading when the transport started used to
                       join at ITS zero — which, if the others were already a
                       few hundred milliseconds in, left it behind for the
                       rest of the session. It joins where the group IS. */
                    const v = e.currentTarget;
                    const { time } = tileTarget(at, Number.isFinite(v.duration) ? v.duration : null);
                    try { v.currentTime = time; } catch { /* not seekable yet */ }
                    if (playing) void v.play().catch(() => {});
                  }}
                  onEnded={() => { if (i === clockAt) wrap(); }}
                  onClick={() => onOpen?.(t.id)}
                />
                <span className="cmp-badge mono-s">v{t.version ?? 1}</span>
                {ended[i] && <span className="cmp-ended mono-s">ENDED</span>}
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
        <span className="mono-s">{readout(at, span)}</span>
      </div>
    </div>
  );
}
