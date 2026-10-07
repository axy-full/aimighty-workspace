"use client";
import { useState } from "react";
import { Price } from "@/components/graphite/Price";
import { restoreScript, versionsOf } from "@/lib/production/script-versions";
import { FREE } from "@/lib/shell/price-words";
import type { BoardCtx } from "./cards/types";
import "./earlier-scripts.css";

/** "6 Oct, 10:20", in the viewer's own time. */
function when(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return `${d.getDate()} ${d.toLocaleString("en-US", { month: "short" })}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
const gist = (text: string) => { const one = text.replace(/\s+/g, " ").trim(); return one.length > 90 ? `${one.slice(0, 90)}…` : one; };

/**
 * Earlier scripts (owner decision 11): the scripts a replacement (Transcribe's "Use as script", or a restore) took away, newest first, each with Restore, free.
 * Restore goes back to that script and keeps the current one as a version too, so it can be undone by another restore. Nothing is deleted and nothing is spent.
 */
export function EarlierScripts({ ctx }: { ctx: BoardCtx }) {
  const list = versionsOf(ctx.project);
  const [open, setOpen] = useState(false);
  const blocked = ctx.readOnly ?? ctx.exploreOnly ?? (ctx.offline ? "Needs a connection" : null);
  if (!list.length) return null;
  const restore = (id: string) => {
    const refused = ctx.rig.apply((p) => restoreScript(p, id) ?? p);
    if (refused) { ctx.toast(refused); return; }
    void ctx.rig.save();
    ctx.toast("The earlier script is the script now. The one it replaced is kept under Earlier scripts.");
  };
  return (
    <section className="gx-es" data-testid="earlier-scripts" aria-label="Earlier scripts">
      <button type="button" className="gx-es-head nodrag nopan" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="earlier-scripts-toggle">
        <span>Earlier scripts · {list.length}</span><span aria-hidden="true">{open ? "−" : "+"}</span>
      </button>
      {open ? (
        <ul className="gx-es-list">
          {list.map((v) => (
            <li key={v.id} className="gx-es-row" data-testid="earlier-script">
              <span className="gx-es-meta">{when(v.at)} · {v.note}</span>
              <span className="gx-es-gist">{gist(v.text)}</span>
              <button type="button" className="gx-es-btn nodrag nopan" disabled={Boolean(blocked)} title={blocked ?? undefined} onClick={() => restore(v.id)} data-testid="earlier-script-restore">
                Restore · <Price value={FREE} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
