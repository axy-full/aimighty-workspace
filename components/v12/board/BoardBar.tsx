"use client";
import { useMemo, useState } from "react";
import { agentAsk } from "@/lib/shell/board-agent";
import { spendAttrsOf } from "@/lib/spend";
import { knownQuote } from "@/lib/v12/quote";
import type { LibraryEntry } from "@/lib/workspace/library";
import type { BoardCtx } from "@/components/graphite/board/cards/types";
import { useAgentRun } from "@/components/graphite/board/agent/use-board-agent";
import { Bar, BarChip, type BarMention } from "@/components/v12/bar/Bar";
import { Price } from "@/components/v12/ui/Price";
import "./board-bar.css";

/** The tools that arm and wait for a click on the canvas (the others open Make or the file picker at once). */
const ARMED: Record<string, string> = { note: "Note", text: "Text" };
const KIND_WORD: Record<string, string> = { image: "Still", video: "Clip", audio: "Sound" };

/**
 * The bar on a board (docs/redesign/inventory.md § 5.8 board, § 6.8; prototype L355–L366; redesign P2-b), the shared
 * bar (components/v12/bar/Bar.tsx) as a board uses it:
 *  - [+] Attach: files go into this board's Library, and pictures and videos onto the canvas, by today's upload path
 *    (BoardView's own, the one its Upload tool runs: lib/workspace/library.ts uploadFilesToProject).
 *  - [@]: this board's Library, finished files only; picking one writes "@Name " into the words.
 *  - The selection ("Shot 4", "3 cards") as a chip; × clears it, as Esc does. An armed Note or Text tool as a chip; ×
 *    puts the tool down.
 *  - Ask: today's board ask (components/graphite/board/agent: the docked panel's), the same call at the same price,
 *    "Ask · up to N cr": Atomik's thinking for this board, the code's planning figure, which the press approves as the
 *    run's limit (CLAUDE.md rule 14). The prototype's "Ask · free" is not what the code charges, so it is not shown.
 *    With a selection, the words say which cards they are about.
 * It hides on a fresh board (nothing on any stage yet), where the board's own way in shows.
 */
export function BoardBar({ ctx, selection, onClearSelection, tool, onDisarm, onAttach, library, onAsked }: {
  ctx: BoardCtx;
  /** The selection's crumb ("Shot 4", "3 cards"), or null. */
  selection: string | null;
  onClearSelection: () => void;
  tool: string;
  onDisarm: () => void;
  onAttach: (files: File[]) => void;
  library: readonly LibraryEntry[];
  /** After a press that went through: the board shows Atomik's run. */
  onAsked: () => void;
}) {
  const agent = useAgentRun();
  const [words, setWords] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const sample = ctx.exploreOnly ?? null;
  const answer = agent.answer;
  const ask = agentAsk({ read: agent.ready, enabled: answer?.enabled ?? false, run: answer?.run ?? null, planning: agent.terms?.planning ?? null, words, busy, sample: sample !== null, offline: ctx.offline });

  /* The panel's own send (components/graphite/board/agent/BoardAgentPanel.tsx): re-read the figure, refuse a moved one, then
     ask with the pressed figure as the run's limit. */
  const send = async () => {
    if (ask.disabled || !ask.price || ask.price.kind === "free") return;
    setBusy(true);
    setSaid(null);
    const pressed = ask.price.credits;
    await agent.refresh();
    const now = agent.latestPlanning();
    const text = selection ? `About ${selection}: ${words.trim()}` : words.trim();
    const why = now !== null && now > pressed ? `Atomik’s thinking now costs up to ${now} cr, not ${pressed} cr. Press Ask again at the new price.`
      : await agent.plan(text, pressed, { aspect: ctx.project.aspect || null });
    setBusy(false);
    if (why) { setSaid(why); return; }
    setWords("");
    onAsked();
  };

  const mentions = useMemo<BarMention[]>(() => library
    /* Finished files only, as the Library tray lists them (lib/v12/library.ts trayItems). */
    .filter((entry) => entry.url && entry.take.status !== "rendering" && entry.take.status !== "held" && entry.take.status !== "failed")
    .map((entry) => ({ id: entry.take.id, name: entry.take.name.replace(/\.[a-z0-9]{2,5}$/i, "") || entry.take.name, kind: KIND_WORD[entry.media ?? ""] ?? "File", thumb: entry.media === "image" || entry.media === "video" ? entry.url : null, media: entry.media === "image" || entry.media === "video" ? entry.media : null })),
  [library]);

  const armed = ARMED[tool] ?? null;
  const note = said ?? ask.reason ?? sample;
  return (
    <div className="v12-bd-bar" data-testid="v12-board-bar">
      <Bar
        value={words}
        onChange={(text) => { setWords(text); setSaid(null); }}
        onSubmit={() => void send()}
        placeholder={selection ? `Ask for a change to ${selection}` : "Ask for a change, add a shot, or paste client feedback"}
        label="Ask for a change"
        maxLength={2000}
        disabled={sample !== null}
        onAttach={ctx.offline || sample !== null ? undefined : onAttach}
        attachAccept="image/*,video/*,audio/*,.pdf,.txt,.md"
        mentions={mentions}
        mentionsTitle="From the library"
        chips={<>
          {selection ? <BarChip tone="selection" label={selection} onRemove={onClearSelection} removeTitle="Clear the selection · Esc" testId="v12-board-bar-selection" /> : null}
          {armed ? <BarChip label={`${armed} · click the canvas`} onRemove={onDisarm} removeTitle="Cancel" testId="v12-board-bar-tool" /> : null}
        </>}
        note={note ? { tone: said ? "problem" : "note", text: note } : null}
        send={{
          label: busy ? "Asking…" : "Ask",
          price: ask.price && !busy ? <Price quote={knownQuote(ask.price)} testId="v12-board-bar-price" /> : undefined,
          disabled: ask.disabled,
          busy,
          busyLabel: "Asking…",
          variant: "outlined",
          testId: "v12-board-bar-ask",
          attrs: { ...spendAttrsOf(ask.price) },
        }}
        testId="v12-board-bar-inner"
      />
    </div>
  );
}
