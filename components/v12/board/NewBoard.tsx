"use client";
import { useCallback, useId, useMemo, useRef, useState } from "react";
import { useShell } from "@/lib/shell/state";
import { useScopedFetch } from "@/lib/useScopedFetch";
import { uploadFilesToProject } from "@/lib/workspace/library";
import type { CreateSeed } from "@/lib/shell/create-project";
import { upTo } from "@/lib/shell/price-words";
import { goalFor, BRIEF_MAX, DEFAULT_ASPECT, DEFAULT_LENGTH } from "@/components/graphite/home/home-model";
import { askAtomik, planningFor, productionOf } from "@/components/graphite/home/start";
import { useThinkingPrice } from "@/components/graphite/home/use-thinking-price";
import { COMPOSER, COMPOSER_LENGTH, FLAVOR_BOARD, KIND_CARDS, boardName, detectCard, flavorForCard, type KindCard } from "@/lib/v12/board/kinds";
import { KIND_LABEL, applyStageEdit, stageLimit, stagesOf, type SavedStage, type StageEdit } from "@/lib/v12/board/stages";
import { IDLE, LOADING, QUOTE_FAULT, knownQuote, type Quote } from "@/lib/v12/quote";
import { Price } from "@/components/v12/ui/Price";
import { useToast } from "@/components/v12/ui";
import { StageRail } from "./StageRail";
import { StageHeader } from "./StageHeader";
import "./board.css";

/**
 * The new-board flow (docs/redesign/inventory.md § 6.3; prototype L300–L312): the board's own tab, "New board", opened by
 * `?view=board&newboard=1` (with `pick=film|previs|campaign|social` to open on a kind). "What are we making?", four kind
 * cards that switch the rail at once (dimmed until Start), a composer whose words follow the kind, and Start.
 *
 * Nothing exists until Start. Start makes the board through today's create path (the shell's createFromSeed, which Home's
 * templates use), files what was attached, asks Atomik to plan at the figure the button shows (the same planning ask as
 * Home's Start: components/graphite/home/start.ts, a person's press is the approval of up to that figure), and opens the
 * board on its first stage. Typing without picking a kind lets the words pick it ("Looks like a Campaign · change").
 */
type Chip = "length" | "aspect" | "platform";
const EDIT_STAGES = "Edit the stages on the rail: rename, drag, ⋯ to skip or remove, + Stage at the end";
const PLATFORM_ASPECT: Record<string, string> = { Reels: "9:16", Shorts: "9:16", YouTube: "16:9" };

type Create = (name: string, seed: CreateSeed) => Promise<{ id: string; productionId?: string | null } | { error: string }>;

export function NewBoard({ scope, onCreate, initialKind }: { scope: string; onCreate: Create; initialKind: KindCard | null }) {
  const shell = useShell();
  const toast = useToast();
  const fetcher = useScopedFetch(scope);
  const { thinking, retry } = useThinkingPrice(scope);
  const [card, setCard] = useState<KindCard | null>(initialKind);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [chips, setChips] = useState<Partial<Record<Chip, string>>>({});
  const [edited, setEdited] = useState<SavedStage[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const pressed = useRef(false);
  const picker = useRef<HTMLInputElement>(null);
  const cardsRef = useRef<HTMLDivElement>(null);
  const textId = useId();

  /* The kind in play: the picked card, else what the words suggest, else Film's rail until anything is said. */
  const suggested = !card && text.trim() ? detectCard(text) : null;
  const shown = card ?? suggested;
  const flavor = flavorForCard(shown ?? "film", text);
  const composer = COMPOSER[card ?? "none"];
  /* A rail edited for one kind is not another kind's: a different kind starts from its own. */
  const [editedFor, setEditedFor] = useState(flavor);
  const savedStages = edited && editedFor === flavor ? edited : null;
  const stages = useMemo(() => stagesOf(flavor, savedStages), [flavor, savedStages]);

  const edit = (change: StageEdit) => {
    const { saved } = applyStageEdit(stages, change, () => crypto.randomUUID().slice(0, 8));
    setEdited(saved);
    setEditedFor(flavor);
  };
  const pickCard = (id: KindCard) => { setCard(id); setProblem(""); };

  const value = (chip: Chip, options: readonly string[]) => chips[chip] ?? (chip === "length" ? (options.includes(COMPOSER_LENGTH) ? COMPOSER_LENGTH : options[0]) : chip === "aspect" ? DEFAULT_ASPECT : options[0]);

  /* Atomik's thinking, as the button states it: the planning figure, "up to N cr". */
  const quote: Quote = thinking.state === "ready" ? knownQuote(upTo(thinking.credits))
    : thinking.state === "loading" ? LOADING
    : thinking.state === "error" ? { state: "error", message: thinking.message || QUOTE_FAULT, retry }
    : IDLE;
  const asks = thinking.state === "ready";
  const waiting = thinking.state === "loading";
  const failed = thinking.state === "error";

  const start = useCallback(async () => {
    if (pressed.current) return;
    if (!text.trim() && !files.length) { toast({ text: "Describe it, or attach something" }); return; }
    if (waiting || failed) return;
    pressed.current = true;
    setBusy(true);
    setProblem("");
    try {
      const picked = card ?? detectCard(text);
      const chosen = flavorForCard(picked, text);
      const length = chips.length ?? (COMPOSER[picked].chips.some((c) => c.id === "length") ? COMPOSER_LENGTH : undefined);
      const platform = chips.platform ?? (picked === "social" ? "Reels" : undefined);
      const aspect = chips.aspect ?? (platform ? PLATFORM_ASPECT[platform] ?? "9:16" : DEFAULT_ASPECT);
      const deliverables = [platform, length].filter(Boolean).join(" · ") || COMPOSER_LENGTH;
      const brief = text.trim().slice(0, BRIEF_MAX);
      const made = await onCreate(boardName(text, chosen), {
        ...(brief ? { brief } : {}), aspect, deliverables, boardKind: FLAVOR_BOARD[chosen], boardFlavor: chosen,
        ...(edited && editedFor === chosen ? { boardStages: edited } : {}),
      }).catch(() => ({ error: "The board could not be made. Try again." }));
      if ("error" in made) { setProblem(made.error); return; }
      if (files.length) {
        const added = await uploadFilesToProject(scope, made.id, files).catch((cause: unknown) => ({ notes: [cause instanceof Error ? cause.message : "The files could not be added."] }));
        if (added.notes.length) toast({ text: added.notes.join(" ") });
      }
      /* Atomik's thinking, at the figure on the button: a person's press approves up to it. A higher figure now is shown, never spent. */
      let asked = false;
      const goal = goalFor({ text, aspect: aspect === DEFAULT_ASPECT ? null : aspect, length: length && length !== DEFAULT_LENGTH ? length : null });
      if (asks && goal) {
        const production = made.productionId ? { productionId: made.productionId } : await productionOf(fetcher, made.id);
        if ("error" in production) toast({ text: `${production.error} The board is made.` });
        else {
          const terms = await planningFor(fetcher, production.productionId, made.id);
          if ("error" in terms) toast({ text: `${terms.error} The board is made.` });
          else if (terms.planning > thinking.credits) toast({ text: "Atomik’s thinking costs more for this brief. Ask it from the board to approve the new price." });
          else {
            const reply = await askAtomik(fetcher, { productionId: production.productionId, draftId: made.id, goal, limit: thinking.credits, requestId: crypto.randomUUID() });
            if ("error" in reply) toast({ text: reply.error }); else asked = true;
          }
        }
      }
      toast({ text: `Board started · ${KIND_LABEL[chosen]}${card ? "" : " (Atomik’s pick)"}` });
      const to = FLAVOR_BOARD[chosen];
      /* One move: the board, Atomik's panel beside it when it was asked. The board opens on its first stage. */
      shell.goBoard({ ...(to !== "studio" ? { kind: to } : {}), ...(asked ? { atomik: true } : {}), closeMake: true });
    } finally {
      pressed.current = false;
      setBusy(false);
    }
  }, [asks, card, chips, edited, editedFor, failed, fetcher, files, onCreate, scope, shell, text, thinking, toast, waiting]);

  return (
    <div className="v12-newboard" data-testid="v12-newboard" data-kind={shown ?? "none"} data-flavor={flavor}>
      <StageRail kindLabel={KIND_LABEL[flavor]} dim stages={stages} current={null} status={() => ({ state: "empty", count: 0, summary: "Nothing yet", cards: 0 })}
        readOnly={null} onPick={() => {}} onEdit={edit} addBlocked={stageLimit(stages.length)} />
      <div className="v12-newboard-main">
        <StageHeader board="New board" stage={null} meta={null} selection={null} primary={null} menu={null} />
        <div className="v12-newboard-body">
          <div className="v12-newboard-col">
            <h1 className="v12-newboard-title" data-testid="v12-newboard-title">{composer.title}</h1>
            <div className="v12-newboard-kinds" role="group" aria-label="Kind of board" ref={cardsRef}>
              {KIND_CARDS.map((k) => (
                <button key={k.id} type="button" aria-pressed={card === k.id} className="v12-kindcard" data-selected={card === k.id || undefined} onClick={() => pickCard(k.id)} data-testid={`v12-kind-${k.id}`}>
                  <span className="v12-kindcard-name">{k.name}</span>
                  <span className="v12-kindcard-line">{k.line}</span>
                </button>
              ))}
            </div>
            <div className="v12-composer">
              <label className="v12-sr" htmlFor={textId}>What are we making</label>
              <textarea id={textId} className="v12-composer-text" value={text} onChange={(e) => { setText(e.target.value); setProblem(""); }} placeholder={composer.placeholder} data-testid="v12-newboard-text" />
              <div className="v12-composer-foot">
                <button type="button" className="v12-chip v12-chip-attach" title={composer.attach} onClick={() => picker.current?.click()} data-testid="v12-newboard-attach">+ Attach</button>
                <input ref={picker} type="file" multiple hidden onChange={(e) => { const picked = [...(e.target.files ?? [])]; if (picked.length) setFiles((now) => [...now, ...picked]); e.target.value = ""; }} />
                {files.map((f, i) => (
                  <span key={`${f.name}-${i}`} className="v12-attached" data-testid="v12-newboard-file">
                    {f.name}
                    <button type="button" aria-label={`Remove ${f.name}`} title="Remove" onClick={() => setFiles((now) => now.filter((_, at) => at !== i))}>×</button>
                  </span>
                ))}
                {composer.chips.map((row) => (
                  <span key={row.id} className="v12-chips" role="group" aria-label={row.label}>
                    {row.options.map((option) => {
                      const on = value(row.id, row.options) === option;
                      return <button key={option} type="button" aria-pressed={on} className="v12-chip" data-on={on || undefined} onClick={() => setChips((now) => ({ ...now, [row.id]: option }))} data-testid="v12-newboard-chip" data-chip={row.id} data-value={option}>{option}</button>;
                    })}
                  </span>
                ))}
                <span className="v12-composer-gap" />
                <button type="button" className="v12-startbtn" onClick={() => void start()} disabled={busy || waiting || failed} aria-busy={busy || waiting || undefined} title="Atomik’s thinking is billed as it is used, up to the figure shown" data-testid="v12-newboard-start">
                  {busy ? "Starting…" : <>Start{asks || waiting || failed ? <> · <Price quote={quote} /></> : null}</>}
                </button>
              </div>
            </div>
            {suggested ? (
              <p className="v12-newboard-note" data-testid="v12-newboard-guess">Looks like a {suggested === "previs" ? "Pre-vis" : KIND_CARDS.find((k) => k.id === suggested)?.name} · <button type="button" className="v12-link" onClick={() => cardsRef.current?.querySelector<HTMLElement>("button")?.focus()} data-testid="v12-newboard-change">change</button></p>
            ) : null}
            <p className="v12-newboard-note" data-testid="v12-newboard-note">
              Start confirms the stages on the rail. <button type="button" className="v12-link" onClick={() => toast({ text: EDIT_STAGES })} data-testid="v12-newboard-edit-stages">Edit stages</button>
              {failed ? <> <button type="button" className="v12-link" onClick={retry}>Try again</button></> : null}
            </p>
            {problem ? <p className="v12-newboard-problem" role="alert" data-testid="v12-newboard-problem">{problem}</p> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
