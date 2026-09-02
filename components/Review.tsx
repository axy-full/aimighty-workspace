"use client";

import { useState } from "react";
import { useApi } from "@/lib/useApi";
import { timeAgo } from "@/lib/format";

type Note = { id: string; text: string; author: string; userId: string; createdAt: number };

/**
 * Sign-off and notes for one shot.
 *
 * A film team's real question about a render isn't "did it finish" but "is it
 * good". That verdict, and the conversation around it, belongs beside the
 * shot — not scrolling away in a workspace-wide chat where nobody can tell
 * later which clip a note was about.
 */
export default function Review({ genId, state, reviewBy, onChanged }: {
  genId: string;
  state: "" | "approved" | "changes";
  reviewBy: string | null;
  onChanged: () => void;
}) {
  const { data, refresh } = useApi<{ notes: Note[] }>(`/api/notes?genId=${encodeURIComponent(genId)}`, 0);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const notes = data?.notes ?? [];

  async function setState(next: "" | "approved" | "changes") {
    await fetch(`/api/jobs/${genId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewState: next === state ? "" : next }),
    });
    onChanged();
  }

  async function addNote() {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await fetch("/api/notes", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ genId, text: body }),
      });
      setText("");
      refresh();
    } finally { setBusy(false); }
  }

  return (
    <div className="mt-3 border-t border-hair pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => setState("approved")}
          className={`rounded-full px-3 py-1.5 text-[13px] font-medium transition-colors ${
            state === "approved" ? "bg-ok text-white" : "bg-chip text-dim hover:bg-chip2"
          }`}>
          {state === "approved" ? "Approved" : "Approve"}
        </button>
        <button onClick={() => setState("changes")}
          className={`rounded-full px-3 py-1.5 text-[13px] font-medium transition-colors ${
            state === "changes" ? "bg-warn text-white" : "bg-chip text-dim hover:bg-chip2"
          }`}>
          {state === "changes" ? "Changes wanted" : "Ask for changes"}
        </button>
        {state && reviewBy && (
          <span className="text-[12.5px] text-mute">by {reviewBy}</span>
        )}
        {notes.length > 0 && (
          <span className="ml-auto text-[12.5px] text-mute">
            {notes.length} note{notes.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

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
