"use client";
import { useRef, useState, type ReactNode } from "react";

/**
 * The Inspector's 16:9 output: the real media, a 3px blue playhead and a
 * Play/Pause chip for anything with time. Stills and flat blocks have no
 * transport, so they show none. Key it by URL so a new subject starts stopped.
 */
export function MediaPreview({ url, media, fallback, label }: {
  url: string | null;
  media: "image" | "video" | "audio" | null;
  fallback: ReactNode;
  label: string;
}) {
  const player = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [pct, setPct] = useState(0);
  const timed = Boolean(url) && (media === "video" || media === "audio");
  const toggle = () => {
    const el = player.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => setPlaying(false));
    else el.pause();
  };
  const events = {
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    onEnded: () => setPlaying(false),
    onTimeUpdate: (e: { currentTarget: HTMLMediaElement }) => {
      const { currentTime, duration } = e.currentTarget;
      setPct(Number.isFinite(duration) && duration > 0 ? (currentTime / duration) * 100 : 0);
    },
  };
  return (
    <div className="pxw-preview pxw-insp-preview" data-testid="inspector-preview">
      {url && media === "image" ? (
        // eslint-disable-next-line @next/next/no-img-element -- workspace-scoped media route, as the workbench library
        <img src={url} alt={label} />
      ) : url && media === "video" ? (
        <video ref={player} src={url} playsInline preload="metadata" aria-label={label} {...events} />
      ) : (
        <>
          {fallback}
          {url && media === "audio" ? <audio ref={player} src={url} preload="metadata" aria-label={label} {...events} /> : null}
        </>
      )}
      {timed ? (
        <>
          <div className="pxw-playhead" aria-hidden="true"><div style={{ width: `${pct}%` }} /></div>
          <button type="button" className="pxw-play-chip" onClick={toggle} aria-pressed={playing}>
            {playing ? "Pause" : "Play"}
          </button>
        </>
      ) : null}
    </div>
  );
}
