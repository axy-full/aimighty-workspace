"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { countsByDraft } from "@/lib/control-room/queue";
import { useApprovals } from "@/lib/control-room/use-approvals";
import { useSampleWorkspace } from "@/lib/demo/use-sample";
import { throwIfArmed } from "@/lib/shell/fault";
import { creditRate, priceWords, upTo } from "@/lib/shell/price-words";
import { recreatePreset } from "@/lib/shell/recipe";
import { useShell } from "@/lib/shell/state";
import { useSession } from "@/lib/session";
import { spendAttrsOf } from "@/lib/spend";
import { pickedBrief, startQuote, startWords, waitingShown, wallRow, type WallTile } from "@/lib/v12/home";
import { useMoney } from "@/lib/price";
import { useOverlay } from "@/components/v12/ui/overlay";
import { ASPECTS, BLANK, BRIEF_MAX, LENGTHS, appendBrief, draftAspect, draftLength, withAspect, withLength } from "@/components/graphite/home/home-model";
import { BriefFileError, briefKind, readBriefFile } from "@/components/graphite/home/brief-file";
import type { HomeViewProps } from "@/components/graphite/home/HomeView";
import { useHomeNav } from "@/components/graphite/home/use-home-nav";
import { useHomeStart } from "@/components/graphite/home/use-home-start";
import { MAX_FILES } from "@/components/graphite/home/BriefBox";
import { Bar, BarChip, BarSheet, type BarMention } from "@/components/v12/bar/Bar";
import { Price } from "@/components/v12/ui/Price";
import { useWall } from "./use-wall";
import { Wall } from "./Wall";
import { WaitingStrip } from "./WaitingStrip";
import { YourBoards } from "./YourBoards";
import "./home.css";

const WIDE = "(min-width: 1400px)";
function useWide(): boolean {
  return useSyncExternalStore(
    (notify) => { const q = window.matchMedia(WIDE); q.addEventListener("change", notify); return () => q.removeEventListener("change", notify); },
    () => window.matchMedia(WIDE).matches,
    () => false,
  );
}

/* "Hide for now": the items waiting when it was pressed stay hidden for this tab; something new brings the strip back. */
const hiddenKey = (scope: string) => `particl-v12-waiting-hidden:${scope}`;
function readHidden(scope: string): Set<string> {
  try { return new Set((JSON.parse(sessionStorage.getItem(hiddenKey(scope)) ?? "[]") as unknown[]).filter((id): id is string => typeof id === "string")); }
  catch { return new Set(); }
}

const ATTACH_ACCEPT = ".pdf,.txt,.md,.markdown,.fountain,application/pdf,text/plain,text/markdown,image/*,video/*";

/**
 * Home, signed in, in the new interface (redesign plan C2; docs/redesign/inventory.md § 5.9; prototype `?` default
 * view): Waiting for you, the wall of this workspace's own work, Your boards with kind filters, and the bar.
 *
 * It starts boards on today's paths only (components/graphite/home/use-home-start: the same create and the same
 * "Start · up to N cr", which approves Atomik's thinking up to N and nothing else). A picked tile starts a board from
 * its words; Remix opens Make with the take's own recipe. Every price is the server's: Start's from the board-start
 * planning figure, each waiting item's from the approvals queue.
 */
export function V12Home({ scope, projects, status, error, onRetry, onPick, onCreate, onStarter, now }: HomeViewProps) {
  throwIfArmed("home");
  const nav = useHomeNav();
  const shell = useShell();
  const session = useSession();
  const money = useMoney();
  /* One unit for every figure Start shows: the button, its marker and the note that a higher price needs another press. */
  const dollars = session.rates.unit === "usd";
  const creditUsd = creditRate(session.rates.creditUsd);
  const wordsOf = useCallback((credits: number) => startWords(startQuote({ spendOff: false, figure: credits, thinking: { state: "ready" }, dollars, creditUsd }), { creditUsd, dollars: money.price }) ?? priceWords(upTo(credits)) ?? "", [dollars, creditUsd, money.price]);
  const s = useHomeStart({ scope, projects, onPick, onCreate, onStarter, openBoard: nav.openBoard, worded: wordsOf });
  const approvals = useApprovals();
  const spendOff = useSampleWorkspace();
  const wall = useWall(scope);
  const wide = useWide();

  /* Waiting for you, unless hidden for now. */
  const [hiddenFor, setHiddenFor] = useState(() => ({ scope, ids: readHidden(scope) }));
  const hidden = hiddenFor.scope === scope ? hiddenFor.ids : readHidden(scope);
  const items = approvals.status === "ready" ? approvals.items : [];
  const stripOn = items.some((item) => !hidden.has(item.id));
  const hide = () => {
    const ids = new Set(items.map((item) => item.id));
    setHiddenFor({ scope, ids });
    try { sessionStorage.setItem(hiddenKey(scope), JSON.stringify([...ids])); } catch { /* private storage: hidden until the page reloads */ }
  };
  const approvalsByDraft = useMemo(() => (approvals.status === "ready" ? countsByDraft(approvals.items) : null), [approvals.status, approvals.items]);

  /* The picked tile: the bar opens its sheet, and Start begins from the tile's words. */
  const [pickedId, setPickedId] = useState<string | null>(null);
  const picked = wall.tiles.find((tile) => tile.id === pickedId) ?? null;
  const pick = (tile: WallTile) => setPickedId((now) => (now === tile.id ? null : tile.id));
  /* A picked tile is a selection on the overlay stack: Esc clears it after any menu or dialog above it. */
  useOverlay("selection", Boolean(picked), () => setPickedId(null));

  const remix = (tile: WallTile) => {
    if (tile.remixBlock) return;
    shell.openMake(recreatePreset(tile.source, { name: tile.title }));
  };

  /* Start's price: the one figure a press approves for these words (use-home-start figureFor), worded by the quote
     layer; the house workspace sees that same figure in dollars. */
  const words = picked ? pickedBrief(picked, s.draft.text) : s.draft.text;
  const figure = s.figureFor(words);
  const quote = startQuote({ spendOff: Boolean(spendOff), figure, thinking: s.thinking, dollars, creditUsd });
  const startMarker = startWords(quote, { creditUsd, dollars: money.price });

  /* Attach: a brief (PDF or text) is read into the words; pictures and clips go with the new board as references. */
  const [note, setNote] = useState<{ tone: "note" | "problem"; text: string } | null>(null);
  const reading = useRef<AbortController | null>(null);
  useEffect(() => () => reading.current?.abort(), []);
  const { onDraft, setRefs, setBriefFile, refs, briefFile } = s;
  const attach = useCallback(async (files: File[]) => {
    setNote(null);
    const briefs = files.filter((f) => briefKind(f));
    const media = files.filter((f) => f.type.startsWith("image/") || f.type.startsWith("video/"));
    if (media.length) {
      const room = MAX_FILES - refs.length - (briefFile ? 1 : 0);
      setRefs([...refs, ...media.slice(0, Math.max(0, room))]);
      if (media.length > room) setNote({ tone: "problem", text: `Add up to ${MAX_FILES} files.` });
    }
    if (!briefs.length && !media.length) { setNote({ tone: "problem", text: "Attach a PDF or text brief, or pictures and clips." }); return; }
    const file = briefs[0];
    if (!file) return;
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    setNote({ tone: "note", text: `Reading ${file.name}…` });
    try {
      const read = await readBriefFile(file, controller.signal);
      if (reading.current !== controller) return;
      onDraft((d) => ({ ...d, text: appendBrief(d.text, read.text).text }));
      setBriefFile(file);
      setNote(read.cut ? { tone: "note", text: `Kept the first ${BRIEF_MAX.toLocaleString("en-US")} characters.` } : null);
    } catch (cause) {
      if (reading.current !== controller) return;
      setNote({ tone: "problem", text: cause instanceof BriefFileError || cause instanceof Error ? cause.message || "This file could not be read." : "This file could not be read." });
    } finally {
      if (reading.current === controller) reading.current = null;
    }
  }, [onDraft, setRefs, setBriefFile, refs, briefFile]);

  /* The page leaves room under its last row for the bar as it is now (a picked tile's sheet and a note make it taller). */
  const root = useRef<HTMLDivElement>(null);
  const barBox = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = root.current, bar = barBox.current;
    if (!host || !bar) return;
    const set = () => host.style.setProperty("--v12-bar-h", `${Math.ceil(bar.getBoundingClientRect().height)}px`);
    set();
    if (typeof ResizeObserver === "undefined") return;
    const seen = new ResizeObserver(set);
    seen.observe(bar);
    return () => seen.disconnect();
  }, []);

  const mentions: BarMention[] = wall.tiles.map((tile) => ({ id: tile.id, name: tile.title, kind: tile.type, thumb: tile.url, media: tile.media }));
  const busy = s.pending !== null;
  const send = () => {
    if (!picked && s.draft.text.trim().length < 3) { setNote({ tone: "problem", text: "Describe a film, ad or idea, or pick one above." }); return; }
    setNote(null);
    void s.start(picked ? words : undefined);
  };
  const problem = s.startProblem || s.problem;
  const shownNote = problem ? { tone: "problem" as const, text: problem } : spendOff ? { tone: "note" as const, text: spendOff } : note;

  return (
    <div className="v12-hm" data-testid="v12-home" data-screen-label="Home" ref={root}>
      <div className="v12-hm-scroll gx-scroll" data-testid="home">
        {stripOn ? (
          <WaitingStrip items={items} shown={waitingShown(wide)} onApprove={approvals.approve}
            onOpen={() => nav.openApprovals()} onMore={() => nav.openApprovals()} onHide={hide} />
        ) : null}
        <Wall tiles={wall.tiles} status={wall.status} row={wallRow(stripOn)} picked={picked?.id ?? null} onPick={pick} onRemix={remix} />
        <div className="v12-hm-lower" data-dim={picked ? "" : undefined}>
          <YourBoards scope={scope} projects={projects} status={status} error={error} onRetry={onRetry} now={now} approvals={approvalsByDraft}
            disabled={busy} onOpen={s.open} onNew={() => void s.create(BLANK)} />
        </div>
      </div>
      <div className="v12-hm-bar" ref={barBox}>
        <Bar
          value={s.draft.text}
          onChange={(text) => onDraft((d) => ({ ...d, text }))}
          onSubmit={send}
          placeholder={picked ? "Anything to add (optional)" : "Describe a film, ad or idea, or pick one above"}
          label={picked ? "Anything to add" : "Describe a film, ad or idea"}
          maxLength={BRIEF_MAX}
          disabled={busy}
          onAttach={(files) => void attach(files)}
          attachAccept={ATTACH_ACCEPT}
          attachTitle="Attach a file — A PDF or text brief is read into the words; pictures and clips go with the new board."
          mentions={mentions}
          mentionsTitle="From your work"
          sheet={picked ? (
            <BarSheet testId="v12-home-sheet" rows={[
              { label: "Length", options: LENGTHS, value: draftLength(s.draft), onPick: (v) => onDraft((d) => withLength(d, v)) },
              { label: "Aspect", options: ASPECTS, value: draftAspect(s.draft), onPick: (v) => onDraft((d) => withAspect(d, v)) },
            ]} />
          ) : null}
          chips={<>
            {picked ? <BarChip tone="picked" thumb={picked.url} media={picked.media} label={picked.type} onRemove={() => setPickedId(null)} testId="v12-home-picked-chip" /> : null}
            {briefFile ? <BarChip label={briefFile.name} onRemove={() => setBriefFile(null)} testId="v12-home-brief-chip" /> : null}
            {refs.length ? <BarChip label={refs.length === 1 ? refs[0].name : `${refs.length} files`} onRemove={() => setRefs([])} testId="v12-home-refs-chip" /> : null}
          </>}
          note={shownNote}
          send={{
            label: "Start",
            price: spendOff ? undefined : <Price quote={quote} testId="v12-home-start-price" />,
            disabled: Boolean(spendOff) || figure == null,
            busy: s.pending === "start",
            busyLabel: "Starting…",
            title: spendOff ?? (figure == null ? "Start is priced first: Atomik's thinking, up to a figure you approve." : undefined),
            testId: "v12-home-start",
            attrs: spendOff ? { "data-spend": "unpriced" } : startMarker ? { "data-spend": "priced", "data-spend-price": startMarker } : { ...spendAttrsOf(null) },
          }}
          testId="v12-home-bar"
        />
      </div>
    </div>
  );
}
