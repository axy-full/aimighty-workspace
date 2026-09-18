"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Maximize, Pause, Play, RotateCcw } from "lucide-react";
import styles from "./subatomik.module.css";

const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")}`;

/** Both retained originals share one playback clock; changing the view does not reload media. */
export function SyncedVideoComparison({
  before,
  after,
  afterLabel,
  unavailable,
}: {
  before: string | null;
  after: string | null;
  afterLabel: string;
  unavailable: string;
}) {
  const source = useRef<HTMLVideoElement>(null),
    result = useRef<HTMLVideoElement>(null);
  const container = useRef<HTMLDivElement>(null),
    playAttempt = useRef(0);
  const [view, setView] = useState<"split" | "wipe">("split"),
    [wipe, setWipe] = useState(50);
  const [playing, setPlaying] = useState(false),
    [position, setPosition] = useState(0),
    [duration, setDuration] = useState(0),
    [aspect, setAspect] = useState("16 / 9");
  const [error, setError] = useState("");
  const [volume, setVolume] = useState(1),
    [speed, setSpeed] = useState(1);
  const lifetime = useRef(0);
  const paired = !!before && !!after;
  useEffect(() => {
    const token = ++lifetime.current;
    return () => {
      lifetime.current = token + 1;
    };
  }, []);
  function pause() {
    playAttempt.current++;
    source.current?.pause();
    result.current?.pause();
    setPlaying(false);
  }
  function metadata() {
    const a = source.current,
      b = result.current;
    if (a?.videoWidth && a.videoHeight)
      setAspect(`${a.videoWidth} / ${a.videoHeight}`);
    if (a && b && Number.isFinite(a.duration) && Number.isFinite(b.duration))
      setDuration(Math.min(a.duration, b.duration));
  }
  function seek(seconds: number) {
    const time = Math.max(0, Math.min(duration, seconds));
    if (source.current) source.current.currentTime = time;
    if (result.current) result.current.currentTime = time;
    setPosition(time);
  }
  async function play() {
    const a = source.current,
      b = result.current,
      token = lifetime.current,
      attempt = ++playAttempt.current;
    if (!a || !b || !duration) return;
    setError("");
    if (a.currentTime >= duration - 0.05) seek(0);
    else b.currentTime = Math.min(a.currentTime, duration);
    try {
      await Promise.all([a.play(), b.play()]);
      if (lifetime.current === token && playAttempt.current === attempt)
        setPlaying(true);
      else {
        a.pause();
        b.pause();
      }
    } catch {
      a.pause();
      b.pause();
      if (lifetime.current === token && playAttempt.current === attempt) {
        setPlaying(false);
        setError(
          "The originals could not play together. Check that both files remain available, then try again.",
        );
      }
    }
  }
  function tick() {
    const a = source.current,
      b = result.current;
    if (!a || !b || !paired) return;
    const time = Math.min(a.currentTime, duration || a.currentTime);
    setPosition(time);
    if (Math.abs(b.currentTime - time) > 0.12 && b.readyState >= 1)
      b.currentTime = time;
    if (duration > 0 && a.currentTime >= duration - 0.025) pause();
  }
  function failed() {
    pause();
    setError(
      "One comparison original could not be loaded. The take’s saved settings and receipt remain available.",
    );
  }
  function fullscreen() {
    if (!container.current?.requestFullscreen) {
      setError("Fullscreen is not available in this browser.");
      return;
    }
    if (document.fullscreenElement === container.current)
      void document
        .exitFullscreen()
        .catch(() => setError("Fullscreen could not be closed."));
    else
      void container.current
        .requestFullscreen()
        .catch(() => setError("Fullscreen is not available in this browser."));
  }
  return (
    <div
      ref={container}
      className={styles.comparisonPlayer}
      aria-label="Synchronized video comparison"
    >
      <div className={styles.row}>
        <div
          className={styles.viewToggle}
          role="group"
          aria-label="Comparison view"
        >
          <button
            type="button"
            aria-pressed={view === "split"}
            onClick={() => setView("split")}
          >
            Split view
          </button>
          <button
            type="button"
            aria-pressed={view === "wipe"}
            disabled={!paired}
            onClick={() => setView("wipe")}
          >
            Wipe view
          </button>
        </div>
        {paired && (
          <small className={styles.hint}>Linked playback · source audio</small>
        )}
      </div>
      <div
        className={styles.compareStage}
        data-comparison-view={view}
        style={{ "--comparison-aspect": aspect } as CSSProperties}
      >
        <figure className={styles.compareBefore}>
          <figcaption>Before · source original</figcaption>
          {before ? (
            <video
              ref={source}
              aria-label="Genjutsu before preview"
              src={before}
              controls={!paired}
              playsInline
              preload="metadata"
              onLoadedMetadata={metadata}
              onTimeUpdate={tick}
              onEnded={pause}
              onError={failed}
            />
          ) : (
            <p>The source preview is unavailable for this saved take.</p>
          )}
        </figure>
        <figure
          className={styles.compareAfter}
          style={
            view === "wipe"
              ? { clipPath: `inset(0 ${100 - wipe}% 0 0)` }
              : undefined
          }
        >
          <figcaption>After · {afterLabel}</figcaption>
          {after ? (
            <video
              ref={result}
              aria-label="Genjutsu after preview"
              src={after}
              controls={!paired}
              muted={paired}
              playsInline
              preload="metadata"
              onLoadedMetadata={metadata}
              onEnded={pause}
              onError={failed}
            />
          ) : (
            <p>{unavailable}</p>
          )}
        </figure>
        {view === "wipe" && (
          <span
            className={styles.wipeDivider}
            aria-hidden="true"
            style={{ left: `${wipe}%` }}
          />
        )}
      </div>
      {paired && (
        <>
          {view === "wipe" && (
            <label className={styles.comparisonControl}>
              Before / after wipe
              <input
                type="range"
                aria-label="Comparison wipe position"
                aria-valuetext={`${wipe}% after, ${100 - wipe}% before`}
                min={0}
                max={100}
                step={1}
                value={wipe}
                onChange={(event) => setWipe(Number(event.target.value))}
              />
            </label>
          )}
          <div className={styles.transport}>
            <button
              type="button"
              disabled={!duration}
              onClick={() => (playing ? pause() : void play())}
              aria-label={playing ? "Pause comparison" : "Play comparison"}
            >
              {playing ? <Pause size={16} /> : <Play size={16} />}
            </button>
            <button
              type="button"
              disabled={!duration}
              onClick={() => {
                pause();
                seek(0);
              }}
              aria-label="Restart comparison"
            >
              <RotateCcw size={15} />
            </button>
            <input
              type="range"
              aria-label="Comparison playback position"
              aria-valuetext={`${position.toFixed(1)} of ${duration.toFixed(1)} seconds`}
              min={0}
              max={duration || 1}
              step={0.01}
              value={position}
              disabled={!duration}
              onChange={(event) => seek(Number(event.target.value))}
            />
            <output>
              {clock(position)} / {clock(duration)}
            </output>
          </div>
          <div className={styles.playbackOptions}>
            <label>
              Source volume
              <input
                type="range"
                aria-label="Comparison source volume"
                min={0}
                max={1}
                step={0.05}
                value={volume}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setVolume(next);
                  if (source.current) source.current.volume = next;
                }}
              />
            </label>
            <label>
              Speed
              <select
                aria-label="Comparison playback speed"
                value={speed}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setSpeed(next);
                  if (source.current) source.current.playbackRate = next;
                  if (result.current) result.current.playbackRate = next;
                }}
              >
                {[0.25, 0.5, 1, 1.5, 2].map((value) => (
                  <option key={value} value={value}>
                    {value}×
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="suite-button" onClick={fullscreen}>
              <Maximize size={14} />
              Fullscreen comparison
            </button>
          </div>
          {!duration && !error && (
            <p className={styles.hint} role="status">
              Loading both originals for linked playback…
            </p>
          )}
        </>
      )}
      {error && (
        <p className={styles.error} role="status">
          {error}
        </p>
      )}
    </div>
  );
}
