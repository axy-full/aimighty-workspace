"use client";
import { useRef, useState } from "react";
import { Price } from "@/components/graphite/Price";
import { FREE } from "@/lib/shell/price-words";
import { refreshProjectLibrary, uploadFilesToProject } from "@/lib/workspace/library";
import type { BoardCtx } from "../cards/types";
import "../ads/ads.css";
import "./social.css";

/*
 * The empty Social board (gap G2; decision 32: follow the empty Studio board until Claude Design draws it): the source video goes
 * in here. An upload is filed in this project's Library and its original is kept; nothing is made from it until a person opens a
 * quick tool in Make and presses its priced button.
 */
export function StartSource({ ctx }: { ctx: BoardCtx }) {
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const add = async (list: FileList | null) => {
    const picked = [...(list ?? [])];
    if (!picked.length) return;
    setBusy(true); setProblem(null);
    try {
      const { uploads, notes } = await uploadFilesToProject(ctx.scope, ctx.project.id, picked);
      if (!uploads.length) setProblem(notes[0] ?? "That file could not be added.");
      else { void refreshProjectLibrary(ctx.scope, ctx.project.id); ctx.toast(notes.length ? notes.join(" ") : "Source added · original kept"); }
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "That file could not be added.");
    } finally {
      setBusy(false);
      if (file.current) file.current.value = "";
    }
  };
  return (
    <div className="ab-start" data-testid="social-start">
      <div className="ab-start-box">
        <h2>What is the source video?</h2>
        <p>Add a video of 4 to 30 seconds. Its original is kept, and you open Motion transfer or Object swap on it from the board.</p>
        <span className="ab-start-actions">
          <button type="button" className="ab-btn ab-btn--solid" disabled={busy || ctx.offline} onClick={() => file.current?.click()} data-testid="social-start-upload">{busy ? "Adding…" : <>Add the source · <Price value={FREE} /></>}</button>
        </span>
        <input ref={file} type="file" accept="video/mp4,video/webm,video/quicktime" hidden onChange={(e) => void add(e.target.files)} data-testid="social-start-file" />
        {problem ? <p className="ab-note" data-tone="bad" role="alert">{problem}</p> : null}
      </div>
    </div>
  );
}
