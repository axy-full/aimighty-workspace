"use client";

import { useEffect, useRef, useState } from "react";
import { Download, Film, Loader2 } from "lucide-react";
import { safeName, type Project } from "@/lib/workbench/studio";
import {
  defaultMovieOptions,
  movieDimensions,
  moviePlan,
  type MovieFormat,
} from "@/lib/workbench/movie";
import type {
  MovieCapability,
  MovieProgress,
} from "@/lib/workbench/render-movie";

export function MovieExport({
  project,
  scope,
}: {
  project: Project;
  scope: string;
}) {
  const [options, setOptions] = useState(defaultMovieOptions);
  const [capabilities, setCapabilities] = useState<{
    key: string;
    formats: MovieCapability[];
    error?: string;
  } | null>(null);
  const [progress, setProgress] = useState<MovieProgress | null>(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{
    url: string;
    name: string;
    fingerprint: string;
    audio: boolean;
    reduced: boolean;
    width: number;
    height: number;
    seconds: number;
  } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const capabilityKey = `${project.aspect}:${options.resolution}`;
  const fingerprint = JSON.stringify([
    project.fps,
    project.aspect,
    project.shots,
    project.assets,
    project.audioAssetId,
    options,
  ]);
  useEffect(() => {
    let active = true;
    import("@/lib/workbench/render-movie")
      .then((module) =>
        module.movieCapabilities(project.aspect, options.resolution),
      )
      .then((formats) => {
        if (active) setCapabilities({ key: capabilityKey, formats });
      })
      .catch(() => {
        if (active)
          setCapabilities({
            key: capabilityKey,
            formats: [],
            error:
              "Video encoding could not be loaded. Reload this page and try again.",
          });
      });
    return () => {
      active = false;
    };
  }, [capabilityKey, project.aspect, options.resolution]);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(
    () => () => {
      if (result) URL.revokeObjectURL(result.url);
    },
    [result],
  );
  const formats =
    capabilities?.key === capabilityKey ? capabilities.formats : null;
  const format = formats?.some((item) => item.format === options.format)
    ? options.format
    : formats?.[0]?.format;
  let invalid = "";
  let size: { width: number; height: number } | null = null;
  try {
    moviePlan(project, options);
    size = movieDimensions(project.aspect, options.resolution);
  } catch (cause) {
    invalid = (cause as Error).message;
  }
  async function render() {
    if (controller.current || invalid || !format) return;
    const abort = new AbortController();
    controller.current = abort;
    const snapshot = structuredClone(project);
    setError("");
    setProgress({ phase: "Loading media", fraction: 0 });
    setResult(null);
    try {
      const account = await fetch("/api/me", {
        signal: abort.signal,
        cache: "no-store",
      });
      let activeScope = "particl-active-visitor-visitor";
      if (account.ok) {
        const me = await account.json();
        activeScope = `particl-active-${me.workspace?.id || "visitor"}-${me.id || "visitor"}`;
      } else if (account.status !== 401)
        throw new Error("Your account could not be verified. Try again.");
      if (activeScope !== scope)
        throw new Error(
          "Your account or workspace changed. Return to Delivery to prepare a new export.",
        );
      const { renderMovie } = await import("@/lib/workbench/render-movie");
      const movie = await renderMovie(
        snapshot,
        { ...options, format },
        {
          signal: abort.signal,
          onProgress: (value) => {
            if (!abort.signal.aborted) setProgress(value);
          },
        },
      );
      abort.signal.throwIfAborted();
      setResult({
        url: URL.createObjectURL(movie.blob),
        name: `${safeName(snapshot.name)}_${movie.width}x${movie.height}_${snapshot.fps}fps.${movie.format}`,
        fingerprint,
        audio: movie.hasAudio,
        reduced: movie.mixGain < 1,
        width: movie.width,
        height: movie.height,
        seconds: movie.duration,
      });
    } catch (cause) {
      if (!abort.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : "Movie export failed. Try a shorter sequence or 720p.",
        );
    } finally {
      if (controller.current === abort) {
        controller.current = null;
        setProgress(null);
      }
    }
  }
  return (
    <section className="movie-export" aria-labelledby="movie-export-title">
      <div className="movie-heading">
        <Film size={21} />
        <div>
          <h3 id="movie-export-title">Final movie</h3>
          <p>
            Render the selected takes and sound into one downloadable video.
          </p>
        </div>
      </div>
      <fieldset disabled={!!progress} className="movie-settings">
        <label>
          Format
          <select
            aria-label="Movie format"
            value={format || ""}
            disabled={!formats?.length}
            onChange={(event) =>
              setOptions((old) => ({
                ...old,
                format: event.target.value as MovieFormat,
              }))
            }
          >
            {!formats?.length && (
              <option value="">
                {formats ? "Unavailable" : "Checking browser…"}
              </option>
            )}
            {formats?.map((item) => (
              <option key={item.format} value={item.format}>
                {item.format === "mp4"
                  ? "MP4 · H.264 / AAC"
                  : "WebM · VP9 or VP8 / Opus"}
              </option>
            ))}
          </select>
        </label>
        <label>
          Resolution
          <select
            aria-label="Movie resolution"
            value={options.resolution}
            onChange={(event) =>
              setOptions((old) => ({
                ...old,
                resolution: Number(event.target.value) as 720 | 1080,
              }))
            }
          >
            <option value={720}>720p</option>
            <option value={1080}>1080p</option>
          </select>
        </label>
        <label>
          Framing
          <select
            aria-label="Movie framing"
            value={options.fit}
            onChange={(event) =>
              setOptions((old) => ({
                ...old,
                fit: event.target.value as "contain" | "cover",
              }))
            }
          >
            <option value="contain">Fit · preserve full frame</option>
            <option value="cover">Fill · crop to aspect</option>
          </select>
        </label>
        <label className="movie-audio-option">
          <input
            type="checkbox"
            checked={options.clipAudio}
            onChange={(event) =>
              setOptions((old) => ({ ...old, clipAudio: event.target.checked }))
            }
          />
          Include original clip audio
        </label>
        <label className="movie-audio-option">
          <input
            type="checkbox"
            checked={options.soundtrack}
            disabled={!project.audioAssetId}
            onChange={(event) =>
              setOptions((old) => ({
                ...old,
                soundtrack: event.target.checked,
              }))
            }
          />
          {project.audioAssetId
            ? "Include sequence soundtrack"
            : "No sequence soundtrack selected"}
        </label>
      </fieldset>
      <p className="movie-spec">
        {size ? `${size.width} × ${size.height} · ` : ""}
        {project.fps} fps · {project.aspect} · SDR
      </p>
      <p className="movie-limit">
        Rendered on this device, with no generation credits. Up to 3 minutes and
        200 MB of sources and output. Straight cuts; stills hold. The soundtrack
        starts at 00:00 and ends with the sequence. Keep this page open.{" "}
        <a href="/licenses/mediabunny.txt" target="_blank" rel="noreferrer">
          Media toolkit license
        </a>
        .
      </p>
      {formats && !formats.length && (
        <p role="alert">
          {capabilities?.error ||
            "This browser does not offer the required video and audio encoders. Use current desktop Chrome or Edge, or download the editorial package."}
        </p>
      )}
      {(error || invalid) && <p role="alert">{error || invalid}</p>}
      {progress ? (
        <div className="movie-progress" role="status">
          <span>
            <Loader2 className="spin" size={16} />
            {progress.phase} · {Math.round(progress.fraction * 100)}%
          </span>
          <progress max={1} value={progress.fraction} />
          <button className="btn" onClick={() => controller.current?.abort()}>
            Cancel movie render
          </button>
        </div>
      ) : (
        <button
          className="btn primary large"
          onClick={() => void render()}
          disabled={!!invalid || !format}
        >
          <Film size={17} />
          Render movie
        </button>
      )}
      {result && (
        <div className="movie-result">
          <p role="status">
            {result.fingerprint === fingerprint
              ? "Final movie ready"
              : "Movie from an earlier edit · render again to update"}{" "}
            · {result.width} × {result.height} · {result.seconds.toFixed(2)}s ·{" "}
            {result.audio ? "Audio included" : "Silent"}
            {result.reduced ? " · Mix reduced to prevent clipping" : ""}
          </p>
          <video
            src={result.url}
            controls
            playsInline
            preload="metadata"
            aria-label="Rendered final movie"
          />
          <a
            className="btn primary large"
            href={result.url}
            download={result.name}
          >
            <Download size={17} />
            Download {result.name.endsWith(".mp4") ? "MP4" : "WebM"}
          </a>
        </div>
      )}
    </section>
  );
}
