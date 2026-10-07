"use client";
import { useRef, useState, type DragEvent } from "react";
import { useShell } from "@/lib/shell/state";
import { Price } from "@/components/graphite/Price";
import { FREE } from "@/lib/shell/price-words";
import { SOURCE_SECONDS } from "@/lib/shell/viral";
import { refreshProjectLibrary, uploadFilesToProject } from "@/lib/workspace/library";
import type { BoardCtx } from "../cards/types";
import "../ads/ads.css";
import "./social.css";

/*
 * The empty Social board on first open (Gaps B frames, "Ads and Social"): one question, "What are we cutting?", one action, a long
 * video (drop it on the box or press "Add the source · free"), and a row under it. An upload is filed in this project's Library and
 * its original is kept; nothing is made from it until a person opens a quick tool in Make and presses its priced button. Social has
 * no templates in the code, and clips, hooks, narrated video and posts are not built: the row under the box is the two tools that
 * are (Motion transfer and Object swap, which open in Make and price there), never a template that promises more.
 */
export function StartSource({ ctx }: { ctx: BoardCtx }) {
  const shell = useShell();
  const file = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
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
  const drop = (e: DragEvent) => {
    e.preventDefault(); setOver(false);
    if (!busy && !ctx.offline) void add(e.dataTransfer.files);
  };
  return (
    <div className="ab-start" data-testid="social-start">
      <div className="ab-start-box">
        <h2>What are we cutting?</h2>
        <div className="ab-start-drop" data-over={over || undefined} data-testid="social-start-drop"
          onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}>
          <span>Drop a long video here</span>
          <button type="button" className="ab-btn ab-btn--solid" disabled={busy || ctx.offline} onClick={() => file.current?.click()} data-testid="social-start-upload">{busy ? "Adding…" : <>Add the source · <Price value={FREE} /></>}</button>
        </div>
        <p className="ab-start-line">Its original is kept. Motion transfer and Object swap take a part of {SOURCE_SECONDS.min} to {SOURCE_SECONDS.max} seconds.</p>
        <div className="ab-start-templates" role="group" aria-label="Quick tools" data-testid="social-start-tools">
          <button type="button" className="ab-btn" onClick={() => shell.openMake("motion")} data-testid="social-start-motion">Motion transfer</button>
          <button type="button" className="ab-btn" onClick={() => shell.openMake("swap")} data-testid="social-start-swap">Object swap</button>
        </div>
        <input ref={file} type="file" accept="video/mp4,video/webm,video/quicktime" hidden onChange={(e) => void add(e.target.files)} data-testid="social-start-file" />
        {problem ? <p className="ab-note" data-tone="bad" role="alert">{problem}</p> : null}
      </div>
    </div>
  );
}
