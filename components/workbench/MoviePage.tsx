"use client";

import { useMemo, useSyncExternalStore } from "react";
import {
  movieHandoffKey,
  readMovieHandoff,
} from "@/lib/workbench/movie-handoff";
import { MovieExport } from "./MovieExport";
const subscribe = () => () => {};
export function MoviePage({
  token,
  scope,
  workspace,
}: {
  token: string;
  scope: string;
  workspace: string;
}) {
  const raw = useSyncExternalStore(
    subscribe,
    () => {
      try {
        return sessionStorage.getItem(movieHandoffKey(token, scope)) || "";
      } catch {
        return "";
      }
    },
    () => null,
  );
  const state = useMemo(() => {
    if (raw === null) return null;
    try {
      return { project: readMovieHandoff(raw, scope) };
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : "This export snapshot is invalid.",
      };
    }
  }, [raw, scope]);
  return (
    <main className="ps movie-page">
      <div className="movie-page-inner">
        <header>
          <a href="/workbench">← Back to workbench</a>
          <span>{workspace}</span>
        </header>
        {state?.project ? (
          <>
            <h1>{state.project.name}</h1>
            <p className="movie-page-note">
              Delivery snapshot · changes in the workbench require a new export.
            </p>
            <MovieExport project={state.project} scope={scope} />
          </>
        ) : (
          <p role="status">{state?.error || "Loading export snapshot…"}</p>
        )}
      </div>
    </main>
  );
}
