"use client";

import { useState } from "react";
import { appAlert } from "./dialog";
import { useApi } from "@/lib/useApi";
import { timeAgo } from "@/lib/format";
import { trailLine, type Trail } from "@/lib/approval";

type Note = { id: string; text: string; author: string; userId: string; createdAt: number };

/**
 * Sign-off and notes for one shot.
 *
 * A film team's real question about a render isn't "did it finish" but "is it
 * good". That verdict, and the conversation around it, belongs beside the
 * shot — not scrolling away in a workspace-wide chat where nobody can tell
 * later which clip a note was about.
 */
export default function Review({ genId, state, reviewBy, trail, reason, onChanged }: {
  genId: string;
  state: "" | "approved" | "picked" | "changes";
  reviewBy: string | null;
  /** Who picked and who approved, each with its moment (brief 2.1). */
  trail?: Trail;
  /** Why this take was made past an approved one. */
  reason?: string | null;
  onChanged: () => void;
}) {
  const { data, refresh } = useApi<{ notes: Note[] }>(`/api/notes?genId=${encodeURIComponent(genId)}`, 0);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const notes = data?.notes ?? [];

  async function setState(next: "" | "approved" | "picked" | "changes") {
    try {
      const res = await fetch(`/api/jobs/${genId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewState: next === state ? "" : next }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "The review wasn't saved");
      onChanged();
    } catch (e) {
      // Doing nothing silently is worse than the failure itself: the button
      // never latches, so the person assumes they mis-clicked and walks away
      // believing the shot is signed off.
      await appAlert("The review wasn't saved", (e as Error).message);
    }
  }

  async function addNote() {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/notes", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ genId, text: body }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "The note wasn't posted");
      // Cleared only once it has actually saved — clearing first threw away
      // whatever had just been typed.
      setText("");
      refresh();
    } catch (e) {
      await appAlert("The note wasn't posted", (e as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <div className="mt-3 border-t border-hair pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => setState("approved")}
          className={`rounded-full px-3 py-1.5 text-[13px] font-medium transition-colors ${
            state === "approved" ? "bg-ok text-on-ink" : "bg-chip text-dim hover:bg-chip2"
          }`}>
          {state === "approved" ? "Approved" : "Approve"}
        </button>
        <button onClick={() => setState("changes")}
          className={`rounded-full px-3 py-1.5 text-[13px] font-medium transition-colors ${
            state === "changes" ? "bg-warn text-white" : "bg-chip text-dim hover:bg-chip2"
          }`}>
          {state === "changes" ? "Changes wanted" : "Ask for changes"}
        </button>
        {trail && trailLine(trail, (ms) => timeAgo(ms)) ? (
          <span className="text-[12.5px] text-mute">{trailLine(trail, (ms) => timeAgo(ms))}</span>
        ) : state && reviewBy ? (
          <span className="text-[12.5px] text-mute">by {reviewBy}</span>
        ) : null}
        {notes.length > 0 && (
          <span className="ml-auto text-[12.5px] text-mute">
            {notes.length} note{notes.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {reason && <p className="mt-2 text-[12.5px] text-mute">Rendered past an approved take — &ldquo;{reason}&rdquo;</p>}

      {notes.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2">
          {notes.map((n) => (
            <li key={n.id} className="text-[13.5px] leading-relaxed">
              <span className="font-medium">{n.author}</span>{" "}
              <span className="text-mute">{timeAgo(n.createdAt)}</span>
              <p className="whitespace-pre-wrap text-dim">{n.text}</p>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2.5 flex items-center gap-2">
        <input
          value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addNote(); } }}
          placeholder="Leave a note on this shot…"
          className="h-9 min-w-0 flex-1 rounded-full bg-panel2 px-3.5 text-[14px] text-bone placeholder:text-mute focus:bg-panel focus:outline-none"
        />
        <button onClick={addNote} disabled={busy || !text.trim()}
          className="btn-render h-9 shrink-0 px-3.5 text-[13px]">Post</button>
      </div>
    </div>
  );
}
