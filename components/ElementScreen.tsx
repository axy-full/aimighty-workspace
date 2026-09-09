"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useApi } from "@/lib/useApi";
import { Waiting, Trouble } from "@/components/ParticlMark";
import ImpactSheet from "@/components/ImpactSheet";
import {
  attributeRows, wiredInto, usedByLine, lockLabel, lockNote, addLabel,
  RULE, ADD_NOTE, EMPTY_USE,
  type ElementIn, type ElementUse,
} from "@/lib/elementScreen";
import type { Impact } from "@/lib/impact";

type Payload = {
  element: ElementIn & { projectId: string | null };
  usage: ElementUse;
  overrides: { shotCode: string; attributeId: string; versionId: string }[];
  stages: { visual: string[]; audio: string[] };
};

/**
 * One element's ports (brief 3, surface 2b).
 *
 * A character is four versioned attributes, not one asset. That is the whole
 * claim, and the screen is built to make it true rather than to illustrate
 * it: each attribute is a port with its own lock and its own history, and the
 * numbers beside it are the ones the impact panel will price if you swap it.
 *
 * The one act here that reaches other people's work is the swap, and it does
 * not happen on this screen. Pressing a version asks the server, the server
 * answers 409 with the impact, and the panel is what decides — the same path
 * the element list uses, because rule 5 has to be enforced in one place or it
 * is enforced nowhere.
 *
 * Desktop and phone are different shapes: at 1440 the reference strip and
 * WIRED INTO sit beside the ports so a swap can be judged against what it
 * reaches without scrolling; on a phone they stack, because 390px has no room
 * for two columns and the ports are what you came for.
 */
export default function ElementScreen({ elementId }: { elementId: string }) {
  const { data, error, refresh } = useApi<Payload>(
    `/api/rig/elements/${encodeURIComponent(elementId)}`);

  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);
  const [asking, setAsking] = useState<{ impact: Impact; kindWord: string; versionLabel: string } | null>(null);
  /* Where focus and the announcement go when an action finishes. The sheet
     closes, the tile that was pressed becomes the current one and disables
     itself, and without this focus fell to <body> and nothing was said —
     the bug 2c's save already had. */
  const said = useRef<HTMLParagraphElement | null>(null);

  const el = data?.element ?? null;
  const use = data?.usage ?? EMPTY_USE;

  const rows = useMemo(() => (el ? attributeRows(el, use) : []), [el, use]);

  const wired = useMemo(() => {
    if (!el || !data) return [];
    return wiredInto(el, data.stages, data.overrides.map((o) => {
      const a = el.attributes.find((x) => x.id === o.attributeId);
      const i = a ? a.versions.findIndex((v) => v.id === o.versionId) : -1;
      return { shotCode: o.shotCode, attributeId: o.attributeId, versionLabel: i < 0 ? "" : `v${i + 1}` };
    }));
  }, [el, data]);

  if (error && !data) return <Trouble label="This element didn't load" />;
  if (!data || !el) return <Waiting />;

  /* The ask carries no production: `current_id` is one column on one
     attribute, so moving it moves every shot in every production that follows
     this element. The panel has to be told the truth about what it reaches. */
  async function swap(attributeId: string, versionId: string, kindWord: string, versionLabel: string) {
    if (busy) return;
    setBusy(versionId); setTrouble(null);
    try {
      const res = await fetch(`/api/rig/attributes/${encodeURIComponent(attributeId)}/current`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ versionId }),
      });
      const json = await res.json().catch(() => ({}));
      if (json?.impact) setAsking({ impact: json.impact, kindWord, versionLabel });
      else if (json?.ok) await refresh();
      else setTrouble(String(json?.error ?? "That didn't move."));
    } catch {
      setTrouble("That didn't move. The connection or the server had a problem.");
    } finally { setBusy(null); }
  }

  async function toggleLock() {
    if (busy || !el) return;
    setBusy("lock"); setTrouble(null);
    try {
      const res = await fetch(`/api/rig/elements/${encodeURIComponent(elementId)}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locked: !el.locked }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setTrouble(String(json?.error ?? "That didn't change.")); return; }
      await refresh();
    } catch {
      setTrouble("That didn't change. The connection or the server had a problem.");
    } finally { setBusy(null); }
  }

  /* Both halves off the SAME list. The first pass sliced the rows that have
     versions but counted the overflow off every row, so an element with six
     attributes and three versions showed three tiles and "+2" — a sum that
     adds up to nothing and names ports that were never dropped. */
  const shown = rows.filter((r) => r.versions.length);
  const thumbs = shown.slice(0, 4);
  const more = shown.length - thumbs.length;

  return (
    <div className="elm">
      <header className="elm-head">
        <div className="elm-head-text">
          <h1 className="elm-name">{el.name}</h1>
          <p className="elm-sub">{usedByLine(el, use)}</p>
        </div>
        {el.locked ? <span className="elm-lock" title="Locked">LOCKED</span> : null}
        {el.projectId ? (
          <Link className="elm-up" href={`/projects/${encodeURIComponent(el.projectId)}/rig`}>Rig</Link>
        ) : null}
      </header>

      <div className="elm-body">
        <section className="elm-ports">
          <span className="elm-label">
            ATTRIBUTES · {rows.length} PORT{rows.length === 1 ? "" : "S"}
          </span>
          <div className="elm-rows">
            {rows.map((row) => {
              const expanded = open === row.id;
              return (
                <div key={row.id} className={`elm-row-shell${expanded ? " is-open" : ""}`}>
                  <button
                    type="button" className="elm-row"
                    aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? null : row.id)}
                  >
                    <span className="elm-thumb" aria-hidden="true" />
                    <span className="elm-port">
                      <span className="elm-port-top">
                        <span className="elm-port-name">{row.name}</span>
                        <span className="elm-port-at">{row.at || "no version yet"}</span>
                        {row.locked ? <span className="elm-port-lock">LOCKED</span> : null}
                      </span>
                      <span className="elm-port-meta">
                        {[row.source, row.spread].filter(Boolean).join(" · ") || "nothing uses it yet"}
                      </span>
                    </span>
                    <span className="elm-chev" aria-hidden="true" />
                  </button>

                  {expanded ? (
                    <div className="elm-picker">
                      {!row.versions.length ? (
                        <p className="elm-note is-lock">
                          Nothing has been made for this port yet. Add a version from an
                          upload or an approved take, and every shot citing this element
                          picks it up.
                        </p>
                      ) : null}
                      <div className="elm-versions">
                        {row.versions.map((v) => (
                          <button
                            key={v.id} type="button"
                            className={`elm-version${v.current ? " is-on" : ""}`}
                            aria-pressed={v.current}
                            disabled={row.locked || !v.ready || v.current || busy !== null}
                            /* The panel's footnote reads "N DRAFTS LEFT ON
                               ..." — the version shots STAY on, which is the
                               one going out of use, not the one being moved
                               to. Passing the target made the sheet name the
                               wrong version in the one line a producer is
                               actually weighing. */
                            onClick={() => swap(row.id, v.id, row.kind, row.at || v.line)}
                          >
                            <span className="elm-version-frame" aria-hidden="true" />
                            <span className="elm-version-line">{v.line}</span>
                            <span className="elm-version-meta">{v.meta}</span>
                          </button>
                        ))}
                        {/* The handoff draws a dashed `+ New version` card here.
                            It is not built, and a permanently disabled button
                            is the worst way to say so — it promises a control
                            and then refuses it every time, which is a cost
                            paid on every visit for nothing. So the card is
                            absent and the note below says where a version
                            comes from instead. */}
                      </div>
                      <p className="elm-note">{ADD_NOTE}</p>
                      {row.locked ? (
                        <p className="elm-note is-lock">
                          This port is locked. Unlock the element to move it.
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
        <section className="elm-aside">
          {/* One tile per port rather than four of the same face: the claim of
              the screen is that these are four different things. */}
          <div className="elm-refs">
            {thumbs.map((r) => (
              <div key={r.id} className="elm-ref">
                <span className="elm-ref-frame" aria-hidden="true" />
                <span className="elm-ref-tag">{r.name}</span>
              </div>
            ))}
            {more > 0 ? <div className="elm-ref is-more">+{more}</div> : null}
          </div>
          <p className="elm-rule">{RULE}</p>

          {wired.length ? (
            <div className="elm-wired">
              <span className="elm-label">WIRED INTO</span>
              {wired.map((w, i) => (
                <div key={`${w.stages}:${i}`} className={`elm-wire${w.override ? " is-over" : ""}`}>
                  <span className="elm-wire-from">{w.stages}</span>
                  <span className="elm-wire-arrow" aria-hidden="true">→</span>
                  <span className="elm-wire-to">{w.ports}</span>
                  {w.override ? <span className="elm-wire-badge">OVERRIDE</span> : null}
                </div>
              ))}
            </div>
          ) : null}
        </section>

      </div>

      <footer className="elm-foot">
        <p className="elm-lock-note" ref={said} tabIndex={-1} role="status" aria-live="polite">
          {lockNote(el)}
          {el.lockedBy ? <span className="elm-lock-who"> {el.locked ? "Locked" : "Last unlocked"} by {el.lockedBy}.</span> : null}
        </p>
        <p className="elm-trouble" role="status" aria-live="polite" hidden={!trouble}>{trouble}</p>
        <div className="elm-actions">
          <button
            type="button" className="elm-lock-btn"
            disabled={busy !== null}
            onClick={toggleLock}
          >{busy === "lock" ? "…" : lockLabel(el)}</button>
        </div>
      </footer>

      {asking ? (
        <ImpactSheet
          impact={asking.impact}
          kindWord={asking.kindWord}
          versionLabel={asking.versionLabel}
          onClose={() => setAsking(null)}
          onApplied={() => { setAsking(null); said.current?.focus(); refresh(); }}
        />
      ) : null}
    </div>
  );
}
