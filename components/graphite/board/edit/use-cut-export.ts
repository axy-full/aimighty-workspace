"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { defaultMovieOptions, movieDimensions, moviePlan, type MovieFormat } from "@/lib/workbench/movie";
import { movieScopeIsCurrent } from "@/lib/workbench/movie-handoff";
import type { MovieCapability, MovieProgress } from "@/lib/workbench/render-movie";
import { safeName, type Project } from "@/lib/workbench/studio";

/*
 * "Export the cut · free": the browser export that exists today (lib/workbench/render-movie.ts, the renderer
 * components/workbench/MovieExport.tsx drives): MP4 or WebM, encoded in this browser, up to 3 minutes, with no credits.
 * It is not a server render and says so. The hook owns the one export: its progress, Cancel, and the file it makes.
 * Nothing is sent anywhere; the sources are this workspace's own media.
 */
export type CutFile = { url: string; name: string; format: MovieFormat; width: number; height: number; seconds: number; audio: boolean; reduced: boolean };
export type Resolution = 720 | 1080;

export function useCutExport(project: Project, scope: string) {
  const [resolution, setResolution] = useState<Resolution>(defaultMovieOptions.resolution);
  const [capabilities, setCapabilities] = useState<{ key: string; formats: MovieCapability[]; error?: string } | null>(null);
  const [progress, setProgress] = useState<MovieProgress | null>(null);
  const [error, setError] = useState("");
  const [file, setFile] = useState<CutFile | null>(null);
  const controller = useRef<AbortController | null>(null);
  const key = `${project.aspect}:${resolution}`;

  useEffect(() => {
    let active = true;
    import("@/lib/workbench/render-movie")
      .then((m) => m.movieCapabilities(project.aspect, resolution))
      .then((formats) => { if (active) setCapabilities({ key, formats }); })
      .catch(() => { if (active) setCapabilities({ key, formats: [], error: "Video encoding could not be loaded. Reload this page and try again." }); });
    return () => { active = false; };
  }, [key, project.aspect, resolution]);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => () => { if (file) URL.revokeObjectURL(file.url); }, [file]);

  const formats = capabilities?.key === key ? capabilities.formats : null;
  const format: MovieFormat | undefined = formats?.some((f) => f.format === defaultMovieOptions.format) ? defaultMovieOptions.format : formats?.[0]?.format;
  let invalid = "";
  let size: { width: number; height: number } | null = null;
  try {
    moviePlan(project, { ...defaultMovieOptions, resolution, clipAudio: project.clipAudio !== false });
    size = movieDimensions(project.aspect, resolution);
  } catch (cause) { invalid = (cause as Error).message; }
  const unavailable = formats && !formats.length ? capabilities?.error || "This browser does not offer the video and audio encoders the export needs. Use current desktop Chrome or Edge." : "";

  const start = useCallback(async () => {
    if (controller.current || invalid || !format) return;
    const abort = new AbortController();
    controller.current = abort;
    const snapshot = structuredClone(project);
    setError(""); setFile(null);
    setProgress({ phase: "Loading media", fraction: 0 });
    try {
      if (!(await movieScopeIsCurrent(scope, abort.signal))) throw new Error("Your account or workspace changed. Open this production again to export it.");
      const { renderMovie } = await import("@/lib/workbench/render-movie");
      const movie = await renderMovie(snapshot, { ...defaultMovieOptions, resolution, format, clipAudio: snapshot.clipAudio !== false }, {
        signal: abort.signal,
        onProgress: (value) => { if (!abort.signal.aborted) setProgress(value); },
      });
      abort.signal.throwIfAborted();
      setFile({
        url: URL.createObjectURL(movie.blob), name: `${safeName(snapshot.name)}_${movie.width}x${movie.height}_${snapshot.fps}fps.${movie.format}`,
        format: movie.format, width: movie.width, height: movie.height, seconds: movie.duration, audio: movie.hasAudio, reduced: movie.mixGain < 1,
      });
    } catch (cause) {
      if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "The export did not finish. Try a shorter cut or 720p.");
    } finally {
      if (controller.current === abort) { controller.current = null; setProgress(null); }
    }
  }, [project, scope, invalid, format, resolution]);
  const cancel = useCallback(() => controller.current?.abort(), []);
  return { resolution, setResolution, formats, format, invalid, size, unavailable, progress, error, file, start, cancel, running: progress != null };
}
