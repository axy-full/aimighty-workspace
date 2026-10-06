"use client";
import { useEffect, useRef, useState } from "react";
import { useSession } from "@/lib/session";
import { revealClear } from "@/lib/shell/reveal";
import { useShell } from "@/lib/shell/state";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { requestAccountRefresh } from "@/lib/workspace/data";
import type { LibraryEntry } from "@/lib/workspace/library";
import { mayRelease } from "@/lib/workspace/release";
import { useOptionalToast } from "@/lib/workspace/state";

/**
 * Release, on a take held for credits (TakeStatus "held"): the exact credits
 * it needs on the button. POST /api/jobs/:id/release charges that figure at
 * admission or starts nothing and says why — still short, in the route's own
 * words, with the way to more credits (Plans & credits; a member asks an
 * admin). A second press, or a press after a reply that never came, is
 * answered "released" and charges nothing more. Offered only to whom the
 * route allows: the take's author, the owner, an admin.
 */
type Note = { tone: "short" | "error"; text: string };
const UNCONFIRMED = "The release was not confirmed. Press Release again to check — it is never charged twice.";
type Reply = { released?: boolean; already?: boolean; error?: string; credits?: number };

export function ReleaseTake({ entry, onReleased, place }: { entry: LibraryEntry; onReleased: () => Promise<unknown> | void; place: "tile" | "inspector" }) {
  const session = useSession();
  const shell = useShell();
  const scoped = useScopedFetch();
  const toast = useOptionalToast();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  /* The price the route named when it moved: the next press approves that figure, never the old one. */
  const [repriced, setRepriced] = useState<number | null>(null);
  const pressed = useRef(false);
  /* The refusal is said where it can be read: on a phone, clear of the tab bar. */
  const noteRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (note) revealClear(noteRef.current); }, [note]);
  const { take, asset } = entry;
  const generation = asset.origin === "generation" ? asset.value : null;
  if (!generation || take.status !== "held") return null;
  const credits = repriced ?? take.needs ?? null;
  if (credits == null || !mayRelease({ id: session.userId, role: session.role }, generation.createdBy)) return null;
  const admin = session.role === "owner" || session.role === "admin";
  const release = async () => {
    /* One press at a time: a double press is the same press. */
    if (pressed.current) return;
    pressed.current = true;
    setBusy(true); setNote(null);
    let released = false;
    try {
      const response = await scoped(`/api/jobs/${encodeURIComponent(generation.id)}/release`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ credits }),
      });
      const reply = await response.json().catch(() => null) as Reply | null;
      if (response.ok && reply?.released) {
        released = true;
        toast?.(reply.already ? `${take.name} was already released.` : `${take.name} released · ${credits.toLocaleString("en-US")} cr`);
        requestAccountRefresh();
      } else if (!reply?.error || response.status >= 500) {
        /* No answer the route wrote (a gateway's page, a server fault): it may have started. Same as a lost reply. */
        setNote({ tone: "error", text: UNCONFIRMED });
      } else {
        if (typeof reply.credits === "number" && reply.credits !== credits) setRepriced(reply.credits);
        setNote({ tone: response.status === 402 ? "short" : "error", text: reply.error });
      }
    } catch {
      /* The reply was lost: the server may have released it. Pressing again asks, and never charges twice. */
      setNote({ tone: "error", text: UNCONFIRMED });
    } finally {
      pressed.current = false;
      setBusy(false);
    }
    /* Read again after the answer, outside it: a failed re-read is the library's to say, not the release's. */
    if (released) await Promise.resolve(onReleased()).catch(() => undefined);
  };
  return (
    <div className="gx-release" data-place={place} data-testid="take-release-row">
      <button type="button" className="gx-hbtn gx-release-btn" disabled={busy} aria-busy={busy} data-testid="take-release" data-spend="priced"
        onClick={(event) => { event.stopPropagation(); void release(); }}>
        {/* The price stays whole: it may drop to a second line on a narrow tile, never be cut. */}
        {busy ? "Releasing…" : <>Release<span className="sr-only"> {take.name}</span> · {credits.toLocaleString("en-US")}{"\u00a0"}cr</>}
      </button>
      {note ? (
        <p ref={noteRef} className="gx-release-note" data-tone={note.tone} role={note.tone === "short" ? "status" : "alert"} data-testid="take-release-note">
          <span>{note.text}</span>
          {note.tone === "short" ? (admin
            ? <button type="button" className="gx-hbtn gx-release-more" onClick={(event) => { event.stopPropagation(); shell.goWorkspace("credits"); }} data-testid="take-release-credits">Add credits</button>
            : <span className="gx-release-ask" data-testid="take-release-ask">Ask an admin for credits.</span>) : null}
        </p>
      ) : null}
    </div>
  );
}
