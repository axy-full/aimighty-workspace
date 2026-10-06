"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AtomikProvider, useAtomik } from "@/components/atomik/AtomikProvider";
import { ProjectProvider, useProject } from "@/lib/projectContext";
import { HOW_HINTS, howAnswer, type HowAction } from "@/lib/shell/atomik-how";
import { askButton, atomikIntent, thinkingLine, type AtomikIntent } from "@/lib/shell/atomik-panel";
import { sendGenPreset } from "@/lib/shell/gen-preset";
import type { SettingsSection } from "@/lib/shell/palette";
import type { MakeTool } from "@/lib/shell/make";
import { useShell } from "@/lib/shell/state";
import { useSampleWorkspace } from "@/lib/demo/use-sample";
import type { Project } from "@/lib/workbench/studio";
import { useHowFacts } from "../atomik/panel/use-atomik-panel";
import { usePriceTitle } from "../Price";
import { PhoneSheet } from "./PhoneSheet";

/** Where Atomik's offers and commands go on a phone: the phone's own screens, or the shell's page for the place. */
export type SheetPlaces = {
  home: () => void;
  record: () => void;
  make: () => void;
};

type Line = { id: number; who: "You" | "Atomik"; text: string; how?: string; offer?: { label: string; run: () => void } | null };
let lineIds = 0;

/**
 * Atomik as a bottom sheet over the current screen (design/particl-graphite/README.md § 3.6, frame G; lead decision
 * 29: below 768 px the phone sheet is stream 10's, on the same conversation as the panel). The words are the panel's
 * (lib/shell/atomik-panel.ts): a question about Particl is answered free from the how-to table (no model is called),
 * a command navigates or fills Make, and a request is a planning turn in the open project's Atomik thread at the
 * turn's own quote: "Ask · up to N cr" is the approval, and N is the server's figure, never a design figure.
 *
 * Atomik prepares and explains; it never approves. "make …" fills Make and a person presses Make; an approval
 * ("approve …") lists what waits on Home, where each item is a person's own tap.
 */
export function AtomikSheet({ project, query, online, places, onClose }: { project: Project | null; query: string | null; online: boolean; places: SheetPlaces; onClose: () => void }) {
  return (
    <ProjectProvider>
      <AtomikProvider>
        <Sheet productionId={project?.productionProjectId ?? null} query={query} online={online} places={places} onClose={onClose} />
      </AtomikProvider>
    </ProjectProvider>
  );
}

function Sheet({ productionId, query, online, places, onClose }: { productionId: string | null; query: string | null; online: boolean; places: SheetPlaces; onClose: () => void }) {
  const shell = useShell();
  const facts = useHowFacts(true);
  const { selection, setSelection, current } = useProject();
  /* The threads are the open project's production's (none open: the ones filed under no project). */
  useEffect(() => { const want = productionId ?? ""; if (selection !== want) setSelection(want); }, [productionId, selection, setSelection]);
  const ready = productionId ? current?.id === productionId : !current;
  const a = useAtomik();

  const [text, setText] = useState(query ?? "");
  const [lines, setLines] = useState<Line[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const intent = useMemo(() => atomikIntent(text), [text]);
  /* The sample workspace spends nothing (the owner's switch): no ask box there, only the free how-to answers. */
  const spendOff = useSampleWorkspace();
  const asking = intent.kind === "ask" && ready && online && !spendOff;
  const { setDraftText } = a;
  useEffect(() => { setDraftText(asking ? text : ""); }, [asking, text, setDraftText]);

  const add = useCallback((who: Line["who"], words: string, offer?: Line["offer"]): Line => ({ id: ++lineIds, who, text: words, offer: offer ?? null }), []);
  const runOffer = useCallback((action: HowAction) => {
    switch (action.kind) {
      case "make": if (action.tool) shell.openMake(action.tool as MakeTool); else places.make(); return;
      case "library": places.make(); return;
      case "control": if (action.page === "approvals") places.home(); else if (action.page === "runs") places.record(); else shell.goControlRoom(action.page); return;
      case "settings": shell.goWorkspace(action.section as SettingsSection); return;
      case "region": places.record(); return;
      case "home": places.home(); return;
      case "palette": return;
    }
  }, [shell, places]);

  const say = useCallback((raw: string) => {
    const now: AtomikIntent = atomikIntent(raw);
    setNote(null);
    switch (now.kind) {
      case "empty": setNote("Ask how, or say what to do."); return;
      case "how": setLines((all) => [...all, add("You", now.text), { ...add("Atomik", ""), how: now.text }]); setText(""); return;
      case "approve":
        setLines((all) => [...all, add("You", now.text), add("Atomik", "What waits for you is on Home, each with its price. You approve each one yourself.", { label: "Open Home", run: places.home })]);
        setText("");
        return;
      case "make":
        /* Fills Make with the words; the person presses Make, at the price on its button. */
        sendGenPreset({ prompt: now.words });
        setLines((all) => [...all, add("You", now.text), add("Atomik", "I’ve put that in Make. The price shows before you press.", { label: "Open Make", run: places.make })]);
        setText("");
        places.make();
        return;
      case "go":
        setLines((all) => [...all, add("You", now.text), add("Atomik", "The board is the Record on a phone: spend, brief and what waits on you.", { label: "Open the Record", run: places.record })]);
        setText("");
        return;
      case "memory":
        setLines((all) => [...all, add("You", now.text), add("Atomik", "Memory isn’t on the phone, so nothing was kept or forgotten. Open Particl on a computer to keep or forget a line there.")]);
        setText("");
        return;
      case "ask":
        if (spendOff) { setNote(spendOff); return; }
        if (!online) { setNote("Needs a connection"); return; }
        if (!a.quote) { setNote("Wait for the price before sending."); return; }
        void a.send(now.text).then(() => setText(""));
        return;
    }
  }, [a, add, online, places, shell, spendOff]);

  /* Words in the address (`&q=`): into the box once, so a reload does not type them again. */
  const { setScreenParams } = shell;
  useEffect(() => { if (query) setScreenParams({ q: null }, "replace"); }, [query, setScreenParams]);

  const button = askButton(intent, { credits: a.quote?.estimateCredits ?? null, loading: a.quoting, error: a.quoteError });
  const hints = spendOff ? HOW_HINTS.filter((hint) => atomikIntent(hint).kind === "how") : HOW_HINTS;
  const blocked = intent.kind === "ask" && !online ? "Needs a connection" : intent.kind === "ask" && !ready ? "Opening this project’s Atomik…" : null;
  const title = usePriceTitle(button.price);
  const thread = ready && (a.messages.length > 0 || a.current.kind !== "idle");
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { body.current?.scrollTo?.({ top: body.current.scrollHeight }); }, [lines.length, a.messages.length]);
  const empty = !thread && !lines.length;
  const cost = thinkingLine(intent, a.quote?.estimateCredits ?? null);
  const why = spendOff ?? note ?? blocked ?? button.reason ?? a.error;

  return (
    <PhoneSheet title="Atomik" onClose={onClose} testId="phone-atomik"
      footer={(
        <>
          <p className="ph-row-line" data-testid="phone-atomik-cost">{!spendOff && (intent.kind === "ask" || text.trim()) ? cost : "How-to answers are free"}</p>
          <textarea className="ph-make-text ph-atomik-box" aria-label="Ask Atomik" rows={2} value={spendOff ? "" : text} placeholder={spendOff ? "Ask Atomik how, above." : "How do I…? Or tell Atomik what to do."}
            disabled={Boolean(spendOff)} onChange={(e) => { setText(e.target.value); setNote(null); }} data-testid="phone-atomik-input" />
          <button type="button" className="ph-btn ph-btn--primary" disabled={Boolean(spendOff) || button.disabled || Boolean(blocked) || a.busy} title={spendOff ?? title ?? undefined}
            onClick={() => say(text)} data-testid="phone-atomik-send">{spendOff ? "Ask" : a.busy ? "Sending…" : button.label}</button>
          {why ? <p className="ph-row-line ph-plan-why" role="status" data-testid="phone-atomik-note">{why}</p> : null}
        </>
      )}>
      <div ref={body} className="ph-atomik" data-testid="phone-atomik-body">
        {empty ? (
          <div className="ph-atomik-hints" data-testid="phone-atomik-hints">
            <span className="ph-eyebrow">Ask Atomik how</span>
            {hints.map((hint) => <button key={hint} type="button" className="ph-btn ph-atomik-hint" onClick={() => say(hint)}>{hint}</button>)}
          </div>
        ) : null}
        {thread ? a.messages.map((m) => (
          <div key={m.id} className="ph-atomik-msg" data-who={m.role === "user" ? "You" : "Atomik"} data-testid="phone-atomik-thread-line">
            <span className="ph-eyebrow">{m.role === "user" ? "You" : "Atomik"}</span>
            <p className="ph-atomik-text">{m.text}</p>
          </div>
        )) : null}
        {thread && a.current.kind === "planning" ? <p className="ph-row-line" role="status">Atomik is planning…</p> : null}
        {thread && a.plan.length ? (
          <div className="ph-atomik-msg" data-who="Atomik">
            <p className="ph-atomik-text">The plan is ready. Each step that spends waits for you, with its price, in Needs you on Home.</p>
            <button type="button" className="ph-btn" onClick={places.home} data-testid="phone-atomik-home">Open Home</button>
          </div>
        ) : null}
        {lines.map((l) => {
          const answer = l.how ? howAnswer(l.how, facts) : null;
          const offer = answer ? (answer.offer && answer.offer.action.kind !== "palette" ? { label: answer.offer.label, run: () => runOffer(answer.offer!.action) } : null) : l.offer;
          return (
            <div key={l.id} className="ph-atomik-msg" data-who={l.who} data-testid="phone-atomik-line">
              <span className="ph-eyebrow">{l.who}</span>
              <p className="ph-atomik-text">{answer ? answer.text : l.text}</p>
              {offer ? <button type="button" className="ph-btn" onClick={() => { offer.run(); }} data-testid="phone-atomik-offer">{offer.label}</button> : null}
            </div>
          );
        })}
      </div>
    </PhoneSheet>
  );
}
