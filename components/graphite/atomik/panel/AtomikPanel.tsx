"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ProjectProvider, useProject } from "@/lib/projectContext";
import { AtomikProvider, useAtomik } from "@/components/atomik/AtomikProvider";
import { useShell } from "@/lib/shell/state";
import { useSampleWorkspace } from "@/lib/demo/use-sample";
import { CheckAgain } from "../../CheckAgain";
import { CHECK_LINE } from "@/lib/demo/sample";
import { STUDIO_RAIL } from "@/lib/board/regions";
import {
  ATOMIK_PANEL_EVENT, askButton, atomikIntent, handAtomik, matchPlace, takeHanded,
} from "@/lib/shell/atomik-panel";
import { HOW_HINTS, howAnswer } from "@/lib/shell/atomik-how";
import { CONTROL_PLACES } from "@/lib/shell/palette";
import { exact, priceWords, upTo } from "@/lib/shell/price-words";
import type { Project } from "@/lib/workbench/studio";
import type { Step } from "@/lib/atomik";
import { Glyph } from "../../icons";
import { Price, usePriceTitle } from "../../Price";
import { MemoryLine } from "./MemoryLine";
import { useHowFacts, useWideEnough } from "./use-atomik-panel";
import { usePlaces } from "./use-places";
import "./panel.css";

/**
 * Atomik's panel over any screen (design/particl-graphite/README.md § 1, § 3.4; Atomik frames f and p): `&atomik=1`,
 * and `&atomik=how` for "Ask Atomik how".
 *
 *  - Its top links to the control room's four places (stream 8).
 *  - A question about Particl is answered free, from lib/shell/atomik-how.ts, with an offer that does the thing
 *    through the function the screen's own button calls.
 *  - Commands navigate ("go to cast"), fill Make ("make …"), list approvals in ⌘K ("approve …"), or keep and forget
 *    memory lines: none of them spends.
 *  - A request is a planning turn in the open project's Atomik thread (today's conversation engine,
 *    components/atomik/AtomikProvider.tsx), at the turn's own quote: "Ask · up to N cr" is the approval, sent as the
 *    turn's ceiling. Each paid step the plan proposes waits for its own Continue at its price. One thread at a time.
 *
 * From 768 px up; below, the phone's Atomik sheet (stream 10) answers the same address.
 */
export type AtomikPanelProps = {
  mode: "panel" | "how";
  /** The words handed to the panel (`&q=`), or null. */
  query: string | null;
  onClose: () => void;
  scope: string;
  project: Project | null;
};

/** The shell mounts this while `&atomik=` is set (components/graphite/screens.tsx › AtomikMount). */
export function AtomikPanel({ mode, query, onClose, project }: AtomikPanelProps) {
  return (
    <ProjectProvider>
      <AtomikProvider>
        <Panel mode={mode} query={query} onClose={onClose} productionId={project?.productionProjectId ?? null} />
      </AtomikProvider>
    </ProjectProvider>
  );
}

type Line = { id: number; who: "You" | "Atomik"; text: string; offer?: { label: string; run: () => void } | null; /** A how-to answer, read from the table as it shows, so a figure from the rate card lands when the card is read. */ how?: string };
/* Lines are keyed in the order they were said, across the page's life. */
let lineIds = 0;
type Memory = { verb: "remember" | "forget"; subject: string } | null;

function Panel({ mode, query, onClose, productionId }: { mode: "panel" | "how"; query: string | null; onClose: () => void; productionId: string | null }) {
  const shell = useShell();
  const wide = useWideEnough();
  const places = usePlaces();
  const facts = useHowFacts(true);
  const { selection, setSelection, current } = useProject();
  /* The threads are the open project's production's (none open: the ones filed under no project). */
  useEffect(() => { const want = productionId ?? ""; if (selection !== want) setSelection(want); }, [productionId, selection, setSelection]);
  const ready = productionId ? current?.id === productionId : !current;
  const a = useAtomik();
  /* The sample workspace spends nothing (the owner's switch): no ask box there, only the free how-to answers. */
  const spendOff = useSampleWorkspace();
  const hints = useMemo(() => (spendOff ? HOW_HINTS.filter((hint) => atomikIntent(hint).kind === "how") : HOW_HINTS), [spendOff]);

  const [text, setText] = useState("");
  const intent = useMemo(() => atomikIntent(text), [text]);
  const line = useCallback((who: Line["who"], words: string, offer?: Line["offer"]): Line => ({ id: ++lineIds, who, text: words, offer: offer ?? null }), []);
  const answerHow = useCallback((question: string): Line[] => [line("You", question), { ...line("Atomik", ""), how: question }], [line]);
  /* `&atomik=how` opens on the design's own question, answered from the table like any other. */
  const [local, setLocal] = useState<Line[]>(() => (mode === "how" ? answerHow(HOW_HINTS[0]) : []));
  const askedHow = useRef(mode === "how");
  useEffect(() => {
    if (mode !== "how" || askedHow.current) return;
    askedHow.current = true;
    setLocal((all) => [...all, ...answerHow(HOW_HINTS[0])]);
  }, [mode, answerHow]);
  const [memory, setMemory] = useState<Memory>(null);
  const [note, setNote] = useState<string | null>(null);
  /* A request handed over with the figure the person pressed (⌘K's "Ask · up to N cr"): sent once this turn's own quote is in, if it is no higher. */
  const [autoSend, setAutoSend] = useState<number | null>(null);

  /* The composer's words are the thread's draft only for a request, so only a request is quoted. */
  const asking = intent.kind === "ask" && ready && !spendOff;
  const { setDraftText } = a;
  useEffect(() => { setDraftText(asking ? text : ""); }, [asking, text, setDraftText]);

  const say = useCallback((words: string) => {
    const now = atomikIntent(words);
    setNote(null);
    switch (now.kind) {
      case "empty": setNote("Ask how, or say what to do."); return;
      case "how": setLocal((all) => [...all, ...answerHow(now.text)]); setText(""); return;
      case "approve":
        setLocal((all) => [...all, line("You", now.text), line("Atomik", "I’ll list what that covers and the total in ⌘K; you confirm with one tap.", { label: "Open ⌘K", run: () => places.palette(now.text) })]);
        setText("");
        places.palette(now.text);
        return;
      case "make":
        setLocal((all) => [...all, line("You", now.text), line("Atomik", "I’ll fill Make for you; the price shows before you press.", { label: "Open Make", run: () => places.make({ prompt: now.words }) })]);
        setText("");
        return;
      case "go": {
        const place = matchPlace(now.place, STUDIO_RAIL);
        setLocal((all) => [...all, line("You", now.text), line("Atomik", place ? `${place.label}, on the board.` : "That isn’t a place on the board. Try Brief, Looks, Storyboard, Shots, Cast, Cut or Deliver.")]);
        setText("");
        if (place) places.region(place.id);
        return;
      }
      case "memory": setMemory({ verb: now.verb, subject: now.subject }); return;
      case "ask":
        if (spendOff) { setNote(spendOff); return; }
        if (!a.quote) { setNote("Wait for the price before sending."); return; }
        void a.send(now.text).then(() => setText(""));
        return;
    }
  }, [a, answerHow, line, places, spendOff]);

  /* Words handed over from ⌘K, Settings or a card: into the box; asked at once when the person already pressed. */
  useEffect(() => {
    const take = () => {
      const handed = takeHanded();
      if (!handed) return;
      setText(handed.text);
      const kind = atomikIntent(handed.text).kind;
      if (!handed.send) return;
      if (kind !== "ask") say(handed.text);
      else if (handed.approved !== null) setAutoSend(handed.approved);
    };
    take();
    window.addEventListener(ATOMIK_PANEL_EVENT, take);
    return () => window.removeEventListener(ATOMIK_PANEL_EVENT, take);
  }, [say]);
  useEffect(() => {
    if (autoSend === null || !asking) return;
    /* One shot as the turn's quote arrives (a server answer): the hand-over is used up either way. */
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (a.quoteError) { setAutoSend(null); return; }
    if (!a.quote) return;
    const now = a.quote.estimateCredits;
    setAutoSend(null);
    if (now <= autoSend) void a.send(text).then(() => setText(""));
    else setNote(`This turn now costs ${priceWords(upTo(now)) ?? "more"}, not ${priceWords(upTo(autoSend))}. Press Ask to send it at the new price.`);
  }, [a, asking, autoSend, text]);

  /* Words in the address (`&q=`): into the box once, then out of the address so a reload does not type them again. */
  const { setScreenParams } = shell;
  useEffect(() => {
    if (!query) return;
    handAtomik(query);
    setScreenParams({ q: null }, "replace");
  }, [query, setScreenParams]);

  const button = askButton(intent, { credits: a.quote?.estimateCredits ?? null, loading: a.quoting, error: a.quoteError });
  const blocked = intent.kind === "ask" && !ready ? "Opening this project’s Atomik…" : null;
  const title = usePriceTitle(button.price);
  const thread = ready && (a.messages.length > 0 || a.current.kind !== "idle");
  const empty = !thread && !local.length && !memory;
  const box = useRef<HTMLDivElement>(null);
  /* The panel starts under the header, whatever height the header has on this screen (as Make's panel does). */
  const aside = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = aside.current, header = document.querySelector<HTMLElement>(".gx-header");
    if (!el || !header) return;
    const place = () => el.style.setProperty("--ak-top", `${Math.max(0, Math.round(header.getBoundingClientRect().bottom))}px`);
    place();
    const watch = typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
    watch?.observe(header);
    window.addEventListener("resize", place);
    return () => { watch?.disconnect(); window.removeEventListener("resize", place); };
  }, []);
  useEffect(() => { box.current?.scrollTo?.({ top: box.current.scrollHeight }); }, [local.length, a.messages.length, memory]);

  return (
    <aside ref={aside} className="ak-panel" aria-label="Atomik" data-testid="atomik-panel-global" data-mode={mode} data-wide={wide ? "" : undefined}>
      <div className="ak-head">
        <span className="ak-title"><span className="ak-spark" aria-hidden="true"><Glyph name="spark" size={16} /></span>Atomik</span>
        <button type="button" className="ak-close" onClick={onClose} aria-label="Close Atomik" data-testid="atomik-panel-close">×</button>
      </div>
      <nav className="ak-links" aria-label="Control room">
        {CONTROL_PLACES.map((p) => {
          const here = shell.view === "suite" && shell.suite.id === "atomik" && shell.page.id === p.page;
          return <button key={p.page} type="button" className="ak-link-btn" aria-current={here ? "page" : undefined} onClick={() => places.control(p.page)}>{p.label}</button>;
        })}
      </nav>
      <div className="ak-body" ref={box}>
        {empty ? (
          <div className="ak-hints" data-testid="atomik-hints">
            <span className="ak-eyebrow">Ask Atomik how</span>
            {hints.map((hint) => <button key={hint} type="button" className="ak-hint" onClick={() => say(hint)}>{hint}</button>)}
          </div>
        ) : null}
        {thread ? <ThreadLines onPick={setText} /> : null}
        {local.map((l) => {
          const answer = l.how ? howAnswer(l.how, facts) : null;
          const offer = answer ? (answer.offer ? { label: answer.offer.label, run: () => places.run(answer.offer!.action) } : null) : l.offer;
          return (
            <div key={l.id} className="ak-msg" data-who={l.who} data-testid="atomik-line">
              <span className="ak-eyebrow" data-who={l.who}>{l.who}</span>
              <p className="ak-msg-text">{answer ? answer.text : l.text}</p>
              {offer ? <div className="ak-actions"><button type="button" className="ak-btn ak-btn-offer" onClick={offer.run} data-testid="atomik-offer">{offer.label}</button></div> : null}
            </div>
          );
        })}
        {memory ? (
          <MemoryLine verb={memory.verb} subject={memory.subject} productionId={productionId}
            onCancel={() => setMemory(null)}
            onDone={(said) => { setLocal((all) => [...all, line("You", text), line("Atomik", said)]); setMemory(null); setText(""); }} />
        ) : null}
      </div>
      <div className="ak-compose">
        {a.recoveryText ? (
          <p className="ak-note" role="status">A request didn’t finish. <button type="button" className="ak-link" disabled={a.busy} onClick={() => void a.send(a.recoveryText ?? "")}>Recover it</button></p>
        ) : null}
        <div className="ak-box">
          <textarea aria-label="Ask Atomik" value={spendOff ? "" : text} placeholder={spendOff ? "Ask Atomik how, above." : "How do I…? Or tell Atomik what to do."} rows={2}
            disabled={Boolean(spendOff)} onChange={(e) => { setText(e.target.value); setNote(null); }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!spendOff && !button.disabled && !blocked && !a.busy) say(text); } }}
            data-testid="atomik-input" />
          <button type="button" className="ak-btn ak-btn-primary ak-send" disabled={Boolean(spendOff) || button.disabled || !!blocked || a.busy}
            title={spendOff ?? title ?? (button.price?.kind === "free" ? "How-to answers are free" : undefined)} onClick={() => say(text)} data-testid="atomik-send">
            {spendOff ? "Ask" : a.busy ? "Sending…" : button.label}
          </button>
        </div>
        {spendOff ?? note ?? blocked ?? button.reason ?? a.error ? <p className="ak-note" role="status" data-testid="atomik-note">{spendOff ?? note ?? blocked ?? button.reason ?? a.error}{spendOff === CHECK_LINE ? <> <CheckAgain className="ak-link" /></> : null}</p> : null}
      </div>
    </aside>
  );
}

/** The open thread as lines: what was said, Atomik's question as chips, the plan with its prices, and the step waiting for Continue. */
function ThreadLines({ onPick }: { onPick: (words: string) => void }) {
  const a = useAtomik();
  const c = a.current;
  const checkpoint = c.kind === "checkpoint" ? c.step : null;
  return (
    <>
      {a.messages.map((m) => (
        <div key={m.id} className="ak-msg" data-who={m.role === "user" ? "You" : "Atomik"} data-testid="atomik-thread-line">
          <span className="ak-eyebrow" data-who={m.role === "user" ? "You" : "Atomik"}>{m.role === "user" ? "You" : "Atomik"}</span>
          <p className="ak-msg-text">{m.text}</p>
        </div>
      ))}
      {c.kind === "planning" ? <p className="ak-line" role="status">Atomik is planning…</p> : null}
      {c.kind === "question" ? (
        <div className="ak-chips" role="group" aria-label={c.ask.question}>
          {c.ask.options.map((o) => <button key={o} type="button" className="ak-chip" disabled={a.busy} onClick={() => onPick(o)}>{o}</button>)}
        </div>
      ) : null}
      {a.plan.length ? (
        <ol className="ak-plan" aria-label="Plan" data-testid="atomik-plan">
          {a.plan.map((s) => <PlanStep key={s.id} step={s} checkpoint={checkpoint?.id === s.id} />)}
        </ol>
      ) : null}
      {checkpoint ? (
        <div className="ak-card" role="group" aria-label="Waiting for you" data-testid="atomik-checkpoint">
          <span className="ak-line">Next: {checkpoint.title} on {a.engineLabel(checkpoint.model)}. Continue approves this step, up to its price; nothing else runs.</span>
          <div className="ak-actions">
            <button type="button" className="ak-btn" disabled={a.busy} onClick={() => void a.stop(checkpoint)}>Stop here</button>
            <ContinueButton step={checkpoint} />
          </div>
          {a.stepQuoteError ? <p className="ak-line ak-problem" role="alert">{a.stepQuoteError}</p> : null}
        </div>
      ) : null}
      {c.kind === "done" ? <p className="ak-line" role="status">{c.failed.length ? `${c.failed.length} did not run; the rest are in the project.` : "Every step ran and is in the project."}</p> : null}
    </>
  );
}

function PlanStep({ step, checkpoint }: { step: Step; checkpoint: boolean }) {
  const a = useAtomik();
  const credits = a.credits(step);
  /* A step whose price is only known as an estimate that can settle either side (a Marketing Studio 2.5 build) keeps
     today's own wording; every other figure is the server's, worded once (lib/shell/price-words.ts). */
  const approximate = a.approximate(step);
  return (
    <li className="ak-step" data-status={step.status} data-checkpoint={checkpoint ? "" : undefined}>
      <span className="ak-step-title">{step.title}</span>
      <span className="ak-step-meta">{a.engineLabel(step.model)} · {step.status === "proposed" ? (checkpoint ? "waiting for you" : "next") : step.status === "done" ? "done" : step.status === "running" ? "running" : step.status === "failed" ? "did not run" : step.status}</span>
      {/* A step not yet run shows its estimate as a ceiling ("up to N cr"): Continue caps the charge at its live quote.
          A step that ran shows what it was billed. */}
      <span className="ak-step-price">{credits === null || approximate ? a.priceLabel(step) : <Price value={step.status === "done" ? exact(credits) : upTo(credits)} />}</span>
    </li>
  );
}

function ContinueButton({ step }: { step: Step }) {
  const a = useAtomik();
  const credits = a.credits(step);
  /* Continue sends its live quote as the ceiling, so the charge is at most this figure. */
  const value = credits === null ? null : upTo(credits);
  const title = usePriceTitle(value);
  const words = a.approximate(step) ? a.priceLabel(step) : priceWords(value);
  return (
    <button type="button" className="ak-btn ak-btn-primary" disabled={a.busy || !a.approvable(step)} title={title ?? undefined}
      onClick={() => void a.approve(step)} data-testid="atomik-continue">
      {a.busy ? "Starting…" : words ? `Continue · ${words}` : "Continue"}
    </button>
  );
}
