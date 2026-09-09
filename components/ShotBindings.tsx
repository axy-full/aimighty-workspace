"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useApi } from "@/lib/useApi";
import { Waiting, Trouble } from "@/components/ParticlMark";
import {
  rowsOf, madeHere, consequenceOf, saveLabel, renderPrice, lockNote, takeLine, countLine,
  BADGE_LABELS, sameBinding, follows, rowKey, candidatesFor, emptyNote,
  type Row, type BindingIn, type ElementIn,
} from "@/lib/shotBindings";
import { versionLine } from "@/lib/rig";
import type { Verdict } from "@/lib/quote";

type Shot = { id: string; projectId: string | null; code: string; title: string; status: string };
type Take = { id: string; version: number; state: string; approved: boolean; kind: string; seconds: number | null; credits: number };
type Payload = {
  shot: Shot; take: Take | null;
  bindings: BindingIn[]; elements: ElementIn[];
  credits: number; verdict: Verdict;
};

/**
 * One shot's five slots (brief 3, surface 2c).
 *
 * The surface where the port model is at its smallest and therefore at its
 * clearest: five slots, each pointing at one version, and changing one moves
 * this shot and nothing else. That is the sentence the whole screen exists to
 * make true, so the only pending state it keeps is which slot is expanded and
 * what has been picked but not saved — and the picked-but-not-saved set is
 * kept beside the saved rows rather than written over them, so that "changed"
 * is always a comparison and never a memory.
 *
 * Desktop and phone are different shapes, not one shape scaled. On a desktop
 * the take, the rows and the picker are visible together, because wiring is
 * comparing: you change the plate while looking at the frame it replaces. On
 * a phone the take is the top of one column and the picker opens inside its
 * row, because there is nothing to compare against on 390px and pretending
 * otherwise costs the row its legibility.
 */
export default function ShotBindings({ shotId }: { shotId: string }) {
  const { data, error, refresh } = useApi<Payload>(`/api/rig/bindings/${encodeURIComponent(shotId)}`);
  /* Both keyed by rowKey(slot, ordinal), not by slot: a shot can hold two
     characters, and keying by slot would let the second one's edit overwrite
     the first's and open the wrong picker. */
  const [open, setOpen] = useState<string | null>(null);
  /* Which port of a bundle row is being looked at. Local to the surface and
     never a binding: narrowing a bundle is a decision, and looking at one of
     its attributes is not yet that decision. */
  const [focus, setFocus] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Record<string, BindingIn>>({});
  const [saving, setSaving] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  const said = useRef<HTMLParagraphElement | null>(null);

  const rows = useMemo(
    () => (data ? rowsOf(shotId, data.bindings, data.elements, pending) : []),
    [data, shotId, pending]);

  const made = useMemo(() => (data ? madeHere(data.elements, shotId) : []), [data, shotId]);

  /* Only when there is nothing to show. A refresh that fails AFTER a
     successful save was replacing the whole surface with an error screen, so
     the save had worked and the person was told it had not, with no way back
     to what they were doing. */
  if (error && !data) return <Trouble label="This shot's bindings didn't load" />;
  if (!data) return <Waiting />;

  const changedRows = rows.filter((r) => r.badges.includes("changed"));
  const dirty = changedRows.length > 0;

  /* A pick that lands back on what is already saved clears the pending entry
     instead of storing an equal one, so the badge and the footer agree with
     each other without either having to diff again. */
  function pick(row: Row, versionId: string | null, attributeId?: string | null) {
    if (row.locked || !row.elementId || !data) return;
    const saved = data.bindings.find((b) => b.slot === row.slot && b.ordinal === row.ordinal) ?? null;
    /* `undefined` means "whatever the row already points at"; an explicit
       null is the bundle being restored. A bundle row narrows only when a
       version of one of its ports is picked, and then it names that port. */
    const at = attributeId === undefined ? row.attributeId : attributeId;
    const next: BindingIn = {
      slot: row.slot, ordinal: row.ordinal, elementId: row.elementId,
      attributeId: at, versionId,
    };
    const key = rowKey(row.slot, row.ordinal);
    setPending((p) => {
      const out = { ...p };
      if (sameBinding(next, saved)) delete out[key];
      else out[key] = next;
      return out;
    });
  }

  /* Binding an EMPTY slot. The port is the bundle — no attribute, no version —
     because a slot that has just been wired should follow the library until
     somebody deliberately pins it, which is the inherited wire on the canvas
     and the cheaper of the two things to be wrong about. */
  function bind(row: Row, elementId: string) {
    if (!data) return;
    const key = rowKey(row.slot, row.ordinal);
    const saved = data.bindings.find((b) => b.slot === row.slot && b.ordinal === row.ordinal) ?? null;
    const next: BindingIn = { slot: row.slot, ordinal: row.ordinal, elementId, attributeId: null, versionId: null };
    setTrouble(null);
    setPending((p) => {
      const out = { ...p };
      if (sameBinding(next, saved)) delete out[key];
      else out[key] = next;
      return out;
    });
  }

  async function save() {
    if (!dirty || saving) return;
    setSaving(true); setTrouble(null);
    try {
      const sent = Object.keys(pending);
      const res = await fetch(`/api/rig/bindings/${encodeURIComponent(shotId)}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changes: sent.map((k) => pending[k]) }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setTrouble(String(json?.error ?? "That didn't save.")); return; }
      /* Only what was sent. Blanking the whole map threw away any pick made
         while the request was in flight — the edit vanished and the surface
         said it had saved. */
      setPending((p) => {
        const out = { ...p };
        for (const k of sent) delete out[k];
        return out;
      });
      /* Save disables itself the moment it succeeds, and focus was falling to
         the document — a keyboard user landed nowhere and a screen reader
         announced nothing. It goes to the line that says what happened. */
      said.current?.focus();
      await refresh();
    } catch {
      setTrouble("That didn't save. The connection or the server had a problem.");
    } finally { setSaving(false); }
  }

  const { shot, take, credits, verdict } = data;

  return (
    <div className="bnd">
      <header className="bnd-head">
        <div className="bnd-head-text">
          <h1 className="bnd-code">{shot.code || "SHOT"}</h1>
          <p className="bnd-title">
            {[shot.title, take?.approved ? "APPROVED" : shot.status].filter(Boolean).join(" · ").toUpperCase()}
          </p>
        </div>
        {shot.projectId ? (
          <Link className="bnd-up" href={`/projects/${encodeURIComponent(shot.projectId)}/rig`}>Rig</Link>
        ) : null}
      </header>

      <div className="bnd-body">
        {/* Left on a desktop, top on a phone: what this shot currently is. */}
        <section className="bnd-take">
          <div className="bnd-frame">
            <span className="bnd-frame-chip">{takeLine(take)}</span>
          </div>
          <p className="bnd-lede">
            Five slots, each pointing at a version in the library. Change a slot
            and only this shot moves.
          </p>

          {made.length ? (
            <div className="bnd-made">
              <span className="bnd-label">THIS SHOT MADE {made.length === 1 ? "AN ELEMENT" : "ELEMENTS"}</span>
              {made.map((e) => (
                <div key={e.id} className="bnd-made-row">
                  <span className="bnd-made-name">{e.name}</span>
                  <span className="bnd-made-meta">
                    {[e.kind, countLine(e.attributes.reduce((n, a) => n + a.versions.length, 0), "version")]
                      .filter(Boolean).join(" · ")}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </section>

        {/* Right on a desktop, below on a phone: the rows and the picker. */}
        <section className="bnd-rows-wrap">
          <div className="bnd-rows">
            {rows.map((row) => {
              const key = rowKey(row.slot, row.ordinal);
              const expanded = open === key;
              const empty = !row.elementId;
              /* An element already on another slot of this shot is not offered
                 again: two slots pointing at one element is a wire drawn twice
                 and a shot that reads as holding two of something it holds one
                 of. */
              const bound = new Set(rows.map((r) => r.elementId).filter(Boolean) as string[]);
              const candidates = empty ? candidatesFor(row.slot, data.elements, bound) : [];
              /* A row opens whenever it has something to say. A BOUND row
                 always does — its versions, or, on a bundle, why there are
                 none to offer. An empty one opens when there is something to
                 bind; keyframe opens to explain why there never will be. */
              const canOpen = !empty || candidates.length > 0 || row.slot === "keyframe";
              return (
                <div key={key} className={`bnd-row-shell${expanded ? " is-open" : ""}`}>
                  <button
                    type="button"
                    className="bnd-row"
                    aria-expanded={expanded}
                    /* Expanded rows stay pressable so a picker can always be
                       closed, even if a reload leaves the row nothing to
                       offer. A disabled control that is currently open is a
                       panel with no way out of it. */
                    disabled={!canOpen && !expanded}
                    onClick={() => setOpen(expanded ? null : key)}
                  >
                    <span className={`bnd-thumb${empty ? " is-empty" : ""}`} aria-hidden="true" />
                    <span className="bnd-slot">{row.label}</span>
                    <span className="bnd-value" data-slot={row.label}>
                      <span className="bnd-name">{row.name || "Nothing bound"}</span>
                      <span className="bnd-detail">
                        {row.detail}
                        {row.wasLine ? <em className="bnd-was"> · {row.wasLine}</em> : null}
                      </span>
                    </span>
                    <span className="bnd-badges">
                      {row.badges.map((b) => (
                        <span key={b} className={`bnd-badge is-${b}`}>{BADGE_LABELS[b]}</span>
                      ))}
                    </span>
                    <span className="bnd-chev" aria-hidden="true" />
                  </button>

                  {expanded ? (
                    <div className="bnd-picker">
                      {lockNote(row) ? <p className="bnd-lock">{lockNote(row)}</p> : null}
                      {empty ? <p className="bnd-lock">{emptyNote(row.slot, candidates.length)}</p> : null}

                      {/* An empty slot picks an ELEMENT; a bound one picks a
                          version of what is already there. Two questions, so
                          two controls, rather than one that means whichever
                          the row happens to be. */}
                      {empty && candidates.length ? (
                        <div className="bnd-candidates">
                          {candidates.map((e) => (
                            <button
                              key={e.id} type="button" className="bnd-candidate"
                              onClick={() => bind(row, e.id)}
                            >
                              <span className="bnd-candidate-thumb" aria-hidden="true" />
                              <span className="bnd-candidate-name">{e.name}</span>
                              <span className="bnd-candidate-meta">{e.kind}</span>
                            </button>
                          ))}
                        </div>
                      ) : null}

                      {/* A bundle: its ports first, then that port's versions.
                          Two steps, because narrowing a bundle to one attribute
                          is a real change to what the shot carries and must be
                          something a person chose rather than something that
                          happened when they tapped a thumbnail. */}
                      {row.bundle.length ? (
                        <>
                          <p className="bnd-lock">
                            This slot follows every one of {row.name}&rsquo;s attributes at its
                            current version. Pick one to override it for this shot alone.
                          </p>
                          <div className="bnd-ports">
                            {row.bundle.map((port) => (
                              <button
                                key={port.id} type="button"
                                className={`bnd-port${focus[key] === port.id ? " is-on" : ""}`}
                                aria-pressed={focus[key] === port.id}
                                disabled={port.locked || row.locked}
                                onClick={() => setFocus((f) => ({ ...f, [key]: f[key] === port.id ? "" : port.id }))}
                              >
                                <span className="bnd-port-name">{port.label}</span>
                                <span className="bnd-port-at">{port.at}</span>
                                {port.locked ? <span className="bnd-port-lock">LOCKED</span> : null}
                              </button>
                            ))}
                          </div>
                        </>
                      ) : null}

                      {/* The focused port's versions. Picking one writes the
                          narrowed port — element, that attribute, that version
                          — and only then does the bundle stop being a bundle. */}
                      {row.bundle.length && focus[key] ? (
                        <div className="bnd-versions">
                          {(row.bundle.find((b) => b.id === focus[key])?.versions ?? []).map((v, i) => (
                            <button
                              key={v.id} type="button" className="bnd-version"
                              disabled={row.locked || (v.status ?? "ready") !== "ready"}
                              onClick={() => pick(row, v.id, focus[key])}
                            >
                              <span className="bnd-version-frame" aria-hidden="true" />
                              <span className="bnd-version-line">{versionLine(i, v.label)}</span>
                              <span className="bnd-version-meta">
                                {(v.status ?? "ready") !== "ready" ? "still rendering" : "override for this shot"}
                              </span>
                            </button>
                          ))}
                        </div>
                      ) : null}

                      <div className="bnd-versions">
                        {row.versions.map((v) => (
                          <button
                            key={v.id}
                            type="button"
                            className={`bnd-version${v.inUse ? " is-on" : ""}`}
                            disabled={row.locked || !v.ready}
                            aria-pressed={v.inUse}
                            onClick={() => pick(row, v.id)}
                          >
                            <span className="bnd-version-frame" aria-hidden="true" />
                            <span className="bnd-version-line">{v.line}</span>
                            <span className="bnd-version-meta">
                              {!v.ready ? "still rendering" : v.current ? "current" : v.inUse ? "pinned here" : ""}
                            </span>
                          </button>
                        ))}
                      </div>
                      {/* Not a version, so not a card among versions. It is the
                          mode the other tiles are the alternative to: pin one
                          of those, or move with the library. Drawn as a card it
                          read as a fourth plate, and took a 3:4 tile's height
                          to say one line. Absent where there are no versions:
                          an unbound slot follows nothing. */}
                      {row.versions.length ? (
                      <button
                        type="button"
                        className={`bnd-follow${follows(row) ? " is-on" : ""}`}
                        disabled={row.locked}
                        aria-pressed={follows(row)}
                        onClick={() => pick(row, null)}
                      >
                        <span className="bnd-follow-dot" aria-hidden="true" />
                        <span className="bnd-follow-line">Follow current</span>
                        <span className="bnd-follow-meta">
                          {follows(row) ? "this shot moves when the library moves" : "unpin, and move with the library again"}
                        </span>
                      </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      </div>

      <footer className="bnd-foot">
        <p className="bnd-consequence" ref={said} tabIndex={-1} role="status" aria-live="polite">
          {consequenceOf(rows, credits, Boolean(take?.approved))}
        </p>
        {/* Two different things, and they were one line until a save that had
            worked sat under a red sentence about a cap. `trouble` is this
            surface failing; the verdict is a standing fact about the RENDER,
            which this surface does not perform. */}
        <p className="bnd-trouble" role="status" aria-live="polite" hidden={!trouble}>{trouble}</p>
        {verdict.line ? <p className="bnd-verdict">{verdict.line}</p> : null}
        {!verdict.line && verdict.notice ? <p className="bnd-verdict">{verdict.notice}</p> : null}
        <div className="bnd-actions">
          <button
            type="button" className="bnd-revert"
            disabled={!dirty || saving}
            onClick={() => setPending({})}
          >Revert</button>
          <button
            type="button" className="bnd-save"
            disabled={!dirty || saving}
            onClick={save}
          >{saving ? "Saving…" : saveLabel(rows)}</button>
          {/* Not a button, and deliberately. The render is pressed where every
              other render in this product is pressed; duplicating the press
              here would duplicate the caps, the approval rule and the cost on
              the button — three chances for two surfaces to disagree about
              somebody else's money. The first draft made it a link to
              /studio/shot, which is worse than useless: that screen is the
              Setup builder rather than the press, and it looks the shot up in
              whichever production the project switcher happens to be on, so
              the link landed on an empty builder for any shot outside it.
              What is owed here is the PRICE, before anything is decided. */}
          <span className="bnd-render">{renderPrice(credits, verdict.allow)}</span>
        </div>
      </footer>
    </div>
  );
}
