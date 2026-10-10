"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { useSession } from "@/lib/session";
import { exact, upTo } from "@/lib/shell/price-words";
import { useStageQuotes } from "@/lib/production/use-stage-quotes";
import { retryQuoteBody } from "@/lib/workspace/retry-request";
import { addInput, removeInput } from "@/lib/production/rig-build";
import { fmtRenderPrice, type RenderPrice } from "@/lib/v12/renderState";
import type { Generation } from "@/lib/jobs";
import { knownQuote } from "@/lib/v12/quote";
import type { RigContext } from "@/components/workspace/rig/RigProvider";
import type { Project } from "@/lib/workbench/studio";
import { Price } from "@/components/v12/ui/Price";
import { useToast } from "@/components/v12/ui/Toast";
import { useOverlay } from "@/components/v12/ui/overlay";
import { GROUP_LABEL, STATE_WORD, redrawn, shotsList, shotsWord, stepName, type RigGroup, type RigInput, type RigModel, type RigShot } from "./model";
import "./rig.css";

/**
 * The Rig, the board's fourth view (redesign P5; docs/redesign/inventory.md § 9; prototype L283–L291): "see what feeds what, and
 * what a change will cost". Inputs · from the Library on the left, The work in the middle, Outputs on the right: Takes, The cut
 * and Masters. No lines until you point at something: click an input and its shots light, click a shot and its inputs light;
 * only that connection is drawn and the rest dims. The Rig fits the stage or scrolls inside its own canvas, and everything
 * that is said to you (the hint, the price of a change) has a place of its own, so nothing is ever drawn over a node.
 *
 * What it does, on today's board:
 *  - the price of a change: the shots an input feeds would be redrawn from their current takes, each priced by the server's
 *    own quote of the same request (the one Retry makes); the figure is said, the redraw is asked of Atomik, never done here;
 *  - drag an input onto a shot: it becomes a reference of that shot (today's addInput, one draft edit, with Undo);
 *  - click a connection and press Delete: it is taken out of that shot (today's removeInput, with Undo);
 *  - double-click a shot: the steps its takes went through, with what each cost.
 */
const HINT_KEY = "particl:rig-hint";
const readHint = (user: string | null) => { try { return window.localStorage.getItem(`${HINT_KEY}:${user ?? ""}`) === "1"; } catch { return false; } };
const writeHint = (user: string | null) => { try { window.localStorage.setItem(`${HINT_KEY}:${user ?? ""}`, "1"); } catch { /* shown again next time */ } };

type Pick = { kind: "input"; id: string } | { kind: "shot"; id: string } | { kind: "edge"; input: string; shot: string } | null;
type Line = { key: string; d: string; picked: boolean };

const GROUPS: RigGroup[] = ["cast", "elements", "look"];
/* A face sits high in the picture; a place or a thing, in the middle. */
const cropOf = (kind: string) => (kind === "Character" ? "50% 12%" : "50% 50%");

function Thumb({ still, kind, className }: { still: { url: string; kind: "image" | "video" } | null; kind?: string; className: string }) {
  if (!still) return <span className={`${className} v12-rig-thumb-empty`} aria-hidden="true" />;
  return still.kind === "video"
    ? <video className={className} src={still.url} muted playsInline preload="metadata" aria-hidden="true" style={{ objectPosition: cropOf(kind ?? "") }} />
    // eslint-disable-next-line @next/next/no-img-element -- Particl's own media route, already sized
    : <img className={className} src={still.url} alt="" loading="lazy" draggable={false} style={{ objectPosition: cropOf(kind ?? "") }} />;
}

export function RigView({ model, project, scope, userId, apply, onStage, onAsk, readOnly }: {
  model: RigModel;
  project: Project;
  scope: string;
  userId: string | null;
  apply: RigContext["apply"];
  onStage: (stage: "shots" | "cut" | "deliver") => void;
  /** Atomik's panel with these words, never sent (BoardCtx.askAtomik). */
  onAsk: (words: string) => void;
  readOnly: boolean;
}) {
  const toast = useToast();
  const { rates } = useSession();
  const dollars = rates.unit === "usd";
  const [pick, setPick] = useState<Pick>(null);
  const [closed, setClosed] = useState<ReadonlySet<RigGroup>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [hint, setHint] = useState(() => (typeof window === "undefined" ? false : !readHint(userId)));
  const [over, setOver] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const inner = useRef<HTMLDivElement>(null);
  const refs = useRef(new Map<string, HTMLElement>());
  const ref = useCallback((id: string) => (el: HTMLElement | null) => { if (el) refs.current.set(id, el); else refs.current.delete(id); }, []);

  const input = pick?.kind === "input" ? model.inputs.find((i) => i.id === pick.id) ?? null : null;
  const shot = pick?.kind === "shot" ? model.shots.find((s) => s.nodeId === pick.id) ?? null : null;
  const inputById = useMemo(() => new Map(model.inputs.map((i) => [i.id, i])), [model.inputs]);

  /* The connections of the selection: an input to each shot it feeds, a shot from each input it uses. */
  const pairs = useMemo<{ input: RigInput; shot: RigShot }[]>(() => {
    if (!pick) return [];
    if (pick.kind === "input") { const i = inputById.get(pick.id); return i ? model.shots.filter((s) => i.shots.includes(s.index)).map((s) => ({ input: i, shot: s })) : []; }
    if (pick.kind === "shot") { const s = model.shots.find((x) => x.nodeId === pick.id); return s ? s.inputs.flatMap((id) => { const i = inputById.get(id); return i ? [{ input: i, shot: s }] : []; }) : []; }
    const i = inputById.get(pick.input), s = model.shots.find((x) => x.nodeId === pick.shot);
    return i && s ? [{ input: i, shot: s }] : [];
  }, [pick, model.shots, inputById]);
  const lit = useMemo(() => new Set(pairs.flatMap((p) => [`i:${p.input.id}`, `s:${p.shot.nodeId}`])), [pairs]);

  const shown = (i: RigInput) => !closed.has(i.group);
  useLayoutEffect(() => {
    const root = inner.current;
    if (!root || !pairs.length) { setLines([]); return; }
    const at = root.getBoundingClientRect();
    const next: Line[] = [];
    for (const { input: i, shot: s } of pairs) {
      const a = refs.current.get(`i:${i.id}`), b = refs.current.get(`s:${s.nodeId}`);
      if (!a || !b || !shown(i)) continue;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const x1 = ra.right - at.left, y1 = ra.top + ra.height / 2 - at.top, x2 = rb.left - at.left, y2 = rb.top + Math.min(rb.height / 2, 28) - at.top;
      const mid = (x1 + x2) / 2;
      next.push({ key: `${i.id}>${s.nodeId}`, d: `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`, picked: pick?.kind === "edge" });
    }
    setLines(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `shown` is a function of `closed`
  }, [pairs, closed, open, model, pick]);
  /* The drawing follows the page: a window resize moves the columns. */
  useEffect(() => {
    const onResize = () => setLines((l) => [...l]);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /* Esc: a shot's steps close, then the selection clears; never anything else (Esc never cancels or leaves). */
  useOverlay("selection", open !== null || pick !== null, () => { if (open) setOpen(null); else setPick(null); });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.key !== "Delete" && event.key !== "Backspace") || pick?.kind !== "edge") return;
      const t = event.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      event.preventDefault();
      removeEdge(pick.input, pick.shot);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `removeEdge` reads the model it is rendered with
  });

  const removeEdge = (inputId: string, shotNode: string) => {
    const i = inputById.get(inputId), s = model.shots.find((x) => x.nodeId === shotNode);
    if (!i || !s) return;
    if (readOnly) { toast({ text: "Needs a connection" }); return; }
    if (!i.nodeId || !i.wired.includes(s.index)) { toast({ text: `${i.name} is in Shot ${s.index} through the script. Change the script to take it out.` }); return; }
    const before = project;
    const refusal = apply((p) => removeInput(p, shotNode, i.nodeId!));
    if (refusal) { toast({ text: refusal }); return; }
    setPick(null);
    toast({ text: `${i.name} is no longer an input of Shot ${s.index}`, action: { label: "Undo", run: () => { apply(() => before); } } });
  };

  const drop = (target: RigShot, event: DragEvent) => {
    event.preventDefault();
    setOver(null);
    const id = event.dataTransfer.getData("application/x-particl-rig-input");
    const i = inputById.get(id);
    if (!i) return;
    if (readOnly) { toast({ text: "Needs a connection" }); return; }
    const node = i.nodeId ? project.nodes.find((n) => n.id === i.nodeId) : undefined;
    const asset = node?.assetId ? [...project.assets, ...(project.sharedAssets ?? [])].find((a) => a.id === node.assetId) : undefined;
    if (i.shots.includes(target.index)) { toast({ text: `${i.name} is already in Shot ${target.index}.` }); return; }
    if (!asset) { toast({ text: `${i.name} has no picture to add yet.` }); return; }
    const before = project;
    const refusal = apply((p) => addInput(p, target.nodeId, asset, i.name));
    if (refusal) { toast({ text: refusal }); return; }
    toast({ text: `${i.name} is a reference for Shot ${target.index}`, action: { label: "Undo", run: () => { apply(() => before); } } });
    setPick({ kind: "shot", id: target.nodeId });
  };

  /* The price of a change: each shot an input feeds is redrawn from its current take, priced by the server (free, nothing reserved). */
  const affected = useMemo(() => (input ? redrawn(input, model) : []), [input, model]);
  const requests = useMemo(() => Object.fromEntries(affected.flatMap((s) => {
    const entry = s.take?.entry;
    const g = entry && entry.asset.origin === "generation" ? entry.asset.value : null;
    const body = g ? retryQuoteBody({ ...g, status: "failed" }) : null;
    return body ? [[s.nodeId, { body }]] : [];
  })), [affected]);
  const { quotes } = useStageQuotes(scope, requests);
  const priced = affected.length > 0 && affected.every((s) => requests[s.nodeId]);
  const credits = affected.map((s) => quotes[s.nodeId]);
  const total = priced && credits.every((q) => q && q.credits != null) ? credits.reduce((n, q) => n + (q!.credits ?? 0), 0) : null;
  const approximate = credits.some((q) => q?.approximate);
  const engines = [...new Set(affected.map((s) => s.take!.engine.split(" · ")[0]))].join(" · ");
  const wording = (i: RigInput) => `Redraw ${shotsList(affected.map((s) => s.index))} with the change to ${i.name}: `;

  const groupOf = (g: RigGroup) => model.inputs.filter((i) => i.group === g);
  const note = (() => {
    if (pick?.kind === "edge") { const e = pairs[0]; return e ? { text: `Remove ${e.input.name} from Shot ${e.shot.index}`, action: <button type="button" className="v12-rig-btn" onClick={() => removeEdge(e.input.id, e.shot.nodeId)} data-testid="v12-rig-remove">Remove · Delete</button> } : null; }
    if (input) {
      if (!affected.length) return { text: `${input.name} feeds ${shotsWord(input.shots.length)}. Nothing would be redrawn: no take of it yet, or locked.`, action: null };
      return {
        text: null,
        action: null,
        impact: true,
      };
    }
    if (shot) {
      const names = shot.inputs.map((id) => inputById.get(id)?.name).filter(Boolean);
      return { text: `${shot.label} uses ${names.length ? names.join(", ") : "no input yet"}. Double-click for its steps.`, action: null };
    }
    return null;
  })();

  const dismissHint = () => { writeHint(userId); setHint(false); };
  const empty = !model.inputs.length && !model.shots.length;

  return (
    <div className="v12-rig" data-testid="v12-rig" data-selecting={pick ? "" : undefined}>
      <div className="v12-rig-note" role="status" aria-live="polite" data-testid="v12-rig-note">
        {note && "impact" in note && input ? (
          <span className="v12-rig-impact" data-testid="v12-rig-impact">
            <strong>Change {input.name}</strong>
            <span>
              {plural(affected.length)} will redraw · {engines || "—"} · {total != null ? <Price quote={knownQuote(approximate ? upTo(total) : exact(total))} testId="v12-rig-price" /> : priced ? <Price quote={{ state: "loading" }} testId="v12-rig-price" /> : <Price quote={knownQuote(null)} testId="v12-rig-price" />}
              {input.locked ? " · Never change" : ""}. Locked frames stay.
            </span>
            <button type="button" className="v12-rig-btn" data-hot="" onClick={() => onAsk(wording(input))} disabled={readOnly} data-testid="v12-rig-ask">Ask Atomik to redraw</button>
          </span>
        ) : note ? (
          <span className="v12-rig-impact">{note.text}{note.action}</span>
        ) : null}
      </div>

      <div className="v12-rig-scroll" data-testid="v12-rig-scroll" onClick={(e) => { if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("v12-rig-cols") || (e.target as HTMLElement).classList.contains("v12-rig-inner")) setPick(null); }}>
        <div className="v12-rig-inner" ref={inner}>
          <svg className="v12-rig-edges" aria-hidden="true">
            {lines.map((l) => (
              <path key={l.key} d={l.d} className="v12-rig-edge" data-picked={l.picked ? "" : undefined} data-testid="v12-rig-edge"
                onClick={() => { const [i, s] = l.key.split(">"); setPick({ kind: "edge", input: i, shot: s }); }} />
            ))}
          </svg>
          <div className="v12-rig-cols">
            <section className="v12-rig-col" aria-label="Inputs">
              <h3 className="v12-rig-h">Inputs · from the Library</h3>
              <div className="v12-rig-chips" role="group" aria-label="Groups">
                {GROUPS.map((g) => (
                  <button key={g} type="button" className="v12-rig-chip" aria-pressed={!closed.has(g)} data-testid={`v12-rig-group-${g}`}
                    onClick={() => setClosed((was) => { const next = new Set(was); if (next.has(g)) next.delete(g); else next.add(g); return next; })}>{closed.has(g) ? "▸" : "▾"} {GROUP_LABEL[g]}</button>
                ))}
              </div>
              {GROUPS.flatMap(groupOf).filter(shown).map((i) => (
                <button key={i.id} ref={ref(`i:${i.id}`)} type="button" className="v12-rig-node v12-rig-input" data-testid="v12-rig-input" data-id={i.id} data-kind={i.kind}
                  data-selected={pick?.kind === "input" && pick.id === i.id ? "" : undefined} data-dim={pick && !lit.has(`i:${i.id}`) ? "" : undefined}
                  draggable={!readOnly && Boolean(i.nodeId)} onDragStart={(e) => { e.dataTransfer.setData("application/x-particl-rig-input", i.id); e.dataTransfer.effectAllowed = "copy"; }}
                  onClick={(e) => { e.stopPropagation(); setPick(pick?.kind === "input" && pick.id === i.id ? null : { kind: "input", id: i.id }); }}>
                  <Thumb still={i.thumb} kind={i.kind} className="v12-rig-thumb" />
                  <span className="v12-rig-body">
                    <span className="v12-rig-name">{i.name}{i.locked ? <svg className="v12-rig-lock" width="12" height="13" viewBox="0 0 14 16" fill="none" stroke="currentColor" strokeWidth="1.6" role="img" aria-label="Never change" data-testid="v12-rig-lock"><title>Never change</title><rect x="1.5" y="7" width="11" height="8" rx="2" /><path d="M4 7V5a3 3 0 0 1 6 0v2" /></svg> : null}</span>
                    <span className="v12-rig-meta">{i.kind} · {i.shots.length ? plural(i.shots.length) : "no shot yet"}</span>
                  </span>
                </button>
              ))}
              {!model.inputs.length ? <p className="v12-rig-empty">Nothing from the Library is used on this board yet.</p> : null}
            </section>

            <section className="v12-rig-col" aria-label="The work">
              <h3 className="v12-rig-h">{model.heading}</h3>
              {model.shots.map((s) => {
                const expanded = open === s.nodeId;
                return (
                  <div key={s.nodeId} ref={ref(`s:${s.nodeId}`)} role="button" tabIndex={0} className="v12-rig-node v12-rig-shot" data-testid="v12-rig-shot" data-id={s.nodeId} data-state={s.state} data-expanded={expanded ? "" : undefined}
                    data-selected={pick?.kind === "shot" && pick.id === s.nodeId ? "" : undefined} data-dim={pick && !lit.has(`s:${s.nodeId}`) ? "" : undefined} data-over={over === s.nodeId ? "" : undefined}
                    onClick={(e) => { e.stopPropagation(); setPick(pick?.kind === "shot" && pick.id === s.nodeId ? null : { kind: "shot", id: s.nodeId }); }}
                    onDoubleClick={(e) => { e.stopPropagation(); setOpen(expanded ? null : s.nodeId); }}
                    onKeyDown={(e) => { if (e.key === "Enter") setPick({ kind: "shot", id: s.nodeId }); }}
                    onDragOver={(e) => { if (e.dataTransfer.types.includes("application/x-particl-rig-input")) { e.preventDefault(); setOver(s.nodeId); } }}
                    onDragLeave={() => setOver((o) => (o === s.nodeId ? null : o))} onDrop={(e) => drop(s, e)}>
                    <Thumb still={s.thumb} className="v12-rig-thumb v12-rig-thumb--shot" />
                    <span className="v12-rig-body">
                      <span className="v12-rig-name v12-rig-name--wrap" title={s.label}>{s.label}</span>
                      <span className="v12-rig-meta">
                        <span className="v12-rig-avatars" aria-label={`${s.inputs.length} inputs`}>
                          {s.inputs.slice(0, 4).map((id) => { const i = inputById.get(id); return i ? (
                            <span key={id} className="v12-rig-avatar" title={i.name} data-testid="v12-rig-avatar">{i.thumb ? <Thumb still={i.thumb} kind={i.kind} className="v12-rig-avatar-img" /> : i.name.charAt(0)}</span>
                          ) : null; })}
                          {s.inputs.length > 4 ? <span className="v12-rig-avatar v12-rig-avatar--more">+{s.inputs.length - 4}</span> : null}
                        </span>
                        {STATE_WORD[s.state] ? <span className="v12-rig-state" data-state={s.state} data-testid="v12-rig-state">{STATE_WORD[s.state]}</span> : null}
                      </span>
                    </span>
                    {expanded ? <Steps shot={s} dollars={dollars} /> : null}
                  </div>
                );
              })}
              {!model.shots.length ? <p className="v12-rig-empty">No shots on this board yet.</p> : null}
            </section>

            <section className="v12-rig-col" aria-label="Outputs">
              <h3 className="v12-rig-h">Outputs</h3>
              {model.outputs.map((o) => (
                <button key={o.id} type="button" className="v12-rig-node v12-rig-output" data-testid="v12-rig-output" data-id={o.id} data-dim={pick ? "" : undefined}
                  onClick={(e) => { e.stopPropagation(); onStage(o.stage); }} title={`Opens ${o.stage === "shots" ? "Shots" : o.stage === "cut" ? "Cut" : "Deliver"}`}>
                  <span className="v12-rig-mosaic" data-n={Math.min(4, model.shots.filter((s) => s.thumb).length)} aria-hidden="true">
                    {model.shots.filter((s) => s.thumb).slice(0, o.id === "masters" ? 1 : 4).map((s) => <Thumb key={s.nodeId} still={s.thumb} className="v12-rig-mosaic-img" />)}
                  </span>
                  <span className="v12-rig-body"><span className="v12-rig-name">{o.name}</span><span className="v12-rig-meta">{o.meta}</span></span>
                </button>
              ))}
            </section>
          </div>
        </div>
        {empty ? null : null}
      </div>

      {hint ? (
        <div className="v12-rig-hint" role="note" data-testid="v12-rig-hint">
          <span>Click anything to see what it feeds.</span>
          <button type="button" className="v12-rig-btn" onClick={dismissHint} data-testid="v12-rig-got-it">Got it</button>
        </div>
      ) : null}
    </div>
  );
}

const plural = (n: number) => `${n} ${n === 1 ? "shot" : "shots"}`;

/** What the ledger charged for a settled take, in the workspace's own unit; null while it is still in flight. */
function chargedOf(g: Generation, dollars: boolean): RenderPrice | null {
  if (g.status !== "succeeded" && g.status !== "failed" && g.status !== "cancelled") return null;
  if (dollars) return typeof g.costUsd === "number" ? { amount: g.costUsd, unit: "usd" } : null;
  return typeof g.creditsBilled === "number" ? { amount: g.creditsBilled, unit: "cr" } : null;
}

/** A shot's steps (double-click): what its takes went through, oldest first, with the engine and what each cost. */
function Steps({ shot, dollars }: { shot: RigShot; dollars: boolean }) {
  const versions = shot.row.versions;
  return (
    <div className="v12-rig-steps" data-testid="v12-rig-steps" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      {versions.length ? versions.map((v) => {
        const g = v.entry.asset.origin === "generation" ? v.entry.asset.value : null;
        const charged = g ? chargedOf(g, dollars) : null;
        return (
          <div key={v.genId} className="v12-rig-step" data-testid="v12-rig-step" style={{ "--n": 1 } as CSSProperties}>
            <span>{stepName(v.task, v.media)} · {v.engine}</span>
            <span className="v12-rig-step-price">{charged ? fmtRenderPrice(charged) : v.status === "rendering" || v.status === "held" ? "not billed yet" : "—"}</span>
          </div>
        );
      }) : <div className="v12-rig-step"><span>No take yet</span></div>}
      <div className="v12-rig-step v12-rig-step--quiet"><span>Esc collapses</span></div>
    </div>
  );
}
